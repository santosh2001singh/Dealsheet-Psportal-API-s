/**
 * CONTRACT_ID resolution for deal sheet rows.
 *
 * Two-phase model (defer allocation pattern):
 *   Phase A — `resolveContractIdsForRows({ skipAllocation: true })`
 *     Reuse-only. Sets CONTRACT_ID for rows where it can be inherited from
 *     existing BigQuery rows or in-batch DEAL rows. DEAL rows that would
 *     otherwise need a fresh Firestore allocation are left with
 *     CONTRACT_ID = null.
 *   Phase B — `allocateContractIdsForInsertableRows(rowsToInsert, { tableId })`
 *     Called AFTER append-on-change filtering. Allocates Firestore IDs only
 *     for the DEAL rows that will actually be inserted, then propagates the
 *     freshly-allocated id onto any EXTENSION rows that share the same match
 *     key in the same insert batch.
 *
 * IDs are prefixed strings per table: CHC1000, CAC1000, LOC1000.
 *
 * EXTENSION rules: reuse CONTRACT_ID from matching DEAL via in-batch map or
 * table-scoped BigQuery lookup; never allocate a brand-new id for EXTENSION.
 */

const { logLine } = require("./logger");
const { allocateContractIds } = require("./contractIdSequence");
const {
  normalizeContractIdOrNull,
  compareContractIds,
  buildSequenceOptionsForTable,
} = require("./contractIdFormat");
const {
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
} = require("./bigQueryClient");
const { resolveActiveDealSheetTableId } = require("./recruiterDomainTables");

function toInt64OrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normalizeDealTypeKey(value) {
  return String(value || "").trim().toUpperCase();
}

function parseStartDateMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(`${s.slice(0, 10)}T00:00:00Z`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const d = new Date(value);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Match key: candidate + email + phone + client.
 * @param {object} row
 * @returns {string|null}
 */
function buildContractMatchKey(row) {
  const candidateNexusId = toInt64OrNull(row?.CANDIDATE_NEXUS_ID);
  if (candidateNexusId == null) return null;
  const clientId = toInt64OrNull(row?.CLIENT_ID);
  if (clientId == null) return null;
  const email =
    row?.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase();
  const phone = row?.PHONE_NUMBER == null ? "" : String(row.PHONE_NUMBER).trim();
  return `${candidateNexusId}|${email}|${phone}|${clientId}`;
}

/**
 * Pick latest DEAL contract id on or before extension start (in-batch).
 * @param {Array<{contractId: string, startDateMs: number|null}>|undefined} deals
 * @param {number|null} extensionStartMs
 * @returns {string|null}
 */
function pickDealContractIdFromBatch(deals, extensionStartMs) {
  if (!deals || deals.length === 0) return null;
  let candidates = deals;
  if (extensionStartMs != null) {
    candidates = deals.filter(
      (d) => d.startDateMs == null || d.startDateMs <= extensionStartMs
    );
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const sa = a.startDateMs ?? Number.NEGATIVE_INFINITY;
    const sb = b.startDateMs ?? Number.NEGATIVE_INFINITY;
    if (sb !== sa) return sb - sa;
    return compareContractIds(a.contractId, b.contractId);
  });
  return candidates[0].contractId;
}

function recordDealInBatchMap(dealMap, row, contractId) {
  const key = buildContractMatchKey(row);
  const normalized = normalizeContractIdOrNull(contractId);
  if (!key || normalized == null) return;
  const entry = {
    contractId: normalized,
    startDateMs: parseStartDateMs(row?.START_DATE),
  };
  if (!dealMap.has(key)) dealMap.set(key, []);
  dealMap.get(key).push(entry);
}

/**
 * @param {object[]} unresolvedExtensions
 * @param {Function} fetchContractIdsForExtensionsFn
 * @param {object} bqOptions
 * @returns {Promise<Map<string, string|null>>}
 */
