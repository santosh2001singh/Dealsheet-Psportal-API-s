/**
 * BigQuery Client
 * Handles BigQuery operations for deal sheet data
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { randomUUID } = require("crypto");
const config = require("./config");
const { logLine, logError } = require("./logger");
const { shouldExcludeRowFromBigQuery } = require("./bqRowExclusions");
const { ACTIVE_DEAL_SHEET_TABLE_IDS, resolveActiveDealSheetTableId } = require("./recruiterDomainTables");
const { API_OWNED_COLUMNS, SYSTEM_CONTROLLED_COLUMNS } = require("./columnMappings");

let bigquery;
const tableFqn = `${config.projectId}.${config.datasetId}.${config.tableId}`;

if (config.serviceAccount.client_email && config.serviceAccount.private_key) {
  bigquery = new BigQuery({
    projectId: config.projectId,
    credentials: {
      client_email: config.serviceAccount.client_email,
      private_key: config.serviceAccount.private_key,
    },
  });
  logLine(
    `[enriched sync] [BigQuery auth] mode=service_account client_email=${config.serviceAccount.client_email} target_table=${tableFqn}`
  );
} else {
  bigquery = new BigQuery({ projectId: config.projectId });
  logLine(`[enriched sync] [BigQuery auth] mode=runtime_default target_table=${tableFqn}`);
}

/**
 * Escape single quotes for SQL string literals
 */
function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Run a BigQuery query and return results as objects
 */
async function queryObjects(sql, maxResults = 1000) {
  const options = { query: sql, maxResults };
  const [rows] = await bigquery.query(options);
  return rows;
}

function resolveBqDatasetTable(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const tableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : config.tableId;
  return { datasetId, tableId };
}

/**
 * Returns a Set of DEAL_SHEET_ID values that already exist in BigQuery
 */
async function fetchExistingDealSheetIdsSet(dealSheetIds, options = {}) {
  const out = new Set();
  if (!dealSheetIds || dealSheetIds.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);

  const uniq = [];
  const seen = new Set();
  for (const id of dealSheetIds) {
    if (id == null || String(id).trim() === "") continue;
    const s = String(id).trim();
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id 
                 FROM \`${config.projectId}.${datasetId}.${tableId}\` 
                 WHERE CAST(DEAL_SHEET_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length);
    for (const row of rows) {
      const id = row?.deal_sheet_id;
      if (id != null && String(id).trim() !== "") {
        out.add(String(id).trim());
      }
    }
  }
  return out;
}

/**
 * Returns a Set of PLACEMENT_ID values that already exist in BigQuery
 */
async function fetchExistingPlacementIdsSet(placementIds, options = {}) {
  const out = new Set();
  if (!placementIds || placementIds.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);

  const uniq = [];
  const seen = new Set();
  for (const id of placementIds) {
    if (id == null || String(id).trim() === "") continue;
    const s = String(id).trim();
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT CAST(PLACEMENT_ID AS STRING) AS placement_id
                 FROM \`${config.projectId}.${datasetId}.${tableId}\`
                 WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length);
    for (const row of rows) {
      const id = row?.placement_id;
      if (id != null && String(id).trim() !== "") {
        out.add(String(id).trim());
      }
    }
  }
  return out;
}

/**
 * Returns Map<placementIdString, Set<UPPERCASE placement statuses>> from BigQuery
 */
async function fetchPlacementStatusesByPlacementIds(placementIds, options = {}) {
  const out = new Map();
  if (!placementIds || placementIds.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const uniq = [];
  const seen = new Set();
  for (const id of placementIds) {
    if (id == null || String(id).trim() === "") continue;
    const s = String(id).trim();
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) AS placement_status
    FROM \`${config.projectId}.${datasetId}.${tableId}\`
    WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length * 5);
    for (const row of rows) {
      const pid = row?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;
      const key = String(pid).trim();
      const status = row?.placement_status == null ? "" : String(row.placement_status).trim();
      if (!out.has(key)) out.set(key, new Set());
      if (status) out.get(key).add(status);
    }
  }
  return out;
}

/**
 * Returns Map<dealSheetIdString, latest row object> from BigQuery
 */
async function fetchLatestRowsByDealSheetIds(dealSheetIds, options = {}) {
  const out = new Map();
  if (!dealSheetIds || dealSheetIds.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const uniq = [];
  const seen = new Set();
  for (const id of dealSheetIds) {
    if (id == null || String(id).trim() === "") continue;
    const s = String(id).trim();
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT * EXCEPT(_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(DEAL_SHEET_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE CAST(DEAL_SHEET_ID AS STRING) IN (${inList})
                 )
                 WHERE _rn = 1`;
    const rows = await queryObjects(sql, chunk.length * 2);
    for (const row of rows) {
      const key = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
      if (!key) continue;
      out.set(key, row);
    }
  }
  return out;
}

function buildDealSheetPlacementCompositeKey(dealSheetId, placementId) {
  const dsid = dealSheetId == null ? "" : String(dealSheetId).trim();
  const pid = placementId == null ? "" : String(placementId).trim();
  if (!dsid || !pid) return "";
  return `${dsid}|${pid}`;
}

/**
 * Returns Map<"DEAL_SHEET_ID|PLACEMENT_ID", latest row object> from BigQuery
 */
