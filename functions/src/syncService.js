/**
 * Sync Service
 * Main orchestration logic for syncing deal sheet data to BigQuery
 */

const config = require("./config");
const admin = require("firebase-admin");
const { logLine, formatDuration } = require("./logger");
const {
  buildUrl,
  getNexusAccessToken,
  nexusGetJson,
  nexusGetJsonWithRetry,
  nexusFetchAllJsonBatched,
  normalizePagedResponse,
  normalizeNexusResourceId,
  shortUrlForLog,
} = require("./nexusClient");
const {
  insertEnrichedDealSheetBatch,
  insertEnrichedDealSheetBatchRouted,
  insertRateChangeLogBatch,
  insertAdditionalCostLogBatch,
  insertTerminationReasonLogBatch,
  fetchExistingDealSheetIdsSet,
  fetchExistingDealSheetIdsSetAnyActiveTable,
  fetchExistingPlacementIdsSet,
  fetchExistingPlacementIdsSetAnyActiveTable,
  fetchActiveDealSheetUpdateTargets,
  fetchLatestRowsByDealSheetPlacementPairs,
  fetchLatestRowsByDealSheetIds,
  fetchLatestAdditionalCostLogRowsByKeys,
  fetchLatestTerminationReasonLogRowsByKeys,
  fetchContractRateChangePairsFromActive,
  hasBusinessColumnChanges,
  normalizeForCompare,
  resolveFirstInsertPlacementAllowlist,
  placementStatusAllowsFirstInsert,
  buildDealSheetPlacementCompositeKey,
  buildAdditionalCostLogCompositeKey,
  buildTerminationReasonLogCompositeKey,
} = require("./bigQueryClient");
const { startDateOnOrAfterUtcMin, effectiveMinFilterDate, API_OWNED_COLUMNS } = require("./columnMappings");
const { buildEnrichedRowsFromDealSheetCandidates } = require("./api/dealSheetEnricher");
const {
  resolveActiveDealSheetTableId,
  buildActiveDealSheetRoutingSentinel,
  resolveEndedDealSheetTableId,
  buildEndedDealSheetRoutingSentinel,
} = require("./recruiterDomainTables");

function isPositiveInt(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0;
}

function resolveAdditionalCostLogTarget(params = {}) {
  const datasetId =
    typeof params.bq_additional_cost_log_dataset === "string" &&
    params.bq_additional_cost_log_dataset.trim() !== ""
      ? params.bq_additional_cost_log_dataset.trim()
      : config.additionalCostLogDatasetId;
  const tableId =
    typeof params.bq_additional_cost_log_table === "string" &&
    params.bq_additional_cost_log_table.trim() !== ""
      ? params.bq_additional_cost_log_table.trim()
      : config.additionalCostLogTableId;
  return { datasetId, tableId };
}

function resolveTerminationReasonLogTarget(params = {}) {
  const datasetId =
    typeof params.bq_termination_reason_log_dataset === "string" &&
    params.bq_termination_reason_log_dataset.trim() !== ""
      ? params.bq_termination_reason_log_dataset.trim()
      : config.terminationReasonLogDatasetId;
  const tableId =
    typeof params.bq_termination_reason_log_table === "string" &&
    params.bq_termination_reason_log_table.trim() !== ""
      ? params.bq_termination_reason_log_table.trim()
      : config.terminationReasonLogTableId;
  return { datasetId, tableId };
}

/** Numeric tolerance for VALUE comparisons when deciding whether a log row changed. */
const ADDITIONAL_COST_LOG_VALUE_TOLERANCE = 0.01;

function additionalCostLogStringEquals(a, b) {
  const sa = a == null ? "" : String(a).trim();
  const sb = b == null ? "" : String(b).trim();
  return sa === sb;
}

function additionalCostLogValueEquals(a, b) {
  const na = toFloatOrNull(a);
  const nb = toFloatOrNull(b);
  if (na == null && nb == null) return true;
  if (na == null || nb == null) return false;
  // Allow tiny float noise on the boundary itself (e.g. 100.01 - 100 = 0.0100000000005 in IEEE-754).
  return Math.abs(na - nb) <= ADDITIONAL_COST_LOG_VALUE_TOLERANCE + 1e-9;
}

/**
 * Returns true when the incoming log snapshot differs from the latest existing log row
 * on any line-item field worth recording: name, category, duration, notes, or value
 * (VALUE compared with ±0.01 tolerance to absorb API float noise).
 */
function hasAdditionalCostLogChange(incoming, existing) {
  if (!existing) return true;
  if (!additionalCostLogStringEquals(incoming?.ADDITIONAL_COST_NAME, existing?.ADDITIONAL_COST_NAME)) return true;
  if (!additionalCostLogStringEquals(incoming?.CATEGORY, existing?.CATEGORY)) return true;
  if (!additionalCostLogStringEquals(incoming?.DURATION, existing?.DURATION)) return true;
  if (!additionalCostLogStringEquals(incoming?.NOTES, existing?.NOTES)) return true;
  if (!additionalCostLogValueEquals(incoming?.VALUE, existing?.VALUE)) return true;
  return false;
}

function terminationReasonLogStringEquals(a, b) {
  const sa = a == null ? "" : String(a).trim();
  const sb = b == null ? "" : String(b).trim();
  return sa === sb;
}

/**
 * Returns true when incoming termination log differs from latest existing log row.
 */
function hasTerminationReasonLogChange(incoming, existing) {
  if (!existing) return true;
  if (!terminationReasonLogStringEquals(incoming?.VALUE, existing?.VALUE)) return true;
  if (!terminationReasonLogStringEquals(incoming?.NOTES, existing?.NOTES)) return true;
  if (!terminationReasonLogStringEquals(incoming?.CANCELLED_BY, existing?.CANCELLED_BY)) return true;
  if (!terminationReasonLogStringEquals(incoming?.TERMINATION_TYPE, existing?.TERMINATION_TYPE)) return true;
  if (!terminationReasonLogStringEquals(incoming?.DNR_AT, existing?.DNR_AT)) return true;
  if (!terminationReasonLogStringEquals(incoming?.CONTRACT_ID, existing?.CONTRACT_ID)) return true;
  return false;
}

/**
 * Write termination-reason log rows with append-on-change dedupe (no duplicate unchanged snapshots).
 */
async function writeTerminationReasonLogRows(terminationLogRows, insertIdBase, params = {}, options = {}) {
  if (!terminationLogRows || terminationLogRows.length === 0) return { inserted: 0 };

  let rowsToWrite = terminationLogRows;

  const insertedKeys = options.insertedKeys instanceof Set ? options.insertedKeys : null;
  if (insertedKeys) {
    const filtered = [];
    let droppedNotInserted = 0;
    let keptNoCompositeKey = 0;
    for (const row of rowsToWrite) {
      const key = buildDealSheetPlacementCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID);
      if (!key) {
        filtered.push(row);
        keptNoCompositeKey++;
        continue;
      }
      if (insertedKeys.has(key)) {
        filtered.push(row);
      } else {
        droppedNotInserted++;
      }
    }
    rowsToWrite = filtered;
    if (droppedNotInserted > 0 || keptNoCompositeKey > 0) {
      logLine(
        `[termination-reason logs] gate-by-inserted-deal-sheets: droppedNotInserted=${droppedNotInserted} keptNoCompositeKey=${keptNoCompositeKey} remaining=${rowsToWrite.length}`
      );
    }
  }

  if (rowsToWrite.length === 0) {
    logLine(`[termination-reason logs] SKIP: no rows survive inserted-deal-sheet gate`);
    return { inserted: 0 };
  }

  try {
    const logTarget = resolveTerminationReasonLogTarget(params);

    let latestByKey;
    try {
      latestByKey = await fetchLatestTerminationReasonLogRowsByKeys(rowsToWrite, {
        datasetId: logTarget.datasetId,
        tableId: logTarget.tableId,
      });
    } catch (err) {
      logLine(
        `[termination-reason logs] latest-fetch failed; falling back to insert-without-compare: ${err?.message || err}`
      );
      latestByKey = new Map();
    }

    const filtered = [];
    let unchangedSkipped = 0;
    let newIncluded = 0;
    let changedIncluded = 0;
    for (const row of rowsToWrite) {
      const key = buildTerminationReasonLogCompositeKey(row?.PLACEMENT_ID, row?.TERMINATION_DETAIL_ID);
      if (!key) {
        filtered.push(row);
        newIncluded++;
        continue;
      }
      const existing = latestByKey.get(key);
      if (!existing) {
        filtered.push(row);
        newIncluded++;
        continue;
      }
      if (hasTerminationReasonLogChange(row, existing)) {
        filtered.push(row);
        changedIncluded++;
      } else {
        unchangedSkipped++;
      }
    }
    rowsToWrite = filtered;
    logLine(
      `[termination-reason logs] append-on-change: newIncluded=${newIncluded} changedIncluded=${changedIncluded} unchangedSkipped=${unchangedSkipped} remaining=${rowsToWrite.length}`
    );

    if (rowsToWrite.length === 0) {
      logLine(`[termination-reason logs] SKIP: no rows changed vs latest log snapshot`);
      return { inserted: 0 };
    }

    const result = await insertTerminationReasonLogBatch(rowsToWrite, insertIdBase, {
      datasetId: logTarget.datasetId,
      tableId: logTarget.tableId,
      generatedUuidField: "ID",
    });
    return result;
  } catch (err) {
    logLine(`[termination-reason logs] write failed (non-fatal): ${err?.message || err}`);
    return { inserted: 0, errorBatches: 1 };
  }
}

/**
 * Write additional-cost log rows with two gates:
 *   1. (Optional) `insertedKeys` Set — only keep rows whose DEAL_SHEET_ID|PLACEMENT_ID
 *      matches a deal sheet that the caller actually inserted/appended in this run.
 *   2. Compare each remaining row to the latest existing log row in BigQuery (by
 *      DEAL_SHEET_ID + PLACEMENT_ID + ADDITIONAL_COST_ID) and skip when nothing
 *      meaningful changed (see `hasAdditionalCostLogChange`).
 */
