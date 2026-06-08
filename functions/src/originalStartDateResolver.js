/**
 * ORIGINAL_START_DATE resolution for deal sheet rows.
 *
 * DEAL rows: stamped at insert time via computeDealSheetFirstInsertDateStamps
 * (START_DATE -> ORIGINAL_START_DATE on first insert only).
 *
 * EXTENSION rows: inherit the original DEAL start date via in-batch match key
 * or BigQuery lookup (same lineage key as CONTRACT_ID). Orphan extensions stay null.
 */

const { logLine } = require("./logger");
const { formatDateOnlyForSql } = require("./bigQueryClient");
const {
  buildContractMatchKey,
  parseStartDateMs,
  toInt64OrNull,
  normalizeDealTypeKey,
} = require("./contractIdResolver");

/**
 * Pick latest DEAL original start on or before extension start (in-batch).
 * @param {Array<{originalStartDate: string, startDateMs: number|null}>|undefined} deals
 * @param {number|null} extensionStartMs
 * @returns {string|null}
 */
function pickOriginalStartDateFromBatch(deals, extensionStartMs) {
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
    return sb - sa;
  });
  return candidates[0].originalStartDate ?? null;
}

function dealOriginalStartDateFromRow(row) {
  const fromOriginal = formatDateOnlyForSql(row?.ORIGINAL_START_DATE);
  if (fromOriginal != null) return fromOriginal;
  return formatDateOnlyForSql(row?.START_DATE);
}

function recordDealInBatchMap(dealMap, row) {
  const key = buildContractMatchKey(row);
  const originalStartDate = dealOriginalStartDateFromRow(row);
  if (!key || originalStartDate == null) return;
  const entry = {
    originalStartDate,
    startDateMs: parseStartDateMs(row?.START_DATE),
  };
  if (!dealMap.has(key)) dealMap.set(key, []);
  dealMap.get(key).push(entry);
}

/**
 * Resolve ORIGINAL_START_DATE for EXTENSION rows in an enriched batch.
 * DEAL rows are left to insert-time self-stamp.
 *
 * @param {object[]} rows
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
async function resolveOriginalStartDatesForRows(rows, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const fetchOriginalStartDatesForExtensionsFn =
    deps.fetchOriginalStartDatesForExtensionsFn;

  /** @type {Map<string, Array<{originalStartDate: string, startDateMs: number|null}>>} */
  const dealMap = new Map();

  for (const row of rows) {
    if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "DEAL") continue;
    recordDealInBatchMap(dealMap, row);
  }

  /** @type {object[]} */
  const unresolvedExtensions = [];
  let extensionFromBatchCount = 0;
  let extensionFromBqCount = 0;
  let extensionOrphanCount = 0;

  for (const row of rows) {
    if (normalizeDealTypeKey(row?.DEAL_TYPE) !== "EXTENSION") continue;

    const matchKey = buildContractMatchKey(row);
    if (!matchKey) {
      row.ORIGINAL_START_DATE = null;
      continue;
    }

    const fromBatch = pickOriginalStartDateFromBatch(
      dealMap.get(matchKey),
      parseStartDateMs(row?.START_DATE)
    );
    if (fromBatch != null) {
      row.ORIGINAL_START_DATE = fromBatch;
      extensionFromBatchCount++;
      continue;
    }

    const extPlacementId = toInt64OrNull(row?.PLACEMENT_ID);
    if (extPlacementId == null) {
      row.ORIGINAL_START_DATE = null;
      extensionOrphanCount++;
      continue;
    }

    unresolvedExtensions.push({
      placementId: extPlacementId,
      candidateNexusId: toInt64OrNull(row.CANDIDATE_NEXUS_ID),
      candidateEmail: row.CANDIDATE_EMAIL,
      phoneNumber: row.PHONE_NUMBER,
      clientId: toInt64OrNull(row.CLIENT_ID),
      startDate: row.START_DATE,
      _row: row,
    });
    row.ORIGINAL_START_DATE = null;
  }

  if (unresolvedExtensions.length > 0 && typeof fetchOriginalStartDatesForExtensionsFn === "function") {
    const lookupInput = unresolvedExtensions.map(({ _row, ...rest }) => rest);
    let lookedUp = new Map();
    try {
      const result = await fetchOriginalStartDatesForExtensionsFn(lookupInput, deps.bqOptions);
      if (result instanceof Map) lookedUp = result;
      else if (result && typeof result === "object") lookedUp = new Map(Object.entries(result));
    } catch (err) {
      logLine(
        `[originalStartDate resolver] fetchOriginalStartDatesForExtensions(${lookupInput.length}) failed (EXTENSION rows stay null): ${String(err?.message || err).slice(0, 200)}`
      );
    }
    for (const item of unresolvedExtensions) {
      const pidStr = String(item.placementId);
      const dateVal = lookedUp.get(pidStr);
      const resolved =
        dateVal == null || dateVal === ""
          ? null
          : formatDateOnlyForSql(dateVal);
      item._row.ORIGINAL_START_DATE = resolved;
      if (resolved != null) extensionFromBqCount++;
      else extensionOrphanCount++;
    }
  } else if (unresolvedExtensions.length > 0) {
    extensionOrphanCount += unresolvedExtensions.length;
  }

  logLine(
    `[originalStartDate resolver] rows=${rows.length} extensionFromBatch=${extensionFromBatchCount} extensionFromBq=${extensionFromBqCount} extensionOrphan=${extensionOrphanCount}`
  );

  return rows;
}

module.exports = {
  resolveOriginalStartDatesForRows,
  pickOriginalStartDateFromBatch,
  dealOriginalStartDateFromRow,
  recordDealInBatchMap,
};