async function fetchExtensionContractIdsByTable(unresolvedExtensions, fetchContractIdsForExtensionsFn, bqOptions) {
  const out = new Map();
  if (!unresolvedExtensions.length) return out;

  /** @type {Map<string, object[]>} */
  const byTable = new Map();
  for (const item of unresolvedExtensions) {
    const tableId = item.tableId || "";
    if (!byTable.has(tableId)) byTable.set(tableId, []);
    byTable.get(tableId).push(item);
  }

  for (const [tableId, items] of byTable) {
    const lookupInput = items.map(({ _row, tableId: _tid, ...rest }) => rest);
    let lookedUp = new Map();
    try {
      const result = await fetchContractIdsForExtensionsFn(lookupInput, {
        ...bqOptions,
        tableId: tableId || undefined,
      });
      if (result instanceof Map) lookedUp = result;
      else if (result && typeof result === "object") lookedUp = new Map(Object.entries(result));
    } catch (err) {
      logLine(
        `[contractId resolver] fetchContractIdsForExtensions(${lookupInput.length}, table=${tableId || "union"}) failed: ${String(err?.message || err).slice(0, 200)}`
      );
    }
    for (const [pid, cid] of lookedUp) {
      out.set(String(pid), normalizeContractIdOrNull(cid));
    }
  }

  return out;
}