async function writeAdditionalCostLogRows(additionalCostLogRows, insertIdBase, params = {}, options = {}) {
  if (!additionalCostLogRows || additionalCostLogRows.length === 0) return { inserted: 0 };

  let rowsToWrite = additionalCostLogRows;

  const insertedKeys = options.insertedKeys instanceof Set ? options.insertedKeys : null;
  if (insertedKeys) {
    const filtered = [];
    let droppedNotInserted = 0;
    let keptNoCompositeKey = 0;
    for (const row of rowsToWrite) {
      const key = buildDealSheetPlacementCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID);
      if (!key) {
        filtered.push(row);
        keptNoCompositeKey++;
        continue;
      }
      if (insertedKeys.has(key)) {
        filtered.push(row);
      } else {
        droppedNotInserted++;
      }
    }
    rowsToWrite = filtered;
    if (droppedNotInserted > 0 || keptNoCompositeKey > 0) {
      logLine(
        `[additional-cost logs] gate-by-inserted-deal-sheets: droppedNotInserted=${droppedNotInserted} keptNoCompositeKey=${keptNoCompositeKey} remaining=${rowsToWrite.length}`
      );
    }
  }

  if (rowsToWrite.length === 0) {
    logLine(`[additional-cost logs] SKIP: no rows survive inserted-deal-sheet gate`);
    return { inserted: 0 };
  }

  try {
    const logTarget = resolveAdditionalCostLogTarget(params);

    let latestByKey;
    try {
      latestByKey = await fetchLatestAdditionalCostLogRowsByKeys(rowsToWrite, {
        datasetId: logTarget.datasetId,
        tableId: logTarget.tableId,
      });
    } catch (err) {
      logLine(
        `[additional-cost logs] latest-fetch failed; falling back to insert-without-compare: ${err?.message || err}`
      );
      latestByKey = new Map();
    }

    const filtered = [];
    let unchangedSkipped = 0;
    let newIncluded = 0;
    let changedIncluded = 0;
    for (const row of rowsToWrite) {
      const key = buildAdditionalCostLogCompositeKey(
        row?.DEAL_SHEET_ID,
        row?.PLACEMENT_ID,
        row?.ADDITIONAL_COST_ID
      );
      if (!key) {
        filtered.push(row);
        newIncluded++;
        continue;
      }
      const existing = latestByKey.get(key);
      if (!existing) {
        filtered.push(row);
        newIncluded++;
        continue;
      }
      if (hasAdditionalCostLogChange(row, existing)) {
        filtered.push(row);
        changedIncluded++;
      } else {
        unchangedSkipped++;
      }
    }
    rowsToWrite = filtered;
    logLine(
      `[additional-cost logs] append-on-change: newIncluded=${newIncluded} changedIncluded=${changedIncluded} unchangedSkipped=${unchangedSkipped} remaining=${rowsToWrite.length}`
    );

    if (rowsToWrite.length === 0) {
      logLine(`[additional-cost logs] SKIP: no rows changed vs latest log snapshot`);
      return { inserted: 0 };
    }

    const result = await insertAdditionalCostLogBatch(rowsToWrite, insertIdBase, {
      datasetId: logTarget.datasetId,
      tableId: logTarget.tableId,
      generatedUuidField: "ID",
    });
    return result;
  } catch (err) {
    logLine(`[additional-cost logs] write failed (non-fatal): ${err?.message || err}`);
    return { inserted: 0, errorBatches: 1 };
  }
}

/** BigQuery INT64: use finite integer or null */
function toInt64OrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** BigQuery FLOAT64: finite number or null */
function toFloatOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(n) ? n : null;
}

function toRateChangeEffectiveDate(row) {
  const dt = row?.DATE_AND_TIME;
  if (dt == null) return null;
  if (dt instanceof Date) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof dt === "object" && dt.value != null) {
    const s = String(dt.value);
    return s.length >= 10 ? s.slice(0, 10) : null;
  }
  const s = String(dt);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function numDiff(newVal, oldVal) {
  const n = toFloatOrNull(newVal);
  const o = toFloatOrNull(oldVal);
  if (n == null || o == null) return null;
  return n - o;
}

/**
 * Map deal-sheet row columns into OLD_* or NEW_* rate snapshot fields on the log row.
 * @param {object|null} row
 * @param {"OLD_"|"NEW_"} prefix
 */
function extractRateSnapshotFields(row, prefix) {
  if (!row) {
    return {
      [`${prefix}GUARANTEED_HOURS`]: null,
      [`${prefix}INITIAL_PROJECT_DURATION_IN_WEEKS`]: null,
      [`${prefix}ORIENTATION_HOURS`]: null,
      [`${prefix}ADDITIONAL_BONUS`]: null,
      [`${prefix}PAY_RATE`]: null,
      [`${prefix}WEEKLY_PER_DIEM`]: null,
      [`${prefix}W2_PAY_RATE`]: null,
      [`${prefix}FINAL_PAY_RATE`]: null,
      [`${prefix}FINAL_COST`]: null,
      [`${prefix}BILL_RATE`]: null,
      [`${prefix}FINAL_BILL_RATE`]: null,
      [`${prefix}NET_MARGIN`]: null,
      [`${prefix}GROSS_MARGIN`]: null,
      [`${prefix}CLIENT_MSP_FEE`]: null,
      [`${prefix}GM_BASED_ON_NEW_LOADING_COST`]: null,
    };
  }
  return {
    [`${prefix}GUARANTEED_HOURS`]: toFloatOrNull(row.GUARANTEED_HOURS),
    [`${prefix}INITIAL_PROJECT_DURATION_IN_WEEKS`]: toFloatOrNull(row.INITIAL_PROJECT_DURATION_IN_WEEKS),
    [`${prefix}ORIENTATION_HOURS`]: toFloatOrNull(row.ORIENTATION_HOURS),
    [`${prefix}ADDITIONAL_BONUS`]: toFloatOrNull(row.ADDITIONAL_BONUS),
    [`${prefix}PAY_RATE`]: toFloatOrNull(row.PAY_RATE),
    [`${prefix}WEEKLY_PER_DIEM`]: toFloatOrNull(row.WEEKLY_PER_DIEM_NON_TAXED),
    [`${prefix}W2_PAY_RATE`]: toFloatOrNull(row.W2_PAY_RATE),
    [`${prefix}FINAL_PAY_RATE`]: toFloatOrNull(row.FINAL_PAY_RATE),
    [`${prefix}FINAL_COST`]: toFloatOrNull(row.FINAL_COST),
    [`${prefix}BILL_RATE`]: toFloatOrNull(row.BILL_RATE),
    [`${prefix}FINAL_BILL_RATE`]: toFloatOrNull(row.FINAL_BILL_RATE),
    [`${prefix}NET_MARGIN`]: toFloatOrNull(row.NET_MARGIN),
    [`${prefix}GROSS_MARGIN`]: toFloatOrNull(row.GROSS_MARGIN),
    [`${prefix}CLIENT_MSP_FEE`]: toFloatOrNull(row.CLIENT_MSP_FEE),
    [`${prefix}GM_BASED_ON_NEW_LOADING_COST`]: toFloatOrNull(row.NEW_MARGIN),
  };
}

/**
 * Build wide rate-change log row from BigQuery latest (and optional previous) deal-sheet snapshots.
 * @param {object} latestRow
 * @param {object|null} previousRow
 */
function buildRateChangeLogRow(latestRow, previousRow = null) {
  const oldSnap = extractRateSnapshotFields(previousRow, "OLD_");
  const newSnap = extractRateSnapshotFields(latestRow, "NEW_");

  return {
    RATE_CHANGE: "YES",
    SKU_NUMBER: latestRow?.SKU_NUMBER ?? null,
    CONTRACT_ID: toInt64OrNull(latestRow?.CONTRACT_ID),
    CANDIDATE_NAME: latestRow?.CANDIDATE_NAME ?? null,
    RATE_CHANGE_EFFECTIVE_DATE: toRateChangeEffectiveDate(latestRow),
    PLACEMENT_STATUS: latestRow?.PLACEMENT_STATUS ?? null,
    START_DATE: latestRow?.START_DATE ?? null,
    END_DATE: latestRow?.END_DATE ?? null,
    RECRUITER: latestRow?.ASSIGNMENT_RECRUITER ?? null,
    RECRUITER_EMAIL_ID: latestRow?.ASSIGNMENT_RECRUITER_EMAIL ?? null,
    ACCOUNT_MANAGER: latestRow?.ACCOUNT_MANAGER ?? null,
    SECONDARY_AM: latestRow?.SECONDARY_AM ?? null,
    ASSOCIATE_AM: latestRow?.ASSOCIATE_AM ?? null,
    RM: latestRow?.RM ?? null,
    TEAM_LEAD: latestRow?.TEAM_LEAD ?? null,
    ATL: latestRow?.ATL ?? null,
    MSP: latestRow?.MSP_NAME ?? null,
    END_CLIENT_DEPT_FACILITY: latestRow?.END_CLIENT_DEPT_FACILITY ?? null,
    ...oldSnap,
    ...newSnap,
    GM_DIFFERENCE: numDiff(newSnap.NEW_GROSS_MARGIN, oldSnap.OLD_GROSS_MARGIN),
    BR_DIFFERENCE: numDiff(newSnap.NEW_BILL_RATE, oldSnap.OLD_BILL_RATE),
    PROFIT_DIFFERENCE: numDiff(newSnap.NEW_NET_MARGIN, oldSnap.OLD_NET_MARGIN),
    DELIVERY_POC: latestRow?.DELIVERY_POC ?? null,
    ONSITE_MANAGER: latestRow?.ONSITE_AM ?? null,
    CLIENT_STATE: latestRow?.CLIENT_STATE ?? null,
  };
}

function getCheckpointRef(key) {
  const collection = config.backfill?.checkpointCollection || "dealSheetSyncCheckpoints";
  return admin.firestore().collection(collection).doc(String(key));
}

/**
 * Parse `page` from Nexus job-submittals list URL (checkpoint must match API cursor, not loop counter).
 * @param {string} urlString
 * @returns {number|null}
 */
