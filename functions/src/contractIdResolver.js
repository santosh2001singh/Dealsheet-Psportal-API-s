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

const { logDetail } = require("./logger");
const { allocateContractIds } = require("./contractIdSequence");
const {
  normalizeContractIdOrNull,
  compareContractIds,
  buildSequenceOptionsForTable,
} = require("./contractIdFormat");
const {
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
  fetchLegacyContractIdentityForDealRows,
  buildLegacyContractLookupKey,
  legacyDealManualColumns,
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
  const candidateNexusId = toInt64OrNull(row?.CANDIDATE_ID);
  if (candidateNexusId == null) return null;
  const clientId = toInt64OrNull(row?.CLIENT_ID);
  if (clientId == null) return null;
  const email =
    row?.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase();
  const phone = row?.CELL_PHONE == null ? "" : String(row.CELL_PHONE).trim();
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
      logDetail(
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
      logDetail(
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
        logDetail(
          `[contractId resolver] allocateContractIds skipped: missing tableId/sequenceOptions for ${totalToAllocate} DEAL row(s)`
        );
      } else {
        let ids = [];
        try {
          const result = await allocateContractIdsFn(totalToAllocate, sequenceOptions);
          if (Array.isArray(result)) ids = result;
        } catch (err) {
          logDetail(
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
      candidateNexusId: toInt64OrNull(row.CANDIDATE_ID),
      candidateEmail: row.CANDIDATE_EMAIL,
      phoneNumber: row.CELL_PHONE,
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
  logDetail(
    `[contractId resolver ${phaseLabel}] rows=${rows.length} allocated=${allocatedCount} deferred=${deferredAllocationCount} reusedExisting=${reusedExistingCount} reusedInBatch=${reusedInBatchCount} extensionFromBq=${extensionFromBqCount} extensionOrphan=${extensionOrphanCount}`
  );

  return rows;
}

/**
 * Placement statuses that never became a working assignment, so no SKU_NUMBER belongs on the row.
 * A SKU identifies an assignment that actually ran; CONTRACT_ID, by contrast, identifies the
 * contract and is still carried over on these rows.
 */
const SKU_INELIGIBLE_PLACEMENT_STATUSES = new Set(["DID NOT START", "DID NOT ACCEPT"]);

/** @returns {boolean} true when this row's placement status may hold a SKU_NUMBER. */
function skuEligibleForLegacyFill(row) {
  const status = row?.PLACEMENT_STATUS == null ? "" : String(row.PLACEMENT_STATUS).trim().toUpperCase();
  return !SKU_INELIGIBLE_PLACEMENT_STATUSES.has(status);
}

/**
 * Stamp legacy CONTRACT_ID / SKU_NUMBER onto DEAL rows the run-rate table already knows.
 *
 * Runs immediately before Firestore allocation: a placement with run-rate history keeps the id it
 * already has, so one contract never ends up with two ids (and its EXTENSIONs, which inherit from
 * the DEAL, stay on the same one). SKU_NUMBER is filled the same way but only when the row has none
 * and the legacy row actually carries one — many older run-rate rows have a CONTRACT_ID and no SKU,
 * and a null there must not overwrite anything.
 *
 * The manual / ops columns in legacyDealManualColumns() come across on the same matched row, also
 * fill-if-empty, so a DEAL that the run-rate table already tracked keeps the same hand-maintained
 * detail an EXTENSION of it would inherit. SKU_NUMBER is the only field gated on PLACEMENT_STATUS.
 *
 * A lookup failure is non-fatal: rows simply fall through to a freshly minted id, which is the
 * pre-existing behaviour. Losing the legacy link on one run is recoverable; failing the whole insert
 * batch is not.
 *
 * @param {object[]} dealRows - DEAL rows still without a CONTRACT_ID
 * @param {object} [deps]
 * @param {string} [deps.tableId]
 * @param {Function} [deps.fetchLegacyContractIdentityFn]
 * @returns {Promise<number>} rows that took a legacy CONTRACT_ID
 */
async function applyLegacyContractIdentityToDealRows(dealRows, deps = {}) {
  if (!dealRows || dealRows.length === 0) return 0;

  const fetchLegacyContractIdentityFn =
    deps.fetchLegacyContractIdentityFn ?? fetchLegacyContractIdentityForDealRows;
  const tableId = deps.tableId == null ? "" : String(deps.tableId).trim();

  let identityByRowKey;
  try {
    identityByRowKey = await fetchLegacyContractIdentityFn(dealRows, {
      tableId: tableId || undefined,
      datasetId: deps.datasetId,
    });
  } catch (err) {
    logDetail(
      `[contractId allocator] legacy run-rate lookup failed (DEAL rows fall back to a new id): ${String(err?.message || err).slice(0, 200)}`
    );
    return 0;
  }
  if (!identityByRowKey || identityByRowKey.size === 0) return 0;

  let reused = 0;
  let skuFilled = 0;
  let manualFilled = 0;
  let initialStartSet = 0;
  let initialStartRejected = 0;
  for (const row of dealRows) {
    if (row.CONTRACT_ID != null) continue;
    const key = buildLegacyContractLookupKey(row);
    if (!key) continue;
    const identity = identityByRowKey.get(key.rowKey);
    const contractId = normalizeContractIdOrNull(identity?.CONTRACT_ID);
    if (contractId == null) continue;

    row.CONTRACT_ID = contractId;
    reused++;

    // SKU_NUMBER is only carried over for placements that actually took effect. A DID NOT START /
    // DID NOT ACCEPT row never became a working assignment, so it must not inherit the legacy SKU
    // even when the run-rate row carries one — CONTRACT_ID still comes across, since the contract
    // identity is what ties the row to its chain.
    // Overwrites rather than fills: the SKU belongs to the contract just matched, so a value carried
    // over from a different contract has to give way. A null on the legacy row still overwrites
    // nothing — many older run-rate rows have a CONTRACT_ID and no SKU.
    if (skuEligibleForLegacyFill(row)) {
      const legacySku = identity?.SKU_NUMBER;
      if (legacySku != null && String(legacySku).trim() !== "") {
        const proposedSku = String(legacySku).trim();
        if (row.SKU_NUMBER == null || String(row.SKU_NUMBER).trim() !== proposedSku) {
          row.SKU_NUMBER = proposedSku;
          skuFilled++;
        }
      }
    }

    // INITIAL_START_DATE is the matched run-rate row's START_DATE: that row IS the contract, so its
    // start is the contract's true initial start. Unlike the fields above this OVERWRITES, because
    // Nexus already supplies a value and on a split contract it is the placement's own start, not
    // the contract's — a rate change on 04-01 within a contract that began 02-02 arrives carrying
    // 04-01. Every placement-level row of one contract has to report the same initial start.
    const legacyInitialStart = identity?.INITIAL_START_DATE;
    if (legacyInitialStart != null && String(legacyInitialStart).trim() !== "") {
      const proposed = String(legacyInitialStart).trim();
      const ownStart = row.START_DATE == null ? "" : String(row.START_DATE).trim().slice(0, 10);
      // An initial start AFTER the row's own start is impossible; that means the row matched a
      // later contract's window. Leave the existing value alone and surface it rather than
      // writing a self-contradictory date.
      if (ownStart !== "" && proposed > ownStart) {
        initialStartRejected++;
      } else if (row.INITIAL_START_DATE == null || String(row.INITIAL_START_DATE).trim().slice(0, 10) !== proposed) {
        row.INITIAL_START_DATE = proposed;
        initialStartSet++;
      }
    }

    // Manual / ops columns off the same matched run-rate row, fill-if-empty — the DEAL-side twin of
    // what EXTENSION rows already inherit. Not gated on PLACEMENT_STATUS: only the SKU above is
    // withheld from DID NOT START / DID NOT ACCEPT rows, since these describe the contract rather
    // than an assignment that ran.
    for (const col of legacyDealManualColumns()) {
      const legacyValue = identity?.[col];
      if (legacyValue == null || String(legacyValue).trim() === "") continue;
      if (row[col] != null && String(row[col]).trim() !== "") continue;
      row[col] = typeof legacyValue === "string" ? legacyValue.trim() : legacyValue;
      manualFilled++;
    }
  }

  if (reused > 0) {
    logDetail(
      `[contractId allocator] legacy run-rate identity applied: dealRows=${dealRows.length} contractIdReused=${reused} skuFilled=${skuFilled} initialStartSet=${initialStartSet} manualFieldsFilled=${manualFilled}`
    );
  }
  // Surfaced rather than silently dropped: a proposed INITIAL_START_DATE later than the row's own
  // START_DATE means the matched run-rate window belongs to a later contract, which is a data
  // problem on one side or the other and worth seeing.
  if (initialStartRejected > 0) {
    logDetail(
      `[contractId allocator] INITIAL_START_DATE rejected (later than the row's own START_DATE): ${initialStartRejected}`
    );
  }
  return reused;
}

/**
 * Phase B — allocate CONTRACT_IDs for DEAL rows in the final post-filter insert batch.
 *
 * DEAL_TYPE='DEAL' rows are the ONLY rows in the system that mint a CONTRACT_ID; the
 * `normalizeDealTypeKey(row?.DEAL_TYPE) !== "DEAL"` skip below is that invariant and must stay.
 * EXTENSION rows only ever inherit an existing id (in-batch DEAL map, BigQuery lookup, or
 * applyExtensionInheritForInsertRows), exactly like SKU_NUMBER — see
 * resolveContractIdsForRunrateMatchedExtensions in bigQueryClient.js.
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

  const pendingDealRows = [];
  const pendingExtensionRows = [];
  for (const row of rowsToInsert) {
    if (row == null) continue;
    if (row.CONTRACT_ID != null) continue;
    const dealTypeKey = normalizeDealTypeKey(row?.DEAL_TYPE);
    if (dealTypeKey === "DEAL") {
      pendingDealRows.push(row);
      continue;
    }
    // EXTENSION rows go through the SAME run-rate identity rule as DEALs (tier 1 below) but are
    // kept out of pendingDealRows so they can never reach the Firestore allocation further down —
    // minting for an extension produces a standalone id no DEAL row shares.
    if (dealTypeKey === "EXTENSION") pendingExtensionRows.push(row);
  }

  // Legacy identity first: a placement the run-rate table already tracks keeps its original
  // CONTRACT_ID (and SKU_NUMBER) instead of minting a second id for the same contract. Only rows
  // with no run-rate history reach the Firestore sequence below.
  await applyLegacyContractIdentityToDealRows(pendingDealRows, { tableId, ...deps });

  // Same rule for EXTENSION rows: the run-rate row IS the contract, so matching against its
  // date window is what tells one of a candidate's contracts from the next. The extension-only
  // tiers (parent DEAL / prior extension) match on identity alone and cannot make that
  // distinction, so they run as a FALLBACK for extensions this rule cannot place — see
  // applyExtensionInheritForInsertRows.
  if (pendingExtensionRows.length > 0) {
    await applyLegacyContractIdentityToDealRows(pendingExtensionRows, { tableId, ...deps });
  }

  /** @type {Map<string, object[]>} */
  const needsAllocationByKey = new Map();
  /** @type {object[]} */
  const noKeyAllocationRows = [];

  for (const row of pendingDealRows) {
    if (row.CONTRACT_ID != null) continue;

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
    logDetail(
      `[contractId allocator] skipped: missing tableId sequence config (tableId=${tableId || "none"}, need=${totalToAllocate})`
    );
    return rowsToInsert;
  }

  let ids = [];
  try {
    const result = await allocateContractIdsFn(totalToAllocate, sequenceOptions);
    if (Array.isArray(result)) ids = result;
  } catch (err) {
    logDetail(
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

  logDetail(
    `[contractId allocator] table=${tableId || "none"} insertable=${rowsToInsert.length} allocated=${allocatedCount} uniqueKeys=${allocationKeys.length} noKey=${noKeyAllocationRows.length} extensionPropagated=${extensionPropagated}`
  );

  return rowsToInsert;
}

module.exports = {
  resolveContractIdsForRows,
  allocateContractIdsForInsertableRows,
  applyLegacyContractIdentityToDealRows,
  buildContractMatchKey,
  pickDealContractIdFromBatch,
  normalizeDealTypeKey,
  parseStartDateMs,
  toInt64OrNull,
  recordDealInBatchMap,
};