/**
 * Resolve CONTRACT_IDs for an enriched batch.
 *
 * @param {object[]} rows
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
async function resolveContractIdsForRows(rows, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const skipAllocation = deps.skipAllocation === true;
  const resolveTableIdFn =
    typeof deps.resolveTableIdFn === "function"
      ? deps.resolveTableIdFn
      : (row) => resolveActiveDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL);

  const allocateContractIdsFn =
    deps.allocateContractIdsFn ?? allocateContractIds;
  const fetchContractIdsByDealSheetIdsFn =
    deps.fetchContractIdsByDealSheetIdsFn ?? fetchContractIdsByDealSheetIds;
  const fetchContractIdsForExtensionsFn =
    deps.fetchContractIdsForExtensionsFn ?? fetchContractIdsForExtensions;

  const dealSheetIds = [];
  const dsSeen = new Set();
  for (const row of rows) {
    const dsid = toInt64OrNull(row?.DEAL_SHEET_ID);
    if (dsid == null) continue;
    const key = String(dsid);
    if (dsSeen.has(key)) continue;
    dsSeen.add(key);
    dealSheetIds.push(key);
  }

  let existingByDealSheetId = new Map();
  if (dealSheetIds.length > 0) {
    try {
      const result = await fetchContractIdsByDealSheetIdsFn(dealSheetIds, deps.bqOptions);
      if (result instanceof Map) existingByDealSheetId = result;
    } catch (err) {
      logLine(
        `[contractId resolver] fetchContractIdsByDealSheetIds failed (continuing without existing-by-dsid): ${String(err?.message || err).slice(0, 200)}`
      );
    }
  }

  let allocatedCount = 0;
  let reusedExistingCount = 0;
  let reusedInBatchCount = 0;
  let extensionFromBqCount = 0;
  let extensionOrphanCount = 0;
  let deferredAllocationCount = 0;

  /** @type {Map<string, Array<{contractId: string, startDateMs: number|null}>>} */
  const dealMap = new Map();

  /** @type {Map<string, object[]>} */
  const needsAllocationByKey = new Map();
  const noKeyAllocationRows = [];

  for (const row of rows) {
    if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "DEAL") continue;

    const dsKey =
      row?.DEAL_SHEET_ID == null ? "" : String(toInt64OrNull(row.DEAL_SHEET_ID) ?? "").trim();
    const existingId = dsKey !== "" ? existingByDealSheetId.get(dsKey) : undefined;

    if (existingId != null) {
      row.CONTRACT_ID = existingId;
      recordDealInBatchMap(dealMap, row, existingId);
      reusedExistingCount++;
      continue;
    }

    const matchKey = buildContractMatchKey(row);
    if (matchKey) {
      const fromBatch = pickDealContractIdFromBatch(dealMap.get(matchKey), null);
      if (fromBatch != null) {
        row.CONTRACT_ID = fromBatch;
        recordDealInBatchMap(dealMap, row, fromBatch);
        reusedInBatchCount++;
        continue;
      }
      if (!needsAllocationByKey.has(matchKey)) needsAllocationByKey.set(matchKey, []);
      needsAllocationByKey.get(matchKey).push(row);
      row.CONTRACT_ID = null;
      continue;
    }

    noKeyAllocationRows.push(row);
    row.CONTRACT_ID = null;
  }

  if (skipAllocation) {
    deferredAllocationCount =
      [...needsAllocationByKey.values()].reduce((acc, list) => acc + list.length, 0) +
      noKeyAllocationRows.length;
  } else {
    const tableId = deps.tableId;
    const sequenceOptions =
      deps.sequenceOptions ?? (tableId ? buildSequenceOptionsForTable(tableId) : null);
    const allocationKeys = [...needsAllocationByKey.keys()];
    const totalToAllocate = allocationKeys.length + noKeyAllocationRows.length;
    if (totalToAllocate > 0) {
      if (!sequenceOptions) {
        logLine(
          `[contractId resolver] allocateContractIds skipped: missing tableId/sequenceOptions for ${totalToAllocate} DEAL row(s)`
        );
      } else {
        let ids = [];
        try {
          const result = await allocateContractIdsFn(totalToAllocate, sequenceOptions);
          if (Array.isArray(result)) ids = result;
        } catch (err) {
          logLine(
            `[contractId resolver] allocateContractIds(${totalToAllocate}) failed (DEAL rows will have null CONTRACT_ID): ${String(err?.message || err).slice(0, 200)}`
          );
        }
        let idIndex = 0;
        for (const key of allocationKeys) {
          const contractId = normalizeContractIdOrNull(ids[idIndex] ?? null);
          idIndex++;
          for (const row of needsAllocationByKey.get(key) || []) {
            row.CONTRACT_ID = contractId;
            if (contractId != null) {
              recordDealInBatchMap(dealMap, row, contractId);
              allocatedCount++;
            }
          }
        }
        for (const row of noKeyAllocationRows) {
          const contractId = normalizeContractIdOrNull(ids[idIndex] ?? null);
          idIndex++;
          row.CONTRACT_ID = contractId;
          if (contractId != null) {
            recordDealInBatchMap(dealMap, row, contractId);
            allocatedCount++;
          }
        }
      }
    }
  }

  /** @type {object[]} */
  const unresolvedExtensions = [];

  for (const row of rows) {
    if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "EXTENSION") continue;

    const dsKey =
      row?.DEAL_SHEET_ID == null ? "" : String(toInt64OrNull(row.DEAL_SHEET_ID) ?? "").trim();
    const existingId = dsKey !== "" ? existingByDealSheetId.get(dsKey) : undefined;

    if (existingId != null) {
      row.CONTRACT_ID = existingId;
      continue;
    }

    const matchKey = buildContractMatchKey(row);
    if (!matchKey) {
      row.CONTRACT_ID = null;
      continue;
    }

    const fromBatch = pickDealContractIdFromBatch(
      dealMap.get(matchKey),
      parseStartDateMs(row?.START_DATE)
    );
    if (fromBatch != null) {
      row.CONTRACT_ID = fromBatch;
      continue;
    }

    const extPlacementId = toInt64OrNull(row?.PLACEMENT_ID);
    if (extPlacementId == null) {
      row.CONTRACT_ID = null;
      continue;
    }

    unresolvedExtensions.push({
      placementId: extPlacementId,
      candidateNexusId: toInt64OrNull(row.CANDIDATE_NEXUS_ID),
      candidateEmail: row.CANDIDATE_EMAIL,
      phoneNumber: row.PHONE_NUMBER,
      clientId: toInt64OrNull(row.CLIENT_ID),
      startDate: row.START_DATE,
      tableId: resolveTableIdFn(row),
      _row: row,
    });
    row.CONTRACT_ID = null;
  }

  if (unresolvedExtensions.length > 0) {
    const lookedUp = await fetchExtensionContractIdsByTable(
      unresolvedExtensions,
      fetchContractIdsForExtensionsFn,
      deps.bqOptions
    );
    for (const item of unresolvedExtensions) {
      const pidStr = String(item.placementId);
      const resolved = lookedUp.get(pidStr) ?? null;
      item._row.CONTRACT_ID = resolved;
      if (resolved != null) extensionFromBqCount++;
      else extensionOrphanCount++;
    }
  }

  const phaseLabel = skipAllocation ? "phaseA" : "phaseAB";
  logLine(
    `[contractId resolver ${phaseLabel}] rows=${rows.length} allocated=${allocatedCount} deferred=${deferredAllocationCount} reusedExisting=${reusedExistingCount} reusedInBatch=${reusedInBatchCount} extensionFromBq=${extensionFromBqCount} extensionOrphan=${extensionOrphanCount}`
  );

  return rows;
}