function parseJobSubmittalsPageQueryFromUrl(urlString) {
  if (urlString == null || typeof urlString !== "string" || String(urlString).trim() === "") return null;
  const raw = String(urlString).trim();
  try {
    const base = String(config.nexus.baseUrl || "").replace(/\/$/, "");
    const abs = /^https?:\/\//i.test(raw) ? raw : `${base}${raw.startsWith("/") ? "" : "/"}${raw}`;
    const u = new URL(abs);
    if (!u.pathname.includes("job-submittals")) return null;
    const p = u.searchParams.get("page");
    if (p == null || String(p).trim() === "") return null;
    const n = parseInt(String(p).trim(), 10);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
  } catch {
    return null;
  }
}

/** Next Nexus list `page` after this request (from `next` URL, or current+1). */
function resolveNextNexusSubmittalsPageForCheckpoint(requestUrl, nextListUrl, hasMorePages) {
  if (!hasMorePages) return null;
  const fromNext = parseJobSubmittalsPageQueryFromUrl(nextListUrl);
  if (fromNext != null) return fromNext;
  const cur = parseJobSubmittalsPageQueryFromUrl(requestUrl);
  if (cur != null) return cur + 1;
  return null;
}

/** Compare submittal CSV values regardless of order / case */
function normalizeSubmittalCodesForCompare(csv) {
  return String(csv || "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

/** Effective deal-sheet status for filtering (code wins over label, same as API semantics). */
function dealSheetCandidateEffectiveStatusKey(candidate) {
  const raw =
    candidate?.deal_sheet_status_code ??
    candidate?.deal_sheet_status ??
    "";
  return String(raw).trim().toUpperCase();
}

function normalizeDealSheetStatusCode(value) {
  return String(value || "").trim().toUpperCase();
}

function parseAllowedDealSheetStatusCodes(csvValue) {
  const out = new Set();
  for (const raw of String(csvValue || "").split(",")) {
    const key = normalizeDealSheetStatusCode(raw);
    if (key) out.add(key);
  }
  if (out.size === 0) out.add("FINAL");
  return out;
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const key = String(value || "").trim().toLowerCase();
  if (!key) return null;
  if (["1", "true", "yes", "y", "on"].includes(key)) return true;
  if (["0", "false", "no", "n", "off"].includes(key)) return false;
  return null;
}

function resolvePreferredCandidateRow(candidateRows, preferredCandidateId, preferredDealSheetId) {
  if (!Array.isArray(candidateRows) || candidateRows.length === 0) return null;
  const prefCand = normalizeNexusResourceId(preferredCandidateId);
  const prefDs = normalizeNexusResourceId(preferredDealSheetId);

  for (const row of candidateRows) {
    const cand = normalizeNexusResourceId(row?.candidate);
    const ds = normalizeNexusResourceId(row?.deal_sheet);
    if (prefCand && cand && prefCand === cand && prefDs && ds && prefDs === ds) return row;
  }
  for (const row of candidateRows) {
    const cand = normalizeNexusResourceId(row?.candidate);
    if (prefCand && cand && prefCand === cand) return row;
  }
  for (const row of candidateRows) {
    const ds = normalizeNexusResourceId(row?.deal_sheet);
    if (prefDs && ds && prefDs === ds) return row;
  }
  return candidateRows[0];
}

function computeChangedFields(incomingRow, existingRow, ignoreFields) {
  const out = [];
  if (!existingRow) return out;
  const ignore = new Set((ignoreFields || []).map((x) => String(x).trim()).filter(Boolean));
  for (const key of API_OWNED_COLUMNS) {
    if (ignore.has(key)) continue;
    const nextVal = normalizeForCompare(incomingRow?.[key]);
    const prevVal = normalizeForCompare(existingRow?.[key]);
    if (nextVal !== prevVal) out.push(key);
  }
  return out.sort();
}

async function fetchSubmittalByPlacementId(accessToken, placementId) {
  const pid = normalizeNexusResourceId(placementId);
  if (!pid) return null;
  const url = `${config.nexus.baseUrl}/api/job-submittals/${encodeURIComponent(pid)}/`;
  try {
    return await nexusGetJson(url, accessToken);
  } catch (err) {
    logLine(
      `[placement refresh] submittal detail lookup failed placement_id=${pid}: ${String(err?.message || err).slice(0, 180)}`
    );
    return null;
  }
}

async function resolveRefreshSeed(accessToken, params = {}) {
  const placementId = normalizeNexusResourceId(params.placement_id);
  const explicitDealSheetId = normalizeNexusResourceId(params.deal_sheet_id);
  const explicitJobId = normalizeNexusResourceId(params.job_id);
  const explicitCandidateId = normalizeNexusResourceId(params.candidate_id);

  let submittalRow = null;
  if (placementId) submittalRow = await fetchSubmittalByPlacementId(accessToken, placementId);

  const jobId =
    normalizeNexusResourceId(submittalRow?.job) ??
    explicitJobId ??
    null;
  const candidateId =
    normalizeNexusResourceId(submittalRow?.candidate) ??
    explicitCandidateId ??
    null;

  let dealSheetId = explicitDealSheetId || null;
  let preferredCandidateRow = null;
  if (jobId) {
    const byJob = await fetchDealSheetCandidatesByJobIdsParallel([jobId], accessToken, "FINAL,VERBAL");
    const rows = byJob.get(String(jobId)) || [];
    preferredCandidateRow = resolvePreferredCandidateRow(rows, candidateId, explicitDealSheetId);
    dealSheetId = normalizeNexusResourceId(preferredCandidateRow?.deal_sheet) || dealSheetId;
  }

  return {
    placementId: placementId || normalizeNexusResourceId(submittalRow?.id),
    jobId,
    candidateId,
    dealSheetId,
    submittalRow,
    preferredCandidateRow,
  };
}

/**
 * Summary of ch_additional_cost_logs writes for refreshPlacementRecordToBigQuery responses.
 * Includes the full enriched cost rows so callers can see name/value/category/notes per line item.
 * @param {string} action
 * @param {object[]} additionalCostLogRows
 * @param {{ inserted?: number, errorBatches?: number }|null|undefined} logResult
 * @returns {{ attempted: number, inserted: number, errorBatches?: number, skipped_reason?: string, rows: object[] }}
 */
function buildRefreshAdditionalCostLogsSummary(action, additionalCostLogRows, logResult) {
  const rows = Array.isArray(additionalCostLogRows) ? additionalCostLogRows : [];
  const attempted = rows.length;
  if (action === "INSERTED" && logResult) {
    return {
      attempted,
      inserted: logResult.inserted ?? 0,
      errorBatches: logResult.errorBatches ?? 0,
      rows,
    };
  }
  if (attempted > 0 && action !== "INSERTED") {
    return { attempted, inserted: 0, skipped_reason: "not inserted", rows };
  }
  return { attempted, inserted: 0, errorBatches: 0, rows };
}

function buildRefreshTerminationReasonLogsSummary(action, terminationLogRows, logResult) {
  const rows = Array.isArray(terminationLogRows) ? terminationLogRows : [];
  const attempted = rows.length;
  if (action === "INSERTED" && logResult) {
    return {
      attempted,
      inserted: logResult.inserted ?? 0,
      errorBatches: logResult.errorBatches ?? 0,
      rows,
    };
  }
  if (attempted > 0 && action !== "INSERTED") {
    return { attempted, inserted: 0, skipped_reason: "not inserted", rows };
  }
  return { attempted, inserted: 0, errorBatches: 0, rows };
}

async function refreshPlacementRecordToBigQuery(params = {}) {
  const startMs = Date.now();
  const compareIgnoreFields = Array.isArray(params.compare_ignore_fields)
    ? params.compare_ignore_fields
    : ["ID", "DATE_AND_TIME", "IS_REJECTED"];
  const generatedUuidField =
    typeof params.generated_uuid_field === "string" && params.generated_uuid_field.trim() !== ""
      ? params.generated_uuid_field.trim()
      : "ID";
  const effectiveDatasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : "rr_project_data";
  const applyUpdateToggle = parseBooleanLike(params.apply_update);
  const applyUpdate = applyUpdateToggle == null ? true : applyUpdateToggle;

  const accessToken = await getNexusAccessToken();
  const seed = await resolveRefreshSeed(accessToken, params);

  if (!seed.jobId || !seed.preferredCandidateRow || !seed.dealSheetId) {
    return {
      action: "NOT_FOUND",
      inserted: 0,
      attempted: 0,
      diff_fields: [],
      reason: "Unable to resolve candidate/deal-sheet from provided identifiers",
      resolved_ids: {
        placement_id: seed.placementId || null,
        job_id: seed.jobId || null,
        candidate_id: seed.candidateId || null,
        deal_sheet_id: seed.dealSheetId || null,
      },
      data: null,
      elapsed: formatDuration(Date.now() - startMs),
    };
  }

  const preloadedSubmittals = new Map();
  if (seed.jobId && seed.candidateId && seed.submittalRow) {
    preloadedSubmittals.set(`${seed.jobId}:${seed.candidateId}`, seed.submittalRow);
  }

  const { rows: enrichedRows, additionalCostLogRows, terminationLogRows } =
    await buildEnrichedRowsFromDealSheetCandidates(
      [seed.preferredCandidateRow],
      preloadedSubmittals,
      {
        allowedSubmittalCodes: params.organization_submittal_status_code || config.submittalStatusCodes,
        persistDealSheetStatusFromCandidate: true,
        fetchTerminationDetails: true,
      }
    );
  const row = enrichedRows[0] || null;
  if (!row) {
    return {
      action: "NOT_FOUND",
      inserted: 0,
      attempted: 0,
      diff_fields: [],
      reason: "Enrichment returned no row",
      resolved_ids: {
        placement_id: seed.placementId || null,
        job_id: seed.jobId || null,
        candidate_id: seed.candidateId || null,
        deal_sheet_id: seed.dealSheetId || null,
      },
      data: null,
      elapsed: formatDuration(Date.now() - startMs),
    };
  }

  const minStartDateMs =
    params.min_start_date_ms != null && Number.isFinite(Number(params.min_start_date_ms))
      ? Number(params.min_start_date_ms)
      : null;
  if (minStartDateMs != null && !startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), minStartDateMs)) {
    return {
      action: "SKIPPED_DATE",
      inserted: 0,
      attempted: 0,
      diff_fields: [],
      reason: "START_DATE before minimum",
      resolved_ids: {
        placement_id: seed.placementId || normalizeNexusResourceId(row?.PLACEMENT_ID) || null,
        job_id: seed.jobId || null,
        candidate_id: seed.candidateId || null,
        deal_sheet_id: seed.dealSheetId || null,
      },
      data: row,
      elapsed: formatDuration(Date.now() - startMs),
    };
  }

  const explicitBqTable = typeof params.bq_table === "string" && params.bq_table.trim() !== "";
  const effectiveTableId = explicitBqTable
    ? params.bq_table.trim()
    : resolveActiveDealSheetTableId(row.ASSIGNMENT_RECRUITER_EMAIL);

  const baselineScope =
    String(params.baseline_scope || "composite").trim().toLowerCase() === "deal_sheet_id"
      ? "deal_sheet_id"
      : "composite";
  const updateOnlyExisting = params.update_only_existing === true;

  let baseline = null;
  if (baselineScope === "deal_sheet_id") {
    const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
    if (dsid) {
      const byDs = await fetchLatestRowsByDealSheetIds([dsid], {
        datasetId: effectiveDatasetId,
        tableId: effectiveTableId,
      });
      baseline = byDs.get(dsid) || null;
    }
  } else {
    const baselineMap = await fetchLatestRowsByDealSheetPlacementPairs([row], {
      datasetId: effectiveDatasetId,
      tableId: effectiveTableId,
    });
    const compositeKey = `${String(row.DEAL_SHEET_ID || "").trim()}|${String(row.PLACEMENT_ID || "").trim()}`;
    baseline = baselineMap.get(compositeKey) || null;
  }

  const changed = hasBusinessColumnChanges(row, baseline, new Set(compareIgnoreFields));
  const diffFields = computeChangedFields(row, baseline, compareIgnoreFields);
  const allowFirstInsert = placementStatusAllowsFirstInsert(
    row?.PLACEMENT_STATUS,
    resolveFirstInsertPlacementAllowlist({
      first_insert_placement_status_allowlist: params.first_insert_placement_status_allowlist,
    })
  );

  let insertResult = { inserted: 0, attempted: 0, errorBatches: 0 };
  let action = "NO_CHANGE";
  let reason = "No business field changes";

  if (updateOnlyExisting && !baseline) {
    action = "NO_BASELINE";
    reason = "No existing BigQuery row for deal sheet (update-only)";
  } else if (!baseline && !allowFirstInsert) {
    action = "NO_CHANGE";
    reason = "First insert blocked by placement status allowlist";
  } else if (applyUpdate && updateOnlyExisting && baseline && changed) {
    insertResult = await insertEnrichedDealSheetBatch([row], 0, {
      appendOnChangeByDealSheet: true,
      compareIgnoreFields,
      generatedUuidField,
      datasetId: effectiveDatasetId,
      tableId: effectiveTableId,
    });
    if (insertResult.inserted > 0) {
      action = "INSERTED";
      reason = "Business fields changed and appended";
    } else {
      action = "NO_CHANGE";
      reason = "Insert pipeline filtered row";
    }
  } else if (applyUpdate && !updateOnlyExisting && (changed || !baseline)) {
    insertResult = await insertEnrichedDealSheetBatch([row], 0, {
      appendOnChangeByDealSheet: true,
      compareIgnoreFields,
      generatedUuidField,
      datasetId: effectiveDatasetId,
      tableId: effectiveTableId,
      first_insert_placement_status_allowlist: params.first_insert_placement_status_allowlist,
    });
    if (insertResult.inserted > 0) {
      action = "INSERTED";
      reason = baseline ? "Business fields changed and appended" : "Inserted new baseline row";
    } else {
      action = "NO_CHANGE";
      reason = "Insert pipeline filtered row";
    }
  } else if (!applyUpdate && (changed || !baseline)) {
    action = "PREVIEW_CHANGE";
    reason = "Changes found (preview only, no write)";
  }

  let additionalCostLogWriteResult = null;
  if (action === "INSERTED" && additionalCostLogRows.length > 0) {
    additionalCostLogWriteResult = await writeAdditionalCostLogRows(additionalCostLogRows, 0, params, {
      insertedKeys: insertResult.insertedKeys instanceof Set ? insertResult.insertedKeys : new Set(),
    });
  }

  let terminationReasonLogWriteResult = null;
  if (action === "INSERTED" && terminationLogRows.length > 0) {
    terminationReasonLogWriteResult = await writeTerminationReasonLogRows(terminationLogRows, 0, params, {
      insertedKeys: insertResult.insertedKeys instanceof Set ? insertResult.insertedKeys : new Set(),
    });
  }

  return {
    action,
    reason,
    inserted: insertResult.inserted,
    attempted: insertResult.attempted,
    errorBatches: insertResult.errorBatches,
    diff_fields: diffFields,
    additional_cost_logs: buildRefreshAdditionalCostLogsSummary(
      action,
      additionalCostLogRows,
      additionalCostLogWriteResult
    ),
    termination_reason_logs: buildRefreshTerminationReasonLogsSummary(
      action,
      terminationLogRows,
      terminationReasonLogWriteResult
    ),
    resolved_ids: {
      placement_id: seed.placementId || normalizeNexusResourceId(row?.PLACEMENT_ID) || null,
      job_id: seed.jobId || normalizeNexusResourceId(seed.preferredCandidateRow?.job) || null,
      candidate_id: seed.candidateId || normalizeNexusResourceId(seed.preferredCandidateRow?.candidate) || null,
      deal_sheet_id: seed.dealSheetId || normalizeNexusResourceId(seed.preferredCandidateRow?.deal_sheet) || null,
    },
    data: row,
    elapsed: formatDuration(Date.now() - startMs),
  };
}