async function fetchLatestRowsByDealSheetPlacementPairs(rows, options = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const pairMap = new Map();
  for (const row of rows) {
    const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    const key = buildDealSheetPlacementCompositeKey(dsid, pid);
    if (!key || pairMap.has(key)) continue;
    pairMap.set(key, { dsid, pid });
  }
  const pairs = Array.from(pairMap.values());
  if (!pairs.length) return out;

  const chunkSize = 300;
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const chunk = pairs.slice(i, i + chunkSize);
    const wherePairs = chunk
      .map(
        ({ dsid, pid }) =>
          `(CAST(DEAL_SHEET_ID AS STRING) = '${escapeSqlString(dsid)}' AND CAST(PLACEMENT_ID AS STRING) = '${escapeSqlString(pid)}')`
      )
      .join(" OR ");
    const sql = `SELECT * EXCEPT(_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    const dbRows = await queryObjects(sql, chunk.length * 2);
    for (const row of dbRows) {
      const key = buildDealSheetPlacementCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID);
      if (!key) continue;
      out.set(key, row);
    }
  }
  return out;
}

function normalizeForCompare(value) {
  const sanitized = sanitizeValueForStreamingInsert(value);
  if (sanitized == null) return null;
  if (typeof sanitized === "number") {
    return Number.isNaN(sanitized) ? null : `num:${String(Number(sanitized))}`;
  }
  if (typeof sanitized === "boolean") return sanitized;
  if (typeof sanitized === "string") {
    const trimmed = sanitized.trim();
    if (trimmed === "") return null;

    // Normalize numeric-equivalent strings (e.g. "100.0" vs 100).
    if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isNaN(n)) return `num:${String(Number(n))}`;
    }

    // Normalize common timestamp/date string formats into stable UTC ISO.
    const maybeIsoUtc = trimmed
      .replace(/\s+UTC$/i, "Z")
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/, "$1T$2Z")
      .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/, "$1T$2Z");
    if (/^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}:\d{2}/.test(trimmed) || /\sUTC$/i.test(trimmed)) {
      const parsedMs = Date.parse(maybeIsoUtc);
      if (!Number.isNaN(parsedMs)) return `dt:${new Date(parsedMs).toISOString()}`;
    }

    return trimmed;
  }
  if (Array.isArray(sanitized)) {
    return JSON.stringify(sanitized.map((item) => normalizeForCompare(item)));
  }
  if (typeof sanitized === "object") {
    const entries = Object.entries(sanitized)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, normalizeForCompare(v)]);
    return JSON.stringify(Object.fromEntries(entries));
  }
  return String(sanitized);
}

function hasBusinessColumnChanges(incomingRow, existingRow, ignoreFieldsSet) {
  if (!existingRow) return true;
  for (const key of API_OWNED_COLUMNS) {
    if (ignoreFieldsSet && ignoreFieldsSet.has(key)) continue;
    const incomingVal = normalizeForCompare(incomingRow?.[key]);
    const existingVal = normalizeForCompare(existingRow?.[key]);
    if (incomingVal !== existingVal) return true;
  }
  return false;
}

/** Default first-row allowlist for append-on-change mode when DEAL_SHEET_ID has no baseline in BigQuery */
const DEFAULT_FIRST_INSERT_PLACEMENT_STATUSES = ["STARTED", "BOOKED"];

/**
 * Build Set of uppercase placement statuses allowed for the first insert per DEAL_SHEET_ID.
 * @param {object} options - insert batch options; supports `first_insert_placement_status_allowlist` as string (CSV) or string[]
 */
function resolveFirstInsertPlacementAllowlist(options = {}) {
  const raw = options.first_insert_placement_status_allowlist;
  if (Array.isArray(raw)) {
    const set = new Set();
    for (const x of raw) {
      const k = String(x || "").trim().toUpperCase();
      if (k) set.add(k);
    }
    return set.size > 0 ? set : new Set(DEFAULT_FIRST_INSERT_PLACEMENT_STATUSES);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const set = new Set();
    for (const part of raw.split(",")) {
      const k = part.trim().toUpperCase();
      if (k) set.add(k);
    }
    return set.size > 0 ? set : new Set(DEFAULT_FIRST_INSERT_PLACEMENT_STATUSES);
  }
  return new Set(DEFAULT_FIRST_INSERT_PLACEMENT_STATUSES);
}

function placementStatusAllowsFirstInsert(placementStatus, allowSet) {
  const key = placementStatus == null ? "" : String(placementStatus).trim().toUpperCase();
  return key !== "" && allowSet.has(key);
}

function normalizeMoveRunrate(value) {
  if (value == null) return null;
  const key = String(value).trim().toUpperCase();
  if (!key) return null;
  if (key === "TRUE") return "TRUE";
  if (key === "FALSE") return "FALSE";
  return null;
}

function applyMoveRunrateAppendOverride(incomingRow, baselineRow) {
  const baseline = normalizeMoveRunrate(baselineRow?.MOVE_RUNRATE);
  if (baseline === "TRUE") {
    return { row: { ...incomingRow, MOVE_RUNRATE: "FALSE" }, forcedFalse: true, keptNull: false };
  }
  if (baseline == null) {
    return { row: { ...incomingRow, MOVE_RUNRATE: null }, forcedFalse: false, keptNull: true };
  }
  return { row: incomingRow, forcedFalse: false, keptNull: false };
}

/**
 * For real update appends (baseline exists + business fields changed), clear rejected flag.
 * Keeps new/baseline insert rows untouched.
 */
function applyIsRejectedResetForChangedUpdate(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") return incomingRow;
  return { ...incomingRow, IS_REJECTED: "False" };
}

/**
 * Copy manual columns (anything not in API_OWNED_COLUMNS and not system-controlled)
 * from the baseline row onto the incoming row before append-on-change insert.
 * Lets BigQuery-only edits (SKU_NUMBER, BGC_*, ATL, RECRUITMENT_MENTOR, etc.)
 * survive across update appends.
 */
function applyManualColumnsCarryForward(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, carriedCount: 0 };
  }
  const out = { ...incomingRow };
  let carriedCount = 0;
  for (const [key, value] of Object.entries(baselineRow)) {
    if (key === "_rn") continue;
    if (API_OWNED_COLUMNS.has(key)) continue;
    if (SYSTEM_CONTROLLED_COLUMNS.has(key)) continue;
    out[key] = value;
    carriedCount++;
  }
  return { row: out, carriedCount };
}

/**
 * Compute insert ID for deduplication
 */
function computeInsertId(obj, absoluteIndex, options = {}) {
  const field =
    typeof options.insertIdField === "string" && options.insertIdField.trim() !== ""
      ? options.insertIdField.trim()
      : config.bigQuery.insertIdField;
  const candidate = field && obj && Object.prototype.hasOwnProperty.call(obj, field) ? obj[field] : null;
  const s = candidate == null ? "" : String(candidate).trim();
  return s ? s : `idx_${absoluteIndex}`;
}

/**
 * BigQuery query() often returns DATE / TIMESTAMP / DATETIME as `{ value: "..." }`.
 * Streaming insert expects JSON primitives (ISO strings / numbers), not those wrappers.
 */
function sanitizeValueForStreamingInsert(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => sanitizeValueForStreamingInsert(x));
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "value") {
      return sanitizeValueForStreamingInsert(v.value);
    }
    const out = {};
    for (const k of keys) {
      const inner = sanitizeValueForStreamingInsert(v[k]);
      if (inner !== undefined) out[k] = inner;
    }
    return out;
  }
  return v;
}

/**
 * Strip query-only fields and unwrap BigQuery value wrappers for table.insert(raw).
 */
function sanitizeRowForBigQueryStreamingInsert(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "_rn") continue;
    const inner = sanitizeValueForStreamingInsert(v);
    if (inner !== undefined) out[k] = inner;
  }
  return out;
}

/**
 * Insert rows to BigQuery using streaming insert
 */
async function insertAll(rows, options = {}) {
  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const table = bigquery.dataset(datasetId).table(tableId);

  const insertOptions = {
    ignoreUnknownValues: config.bigQuery.ignoreUnknownValues,
    skipInvalidRows: config.bigQuery.skipInvalidRows,
    raw: true,
  };

  // Insert-time timestamp for auditing/debugging in BigQuery (TIMESTAMP column).
  // BigQuery accepts RFC3339/ISO-8601 like "2026-04-07T15:04:05.123Z".
  const insertTs = new Date().toISOString();

  const formattedRows = rows.map((row, idx) => {
    const clean = sanitizeRowForBigQueryStreamingInsert(row);
    const dateTime = clean?.DATE_AND_TIME != null && String(clean.DATE_AND_TIME).trim() !== ""
      ? clean.DATE_AND_TIME
      : insertTs;
    return {
      insertId: computeInsertId(clean, options.insertIdBase + idx, {
        insertIdField: options.insertIdField,
      }),
      json: {
        ...clean,
        DATE_AND_TIME: dateTime,
      },
    };
  });

  try {
    await table.insert(formattedRows, insertOptions);
    return { inserted: rows.length, attempted: rows.length, errors: [] };
  } catch (e) {
    if (e.errors) {
      const failedRows = new Set();
      for (const rowError of e.errors) {
        if (rowError && typeof rowError.row === "number") failedRows.add(rowError.row);
      }
      const failedCount = failedRows.size > 0 ? failedRows.size : e.errors.length;
      const inserted = Math.max(0, rows.length - failedCount);
      logError(
        `[enriched sync] [BigQuery insertAll] ROW_ERRORS sample=${JSON.stringify(e.errors.slice(0, 3))}`
      );
      return { inserted, attempted: rows.length, errors: e.errors };
    }
    throw e;
  }
}

/**
 * Insert enriched deal sheet batch with deduplication
 */
async function insertEnrichedDealSheetBatch(combinedRows, insertIdBase, options = {}) {
  if (!combinedRows || combinedRows.length === 0) {
    logLine(`[enriched sync] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  let rowsToInsert = combinedRows;
  const skipExistingDealSheets = options.skipExistingDealSheets === true;
  const dedupeByPlacementId = options.dedupeByPlacementId === true;
  const skipDidNotAcceptIfAlreadyDidNotAccept = options.skipDidNotAcceptIfAlreadyDidNotAccept === true;
  const appendOnChangeByDealSheet = options.appendOnChangeByDealSheet === true;
  const rejectIfExistingDealSheetOrPlacement = options.rejectIfExistingDealSheetOrPlacement === true;
  const compareIgnoreFields = Array.isArray(options.compareIgnoreFields) ? options.compareIgnoreFields : [];

  if (dedupeByPlacementId && rowsToInsert.length > 0) {
    const seenPlacementIdsInBatch = new Set();
    const filtered = [];
    let droppedSameBatchPlacement = 0;
    for (const row of rowsToInsert) {
      const pidRaw = row?.PLACEMENT_ID;
      const pid = pidRaw == null ? "" : String(pidRaw).trim();
      if (!pid) {
        filtered.push(row);
        continue;
      }
      if (seenPlacementIdsInBatch.has(pid)) {
        droppedSameBatchPlacement++;
        continue;
      }
      seenPlacementIdsInBatch.add(pid);
      filtered.push(row);
    }
    rowsToInsert = filtered;
    if (droppedSameBatchPlacement > 0) {
      logLine(
        `[enriched sync] [BigQuery insertAll] dedupe(same batch PLACEMENT_ID): dropped=${droppedSameBatchPlacement} remaining=${rowsToInsert.length}`
      );
    }
  }

  if (skipExistingDealSheets) {
    const ids = [];
    for (const row of combinedRows) {
      const id = row?.DEAL_SHEET_ID;
      if (id != null && String(id).trim() !== "") {
        ids.push(String(id).trim());
      }
    }

    const existingIds = await fetchExistingDealSheetIdsSet(ids, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingIds.size > 0) {
      const filtered = [];
      let skipped = 0;
      for (const row of combinedRows) {
        const dsid = row?.DEAL_SHEET_ID;
        const key = dsid == null ? "" : String(dsid).trim();
        if (key !== "" && existingIds.has(key)) {
          skipped++;
          continue;
        }
        filtered.push(row);
      }
      rowsToInsert = filtered;
      logLine(
        `[enriched sync] [BigQuery insertAll] dedupe(existing DEAL_SHEET_ID): skipped=${skipped} remaining=${rowsToInsert.length}`
      );
    }
  }

  if ((dedupeByPlacementId || skipDidNotAcceptIfAlreadyDidNotAccept) && rowsToInsert.length > 0) {
    const placementIds = [];
    for (const row of rowsToInsert) {
      const pid = row?.PLACEMENT_ID;
      if (pid == null || String(pid).trim() === "") continue;
      placementIds.push(String(pid).trim());
    }
    const existingByPlacement = await fetchPlacementStatusesByPlacementIds(placementIds, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });

    if (existingByPlacement.size > 0) {
      const filtered = [];
      let skippedByPlacementId = 0;
      let skippedByDidNotAccept = 0;
      for (const row of rowsToInsert) {
        const pidRaw = row?.PLACEMENT_ID;
        const pid = pidRaw == null ? "" : String(pidRaw).trim();
        if (!pid) {
          filtered.push(row);
          continue;
        }
        const existingStatuses = existingByPlacement.get(pid);
        if (!existingStatuses || existingStatuses.size === 0) {
          filtered.push(row);
          continue;
        }

        if (dedupeByPlacementId) {
          skippedByPlacementId++;
          continue;
        }

        if (skipDidNotAcceptIfAlreadyDidNotAccept && existingStatuses.has("DID NOT ACCEPT")) {
          skippedByDidNotAccept++;
          continue;
        }

        filtered.push(row);
      }

      rowsToInsert = filtered;
      logLine(
        `[enriched sync] [BigQuery insertAll] dedupe(existing PLACEMENT_ID): skippedByPlacementId=${skippedByPlacementId} skippedByDidNotAccept=${skippedByDidNotAccept} remaining=${rowsToInsert.length}`
      );
    }
  }

  if (
    rejectIfExistingDealSheetOrPlacement &&
    !appendOnChangeByDealSheet &&
    rowsToInsert.length > 0
  ) {
    const dealSheetIds = [];
    const placementIds = [];
    for (const row of rowsToInsert) {
      const dsid = row?.DEAL_SHEET_ID;
      if (dsid != null && String(dsid).trim() !== "") dealSheetIds.push(String(dsid).trim());
      const pid = row?.PLACEMENT_ID;
      if (pid != null && String(pid).trim() !== "") placementIds.push(String(pid).trim());
    }
    const existingDealSheets = await fetchExistingDealSheetIdsSet(dealSheetIds, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    const existingPlacements = await fetchExistingPlacementIdsSet(placementIds, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingDealSheets.size > 0 || existingPlacements.size > 0) {
      const filtered = [];
      let skippedExistingDealSheet = 0;
      let skippedExistingPlacement = 0;
      for (const row of rowsToInsert) {
        const dsKey = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
        const pidKey = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
        if (dsKey !== "" && existingDealSheets.has(dsKey)) {
          skippedExistingDealSheet++;
          continue;
        }
        if (pidKey !== "" && existingPlacements.has(pidKey)) {
          skippedExistingPlacement++;
          continue;
        }
        filtered.push(row);
      }
      rowsToInsert = filtered;
      logLine(
        `[enriched sync] [BigQuery insertAll] reject-existing(DEAL_SHEET_ID|PLACEMENT_ID): skippedExistingDealSheet=${skippedExistingDealSheet} skippedExistingPlacement=${skippedExistingPlacement} remaining=${rowsToInsert.length}`
      );
    }
  }

  if (!appendOnChangeByDealSheet && rowsToInsert.length > 0 && options.first_insert_placement_status_allowlist != null) {
    const firstInsertAllowSet = resolveFirstInsertPlacementAllowlist(options);
    const filtered = [];
    let skippedByPlacementStatus = 0;
    for (const row of rowsToInsert) {
      if (placementStatusAllowsFirstInsert(row?.PLACEMENT_STATUS, firstInsertAllowSet)) {
        filtered.push(row);
      } else {
        skippedByPlacementStatus++;
      }
    }
    rowsToInsert = filtered;
    if (skippedByPlacementStatus > 0) {
      logLine(
        `[enriched sync] [BigQuery insertAll] insert-only first_insert_allowlist: skippedByPlacementStatus=${skippedByPlacementStatus} remaining=${rowsToInsert.length}`
      );
    }
  }

  if (appendOnChangeByDealSheet && rowsToInsert.length > 0) {
    const ignoreFieldsSet = new Set(compareIgnoreFields.map((f) => String(f).trim()).filter(Boolean));
    const firstInsertAllowSet = resolveFirstInsertPlacementAllowlist(options);
    const latestRowsByCompositeKey = await fetchLatestRowsByDealSheetPlacementPairs(rowsToInsert, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });

    const filtered = [];
    let unchangedSkipped = 0;
    let changedIncluded = 0;
    let noBaselineIncluded = 0;
    let newRowSkippedByPlacementStatus = 0;
    let missingPlacementIdCount = 0;
    let moveRunrateForcedFalse = 0;
    let moveRunrateKeptNull = 0;
    let isRejectedResetCount = 0;
    let manualColumnsCarriedTotal = 0;
    for (const row of rowsToInsert) {
      const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
      if (!dsid) {
        noBaselineIncluded++;
        filtered.push(row);
        continue;
      }
      const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
      if (!pid) {
        missingPlacementIdCount++;
        if (placementStatusAllowsFirstInsert(row?.PLACEMENT_STATUS, firstInsertAllowSet)) {
          noBaselineIncluded++;
          filtered.push(row);
        } else {
          newRowSkippedByPlacementStatus++;
        }
        continue;
      }
      const compositeKey = buildDealSheetPlacementCompositeKey(dsid, pid);
      const existing = latestRowsByCompositeKey.get(compositeKey);
      if (!existing) {
        if (placementStatusAllowsFirstInsert(row?.PLACEMENT_STATUS, firstInsertAllowSet)) {
          noBaselineIncluded++;
          filtered.push(row);
        } else {
          newRowSkippedByPlacementStatus++;
        }
        continue;
      }
      if (hasBusinessColumnChanges(row, existing, ignoreFieldsSet)) {
        changedIncluded++;
        const carryForward = applyManualColumnsCarryForward(row, existing);
        manualColumnsCarriedTotal += carryForward.carriedCount;
        const moveRunrateAdjusted = applyMoveRunrateAppendOverride(carryForward.row, existing);
        const withRejectedReset = applyIsRejectedResetForChangedUpdate(moveRunrateAdjusted.row, existing);
        if (moveRunrateAdjusted.forcedFalse) moveRunrateForcedFalse++;
        if (moveRunrateAdjusted.keptNull) moveRunrateKeptNull++;
        if (withRejectedReset?.IS_REJECTED === "False") isRejectedResetCount++;
        filtered.push(withRejectedReset);
        continue;
      }
      unchangedSkipped++;
    }
    rowsToInsert = filtered;
    logLine(
      `[enriched sync] [BigQuery insertAll] append-on-change(DEAL_SHEET_ID+PLACEMENT_ID): changedIncluded=${changedIncluded} noBaselineIncluded=${noBaselineIncluded} newRowSkippedByPlacementStatus=${newRowSkippedByPlacementStatus} missingPlacementIdCount=${missingPlacementIdCount} moveRunrateForcedFalse=${moveRunrateForcedFalse} moveRunrateKeptNull=${moveRunrateKeptNull} unchangedSkipped=${unchangedSkipped} remaining=${rowsToInsert.length}`
      + ` isRejectedResetCount=${isRejectedResetCount} manualColumnsCarriedTotal=${manualColumnsCarriedTotal}`
    );
  }

  if (!rowsToInsert || rowsToInsert.length === 0) {
    logLine(`[enriched sync] [BigQuery insertAll] SKIP: all rows filtered by dedupe rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const beforeTrainingFilter = rowsToInsert.length;
  rowsToInsert = rowsToInsert.filter((r) => !shouldExcludeRowFromBigQuery(r));
  const droppedTraining = beforeTrainingFilter - rowsToInsert.length;
  if (droppedTraining > 0) {
    logLine(
      `[enriched sync] [BigQuery insertAll] training/dummy filter: dropped=${droppedTraining} remaining=${rowsToInsert.length}`
    );
  }

  if (!rowsToInsert.length) {
    logLine(`[enriched sync] [BigQuery insertAll] SKIP: all rows filtered by training/dummy rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  // Phase B: allocate Firestore-backed CONTRACT_IDs only for rows that will
  // actually be inserted (defer allocation pattern). Rows already carrying a
  // CONTRACT_ID from Phase A (resolveContractIdsForRows) are left untouched.
  // Lazy require to avoid module-load circular dependency with contractIdResolver.
  const { allocateContractIdsForInsertableRows } = require("./contractIdResolver");
  await allocateContractIdsForInsertableRows(rowsToInsert);

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "";
  if (generatedUuidField) {
    rowsToInsert = rowsToInsert.map((row) => {
      const next = { ...row };
      const raw = next[generatedUuidField];
      const existing = raw == null ? "" : String(raw).trim();
      if (!existing) next[generatedUuidField] = randomUUID();
      return next;
    });
  }

  const result = await insertAll(rowsToInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logLine(
    `[enriched sync] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Partition enriched rows by ASSIGNMENT_RECRUITER_EMAIL domain and insert each group into its table.
 */
async function insertEnrichedDealSheetBatchRouted(combinedRows, insertIdBase, options = {}) {
  if (!combinedRows || combinedRows.length === 0) {
    logLine(`[enriched sync] [BigQuery insertAll] routed SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const groups = new Map();
  const resolveTableId =
    typeof options.resolveTableId === "function"
      ? options.resolveTableId
      : (row) => resolveActiveDealSheetTableId(row?.ASSIGNMENT_RECRUITER_EMAIL);
  for (const row of combinedRows) {
    const tid = resolveTableId(row);
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(row);
  }

  let inserted = 0;
  let attempted = 0;
  let errorBatches = 0;
  let base = insertIdBase;
  const parts = [];
  for (const [tableId, rows] of groups) {
    parts.push(`${tableId}=${rows.length}`);
    const r = await insertEnrichedDealSheetBatch(rows, base, { ...options, tableId });
    inserted += r.inserted;
    attempted += r.attempted;
    errorBatches += r.errorBatches;
    base += r.attempted;
  }
  if (groups.size > 1) {
    logLine(`[enriched sync] [BigQuery insertAll] routed partitions: ${parts.join(", ")}`);
  }

  return { inserted, attempted, errorBatches };
}

/**
 * Insert rate-change logs (only RATE_CHANGE === YES; defense in depth vs transform in syncService).
 */
async function insertRateChangeLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[rate-change logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const beforeYesFilter = logRows.length;
  logRows = logRows.filter((r) => String(r?.RATE_CHANGE ?? "").trim().toUpperCase() === "YES");
  const droppedNonYes = beforeYesFilter - logRows.length;
  if (droppedNonYes > 0) {
    logLine(`[rate-change logs] RATE_CHANGE=YES only: dropped=${droppedNonYes} non-YES row(s)`);
  }
  if (logRows.length === 0) {
    logLine(`[rate-change logs] [BigQuery insertAll] SKIP: no YES rows after filter`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const seenDs = new Set();
  let deduped = [];
  let droppedDupBatch = 0;
  for (const row of logRows) {
    const ds =
      row?.DEAL_SHEET_ID == null || String(row.DEAL_SHEET_ID).trim() === ""
        ? null
        : String(row.DEAL_SHEET_ID).trim();
    if (ds != null) {
      if (seenDs.has(ds)) {
        droppedDupBatch++;
        continue;
      }
      seenDs.add(ds);
    }
    deduped.push(row);
  }
  if (droppedDupBatch > 0) {
    logLine(`[rate-change logs] dedupe(same batch DEAL_SHEET_ID): dropped=${droppedDupBatch} remaining=${deduped.length}`);
  }

  const skipExistingDealSheets = options.skipExistingDealSheets === true;
  if (skipExistingDealSheets && deduped.length > 0) {
    const ids = [];
    for (const row of deduped) {
      const id = row?.DEAL_SHEET_ID;
      if (id != null && String(id).trim() !== "") {
        ids.push(String(id).trim());
      }
    }
    const existingIds = await fetchExistingDealSheetIdsSet(ids, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingIds.size > 0) {
      const filtered = [];
      let skipped = 0;
      for (const row of deduped) {
        const dsid = row?.DEAL_SHEET_ID;
        const key = dsid == null ? "" : String(dsid).trim();
        if (key !== "" && existingIds.has(key)) {
          skipped++;
          continue;
        }
        filtered.push(row);
      }
      deduped = filtered;
      logLine(
        `[rate-change logs] [BigQuery insertAll] dedupe(existing DEAL_SHEET_ID in log table): skipped=${skipped} remaining=${deduped.length}`
      );
    }
  }

  const beforeTraining = deduped.length;
  deduped = deduped.filter((r) => !shouldExcludeRowFromBigQuery(r));
  const droppedTraining = beforeTraining - deduped.length;
  if (droppedTraining > 0) {
    logLine(
      `[rate-change logs] training/dummy filter: dropped=${droppedTraining} remaining=${deduped.length}`
    );
  }

  if (!deduped.length) {
    logLine(`[rate-change logs] [BigQuery insertAll] SKIP: all rows filtered by training/dummy rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const result = await insertAll(deduped, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "RATE_CHANGE_LOG_ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logLine(
    `[rate-change logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Insert additional-cost line-item audit logs (append-only snapshot per sync run).
 */
async function insertAdditionalCostLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[additional-cost logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "ID";
  let rowsToInsert = logRows;
  if (generatedUuidField) {
    rowsToInsert = logRows.map((row) => {
      const next = { ...row };
      const raw = next[generatedUuidField];
      const existing = raw == null ? "" : String(raw).trim();
      if (!existing) next[generatedUuidField] = randomUUID();
      return next;
    });
  }

  const result = await insertAll(rowsToInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logLine(
    `[additional-cost logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Get row count from deal sheet table (optional dataset/table override).
 * @param {object} [options] - `{ datasetId?, tableId? }` merged with config defaults
 * @returns {Promise<number|null>}
 */
async function getDealSheetRowCount(options = {}) {
  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const sql = `SELECT COUNT(1) AS row_count FROM \`${config.projectId}.${datasetId}.${tableId}\``;
  const rows = await queryObjects(sql, 1);
  const n = rows?.[0]?.row_count;
  return n == null ? null : Number(n);
}

/**
 * Sum of row counts across all domain-routed active deal sheet tables (bootstrap vs expanded submittal codes).
 * @param {object} [options]
 * @param {string} [options.datasetId]
 * @returns {Promise<number|null>}
 */
async function getActiveDealSheetTotalRowCount(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const sumExpr = ACTIVE_DEAL_SHEET_TABLE_IDS.map(
    (tid) => `(SELECT COUNT(1) FROM \`${config.projectId}.${datasetId}.${tid}\`)`
  ).join(" + ");
  const sql = `SELECT ${sumExpr} AS row_count`;
  const rows = await queryObjects(sql, 1);
  const n = rows?.[0]?.row_count;
  return n == null ? null : Number(n);
}

/**
 * Update-sync targets: one row per DEAL_SHEET_ID (latest row); PLACEMENT_ID-only when DEAL_SHEET_ID is null.
 * @param {object} [options]
 * @param {string} [options.datasetId]
 * @returns {Promise<Array<{deal_sheet_id: string|null, placement_id: string|null, table_id: string}>>}
 */
async function fetchActiveDealSheetUpdateTargets(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const out = [];
  const seenDealSheets = new Set();
  const seenPlacementFallback = new Set();

  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const sqlByDealSheet = `SELECT
      CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
      CAST(PLACEMENT_ID AS STRING) AS placement_id
    FROM (
      SELECT
        DEAL_SHEET_ID,
        PLACEMENT_ID,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(DEAL_SHEET_ID AS STRING)
          ORDER BY DATE_AND_TIME DESC NULLS LAST
        ) AS _rn
      FROM \`${config.projectId}.${datasetId}.${tableId}\`
      WHERE DEAL_SHEET_ID IS NOT NULL
    )
    WHERE _rn = 1`;

    const rowsByDs = await queryObjects(sqlByDealSheet, 500000);
    for (const row of rowsByDs) {
      const deal_sheet_id = row?.deal_sheet_id == null ? "" : String(row.deal_sheet_id).trim();
      if (!deal_sheet_id) continue;
      const dedupeKey = `ds|${deal_sheet_id}`;
      if (seenDealSheets.has(dedupeKey)) continue;
      seenDealSheets.add(dedupeKey);
      const placement_id = row?.placement_id == null ? null : String(row.placement_id).trim() || null;
      out.push({ deal_sheet_id, placement_id, table_id: tableId });
    }

    const sqlByPlacementFallback = `SELECT
      CAST(PLACEMENT_ID AS STRING) AS placement_id
    FROM (
      SELECT
        PLACEMENT_ID,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(PLACEMENT_ID AS STRING)
          ORDER BY DATE_AND_TIME DESC NULLS LAST
        ) AS _rn
      FROM \`${config.projectId}.${datasetId}.${tableId}\`
      WHERE DEAL_SHEET_ID IS NULL AND PLACEMENT_ID IS NOT NULL
    )
    WHERE _rn = 1`;

    const rowsByPid = await queryObjects(sqlByPlacementFallback, 500000);
    for (const row of rowsByPid) {
      const placement_id = row?.placement_id == null ? "" : String(row.placement_id).trim();
      if (!placement_id) continue;
      const dedupeKey = `pid|${placement_id}`;
      if (seenPlacementFallback.has(dedupeKey)) continue;
      seenPlacementFallback.add(dedupeKey);
      out.push({ deal_sheet_id: null, placement_id, table_id: tableId });
    }
  }

  logLine(
    `[BigQuery] fetchActiveDealSheetUpdateTargets dataset=${datasetId} tables=${ACTIVE_DEAL_SHEET_TABLE_IDS.length} targets=${out.length} byDealSheet=${seenDealSheets.size} placementFallback=${seenPlacementFallback.size}`
  );
  return out;
}

/** Union of existing IDs across all active domain tables (for pre-enrich candidate filters). */
async function fetchExistingDealSheetIdsSetAnyActiveTable(dealSheetIds, options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const out = new Set();
  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const part = await fetchExistingDealSheetIdsSet(dealSheetIds, { datasetId, tableId });
    for (const id of part) out.add(id);
  }
  return out;
}

/** Union of existing placement IDs across all active domain tables. */
async function fetchExistingPlacementIdsSetAnyActiveTable(placementIds, options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const out = new Set();
  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const part = await fetchExistingPlacementIdsSet(placementIds, { datasetId, tableId });
    for (const id of part) out.add(id);
  }
  return out;
}

/** @deprecated Use fetchActiveDealSheetUpdateTargets */
async function fetchLatestActiveDealSheetPlacementPairs(options = {}) {
  return fetchActiveDealSheetUpdateTargets(options);
}

/**
 * Fetch distinct placement IDs from source table
 */
async function fetchDistinctPlacementIdsFromTable(options = {}) {
  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const lookbackDaysRaw = Number(options.lookbackDays);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0 ? Math.trunc(lookbackDaysRaw) : 0;
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 0;
  const whereLookback =
    lookbackDays > 0
      ? `AND DATE_AND_TIME >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lookbackDays} DAY)`
      : "";
  const sql = `SELECT DISTINCT CAST(PLACEMENT_ID AS STRING) AS placement_id
               FROM \`${config.projectId}.${datasetId}.${tableId}\`
               WHERE PLACEMENT_ID IS NOT NULL
               ${whereLookback}
               ${limit > 0 ? `LIMIT ${limit}` : ""}`;
  logLine(
    `[active->ended] [BigQuery] fetchDistinctPlacementIds table=${config.projectId}.${datasetId}.${tableId} lookbackDays=${lookbackDays || "none"} limit=${limit || "none"}`
  );
  const rows = await queryObjects(sql, limit > 0 ? limit : 200000);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const pid = row?.placement_id == null ? "" : String(row.placement_id).trim();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
  }
  logLine(`[active->ended] [BigQuery] fetchDistinctPlacementIds done count=${out.length}`);
  return out;
}

/**
 * Fetch latest active row per placement ID from source table
 */
async function fetchLatestRowsByPlacementIds(placementIds, options = {}) {
  if (!placementIds || placementIds.length === 0) return [];
  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const uniq = [];
  const seen = new Set();
  for (const id of placementIds) {
    const s = id == null ? "" : String(id).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (!uniq.length) return [];
  logLine(
    `[active->ended] [BigQuery] fetchLatestRowsByPlacementIds source=${config.projectId}.${datasetId}.${tableId} placementCount=${uniq.length}`
  );
  const out = [];
  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT * EXCEPT(_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(PLACEMENT_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})
                 )
                 WHERE _rn = 1`;
    const rows = await queryObjects(sql, chunk.length * 2);
    out.push(...rows);
  }
  logLine(`[active->ended] [BigQuery] fetchLatestRowsByPlacementIds done rows=${out.length}`);
  return out;
}

/**
 * Upsert ended rows (idempotent by placement id).
 * Existing placement IDs are treated as updates and skipped for insert.
 */
async function upsertEndedRecordsByPlacementId(rows, insertIdBase, options = {}) {
  if (!rows || rows.length === 0) {
    logLine(`[active->ended] [BigQuery] upsertEndedRecords SKIP: no rows`);
    return { attempted: 0, inserted: 0, updated: 0, errors: [] };
  }
  const placementIds = [];
  for (const row of rows) {
    const pid = row?.PLACEMENT_ID;
    if (pid == null || String(pid).trim() === "") continue;
    placementIds.push(String(pid).trim());
  }
  const existingByPlacement = await fetchPlacementStatusesByPlacementIds(placementIds, {
    datasetId: options.datasetId,
    tableId: options.tableId,
  });
  const toInsert = [];
  let updated = 0;
  for (const row of rows) {
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    if (!pid) continue;
    if (existingByPlacement.has(pid)) {
      updated++;
      continue;
    }
    toInsert.push(row);
  }
  const insertedResult =
    toInsert.length > 0
      ? await insertAll(toInsert, {
          insertIdBase,
          datasetId: options.datasetId,
          tableId: options.tableId,
        })
      : { inserted: 0, attempted: 0, errors: [] };
  logLine(
    `[active->ended] [BigQuery] upsertEndedRecords attempted=${rows.length} inserted=${insertedResult.inserted} updated=${updated} target=${config.projectId}.${options.datasetId || config.datasetId}.${options.tableId || config.tableId}`
  );
  return {
    attempted: rows.length,
    inserted: insertedResult.inserted,
    updated,
    errors: insertedResult.errors || [],
  };
}

/**
 * Delete source-active rows for placements that already exist in ended table.
 * Use safetyAgeHours to avoid streaming buffer mutations for recent rows.
 */
async function deleteActiveRowsMatchedInEnded(options = {}) {
  const source = resolveBqDatasetTable({
    datasetId: options.sourceDatasetId,
    tableId: options.sourceTableId,
  });
  const target = resolveBqDatasetTable({
    datasetId: options.targetDatasetId,
    tableId: options.targetTableId,
  });
  const safetyAgeHoursRaw = Number(options.safetyAgeHours);
  const safetyAgeHours = Number.isFinite(safetyAgeHoursRaw) && safetyAgeHoursRaw > 0 ? Math.trunc(safetyAgeHoursRaw) : 0;
  const whereAge =
    safetyAgeHours > 0
      ? `AND a.DATE_AND_TIME < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safetyAgeHours} HOUR)`
      : "";
  const dryRun = options.dryRun === true;
  const sqlCount = `SELECT COUNT(1) AS row_count
                    FROM \`${config.projectId}.${source.datasetId}.${source.tableId}\` a
                    WHERE EXISTS (
                      SELECT 1
                      FROM \`${config.projectId}.${target.datasetId}.${target.tableId}\` e
                      WHERE CAST(e.PLACEMENT_ID AS STRING) = CAST(a.PLACEMENT_ID AS STRING)
                    )
                    ${whereAge}`;
  const countRows = await queryObjects(sqlCount, 1);
  const rowCount = Number(countRows?.[0]?.row_count || 0);
  logLine(
    `[active->ended] [BigQuery] cleanup candidates source=${config.projectId}.${source.datasetId}.${source.tableId} target=${config.projectId}.${target.datasetId}.${target.tableId} safetyAgeHours=${safetyAgeHours || "none"} matched=${rowCount} dryRun=${dryRun ? "yes" : "no"}`
  );
  if (dryRun || rowCount === 0) return { attempted: rowCount, deleted: 0, dryRun };
  const sqlDelete = `DELETE FROM \`${config.projectId}.${source.datasetId}.${source.tableId}\` a
                     WHERE EXISTS (
                       SELECT 1
                       FROM \`${config.projectId}.${target.datasetId}.${target.tableId}\` e
                       WHERE CAST(e.PLACEMENT_ID AS STRING) = CAST(a.PLACEMENT_ID AS STRING)
                     )
                     ${whereAge}`;
  await bigquery.query({ query: sqlDelete });
  logLine(`[active->ended] [BigQuery] cleanup delete done deleted=${rowCount}`);
  return { attempted: rowCount, deleted: rowCount, dryRun: false };
}

/**
 * Format a date-like value as YYYY-MM-DD for BigQuery DATE literals.
 * @param {Date|string|object|null} value
 * @returns {string|null}
 */
function formatDateOnlyForSql(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Build UNION ALL SQL over all active domain deal sheet tables.
 * @param {string} datasetId
 * @returns {string}
 */
function buildActiveDealSheetsUnionSql(datasetId) {
  return ACTIVE_DEAL_SHEET_TABLE_IDS.map(
    (tableId) =>
      `SELECT DEAL_SHEET_ID, PLACEMENT_ID, CONTRACT_ID, START_DATE, EDIT_DATE, CANDIDATE_NEXUS_ID, CANDIDATE_EMAIL, PHONE_NUMBER, NEXUS_INTERNAL_JOB_ID, CLIENT_ID, DEAL_TYPE FROM \`${config.projectId}.${datasetId}.${tableId}\``
  ).join(" UNION ALL ");
}

/**
 * Latest non-null CONTRACT_ID per DEAL_SHEET_ID across active domain tables.
 * @param {Array<string|number>} dealSheetIds
 * @param {object} [options]
 * @returns {Promise<Map<string, number>>} dealSheetId string -> contract id
 */
async function fetchContractIdsByDealSheetIds(dealSheetIds, options = {}) {
  const out = new Map();
  if (!dealSheetIds || dealSheetIds.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const unionSql = buildActiveDealSheetsUnionSql(datasetId);

  const uniq = [];
  const seen = new Set();
  for (const id of dealSheetIds) {
    if (id == null || String(id).trim() === "") continue;
    const s = String(id).trim();
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `
      WITH all_rows AS (
        ${unionSql}
      ),
      ranked AS (
        SELECT
          CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
          CONTRACT_ID AS contract_id,
          ROW_NUMBER() OVER (
            PARTITION BY DEAL_SHEET_ID
            ORDER BY EDIT_DATE DESC
          ) AS rn
        FROM all_rows
        WHERE CAST(DEAL_SHEET_ID AS STRING) IN (${inList})
          AND CONTRACT_ID IS NOT NULL
      )
      SELECT deal_sheet_id, contract_id
      FROM ranked
      WHERE rn = 1
    `;
    const rows = await queryObjects(sql, chunk.length);
    for (const row of rows) {
      const dsid = row?.deal_sheet_id;
      const cid = row?.contract_id;
      if (dsid == null || String(dsid).trim() === "") continue;
      if (cid == null || !Number.isFinite(Number(cid))) continue;
      out.set(String(dsid).trim(), Math.trunc(Number(cid)));
    }
  }

  return out;
}

/**
 * For EXTENSION rows, find original DEAL CONTRACT_ID across active tables.
 * @param {Array<{placementId: number, candidateNexusId: number, candidateEmail?: string|null, phoneNumber?: string|null, jobId: number, clientId: number, startDate?: *}>} extensionRows
 * @param {object} [options]
 * @returns {Promise<Map<string, number|null>>} placementId string -> contract id or null
 */
async function fetchContractIdsForExtensions(extensionRows, options = {}) {
  const out = new Map();
  if (!extensionRows || extensionRows.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const unionSql = buildActiveDealSheetsUnionSql(datasetId);
  const chunkSize = 100;

  for (let i = 0; i < extensionRows.length; i += chunkSize) {
    const chunk = extensionRows.slice(i, i + chunkSize);
    const structLiterals = [];

    for (const ext of chunk) {
      const pid = Number(ext.placementId);
      const cand = Number(ext.candidateNexusId);
      const job = Number(ext.jobId);
      const client = Number(ext.clientId);
      if (!Number.isFinite(pid) || !Number.isFinite(cand) || !Number.isFinite(job)) continue;
      if (!Number.isFinite(client)) continue;

      const email = escapeSqlString(
        ext.candidateEmail == null ? "" : String(ext.candidateEmail).trim().toLowerCase()
      );
      const phone = escapeSqlString(
        ext.phoneNumber == null ? "" : String(ext.phoneNumber).trim()
      );
      const startDateSql = (() => {
        const d = formatDateOnlyForSql(ext.startDate);
        return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
      })();

      structLiterals.push(
        `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, '${email}' AS candidate_email, '${phone}' AS phone_number, ${Math.trunc(job)} AS nexus_internal_job_id, ${Math.trunc(client)} AS client_id, ${startDateSql} AS start_date)`
      );
    }

    if (structLiterals.length === 0) continue;

    // Decorrelated: BigQuery cannot run a correlated subquery in the SELECT
    // list when the inner FROM is a UNION ALL across tables, so we materialize
    // candidate DEAL rows into a CTE, LEFT JOIN them with the extensions on
    // the match key + start-date constraint, and pick the latest per
    // placement_id with ROW_NUMBER. LEFT JOIN preserves extensions with no
    // matching DEAL (they come back with contract_id = NULL = orphan).
    const sql = `
      WITH extensions AS (
        SELECT * FROM UNNEST([${structLiterals.join(", ")}])
      ),
      deals AS (
        SELECT
          CONTRACT_ID,
          CANDIDATE_NEXUS_ID,
          LOWER(IFNULL(CANDIDATE_EMAIL, '')) AS candidate_email_norm,
          IFNULL(PHONE_NUMBER, '') AS phone_norm,
          NEXUS_INTERNAL_JOB_ID,
          CLIENT_ID,
          START_DATE,
          EDIT_DATE
        FROM (${unionSql})
        WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
          AND CONTRACT_ID IS NOT NULL
      ),
      joined AS (
        SELECT
          ext.placement_id,
          d.CONTRACT_ID,
          ROW_NUMBER() OVER (
            PARTITION BY ext.placement_id
            ORDER BY d.START_DATE DESC NULLS LAST, d.EDIT_DATE DESC NULLS LAST
          ) AS rn
        FROM extensions ext
        LEFT JOIN deals d
          ON d.CANDIDATE_NEXUS_ID = ext.candidate_nexus_id
         AND d.candidate_email_norm = ext.candidate_email
         AND d.phone_norm = ext.phone_number
         AND d.NEXUS_INTERNAL_JOB_ID = ext.nexus_internal_job_id
         AND d.CLIENT_ID = ext.client_id
         AND (ext.start_date IS NULL OR d.START_DATE <= ext.start_date)
      )
      SELECT
        CAST(placement_id AS STRING) AS placement_id,
        CONTRACT_ID AS contract_id
      FROM joined
      WHERE rn = 1
    `;

    const rows = await queryObjects(sql, structLiterals.length);
    for (const row of rows) {
      const pid = row?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;
      const cid = row?.contract_id;
      out.set(
        String(pid).trim(),
        cid == null || cid === "" || !Number.isFinite(Number(cid))
          ? null
          : Math.trunc(Number(cid))
      );
    }
  }

  return out;
}

module.exports = {
  queryObjects,
  fetchExistingDealSheetIdsSet,
  fetchExistingPlacementIdsSet,
  fetchExistingDealSheetIdsSetAnyActiveTable,
  fetchExistingPlacementIdsSetAnyActiveTable,
  fetchPlacementStatusesByPlacementIds,
  fetchLatestRowsByDealSheetIds,
  fetchLatestRowsByDealSheetPlacementPairs,
  insertAll,
  insertEnrichedDealSheetBatch,
  insertEnrichedDealSheetBatchRouted,
  insertRateChangeLogBatch,
  insertAdditionalCostLogBatch,
  getDealSheetRowCount,
  getActiveDealSheetTotalRowCount,
  fetchActiveDealSheetUpdateTargets,
  fetchLatestActiveDealSheetPlacementPairs,
  computeInsertId,
  resolveBqDatasetTable,
  fetchDistinctPlacementIdsFromTable,
  fetchLatestRowsByPlacementIds,
  upsertEndedRecordsByPlacementId,
  deleteActiveRowsMatchedInEnded,
  normalizeForCompare,
  hasBusinessColumnChanges,
  resolveFirstInsertPlacementAllowlist,
  placementStatusAllowsFirstInsert,
  buildDealSheetPlacementCompositeKey,
  normalizeMoveRunrate,
  applyMoveRunrateAppendOverride,
  applyIsRejectedResetForChangedUpdate,
  applyManualColumnsCarryForward,
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
  buildActiveDealSheetsUnionSql,
  formatDateOnlyForSql,
};