/**
 * Phase B — allocate CONTRACT_IDs for DEAL rows in the final post-filter insert batch.
 *
 * @param {object[]} rowsToInsert
 * @param {object} [deps]
 * @param {string} [deps.tableId]
 * @returns {Promise<object[]>}
 */
async function allocateContractIdsForInsertableRows(rowsToInsert, deps = {}) {
  if (!rowsToInsert || rowsToInsert.length === 0) return rowsToInsert;

  const tableId = deps.tableId == null ? "" : String(deps.tableId).trim();
  const sequenceOptions =
    deps.sequenceOptions ?? (tableId ? buildSequenceOptionsForTable(tableId) : null);

  const allocateContractIdsFn =
    deps.allocateContractIdsFn ?? allocateContractIds;

  /** @type {Map<string, object[]>} */
  const needsAllocationByKey = new Map();
  /** @type {object[]} */
  const noKeyAllocationRows = [];

  for (const row of rowsToInsert) {
    if (row == null) continue;
    if (row.CONTRACT_ID != null) continue;
    if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "DEAL") continue;

    const matchKey = buildContractMatchKey(row);
    if (matchKey) {
      if (!needsAllocationByKey.has(matchKey)) needsAllocationByKey.set(matchKey, []);
      needsAllocationByKey.get(matchKey).push(row);
    } else {
      noKeyAllocationRows.push(row);
    }
  }

  const allocationKeys = [...needsAllocationByKey.keys()];
  const totalToAllocate = allocationKeys.length + noKeyAllocationRows.length;

  if (totalToAllocate === 0) return rowsToInsert;

  if (!sequenceOptions) {
    logLine(
      `[contractId allocator] skipped: missing tableId sequence config (tableId=${tableId || "none"}, need=${totalToAllocate})`
    );
    return rowsToInsert;
  }

  let ids = [];
  try {
    const result = await allocateContractIdsFn(totalToAllocate, sequenceOptions);
    if (Array.isArray(result)) ids = result;
  } catch (err) {
    logLine(
      `[contractId allocator] allocateContractIds(${totalToAllocate}) failed (DEAL rows will have null CONTRACT_ID): ${String(err?.message || err).slice(0, 200)}`
    );
  }

  let allocatedCount = 0;
  let idIndex = 0;
  /** @type {Map<string, string>} */
  const allocatedByKey = new Map();

  for (const key of allocationKeys) {
    const contractId = normalizeContractIdOrNull(ids[idIndex] ?? null);
    idIndex++;
    if (contractId != null) allocatedByKey.set(key, contractId);
    for (const row of needsAllocationByKey.get(key) || []) {
      row.CONTRACT_ID = contractId;
      if (contractId != null) allocatedCount++;
    }
  }
  for (const row of noKeyAllocationRows) {
    const contractId = normalizeContractIdOrNull(ids[idIndex] ?? null);
    idIndex++;
    row.CONTRACT_ID = contractId;
    if (contractId != null) allocatedCount++;
  }

  let extensionPropagated = 0;
  if (allocatedByKey.size > 0) {
    for (const row of rowsToInsert) {
      if (row == null) continue;
      if (row.CONTRACT_ID != null) continue;
      if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "EXTENSION") continue;
      const matchKey = buildContractMatchKey(row);
      if (!matchKey) continue;
      const id = allocatedByKey.get(matchKey);
      if (id != null) {
        row.CONTRACT_ID = id;
        extensionPropagated++;
      }
    }
  }

  logLine(
    `[contractId allocator] table=${tableId || "none"} insertable=${rowsToInsert.length} allocated=${allocatedCount} uniqueKeys=${allocationKeys.length} noKey=${noKeyAllocationRows.length} extensionPropagated=${extensionPropagated}`
  );

  return rowsToInsert;
}

module.exports = {
  resolveContractIdsForRows,
  allocateContractIdsForInsertableRows,
  buildContractMatchKey,
  pickDealContractIdFromBatch,
  normalizeDealTypeKey,
  parseStartDateMs,
  toInt64OrNull,
  recordDealInBatchMap,
};