/**
 * Why a deal-sheet-candidate row was excluded from sync (for logs).
 * @returns {"EMPTY_STATUS"|"NOT_ALLOWED_STATUS"|null} null if row passes status filter
 */
function dealSheetCandidateExcludeReason(candidate, allowedStatusKeys) {
  const key = dealSheetCandidateEffectiveStatusKey(candidate);
  if (!key) return "EMPTY_STATUS";
  if (allowedStatusKeys.has(key)) return null;
  return "NOT_ALLOWED_STATUS";
}

/**
 * Fetch deal-sheet-candidates for multiple job_ids in parallel (tolerates individual failures)
 */
async function fetchDealSheetCandidatesByJobIdsParallel(jobIds, accessToken, dealSheetStatusCodesCsv = "FINAL") {
  if (!jobIds || jobIds.length === 0) return new Map();
  const requestedCodes = String(dealSheetStatusCodesCsv || "").trim() || "FINAL";

  const urls = jobIds.map((jobId) =>
    buildUrl(`${config.nexus.baseUrl}/api/deal-sheet-candidates/`, {
      job_id: String(jobId),
      deal_sheet_status_code: requestedCodes,
      page: 1,
      per_page: 1000,
    })
  );

  let responses;
  let failedJobIds = [];
  try {
    responses = await nexusFetchAllJsonBatched(urls, accessToken);
  } catch (err) {
    logLine(`[enriched sync] WARN: nexusFetchAllJsonBatched threw error, attempting individual fallback: ${String(err.message || err).slice(0, 200)}`);
    responses = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        const resp = await nexusGetJson(urls[i], accessToken);
        responses.push(resp);
      } catch (e) {
        logLine(`[enriched sync] SKIP job_id=${jobIds[i]} due to persistent error: ${String(e.message || e).slice(0, 150)}`);
        responses.push({ results: [] });
        failedJobIds.push(jobIds[i]);
      }
    }
  }

  const result = new Map();
  for (let i = 0; i < jobIds.length; i++) {
    const jobId = String(jobIds[i]);
    const normalized = normalizePagedResponse(responses[i] || {});
    result.set(jobId, normalized.items || []);
  }

  if (failedJobIds.length > 0) {
    logLine(`[enriched sync] SUMMARY: skipped ${failedJobIds.length} job(s) due to Nexus errors, continuing with ${jobIds.length - failedJobIds.length} successful`);
  }

  return result;
}

/**
 * Main sync function: job-submittals first -> deal-sheet-candidates -> enrich -> BigQuery
 *
 * Optional Firestore pagination checkpoint: set resume_from_checkpoint and checkpoint_key.
 * clear_checkpoint_on_complete: after a full successful run, delete the checkpoint doc so the
 * next scheduled invocation rescans from page 1 (avoids done=true skipping all pages).
 * use_ended_domain_routing: route BigQuery writes to ended domain tables (no bq_table).
 * checkpoint_use_submittal_page: persist next Nexus job-submittals page in Firestore (with resume).
 */
async function syncEnrichedDealSheetCandidatesToBigQuery(params = {}) {
  const onlyNewDealSheets = params.only_new_deal_sheets === true;
  const skipExistingDealSheetOrPlacement =
    params.skip_existing_deal_sheet_or_placement === true || onlyNewDealSheets;
  const rejectIfExistingDealSheetOrPlacement = params.reject_if_existing_deal_sheet_or_placement === true;
  const dedupeByPlacementId = params.dedupe_by_placement_id === true;
  const skipDidNotAcceptIfAlreadyDidNotAccept = params.skip_did_not_accept_existing === true;
  const maxCandidatesRaw = params.max_candidates;
  const maxCandidates = isPositiveInt(maxCandidatesRaw) ? Math.floor(Number(maxCandidatesRaw)) : 0;

  const testSubmittalLimit = isPositiveInt(params.test_submittal_limit)
    ? Math.floor(Number(params.test_submittal_limit))
    : 0;

  const maxPagesRequested = isPositiveInt(params.max_pages) ? Math.floor(Number(params.max_pages)) : 0;
  const maxPagesProvided = params.max_pages_provided === true;
  const resumeFromCheckpoint = params.resume_from_checkpoint === true;
  const resetCheckpoint = params.reset_checkpoint === true;
  const checkpointKey = String(params.checkpoint_key || config.backfill?.checkpointKey || "active-records-default");
  /** When true, a fully finished run deletes the checkpoint doc so the next invocation scans from page 1 (recurring schedules). */
  const clearCheckpointOnComplete = params.clear_checkpoint_on_complete === true;
  const maxPages = maxPagesProvided && maxPagesRequested > 0 ? maxPagesRequested : 0;

  const allowedSubmittalCodes = params.organization_submittal_status_code || config.submittalStatusCodes;
  const dealSheetStatusCodesCsv = String(params.deal_sheet_status_codes || "FINAL").trim() || "FINAL";
  const allowedDealSheetStatusKeys = parseAllowedDealSheetStatusCodes(dealSheetStatusCodesCsv);
  const includeVerbalDealSheets = allowedDealSheetStatusKeys.has("VERBAL");
  const effectiveDatasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : config.datasetId;
  const explicitBqTable =
    typeof params.bq_table === "string" && params.bq_table.trim() !== "";
  const useEndedDomainRouting = params.use_ended_domain_routing === true && !explicitBqTable;
  const skipContractId = params.skip_contract_id === true || useEndedDomainRouting;
  const checkpointUseSubmittalPage = params.checkpoint_use_submittal_page === true;
  const effectiveTableId = explicitBqTable ? params.bq_table.trim() : config.tableId;
  const bqWriteOptions = { datasetId: effectiveDatasetId, tableId: effectiveTableId };
  const generatedUuidField =
    typeof params.generated_uuid_field === "string" && params.generated_uuid_field.trim() !== ""
      ? params.generated_uuid_field.trim()
      : "";
  const appendOnChangeByDealSheet = params.append_on_change_by_dealsheet === true;
  const compareIgnoreFields = Array.isArray(params.compare_ignore_fields)
    ? params.compare_ignore_fields
    : ["ID", "DATE_AND_TIME", "IS_REJECTED"];
  const firstInsertPlacementStatusAllowlist = params.first_insert_placement_status_allowlist;
  const tableFqn = explicitBqTable
    ? `${config.projectId}.${effectiveDatasetId}.${effectiveTableId}`
    : useEndedDomainRouting
      ? buildEndedDealSheetRoutingSentinel(config.projectId, effectiveDatasetId)
      : buildActiveDealSheetRoutingSentinel(config.projectId, effectiveDatasetId);
  const insertRoutedResolveTableId = useEndedDomainRouting
    ? (row) => resolveEndedDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL)
    : undefined;
  const transformRowsFn = typeof params.transform_rows_fn === "function" ? params.transform_rows_fn : null;
  const insertBatchFn =
    typeof params.insert_batch_fn === "function"
      ? params.insert_batch_fn
      : explicitBqTable
        ? insertEnrichedDealSheetBatch
        : insertEnrichedDealSheetBatchRouted;

  const followNextPage = params.follow_next_page !== false;
  const perPage = testSubmittalLimit > 0 ? testSubmittalLimit : config.perPage;
  const enrichBatchSizeRaw = isPositiveInt(params.enrich_batch_size)
    ? Math.floor(Number(params.enrich_batch_size))
    : config.enrichBatchSize;
  const enrichBatchSize = isPositiveInt(enrichBatchSizeRaw)
    ? Math.min(Math.floor(Number(enrichBatchSizeRaw)), config.batchSize)
    : config.batchSize;

  const submittalBasePath = "/api/job-submittals/";
  const urlQuery = {
    organization_submittal_status_code: allowedSubmittalCodes,
    per_page: perPage,
    page: 1,
  };

  const url = buildUrl(`${config.nexus.baseUrl}${submittalBasePath}`, urlQuery);
  const startMs = Date.now();

  logLine(
    `[enriched sync] === syncEnrichedDealSheetCandidatesToBigQuery START === table=${tableFqn} submittalCodes=${allowedSubmittalCodes} dealSheetStatusCodes=${dealSheetStatusCodesCsv} followNextPage=${followNextPage} onlyNewDealSheets=${onlyNewDealSheets} dedupeByPlacementId=${dedupeByPlacementId} skipDidNotAcceptIfAlreadyDidNotAccept=${skipDidNotAcceptIfAlreadyDidNotAccept} skipContractId=${skipContractId ? "true" : "false"} maxStreamRows=${maxCandidates || "none"} maxSubmittalPages=${maxPages || "none"} testSubmittalLimit=${testSubmittalLimit || "none"} batchSize=${config.batchSize} enrichBatchSize=${enrichBatchSize} fetchAllMax=${config.fetchAllMax} batchDelayMs=${config.batchDelayMs}`
  );

  logLine(
    `[enriched sync] LIST PARAMS: organization_submittal_status_code=${allowedSubmittalCodes} page=1 per_page=${perPage} modified_date_from=none`
  );

  logLine(
    `[enriched sync] PIPELINE: (1) auth -> (2) GET job-submittals (pagination ${followNextPage ? "ON" : "OFF"}) -> (3) GET deal-sheet-candidates by job_id -> (4) enrich batches -> (5) BigQuery insertAll`
  );

  logLine(
    `[enriched sync] DEAL_SHEET_CANDIDATES RULE: Nexus query uses deal_sheet_status_code=${dealSheetStatusCodesCsv}; rows excluded when status is empty or not in allowed set (${Array.from(allowedDealSheetStatusKeys).join(",")})`
  );

  logLine("[enriched sync] STEP 1/5 AUTH: Nexus — getNexusAccessToken()");
  const accessToken = await getNexusAccessToken();
  logLine("[enriched sync] STEP 1/5 AUTH: OK");

  let totalCandidatesProcessed = 0;
  let totalRowsInserted = 0;
  let errorBatches = 0;
  let hasMore = false;

  let nextUrl = url;
  let checkpointNextUrl = null;
  let globalIndex = 0;
  let buffer = [];
  let pageNum = 0;
  let exitedByCap = false;
  let exitedByMaxPages = false;
  let checkpointCompleted = false;
  const checkpointMode = resumeFromCheckpoint || resetCheckpoint;
  const checkpointRef = checkpointMode ? getCheckpointRef(checkpointKey) : null;
  const checkpointStartedAt = new Date().toISOString();
  let checkpointFound = false;
  let checkpointLoadedNextUrl = null;
  let lastSuccessfulNextUrl = null;
  const knownExistingDealSheetIds = new Set();
  const knownNewDealSheetIds = new Set();
  const knownExistingPlacementIds = new Set();
  const knownNewPlacementIds = new Set();
  const submittalByJobCandidate = new Map();
  let totalRowsAfterTransform = 0;

  if (checkpointMode && checkpointRef) {
    if (resetCheckpoint) {
      await checkpointRef.delete();
      logLine(`[checkpoint] reset key=${checkpointKey}`);
    }

    if (resumeFromCheckpoint) {
      const snap = await checkpointRef.get();
      checkpointFound = snap.exists;
      if (snap.exists) {
        const data = snap.data() || {};
        const savedCursorMode = typeof data.checkpointCursorMode === "string" ? data.checkpointCursorMode : "";
        const cursorModeMismatch =
          (checkpointUseSubmittalPage && savedCursorMode === "url") ||
          (!checkpointUseSubmittalPage && savedCursorMode === "page");

        if (cursorModeMismatch) {
          logLine(
            `[checkpoint] cursor mode mismatch saved=${savedCursorMode || "legacy"} current=${checkpointUseSubmittalPage ? "page" : "url"} — starting page=1`
          );
          nextUrl = url;
          checkpointLoadedNextUrl = null;
        } else if (checkpointUseSubmittalPage) {
          const savedPer = data.submittalPerPage;
          if (savedPer != null && Number(savedPer) !== Number(perPage)) {
            logLine(
              `[checkpoint] submittal per_page mismatch saved=${savedPer} current=${perPage} — starting page=1 fresh list`
            );
            nextUrl = url;
            checkpointLoadedNextUrl = null;
          } else if (typeof data.submittalPageNext === "number" && data.submittalPageNext >= 1) {
            nextUrl = buildUrl(`${config.nexus.baseUrl}${submittalBasePath}`, {
              organization_submittal_status_code: allowedSubmittalCodes,
              per_page: perPage,
              page: data.submittalPageNext,
            });
            checkpointLoadedNextUrl = nextUrl;
            logLine(
              `[checkpoint] resume by page submittalPageNext=${data.submittalPageNext} per_page=${perPage} url=${shortUrlForLog(nextUrl)}`
            );
          } else if (typeof data.nextUrl === "string" && data.nextUrl) {
            nextUrl = data.nextUrl;
            checkpointLoadedNextUrl = data.nextUrl;
          } else if (data.done === true) {
            if (clearCheckpointOnComplete) {
              logLine(
                `[checkpoint] prior doc marked done — full scan from page 1 (clear_checkpoint_on_complete key=${checkpointKey})`
              );
              nextUrl = url;
              checkpointLoadedNextUrl = null;
              checkpointCompleted = false;
            } else {
              checkpointCompleted = true;
              nextUrl = null;
            }
          } else {
            nextUrl = url;
          }
        } else if (typeof data.nextUrl === "string" && data.nextUrl) {
          nextUrl = data.nextUrl;
          checkpointLoadedNextUrl = data.nextUrl;
        } else if (data.done === true) {
          if (clearCheckpointOnComplete) {
            logLine(
              `[checkpoint] prior doc marked done — full scan from page 1 (clear_checkpoint_on_complete key=${checkpointKey})`
            );
            nextUrl = url;
            checkpointLoadedNextUrl = null;
            checkpointCompleted = false;
          } else {
            checkpointCompleted = true;
            nextUrl = null;
          }
        } else {
          nextUrl = url;
        }

        const savedCodes = typeof data.submittalStatusCodes === "string" ? data.submittalStatusCodes : "";
        const savedTable = typeof data.table === "string" ? data.table.trim() : "";
        const codesMismatch =
          savedCodes.trim() !== "" &&
          normalizeSubmittalCodesForCompare(savedCodes) !== normalizeSubmittalCodesForCompare(allowedSubmittalCodes);
        const tableMismatch = savedTable !== "" && savedTable !== tableFqn;
        if ((codesMismatch || tableMismatch) && nextUrl && nextUrl !== url) {
          logLine(
            `[checkpoint] resume stale cursor ignored (checkpoint was for different submittalCodes or table) — starting page=1 fresh list`
          );
          nextUrl = url;
          checkpointLoadedNextUrl = null;
          checkpointCompleted = false;
        }
      }
      logLine(
        `[checkpoint] resume key=${checkpointKey} found=${checkpointFound ? "yes" : "no"} nextUrl=${checkpointLoadedNextUrl ? shortUrlForLog(checkpointLoadedNextUrl) : "none"} done=${checkpointCompleted ? "yes" : "no"}`
      );
    }
  }

  async function flushBuffer(label) {
    if (buffer.length === 0) return;
    logLine(`[enriched sync] STEP 4/5 ENRICH: ${label} ${buffer.length} candidates`);
    const { rows: combined, additionalCostLogRows } = await buildEnrichedRowsFromDealSheetCandidates(
      buffer,
      submittalByJobCandidate,
      {
        allowedSubmittalCodes: allowedSubmittalCodes,
        persistDealSheetStatusFromCandidate: includeVerbalDealSheets,
        skip_contract_id: skipContractId,
      }
    );
    const rowsForInsert = transformRowsFn ? await transformRowsFn(combined) : combined;
    totalRowsAfterTransform += rowsForInsert.length;
    logLine(
      `[enriched sync] STEP 5/5 BIGQUERY: insertAll ${label} rows=${rowsForInsert.length} (beforeTransform=${combined.length})`
    );
    const result = await insertBatchFn(rowsForInsert, totalRowsInserted, {
      skipExistingDealSheets: onlyNewDealSheets,
      rejectIfExistingDealSheetOrPlacement,
      dedupeByPlacementId: dedupeByPlacementId,
      skipDidNotAcceptIfAlreadyDidNotAccept: skipDidNotAcceptIfAlreadyDidNotAccept,
      generatedUuidField,
      appendOnChangeByDealSheet,
      compareIgnoreFields,
      ...(firstInsertPlacementStatusAllowlist != null
        ? { first_insert_placement_status_allowlist: firstInsertPlacementStatusAllowlist }
        : {}),
      ...bqWriteOptions,
      ...(skipContractId ? { skip_contract_id: true } : {}),
      ...(insertRoutedResolveTableId ? { resolveTableId: insertRoutedResolveTableId } : {}),
    });
    totalRowsInserted += result.inserted;
    totalCandidatesProcessed += buffer.length;
    errorBatches += result.errorBatches;
    if (additionalCostLogRows.length > 0) {
      const logResult = await writeAdditionalCostLogRows(
        additionalCostLogRows,
        totalRowsInserted,
        params,
        { insertedKeys: result.insertedKeys instanceof Set ? result.insertedKeys : new Set() }
      );
      errorBatches += logResult.errorBatches || 0;
    }
    buffer = [];
  }

  async function writeCheckpoint(reason, overrides = {}) {
    if (!checkpointMode || !checkpointRef) return;
    const resumeUrl =
      Object.prototype.hasOwnProperty.call(overrides, "resumeUrl")
        ? overrides.resumeUrl
        : checkpointNextUrl || nextUrl || null;
    const hasMoreValue =
      Object.prototype.hasOwnProperty.call(overrides, "hasMore")
        ? Boolean(overrides.hasMore)
        : hasMore;

    let submittalPageNextVal = null;
    if (checkpointUseSubmittalPage) {
      if (Object.prototype.hasOwnProperty.call(overrides, "submittalPageNext")) {
        submittalPageNextVal = overrides.submittalPageNext;
      } else if (!hasMoreValue) {
        submittalPageNextVal = null;
      } else {
        submittalPageNextVal = parseJobSubmittalsPageQueryFromUrl(resumeUrl);
      }
    }

    const payload = {
      key: checkpointKey,
      table: tableFqn,
      submittalStatusCodes: allowedSubmittalCodes,
      mode: "resume",
      reason,
      nextUrl: hasMoreValue ? resumeUrl : null,
      hasMore: hasMoreValue,
      done: !hasMoreValue,
      pagesProcessedThisRun: pageNum,
      candidatesProcessedThisRun: totalCandidatesProcessed,
      rowsInsertedThisRun: totalRowsInserted,
      errorBatchesThisRun: errorBatches,
      updatedAt: new Date().toISOString(),
      startedAt: checkpointStartedAt,
      checkpointCursorMode: checkpointUseSubmittalPage ? "page" : "url",
      ...(checkpointUseSubmittalPage
        ? { submittalPerPage: perPage, submittalPageNext: submittalPageNextVal }
        : {}),
    };
    if (overrides.errorMessage) payload.errorMessage = String(overrides.errorMessage);
    await checkpointRef.set(payload, { merge: true });
    const pageLog =
      checkpointUseSubmittalPage && submittalPageNextVal != null ? ` submittalPageNext=${submittalPageNextVal}` : "";
    logLine(
      `[checkpoint] write key=${checkpointKey} reason=${reason} pagesThisRun=${pageNum} hasMore=${hasMoreValue ? "yes" : "no"} nextUrl=${hasMoreValue && resumeUrl ? shortUrlForLog(resumeUrl) : "none"}${pageLog}`
    );
  }

  logLine(`[enriched sync] STEP 2/5 NEXUS API: request GET ${shortUrlForLog(nextUrl || url)} [pagination=${followNextPage ? "ON" : "OFF"}]`);

  let lastJobSubmittalRequestUrl = null;
  try {
    while (nextUrl) {
      const requestUrl = nextUrl;
      lastJobSubmittalRequestUrl = requestUrl;
      pageNum++;
      const nexusListPage = parseJobSubmittalsPageQueryFromUrl(requestUrl);
      const reqStarted = Date.now();
      logLine(
        `[enriched sync] STEP 2/5 NEXUS API: REQUEST wave=${pageNum} listPage=${nexusListPage ?? "?"} GET ${shortUrlForLog(requestUrl)}`
      );

      const page = await nexusGetJsonWithRetry(requestUrl, accessToken);
      const reqMs = Date.now() - reqStarted;
      const normalized = normalizePagedResponse(page);
      const submittalItems = normalized.items || [];
      const next = normalized.next;

      if (testSubmittalLimit > 0) {
        nextUrl = null;
      } else if (followNextPage) {
        nextUrl = next;
      } else {
        nextUrl = null;
      }

      logLine(
        `[enriched sync] STEP 2/5 NEXUS API: RESPONSE wave=${pageNum} listPage=${nexusListPage ?? "?"} submittalsInPage=${submittalItems.length} nextPage=${nextUrl ? "yes" : "no"} httpMs=${reqMs}${testSubmittalLimit > 0 ? " (test: single page)" : ""}`
      );

      const uniqueJobIds = [];
      const seenJobIds = new Set();

      for (const row of submittalItems) {
        const jobId = normalizeNexusResourceId(row?.job);
        const candId = normalizeNexusResourceId(row?.candidate);
        if (!jobId || !candId) continue;
        const jcKey = `${jobId}:${candId}`;
        submittalByJobCandidate.set(jcKey, row);
        if (!seenJobIds.has(jobId)) {
          seenJobIds.add(jobId);
          uniqueJobIds.push(jobId);
        }
      }

      logLine(
        `[enriched sync] STEP 3/5 NEXUS API: fetching deal-sheet-candidates by ${uniqueJobIds.length} unique job_id(s) in PARALLEL from submittal listPage=${nexusListPage ?? "?"} (wave=${pageNum})`
      );

      const candFetchStart = Date.now();
      const candidatesByJobId = await fetchDealSheetCandidatesByJobIdsParallel(
        uniqueJobIds,
        accessToken,
        dealSheetStatusCodesCsv
      );
      const candFetchMs = Date.now() - candFetchStart;
      logLine(`[enriched sync] STEP 3/5 NEXUS API: parallel fetch completed httpMs=${candFetchMs}`);

      const filteredCandidates = [];
      let excludedByStatus = 0;
      let excludedVerbal = 0;
      let excludedEmptyStatus = 0;
      let excludedNotAllowedStatus = 0;
      let excludedFinalNoSubmittalMatch = 0;
      const verbalSamples = [];
      const maxVerbalSamples = 5;

      for (const jobId of uniqueJobIds) {
        const rows = candidatesByJobId.get(jobId) || [];
        for (const item of rows) {
          const statusReason = dealSheetCandidateExcludeReason(item, allowedDealSheetStatusKeys);
          if (statusReason != null) {
            excludedByStatus++;
            const itemStatusKey = dealSheetCandidateEffectiveStatusKey(item);
            if (itemStatusKey === "VERBAL") {
              excludedVerbal++;
              if (verbalSamples.length < maxVerbalSamples) {
                verbalSamples.push({
                  job: item?.job ?? null,
                  candidate: item?.candidate ?? null,
                  deal_sheet: item?.deal_sheet ?? null,
                  deal_sheet_status_code: item?.deal_sheet_status_code ?? null,
                  deal_sheet_status: item?.deal_sheet_status ?? null,
                });
              }
            } else if (statusReason === "EMPTY_STATUS") {
              excludedEmptyStatus++;
            } else {
              excludedNotAllowedStatus++;
            }
            continue;
          }
          const jobK = normalizeNexusResourceId(item?.job);
          const candK = normalizeNexusResourceId(item?.candidate);
          if (!jobK || !candK) {
            excludedFinalNoSubmittalMatch++;
            continue;
          }
          const key = `${jobK}:${candK}`;
          if (!submittalByJobCandidate.has(key)) {
            excludedFinalNoSubmittalMatch++;
            continue;
          }
          filteredCandidates.push(item);
        }
      }

      logLine(
        `[enriched sync] STEP 3/5 DEAL_SHEET_STATUS FILTER (allowed=${Array.from(allowedDealSheetStatusKeys).join(",")}): excludedTotal=${excludedByStatus} verbal=${excludedVerbal} emptyStatus=${excludedEmptyStatus} notAllowedStatus=${excludedNotAllowedStatus} finalButNoSubmittalOnPage=${excludedFinalNoSubmittalMatch} verbalSample=${verbalSamples.length ? JSON.stringify(verbalSamples) : "none"}`
      );

      let candidatesToProcess = filteredCandidates;
      if (skipExistingDealSheetOrPlacement && filteredCandidates.length > 0) {
        const unknownDealSheetIds = [];
        const unknownDealSheetSeen = new Set();
        const unknownPlacementIds = [];
        const unknownPlacementSeen = new Set();
        for (const item of filteredCandidates) {
          const dsid = item?.deal_sheet;
          if (dsid != null && String(dsid).trim() !== "") {
            const id = String(dsid).trim();
            if (!knownExistingDealSheetIds.has(id) && !knownNewDealSheetIds.has(id) && !unknownDealSheetSeen.has(id)) {
              unknownDealSheetSeen.add(id);
              unknownDealSheetIds.push(id);
            }
          }
          const jobK = normalizeNexusResourceId(item?.job);
          const candK = normalizeNexusResourceId(item?.candidate);
          const submittalRow =
            jobK && candK ? submittalByJobCandidate.get(`${jobK}:${candK}`) : null;
          const pidRaw = submittalRow?.id ?? submittalRow?.placement ?? item?.placement ?? item?.placement_id;
          if (pidRaw != null && String(pidRaw).trim() !== "") {
            const pid = String(pidRaw).trim();
            if (!knownExistingPlacementIds.has(pid) && !knownNewPlacementIds.has(pid) && !unknownPlacementSeen.has(pid)) {
              unknownPlacementSeen.add(pid);
              unknownPlacementIds.push(pid);
            }
          }
        }

        if (unknownDealSheetIds.length > 0) {
          const existingDs =
            explicitBqTable || useEndedDomainRouting
              ? await fetchExistingDealSheetIdsSet(unknownDealSheetIds, bqWriteOptions)
              : await fetchExistingDealSheetIdsSetAnyActiveTable(unknownDealSheetIds, {
                  datasetId: effectiveDatasetId,
                });
          for (const id of unknownDealSheetIds) {
            if (existingDs.has(id)) knownExistingDealSheetIds.add(id);
            else knownNewDealSheetIds.add(id);
          }
        }

        if (unknownPlacementIds.length > 0) {
          const existingPid =
            explicitBqTable || useEndedDomainRouting
              ? await fetchExistingPlacementIdsSet(unknownPlacementIds, bqWriteOptions)
              : await fetchExistingPlacementIdsSetAnyActiveTable(unknownPlacementIds, {
                  datasetId: effectiveDatasetId,
                });
          for (const id of unknownPlacementIds) {
            if (existingPid.has(id)) knownExistingPlacementIds.add(id);
            else knownNewPlacementIds.add(id);
          }
        }

        const nextCandidates = [];
        let skippedExistingDealSheet = 0;
        let skippedExistingPlacement = 0;
        for (const row of filteredCandidates) {
          const dsKey = row?.deal_sheet == null ? "" : String(row.deal_sheet).trim();
          const rowJobK = normalizeNexusResourceId(row?.job);
          const rowCandK = normalizeNexusResourceId(row?.candidate);
          const rowSubmittal =
            rowJobK && rowCandK ? submittalByJobCandidate.get(`${rowJobK}:${rowCandK}`) : null;
          const pidKeyRaw = rowSubmittal?.id ?? rowSubmittal?.placement ?? row?.placement ?? row?.placement_id;
          const pidKey = pidKeyRaw == null ? "" : String(pidKeyRaw).trim();
          if (dsKey !== "" && knownExistingDealSheetIds.has(dsKey)) {
            skippedExistingDealSheet++;
            continue;
          }
          if (pidKey !== "" && knownExistingPlacementIds.has(pidKey)) {
            skippedExistingPlacement++;
            continue;
          }
          nextCandidates.push(row);
        }
        candidatesToProcess = nextCandidates;
        logLine(
          `[enriched sync] STEP 3/5 SKIP-EXISTING FILTER: unknownDealSheetsChecked=${unknownDealSheetIds.length} unknownPlacementsChecked=${unknownPlacementIds.length} skippedExistingDealSheet=${skippedExistingDealSheet} skippedExistingPlacement=${skippedExistingPlacement} remainingForFlow=${candidatesToProcess.length}`
        );
      }

      logLine(
        `[enriched sync] STEP 3/5 NEXUS API: listPage=${nexusListPage ?? "?"} wave=${pageNum} filteredCandidates=${filteredCandidates.length} excludedByDealSheetStatus=${excludedByStatus} candidatesForFlow=${candidatesToProcess.length}`
      );

      let pageAccepted = 0;
      for (const item of candidatesToProcess) {
        pageAccepted++;
        buffer.push(item);

        if (buffer.length >= enrichBatchSize) {
          await flushBuffer("batch");
        }

        globalIndex++;
        if (maxCandidates > 0 && globalIndex >= maxCandidates) {
          logLine(`[enriched sync] CAP: max stream rows=${maxCandidates} reached — stopping`);
          if (buffer.length > 0) {
            await flushBuffer("tail-batch");
          }
          exitedByCap = true;
          break;
        }
      }

      logLine(
        `[enriched sync] PROGRESS: listPage=${nexusListPage ?? "?"} wave=${pageNum} acceptedFromPage=${pageAccepted} buffered=${buffer.length} candidatesProcessedSoFar=${totalCandidatesProcessed + buffer.length} rowsInsertedSoFar=${totalRowsInserted}`
      );

      if (checkpointMode && buffer.length > 0) {
        await flushBuffer("page-boundary");
      }

      if (maxPages > 0 && pageNum >= maxPages) {
        logLine(`[enriched sync] CAP: max submittal pages=${maxPages} reached — stopping pagination (more pages may exist)`);
        checkpointNextUrl = nextUrl;
        nextUrl = null;
        exitedByMaxPages = true;
      }

      lastSuccessfulNextUrl = checkpointNextUrl || nextUrl || null;
      hasMore = Boolean(checkpointNextUrl || nextUrl);
      if (checkpointMode) {
        const cpOverrides = {};
        if (checkpointUseSubmittalPage) {
          cpOverrides.submittalPageNext = resolveNextNexusSubmittalsPageForCheckpoint(
            requestUrl,
            checkpointNextUrl || nextUrl,
            hasMore
          );
        }
        await writeCheckpoint(
          exitedByCap ? "max_candidates_cap" : exitedByMaxPages ? "max_pages_cap" : "page_processed",
          cpOverrides
        );
      }

      if (exitedByCap) break;
    }
  } catch (err) {
    const resumeUrl = lastSuccessfulNextUrl;
    if (checkpointMode) {
      const errOverrides = {
        resumeUrl,
        hasMore: Boolean(resumeUrl || (checkpointUseSubmittalPage && pageNum > 0)),
        errorMessage: err?.message || "unknown_error",
      };
      if (checkpointUseSubmittalPage && lastJobSubmittalRequestUrl) {
        const p = parseJobSubmittalsPageQueryFromUrl(lastJobSubmittalRequestUrl);
        if (p != null) {
          errOverrides.submittalPageNext = p;
        } else if (pageNum > 0) {
          errOverrides.submittalPageNext = pageNum;
        }
      }
      if (checkpointUseSubmittalPage) {
        errOverrides.submittalPerPage = perPage;
      }
      await writeCheckpoint("error_paused", errOverrides);
    }
    throw err;
  }

  if (!exitedByCap && !exitedByMaxPages && pageNum > 0) {
    logLine(`[enriched sync] STEP 2/5 NEXUS API: job-submittal paging finished — ${pageNum} GET(s)`);
  } else if (exitedByMaxPages) {
    logLine(`[enriched sync] STEP 2/5 NEXUS API: stopped after max_pages=${maxPages} (${pageNum} submittal GET(s))`);
  }

  if (buffer.length > 0) {
    await flushBuffer("final-tail");
  }

  hasMore = Boolean(checkpointNextUrl || nextUrl);
  if (checkpointMode) {
    if (!hasMore && clearCheckpointOnComplete && checkpointRef) {
      try {
        await checkpointRef.delete();
        logLine(`[checkpoint] deleted key=${checkpointKey} after successful full run (clear_checkpoint_on_complete)`);
      } catch (delErr) {
        logLine(`[checkpoint] delete key=${checkpointKey} failed (non-fatal): ${delErr?.message || delErr}`);
        await writeCheckpoint("completed");
      }
    } else {
      await writeCheckpoint(hasMore ? "run_paused" : "completed");
    }
  }

  const elapsedStr = formatDuration(Date.now() - startMs);
  logLine(
    `[enriched sync] === DONE === rowsInsertedThisRun=${totalRowsInserted} candidatesProcessed=${totalCandidatesProcessed} submittalPagesFetched=${pageNum} errorBatches=${errorBatches} elapsed=${elapsedStr}`
  );
  logLine(`TIMING syncEnrichedDealSheetCandidatesToBigQuery elapsed=${elapsedStr}`);

  return {
    inserted: totalRowsInserted,
    rowsAfterTransform: totalRowsAfterTransform,
    candidatesProcessed: totalCandidatesProcessed,
    errorBatches,
    bigQueryTarget: tableFqn,
    submittalStatusCodes: allowedSubmittalCodes,
    done: true,
    maxCandidates: maxCandidates || null,
    maxPages: maxPages || null,
    submittalPagesFetched: pageNum,
    stoppedEarlyMaxPages: exitedByMaxPages,
    checkpoint: checkpointMode
      ? {
          key: checkpointKey,
          mode: "resume",
          foundAtStart: checkpointFound,
          resumedFromUrl: checkpointLoadedNextUrl ? shortUrlForLog(checkpointLoadedNextUrl) : null,
          hasMore,
        }
      : null,
    hasMore,
    nextPageHint: hasMore && (checkpointNextUrl || nextUrl) ? shortUrlForLog(checkpointNextUrl || nextUrl) : null,
    pagesProcessedThisRun: pageNum,
    elapsed: elapsedStr,
  };
}

async function syncRateChangeLogsFromBigQuery(params = {}) {
  const logDatasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : config.rateChangeLogDatasetId;
  const logTableId =
    typeof params.bq_table === "string" && params.bq_table.trim() !== ""
      ? params.bq_table.trim()
      : config.rateChangeLogTableId;
  const dealSheetDatasetId =
    typeof params.deal_sheet_bq_dataset === "string" && params.deal_sheet_bq_dataset.trim() !== ""
      ? params.deal_sheet_bq_dataset.trim()
      : config.datasetId;

  const startMs = Date.now();
  logLine(
    `[rate-change logs BQ scan] === syncRateChangeLogsFromBigQuery START === dealSheetDataset=${dealSheetDatasetId} logTable=${config.projectId}.${logDatasetId}.${logTableId}`
  );

  const pairs = await fetchContractRateChangePairsFromActive({ datasetId: dealSheetDatasetId });
  logLine(`[rate-change logs BQ scan] contract pairs with RATE_CHANGE=YES and previous row=${pairs.size}`);

  const rows = [];
  for (const [, { latest, previous }] of pairs) {
    if (!latest || !previous) continue;
    rows.push(buildRateChangeLogRow(latest, previous));
  }

  const result = await insertRateChangeLogBatch(rows, 0, {
    skipExistingRateChangeLogs: true,
    datasetId: logDatasetId,
    tableId: logTableId,
  });

  const elapsedStr = formatDuration(Date.now() - startMs);
  logLine(
    `[rate-change logs BQ scan] DONE inserted=${result.inserted} candidates=${pairs.size} built=${rows.length} errorBatches=${result.errorBatches} elapsed=${elapsedStr}`
  );

  return {
    inserted: result.inserted,
    total: pairs.size,
    rateChangeYes: rows.length,
    errorBatches: result.errorBatches,
    elapsed: elapsedStr,
  };
}

/**
 * Build refresh params for scheduled active update (same identifier pattern as refreshDealSheetByPlacementId).
 * @param {{deal_sheet_id?: string|null, placement_id?: string|null, table_id?: string}} target
 * @param {object} baseParams
 * @returns {{params: object|null, skipReason: string|null}}
 */
function buildActiveUpdateRefreshParams(target, baseParams = {}) {
  const dealSheetId = target?.deal_sheet_id == null ? "" : String(target.deal_sheet_id).trim();
  const placementId = target?.placement_id == null ? "" : String(target.placement_id).trim();

  if (!dealSheetId && !placementId) {
    return { params: null, skipReason: "No deal_sheet_id or placement_id on target" };
  }

  const params = { ...baseParams };
  if (dealSheetId) params.deal_sheet_id = dealSheetId;
  if (placementId) params.placement_id = placementId;
  return { params, skipReason: null };
}

/**
 * Scheduled update path: load latest row per DEAL_SHEET_ID from active BigQuery tables (placement fallback),
 * refresh via Nexus, append when business columns differ from latest deal-sheet row in BQ.
 */
async function syncExistingActiveDealSheetUpdatesFromBigQuery(params = {}) {
  const startMs = Date.now();
  const effectiveDatasetId =
    typeof params.bq_dataset === "string" && params.bq_dataset.trim() !== ""
      ? params.bq_dataset.trim()
      : config.datasetId;
  const checkpointKey = String(params.checkpoint_key || "active-deal-sheet-update-cursor");
  const resumeFromCheckpoint = params.resume_from_checkpoint === true;
  const clearCheckpointOnComplete = params.clear_checkpoint_on_complete === true;
  const maxPairsPerRun = isPositiveInt(params.max_pairs_per_run)
    ? Math.floor(Number(params.max_pairs_per_run))
    : 500;
  const minStartDateMs =
    params.min_start_date_ms != null && Number.isFinite(Number(params.min_start_date_ms))
      ? Number(params.min_start_date_ms)
      : null;
  const compareIgnoreFields = Array.isArray(params.compare_ignore_fields)
    ? params.compare_ignore_fields
    : ["ID", "DATE_AND_TIME", "IS_REJECTED"];
  const generatedUuidField =
    typeof params.generated_uuid_field === "string" && params.generated_uuid_field.trim() !== ""
      ? params.generated_uuid_field.trim()
      : "ID";

  logLine(
    `[update sync] === syncExistingActiveDealSheetUpdatesFromBigQuery START === dataset=${effectiveDatasetId} maxPairsPerRun=${maxPairsPerRun} checkpointKey=${checkpointKey} resume=${resumeFromCheckpoint ? "yes" : "no"}`
  );

  const allTargets = await fetchActiveDealSheetUpdateTargets({ datasetId: effectiveDatasetId });
  const targetTotal = allTargets.length;

  let targetOffset = 0;
  const checkpointRef = resumeFromCheckpoint ? getCheckpointRef(checkpointKey) : null;
  if (checkpointRef) {
    try {
      const snap = await checkpointRef.get();
      if (snap.exists) {
        const data = snap.data() || {};
        const savedTotal = Number(data.targetTotal ?? data.pairTotal);
        const savedOffset = Number(data.targetOffset ?? data.pairOffset);
        if (
          Number.isFinite(savedTotal) &&
          savedTotal === targetTotal &&
          Number.isFinite(savedOffset) &&
          savedOffset >= 0 &&
          savedOffset < targetTotal
        ) {
          targetOffset = Math.trunc(savedOffset);
          logLine(`[update sync] checkpoint resume targetOffset=${targetOffset} targetTotal=${targetTotal}`);
        } else {
          logLine(
            `[update sync] checkpoint ignored (stale targetTotal/offset savedTotal=${data.targetTotal ?? data.pairTotal} savedOffset=${data.targetOffset ?? data.pairOffset} currentTotal=${targetTotal})`
          );
        }
      }
    } catch (err) {
      logLine(`[update sync] checkpoint read failed (non-fatal): ${err?.message || err}`);
    }
  }

  const slice = allTargets.slice(targetOffset, targetOffset + maxPairsPerRun);
  const concurrency = Math.max(1, Math.min(Number(config.fetchAllMax) || 20, 20));

  let checked = 0;
  let appended = 0;
  let no_change = 0;
  let not_found = 0;
  let no_baseline = 0;
  let skipped_date = 0;
  let errors = 0;

  async function processTarget(target) {
    try {
      const baseParams = {
        bq_dataset: effectiveDatasetId,
        bq_table: target.table_id,
        apply_update: true,
        baseline_scope: "deal_sheet_id",
        update_only_existing: true,
        generated_uuid_field: generatedUuidField,
        compare_ignore_fields: compareIgnoreFields,
        ...(minStartDateMs != null ? { min_start_date_ms: minStartDateMs } : {}),
      };
      const { params, skipReason } = buildActiveUpdateRefreshParams(target, baseParams);
      if (!params) {
        return { action: "NOT_FOUND", reason: skipReason, inserted: 0 };
      }
      if (params.deal_sheet_id && !params.placement_id) {
        logLine(
          `[update sync] target missing placement_id deal_sheet_id=${params.deal_sheet_id} (Nexus seed may fail)`
        );
      }
      return await refreshPlacementRecordToBigQuery(params);
    } catch (err) {
      return {
        action: "ERROR",
        reason: err?.message || String(err),
        inserted: 0,
      };
    }
  }

  for (let i = 0; i < slice.length; i += concurrency) {
    const batch = slice.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(processTarget));
    for (const r of results) {
      checked++;
      if (r.action === "INSERTED") appended++;
      else if (r.action === "NO_CHANGE" || r.action === "PREVIEW_CHANGE") no_change++;
      else if (r.action === "NOT_FOUND") not_found++;
      else if (r.action === "NO_BASELINE") no_baseline++;
      else if (r.action === "SKIPPED_DATE") skipped_date++;
      else if (r.action === "ERROR") errors++;
      else no_change++;
    }
    if (checked > 0 && checked % 100 === 0) {
      logLine(
        `[update sync] progress checked=${checked}/${slice.length} appended=${appended} no_change=${no_change} not_found=${not_found} no_baseline=${no_baseline} skipped_date=${skipped_date} errors=${errors}`
      );
    }
  }

  const targetOffsetEnd = targetOffset + slice.length;
  const hasMore = targetOffsetEnd < targetTotal;

  if (checkpointRef) {
    try {
      if (!hasMore && clearCheckpointOnComplete) {
        await checkpointRef.delete();
        logLine(`[update sync] checkpoint deleted key=${checkpointKey} (full pass complete)`);
      } else if (hasMore) {
        await checkpointRef.set(
          {
            key: checkpointKey,
            targetOffset: targetOffsetEnd,
            targetTotal,
            pairOffset: targetOffsetEnd,
            pairTotal: targetTotal,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
        logLine(
          `[update sync] checkpoint saved key=${checkpointKey} targetOffset=${targetOffsetEnd} targetTotal=${targetTotal}`
        );
      }
    } catch (err) {
      logLine(`[update sync] checkpoint write failed (non-fatal): ${err?.message || err}`);
    }
  }

  const elapsed = formatDuration(Date.now() - startMs);
  logLine(
    `[update sync] === DONE === checked=${checked} appended=${appended} no_change=${no_change} not_found=${not_found} no_baseline=${no_baseline} skipped_date=${skipped_date} errors=${errors} targetOffset=${targetOffset} targetOffsetEnd=${targetOffsetEnd} targetTotal=${targetTotal} hasMore=${hasMore ? "yes" : "no"} elapsed=${elapsed}`
  );

  return {
    checked,
    appended,
    no_change,
    not_found,
    no_baseline,
    skipped_date,
    errors,
    targetTotal,
    pairTotal: targetTotal,
    targetOffset,
    pairOffset: targetOffset,
    targetOffsetEnd,
    pairOffsetEnd: targetOffsetEnd,
    targetsProcessedThisRun: slice.length,
    pairsProcessedThisRun: slice.length,
    hasMore,
    elapsed,
  };
}

module.exports = {
  syncEnrichedDealSheetCandidatesToBigQuery,
  syncExistingActiveDealSheetUpdatesFromBigQuery,
  syncRateChangeLogsFromBigQuery,
  refreshPlacementRecordToBigQuery,
  buildRefreshAdditionalCostLogsSummary,
  buildActiveUpdateRefreshParams,
  buildRateChangeLogRow,
  parseBooleanLike,
  computeChangedFields,
  resolvePreferredCandidateRow,
  formatDuration,
  parseJobSubmittalsPageQueryFromUrl,
  resolveNextNexusSubmittalsPageForCheckpoint,
  hasAdditionalCostLogChange,
  hasTerminationReasonLogChange,
  additionalCostLogValueEquals,
  additionalCostLogStringEquals,
  ADDITIONAL_COST_LOG_VALUE_TOLERANCE,
};
