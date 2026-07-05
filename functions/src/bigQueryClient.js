/**
 * BigQuery Client
 * Handles BigQuery operations for deal sheet data
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { randomUUID } = require("crypto");
const config = require("./config");
const { logLine, logError } = require("./logger");
const { shouldExcludeRowFromBigQuery } = require("./bqRowExclusions");
const {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  ENDED_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableId,
  resolvePairedActiveTableId,
  resolveRunrateTableIdForDealSheetTable,
} = require("./recruiterDomainTables");
const {
  API_OWNED_COLUMNS,
  SYSTEM_CONTROLLED_COLUMNS,
  MANUAL_COLUMNS,
  isDidNotStartPlacementStatus,
} = require("./columnMappings");
const { isCynetHealthCanadaRecruiter, sanitizeCanadaDealSheetRow, CANADA_EXCLUDED_API_OWNED_COLUMNS } = require("./canadaDerivedPlacementFields");
const { normalizeContractIdOrNull, buildSequenceOptionsForTable } = require("./contractIdFormat");
const { allocateContractIds } = require("./contractIdSequence");
const {
  DEAL_RECRUITER_HIERARCHY_TARGETS,
  HIERARCHY_DESIGNATION_SYNONYMS,
  DESIGNATION_TO_INORGANIC_LOG_COLUMN,
  CSM_LEVEL_TARGETS,
  CSM_LEVEL_TO_INORGANIC_COLUMN,
  resolveCsmLevelsFromChain,
  resolveHierarchyColumnForTitle,
  OWNERSHIP_CHANGE_DIFF_ROLES,
} = require("./recruiterHierarchyDesignations");

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
 * Escape a value for embedding inside a single-quoted BigQuery string literal.
 * BigQuery uses BACKSLASH escaping, not SQL-standard doubled quotes — `'O''Brien'` is read as two
 * adjacent literals ("concatenated string literals must be separated by whitespace"), so a value
 * like "St. Mary's" must become 'St. Mary\'s'. Backslash is escaped first so a literal backslash
 * in the value can't form an unintended escape sequence; newline/carriage-return/tab are escaped
 * because an unescaped one would terminate a single-quoted literal. Values with none of these
 * characters (e.g. numeric IDs) pass through unchanged.
 */
function escapeSqlString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
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

/** Format DATE / wrapper for rate-change log dedupe key segment. */
function formatRateChangeEffectiveDateKey(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof value === "object" && value.value != null) {
    const s = String(value.value);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
  }
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

/** Dedupe key: CONTRACT_ID|YYYY-MM-DD (effective date of latest rate-change row). */
function buildRateChangeLogDedupeKey(row) {
  const cid = row?.CONTRACT_ID == null ? "" : String(row.CONTRACT_ID).trim();
  const eff = formatRateChangeEffectiveDateKey(row?.RATE_CHANGE_EFFECTIVE_DATE);
  if (!cid || !eff) return "";
  return `${cid}|${eff}`;
}

/**
 * Returns Set of "<CONTRACT_ID>|<YYYY-MM-DD>" keys already present in the log table.
 */
async function fetchExistingRateChangeLogContractKeysSet(contractIds, options = {}) {
  const out = new Set();
  if (!contractIds || contractIds.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const uniq = [];
  const seen = new Set();
  for (const id of contractIds) {
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
    const sql = `SELECT CONTRACT_ID, RATE_CHANGE_EFFECTIVE_DATE
                 FROM \`${config.projectId}.${datasetId}.${tableId}\`
                 WHERE CAST(CONTRACT_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length * 5);
    for (const row of rows) {
      const key = buildRateChangeLogDedupeKey(row);
      if (key) out.add(key);
    }
  }
  return out;
}

function stripRateChangeHistoryMetaFields(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  delete out._global_rn;
  delete out._table_rn;
  delete out._src_table;
  delete out._src;
  delete out.rn;
  return out;
}

/**
 * Returns Map<contractIdStr, { latest, previous }> for CONTRACT_IDs whose latest row
 * has RATE_CHANGE='YES' and at least one prior row exists (rate-change event).
 */
async function fetchContractRateChangePairsFromActive(options = {}) {
  const out = new Map();
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const src = escapeSqlString(tableId);
    return `SELECT *, '${src}' AS _src FROM ${fqn} WHERE CONTRACT_ID IS NOT NULL`;
  });

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               ),
               ranked AS (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY CONTRACT_ID
                     ORDER BY DATE_AND_TIME DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
               ),
               yes_contracts AS (
                 SELECT DISTINCT CONTRACT_ID
                 FROM ranked
                 WHERE rn = 1 AND UPPER(TRIM(CAST(RATE_CHANGE AS STRING))) = 'YES'
               )
               SELECT * FROM ranked
               WHERE rn <= 2
                 AND CONTRACT_ID IN (SELECT CONTRACT_ID FROM yes_contracts)`;

  const rows = await queryObjects(sql, 100000);
  for (const raw of rows) {
    const key = raw?.CONTRACT_ID == null ? "" : String(raw.CONTRACT_ID).trim();
    if (!key) continue;
    const rn = Number(raw.rn);
    const cleaned = stripRateChangeHistoryMetaFields(raw);
    if (!out.has(key)) {
      out.set(key, { latest: null, previous: null });
    }
    const slot = out.get(key);
    if (rn === 1) slot.latest = cleaned;
    else if (rn === 2) slot.previous = cleaned;
  }

  for (const [key, pair] of [...out.entries()]) {
    if (!pair.latest || !pair.previous) out.delete(key);
  }

  logLine(
    `[rate-change logs BQ scan] fetchContractRateChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Returns Map<dealSheetIdString, { latest, previous }> across all active domain tables.
 * latest = most recent row by DATE_AND_TIME; previous = second most recent (or null).
 */
async function fetchLatestTwoRowsByDealSheetIdsAcrossActive(dealSheetIds, options = {}) {
  const out = new Map();
  if (!dealSheetIds || dealSheetIds.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

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

  const unionParts = ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const src = escapeSqlString(tableId);
    return `SELECT * EXCEPT(_table_rn)
            FROM (
              SELECT
                *,
                '${src}' AS _src_table,
                ROW_NUMBER() OVER (
                  PARTITION BY CAST(DEAL_SHEET_ID AS STRING)
                  ORDER BY DATE_AND_TIME DESC NULLS LAST
                ) AS _table_rn
              FROM ${fqn}
              WHERE CAST(DEAL_SHEET_ID AS STRING) IN UNNEST(@ids)
            )
            WHERE _table_rn <= 2`;
  });

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const sql = `SELECT * EXCEPT(_global_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(DEAL_SHEET_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _global_rn
                   FROM (
                     ${unionParts.join("\n                     UNION ALL\n                     ")}
                   )
                 )
                 WHERE _global_rn <= 2`;

    const [rows] = await bigquery.query({
      query: sql,
      params: { ids: chunk },
    });

    for (const raw of rows) {
      const key = raw?.DEAL_SHEET_ID == null ? "" : String(raw.DEAL_SHEET_ID).trim();
      if (!key) continue;
      const rn = Number(raw._global_rn);
      const cleaned = stripRateChangeHistoryMetaFields(raw);
      if (!out.has(key)) {
        out.set(key, { latest: null, previous: null });
      }
      const slot = out.get(key);
      if (rn === 1) slot.latest = cleaned;
      else if (rn === 2) slot.previous = cleaned;
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
 * Triple-key (DEAL_SHEET_ID|PLACEMENT_ID|ADDITIONAL_COST_ID) used for log dedupe lookup.
 * All three components must be present for a valid key; missing parts yield "".
 */
function buildAdditionalCostLogCompositeKey(dealSheetId, placementId, additionalCostId) {
  const dsid = dealSheetId == null ? "" : String(dealSheetId).trim();
  const pid = placementId == null ? "" : String(placementId).trim();
  const cid = additionalCostId == null ? "" : String(additionalCostId).trim();
  if (!dsid || !pid || !cid) return "";
  return `${dsid}|${pid}|${cid}`;
}

/**
 * Returns Map<"DEAL_SHEET_ID|PLACEMENT_ID|ADDITIONAL_COST_ID", latest log row> from
 * the additional-cost log table. Used to skip writing unchanged snapshots.
 */
async function fetchLatestAdditionalCostLogRowsByKeys(logRows, options = {}) {
  const out = new Map();
  if (!logRows || logRows.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const tripleMap = new Map();
  for (const row of logRows) {
    const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    const cid = row?.ADDITIONAL_COST_ID == null ? "" : String(row.ADDITIONAL_COST_ID).trim();
    const key = buildAdditionalCostLogCompositeKey(dsid, pid, cid);
    if (!key || tripleMap.has(key)) continue;
    tripleMap.set(key, { dsid, pid, cid });
  }
  const triples = Array.from(tripleMap.values());
  if (!triples.length) return out;

  const chunkSize = 200;
  for (let i = 0; i < triples.length; i += chunkSize) {
    const chunk = triples.slice(i, i + chunkSize);
    const wherePairs = chunk
      .map(
        ({ dsid, pid, cid }) =>
          `(CAST(DEAL_SHEET_ID AS STRING) = '${escapeSqlString(dsid)}' AND ` +
          `CAST(PLACEMENT_ID AS STRING) = '${escapeSqlString(pid)}' AND ` +
          `CAST(ADDITIONAL_COST_ID AS STRING) = '${escapeSqlString(cid)}')`
      )
      .join(" OR ");
    const sql = `SELECT * EXCEPT(_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING), CAST(ADDITIONAL_COST_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    const dbRows = await queryObjects(sql, chunk.length * 2);
    for (const row of dbRows) {
      const key = buildAdditionalCostLogCompositeKey(
        row?.DEAL_SHEET_ID,
        row?.PLACEMENT_ID,
        row?.ADDITIONAL_COST_ID
      );
      if (!key) continue;
      out.set(key, row);
    }
  }
  return out;
}

/**
 * Pair-key (PLACEMENT_ID|TERMINATION_DETAIL_ID) used for termination log dedupe lookup.
 */
function buildTerminationReasonLogCompositeKey(placementId, terminationDetailId) {
  const pid = placementId == null ? "" : String(placementId).trim();
  const tid = terminationDetailId == null ? "" : String(terminationDetailId).trim();
  if (!pid || !tid) return "";
  return `${pid}|${tid}`;
}

/**
 * Returns Map<"PLACEMENT_ID|TERMINATION_DETAIL_ID", latest log row> from termination log table.
 */
async function fetchLatestTerminationReasonLogRowsByKeys(logRows, options = {}) {
  const out = new Map();
  if (!logRows || logRows.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const pairMap = new Map();
  for (const row of logRows) {
    const key = buildTerminationReasonLogCompositeKey(row?.PLACEMENT_ID, row?.TERMINATION_DETAIL_ID);
    if (!key || pairMap.has(key)) continue;
    pairMap.set(key, {
      pid: row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim(),
      tid: row?.TERMINATION_DETAIL_ID == null ? "" : String(row.TERMINATION_DETAIL_ID).trim(),
    });
  }
  const pairs = Array.from(pairMap.values());
  if (!pairs.length) return out;

  const chunkSize = 200;
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const chunk = pairs.slice(i, i + chunkSize);
    const wherePairs = chunk
      .map(
        ({ pid, tid }) =>
          `(CAST(PLACEMENT_ID AS STRING) = '${escapeSqlString(pid)}' AND ` +
          `CAST(TERMINATION_DETAIL_ID AS STRING) = '${escapeSqlString(tid)}')`
      )
      .join(" OR ");
    const sql = `SELECT * EXCEPT(_rn)
                 FROM (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY CAST(PLACEMENT_ID AS STRING), CAST(TERMINATION_DETAIL_ID AS STRING)
                       ORDER BY DATE_AND_TIME DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    const dbRows = await queryObjects(sql, chunk.length * 2);
    for (const row of dbRows) {
      const key = buildTerminationReasonLogCompositeKey(row?.PLACEMENT_ID, row?.TERMINATION_DETAIL_ID);
      if (!key) continue;
      out.set(key, row);
    }
  }
  return out;
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
  const isCanada = isCynetHealthCanadaRecruiter(incomingRow?.ASSIGNMENT_RECRUITER_EMAIL);
  if (isCanada) {
    if (normalizeForCompare(incomingRow?.TYPE) !== normalizeForCompare(existingRow?.TYPE)) {
      return true;
    }
  }
  for (const key of API_OWNED_COLUMNS) {
    if (ignoreFieldsSet && ignoreFieldsSet.has(key)) continue;
    if (isCanada && CANADA_EXCLUDED_API_OWNED_COLUMNS.has(key)) continue;
    const incomingVal = normalizeForCompare(incomingRow?.[key]);
    const existingVal = normalizeForCompare(existingRow?.[key]);
    if (incomingVal !== existingVal) return true;
  }
  if (!config.newHireDateFreezeEnabled) {
    const dealType = incomingRow?.DEAL_TYPE == null
      ? ""
      : String(incomingRow.DEAL_TYPE).trim().toUpperCase();
    if (dealType === "DEAL") {
      const incomingNhd = normalizeForCompare(incomingRow?.NEW_HIRE_DATE);
      const existingNhd = normalizeForCompare(existingRow?.NEW_HIRE_DATE);
      if (incomingNhd !== existingNhd) return true;
    }
  }
  if (isDidNotStartPlacementStatus(incomingRow?.PLACEMENT_STATUS)) {
    const incomingTent = normalizeForCompare(incomingRow?.TENTATIVE_DATE);
    const existingTent = normalizeForCompare(existingRow?.TENTATIVE_DATE);
    if (incomingTent !== existingTent) return true;
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
 * Copy explicit MANUAL_COLUMNS from baseline onto incoming before append-on-change insert.
 * Strips enrich-spread manual keys first so baseline always wins (incl. null).
 */
function applyManualColumnsCarryForward(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, carriedCount: 0 };
  }
  const isCanada = isCynetHealthCanadaRecruiter(incomingRow?.ASSIGNMENT_RECRUITER_EMAIL);
  const out = { ...incomingRow };
  for (const key of MANUAL_COLUMNS) {
    if (isCanada && key === "TYPE") continue;
    delete out[key];
  }
  let carriedCount = 0;
  for (const key of MANUAL_COLUMNS) {
    if (isCanada && key === "TYPE") continue;
    out[key] = Object.prototype.hasOwnProperty.call(baselineRow, key)
      ? baselineRow[key]
      : null;
    carriedCount++;
  }
  return { row: out, carriedCount };
}

/**
 * Freeze TENTATIVE_DATE from baseline when START_DATE is unchanged; keep incoming
 * API value when START_DATE changed (then freeze again on subsequent same-start runs).
 * DID NOT START always clears TENTATIVE_DATE (no baseline carry-forward).
 */
function applyTentativeDateFreeze(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (isDidNotStartPlacementStatus(incomingRow?.PLACEMENT_STATUS)) {
    return { row: { ...incomingRow, TENTATIVE_DATE: null }, frozen: false };
  }
  const incomingStart = normalizeForCompare(incomingRow.START_DATE);
  const baselineStart = normalizeForCompare(baselineRow.START_DATE);
  if (incomingStart === baselineStart) {
    return {
      row: { ...incomingRow, TENTATIVE_DATE: baselineRow.TENTATIVE_DATE },
      frozen: true,
    };
  }
  return { row: incomingRow, frozen: false };
}

/**
 * On an update-append where ASSIGNMENT_RECRUITER_EMAIL changed vs baseline, stamp the OUTGOING
 * recruiter's identity onto PREVIOUS_RECRUITER_NAME/EMAIL/EMP_NO from the baseline row. When the
 * recruiter is unchanged these columns are left as-is (they are MANUAL_COLUMNS, so already carried
 * forward from baseline by applyManualColumnsCarryForward before this runs).
 */
function applyPreviousRecruiterOnRecruiterChange(incomingRow, baselineRow) {
  if (!incomingRow || typeof incomingRow !== "object") return { row: incomingRow, changed: false };
  if (!baselineRow || typeof baselineRow !== "object") return { row: incomingRow, changed: false };
  const normEmail = (v) => (v == null ? "" : String(v).trim().toLowerCase());
  const incEmail = normEmail(incomingRow.ASSIGNMENT_RECRUITER_EMAIL);
  const baseEmail = normEmail(baselineRow.ASSIGNMENT_RECRUITER_EMAIL);
  if (baseEmail === "" || incEmail === baseEmail) return { row: incomingRow, changed: false };
  return {
    row: {
      ...incomingRow,
      PREVIOUS_RECRUITER_NAME: baselineRow.ASSIGNMENT_RECRUITER ?? null,
      PREVIOUS_RECRUITER_EMAIL: baselineRow.ASSIGNMENT_RECRUITER_EMAIL ?? null,
      PREVIOUS_RECRUITER_EMP_NO: baselineRow.RECRUITER_EMP_NO ?? null,
    },
    changed: true,
  };
}

/**
 * Freeze NEW_HIRE_DATE from baseline when present (immutable once set; DEAL and EXTENSION).
 * Skipped when config.newHireDateFreezeEnabled is false (migration backfill).
 */
function applyNewHireDateFreeze(incomingRow, baselineRow) {
  if (!config.newHireDateFreezeEnabled) {
    return { row: incomingRow, frozen: false };
  }
  if (!incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (!baselineRow || typeof baselineRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (isEmptyDateFieldValue(baselineRow.NEW_HIRE_DATE)) {
    return { row: incomingRow, frozen: false };
  }
  return {
    row: { ...incomingRow, NEW_HIRE_DATE: baselineRow.NEW_HIRE_DATE },
    frozen: true,
  };
}

function normalizeDealTypeKey(dealType) {
  if (dealType == null) return "";
  return String(dealType).trim().toUpperCase();
}

/**
 * EXTENSION_START_DATE mirrors START_DATE for EXTENSION rows; null otherwise.
 */
function applyExtensionStartDateForRow(row) {
  if (!row || typeof row !== "object") return row;
  if (normalizeDealTypeKey(row.DEAL_TYPE) === "EXTENSION") {
    return { ...row, EXTENSION_START_DATE: row.START_DATE ?? null };
  }
  return { ...row, EXTENSION_START_DATE: null };
}

/**
 * Freeze EXTENSION_DATE from baseline when present (immutable once set).
 */
function applyExtensionDateFreeze(incomingRow, baselineRow) {
  if (!incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (!baselineRow || typeof baselineRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (isEmptyDateFieldValue(baselineRow.EXTENSION_DATE)) {
    return { row: incomingRow, frozen: false };
  }
  return {
    row: { ...incomingRow, EXTENSION_DATE: baselineRow.EXTENSION_DATE },
    frozen: true,
  };
}

/**
 * Apply EXTENSION_START_DATE from START_DATE on rows about to insert.
 */
function applyExtensionStartDatesForInsertRows(rows) {
  if (!rows || rows.length === 0) return rows;
  return rows.map((row) => applyExtensionStartDateForRow(row));
}

/**
 * Latest NEW_HIRE_DATE per DEAL_SHEET_ID+PLACEMENT_ID from paired active table.
 * @param {object[]} rows
 * @param {object} options - datasetId, tableId (ended table)
 * @returns {Promise<Map<string, string>>}
 */
async function fetchNewHireDatesFromActiveTable(rows, options = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const activeTableId = resolvePairedActiveTableId(tableId);
  if (!activeTableId) return out;

  const latestByKey = await fetchLatestRowsByDealSheetPlacementPairs(rows, {
    datasetId,
    tableId: activeTableId,
  });
  for (const [key, row] of latestByKey) {
    if (isEmptyDateFieldValue(row?.NEW_HIRE_DATE)) continue;
    out.set(key, String(row.NEW_HIRE_DATE));
  }
  return out;
}

/**
 * For ended-table inserts, inherit NEW_HIRE_DATE from active when placement already exists there.
 * @param {object[]} rows
 * @param {object} options
 * @returns {Promise<object[]>}
 */
async function resolveNewHireDatesForEndedRows(rows, options = {}) {
  if (!rows || rows.length === 0) return rows;

  const { tableId } = resolveBqDatasetTable(options);
  const endedTableId = tableId == null ? "" : String(tableId).trim();
  if (!ENDED_DEAL_SHEET_TABLE_IDS.includes(endedTableId)) return rows;

  const needsLookup = [];
  for (const row of rows) {
    const dealType = row?.DEAL_TYPE == null ? "" : String(row.DEAL_TYPE).trim().toUpperCase();
    if (dealType !== "DEAL") continue;
    if (!isEmptyDateFieldValue(row.NEW_HIRE_DATE)) continue;
    needsLookup.push(row);
  }
  if (needsLookup.length === 0) return rows;

  const lookedUp = await fetchNewHireDatesFromActiveTable(needsLookup, options);
  let inheritedCount = 0;
  let stillEmptyCount = 0;
  for (const row of needsLookup) {
    const key = buildDealSheetPlacementCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID);
    if (!key) {
      stillEmptyCount++;
      continue;
    }
    const fromActive = lookedUp.get(key);
    if (fromActive == null || fromActive === "") {
      stillEmptyCount++;
      continue;
    }
    row.NEW_HIRE_DATE = fromActive;
    inheritedCount++;
  }
  logLine(
    `[enriched sync] [BigQuery insertAll] ended NEW_HIRE_DATE inherit from active: inherited=${inheritedCount} stillEmpty=${stillEmptyCount}`
  );
  return rows;
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
    if (k === "_rn" || k === "_INSERT_ID" || k === "rn" || k === "_src" || k === "_src_table") continue;
    const inner = sanitizeValueForStreamingInsert(v);
    if (inner !== undefined) out[k] = inner;
  }
  return sanitizeCanadaDealSheetRow(out);
}

function isEmptyDateFieldValue(value) {
  if (value == null) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function formatDateInTimeZone(dateTime, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(dateTime));
}

/**
 * Reserved for insert-time date stamps. EXTENSION_DATE is set during enrich from submittal created_date.
 * NEW_HIRE_DATE is sourced from job-submittal-notes during enrich (not stamped here).
 * @returns {Record<string, string>} fields to merge into insert json (may be empty)
 */
function computeDealSheetFirstInsertDateStamps() {
  return {};
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
    let json = {
      ...clean,
      DATE_AND_TIME: dateTime,
    };
    if (options.applyDealSheetDateStamps === true) {
      Object.assign(json, computeDealSheetFirstInsertDateStamps(clean, dateTime));
    }
    return {
      insertId: computeInsertId(clean, options.insertIdBase + idx, {
        insertIdField: options.insertIdField,
      }),
      json,
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
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
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
    let tentativeFrozenCount = 0;
    let newHireFrozenCount = 0;
    let extensionFrozenCount = 0;
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
        const previousRecruiterAdjusted = applyPreviousRecruiterOnRecruiterChange(carryForward.row, existing);
        const tentativeAdjusted = applyTentativeDateFreeze(previousRecruiterAdjusted.row, existing);
        if (tentativeAdjusted.frozen) tentativeFrozenCount++;
        const newHireAdjusted = applyNewHireDateFreeze(tentativeAdjusted.row, existing);
        if (newHireAdjusted.frozen) newHireFrozenCount++;
        const extensionAdjusted = applyExtensionDateFreeze(newHireAdjusted.row, existing);
        if (extensionAdjusted.frozen) extensionFrozenCount++;
        const moveRunrateAdjusted = applyMoveRunrateAppendOverride(extensionAdjusted.row, existing);
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
      + ` tentativeFrozenCount=${tentativeFrozenCount}`
      + ` newHireFrozenCount=${newHireFrozenCount}`
      + ` extensionFrozenCount=${extensionFrozenCount}`
    );
  }

  rowsToInsert = await applyExtensionInheritForInsertRows(
    rowsToInsert,
    resolveBqDatasetTable(options)
  );

  rowsToInsert = await applyDealRecruiterHierarchyForInsertRows(
    rowsToInsert,
    resolveBqDatasetTable(options)
  );

  if (!rowsToInsert || rowsToInsert.length === 0) {
    logLine(`[enriched sync] [BigQuery insertAll] SKIP: all rows filtered by dedupe rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
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
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
  }

  if (options.skip_contract_id === true) {
    rowsToInsert = rowsToInsert.map((row) => ({ ...row, CONTRACT_ID: null }));
    logLine(
      `[enriched sync] [BigQuery insertAll] skip_contract_id: CONTRACT_ID cleared for insert count=${rowsToInsert.length}`
    );
  } else {
    // Phase B: allocate Firestore-backed CONTRACT_IDs only for rows that will
    // actually be inserted (defer allocation pattern). Rows already carrying a
    // CONTRACT_ID from Phase A (resolveContractIdsForRows) are left untouched.
    // Lazy require to avoid module-load circular dependency with contractIdResolver.
    const { allocateContractIdsForInsertableRows } = require("./contractIdResolver");
    await allocateContractIdsForInsertableRows(rowsToInsert, { tableId: options.tableId });
  }

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

  rowsToInsert = await resolveNewHireDatesForEndedRows(rowsToInsert, {
    datasetId: options.datasetId,
    tableId: options.tableId,
  });

  rowsToInsert = applyExtensionStartDatesForInsertRows(rowsToInsert);

  rowsToInsert = await applyOnsiteAmCsmHierarchyForRows(rowsToInsert, resolveBqDatasetTable(options));

  const result = await insertAll(rowsToInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    applyDealSheetDateStamps: true,
  });
  const hasErrors = result.errors && result.errors.length > 0;

  const insertedKeys = new Set();
  for (const row of rowsToInsert) {
    const key = buildDealSheetPlacementCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID);
    if (key) insertedKeys.add(key);
  }

  logLine(
    `[enriched sync] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return {
    inserted: result.inserted,
    attempted: result.attempted,
    errorBatches: hasErrors ? 1 : 0,
    insertedKeys,
  };
}

/**
 * Partition enriched rows by ASSIGNMENT_RECRUITER_EMAIL domain and insert each group into its table.
 */
async function insertEnrichedDealSheetBatchRouted(combinedRows, insertIdBase, options = {}) {
  if (!combinedRows || combinedRows.length === 0) {
    logLine(`[enriched sync] [BigQuery insertAll] routed SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
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
  const insertedKeys = new Set();
  for (const [tableId, rows] of groups) {
    parts.push(`${tableId}=${rows.length}`);
    const r = await insertEnrichedDealSheetBatch(rows, base, { ...options, tableId });
    inserted += r.inserted;
    attempted += r.attempted;
    errorBatches += r.errorBatches;
    base += r.attempted;
    if (r.insertedKeys && typeof r.insertedKeys[Symbol.iterator] === "function") {
      for (const k of r.insertedKeys) insertedKeys.add(k);
    }
  }
  if (groups.size > 1) {
    logLine(`[enriched sync] [BigQuery insertAll] routed partitions: ${parts.join(", ")}`);
  }

  return { inserted, attempted, errorBatches, insertedKeys };
}

/**
 * Insert rate-change logs (only RATE_CHANGE === YES; defense in depth vs transform in syncService).
 */
async function insertRateChangeLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[rate-change logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "ID";
  if (generatedUuidField) {
    logRows = logRows.map((row) => {
      const next = { ...row };
      const raw = next[generatedUuidField];
      const existing = raw == null ? "" : String(raw).trim();
      if (!existing) next[generatedUuidField] = randomUUID();
      return next;
    });
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

  const seenKeys = new Set();
  let deduped = [];
  let droppedDupBatch = 0;
  for (const row of logRows) {
    const dedupeKey = buildRateChangeLogDedupeKey(row);
    if (dedupeKey !== "") {
      if (seenKeys.has(dedupeKey)) {
        droppedDupBatch++;
        continue;
      }
      seenKeys.add(dedupeKey);
    }
    deduped.push(row);
  }
  if (droppedDupBatch > 0) {
    logLine(
      `[rate-change logs] dedupe(same batch CONTRACT_ID+EFFECTIVE_DATE): dropped=${droppedDupBatch} remaining=${deduped.length}`
    );
  }

  const skipExisting = options.skipExistingDealSheets === true || options.skipExistingRateChangeLogs === true;
  if (skipExisting && deduped.length > 0) {
    const contractIds = [];
    const seenCids = new Set();
    for (const row of deduped) {
      const cid = row?.CONTRACT_ID;
      if (cid == null || String(cid).trim() === "") continue;
      const key = String(cid).trim();
      if (seenCids.has(key)) continue;
      seenCids.add(key);
      contractIds.push(key);
    }
    const existingKeys = await fetchExistingRateChangeLogContractKeysSet(contractIds, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingKeys.size > 0) {
      const filtered = [];
      let skipped = 0;
      for (const row of deduped) {
        const key = buildRateChangeLogDedupeKey(row);
        if (key !== "" && existingKeys.has(key)) {
          skipped++;
          continue;
        }
        filtered.push(row);
      }
      deduped = filtered;
      logLine(
        `[rate-change logs] [BigQuery insertAll] dedupe(existing CONTRACT_ID+EFFECTIVE_DATE in log table): skipped=${skipped} remaining=${deduped.length}`
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

  const rowsForInsert = deduped.map((row) => {
    const dedupeKey = buildRateChangeLogDedupeKey(row);
    return dedupeKey ? { ...row, _INSERT_ID: dedupeKey } : row;
  });

  const result = await insertAll(rowsForInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "_INSERT_ID",
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
 * Insert termination-reason audit logs (append-only snapshot per sync run).
 */
async function insertTerminationReasonLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[termination-reason logs] [BigQuery insertAll] SKIP: no rows to insert`);
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
    `[termination-reason logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
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

function normalizePlacementStatusFromBigQuery(value) {
  if (value == null) return null;
  const s = String(value).trim().toUpperCase();
  return s === "" ? null : s;
}

/**
 * Update-sync targets: one row per DEAL_SHEET_ID (latest row); PLACEMENT_ID-only when DEAL_SHEET_ID is null.
 * @param {object} [options]
 * @param {string} [options.datasetId]
 * @returns {Promise<Array<{deal_sheet_id: string|null, placement_id: string|null, table_id: string, placement_status: string|null}>>}
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
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) AS placement_status
    FROM (
      SELECT
        DEAL_SHEET_ID,
        PLACEMENT_ID,
        PLACEMENT_STATUS,
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
      const placement_status = normalizePlacementStatusFromBigQuery(row?.placement_status);
      out.push({ deal_sheet_id, placement_id, table_id: tableId, placement_status });
    }

    const sqlByPlacementFallback = `SELECT
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) AS placement_status
    FROM (
      SELECT
        PLACEMENT_ID,
        PLACEMENT_STATUS,
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
      const placement_status = normalizePlacementStatusFromBigQuery(row?.placement_status);
      out.push({ deal_sheet_id: null, placement_id, table_id: tableId, placement_status });
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
 * @param {string} [tableId] When set, single-table SQL instead of union
 * @returns {string}
 */
const ACTIVE_DEAL_SHEET_UNION_BASE_COLUMNS = [
  "DEAL_SHEET_ID",
  "PLACEMENT_ID",
  "CONTRACT_ID",
  "START_DATE",
  "ORIGINAL_START_DATE",
  "EDIT_DATE",
  "CANDIDATE_NEXUS_ID",
  "CANDIDATE_EMAIL",
  "PHONE_NUMBER",
  "NEXUS_INTERNAL_JOB_ID",
  "CLIENT_ID",
  "DEAL_TYPE",
];

/**
 * UNION ALL over active domain deal-sheet tables, projecting a fixed base column set. Callers that
 * need additional columns (e.g. the EXTENSION parent-deal inherit query, which reads NEW_HIRE_DATE
 * and the hierarchy columns) pass them via `extraColumns`; they are de-duped against the base set.
 * Every column listed must exist in all unioned tables or BigQuery rejects the query.
 */
function buildActiveDealSheetsUnionSql(datasetId, tableId, extraColumns = []) {
  const tableIds =
    typeof tableId === "string" && tableId.trim() !== ""
      ? [tableId.trim()]
      : ACTIVE_DEAL_SHEET_TABLE_IDS;
  const seen = new Set(ACTIVE_DEAL_SHEET_UNION_BASE_COLUMNS);
  const columns = [...ACTIVE_DEAL_SHEET_UNION_BASE_COLUMNS];
  for (const col of Array.isArray(extraColumns) ? extraColumns : []) {
    if (col == null || String(col).trim() === "" || seen.has(col)) continue;
    seen.add(col);
    columns.push(col);
  }
  const columnList = columns.join(", ");
  return tableIds.map(
    (tid) =>
      `SELECT ${columnList} FROM \`${config.projectId}.${datasetId}.${tid}\``
  ).join(" UNION ALL ");
}

/**
 * Explicit column set for the recruiter-change / ownership-change latest-vs-previous scans. These
 * scans CANNOT use `SELECT *` in their UNION ALL: the Canada active table drops several columns
 * (W2_PAY_RATE_NEW, REGULAR_HOURS_*, etc.), so `SELECT *` across domains has mismatched column
 * counts and BigQuery rejects the union. This list contains only columns that exist in ALL active
 * tables and that buildInorganicHierarchyLogCandidate / buildOwnershipChangeLogRows actually read.
 */
const ACTIVE_CHANGE_SCAN_COLUMNS = [
  "DEAL_SHEET_ID",
  "PLACEMENT_ID",
  "DATE_AND_TIME",
  "DEAL_TYPE",
  "PLACEMENT_STATUS",
  "CANDIDATE_NAME",
  "CANDIDATE_EMAIL",
  "CANDIDATE_NEXUS_ID",
  "CONTRACT_ID",
  "START_DATE",
  "TENTATIVE_DATE",
  "NEW_HIRE_DATE",
  "EXTENSION_DATE",
  "ASSIGNMENT_RECRUITER",
  "ASSIGNMENT_RECRUITER_EMAIL",
  "RECRUITER_EMP_NO",
  "ONSITE_AM",
  "ONSITE_AM_EMAIL",
  "LEVEL_2_CSM",
  "LEVEL_3_CSM",
  "LEVEL_4_CSM",
  "ATL", "ATL_EMP_NO",
  "SECONDARY_RECRUITER", "SECONDARY_RECRUITER_EMP_NO",
  "TEAM_LEAD", "TEAM_LEAD_EMP_NO",
  "RM", "RM_EMP_NO",
  "SECONDARY_AM", "SECONDARY_AM_EMP_NO",
  "ASSOCIATE_AM", "ASSOCIATE_AM_EMP_NO",
  "ACCOUNT_MANAGER", "ACCOUNT_MANAGER_EMP_NO",
  "DELIVERY_DIRECTOR", "DELIVERY_DIRECTOR_EMP_NO",
  "GRP_DIR_ASSOC_GRP_DIR", "GRP_DIR_ASSOC_GRP_DIR_EMP_NO",
  "VP_SRVP", "VP_SRVP_EMP_NO",
];
Object.freeze(ACTIVE_CHANGE_SCAN_COLUMNS);

/**
 * Per-table SELECTs (explicit columns) for the change-detection scans, UNION ALL'd. Each row is
 * tagged with `_src` (source table id). Safe across domains with differing full schemas.
 */
function buildActiveChangeScanUnionParts(datasetId) {
  const columnList = ACTIVE_CHANGE_SCAN_COLUMNS.join(", ");
  return ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const src = escapeSqlString(tableId);
    return `SELECT ${columnList}, '${src}' AS _src FROM ${fqn} WHERE DEAL_SHEET_ID IS NOT NULL AND PLACEMENT_ID IS NOT NULL`;
  });
}

/**
 * Latest non-null CONTRACT_ID per DEAL_SHEET_ID across active domain tables.
 * @param {Array<string|number>} dealSheetIds
 * @param {object} [options]
 * @returns {Promise<Map<string, string>>} dealSheetId string -> contract id
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
      if (cid == null || String(cid).trim() === "") continue;
      const normalized = String(cid).trim().toUpperCase();
      out.set(String(dsid).trim(), normalized);
    }
  }

  return out;
}

/**
 * Resolve employee_id (emp no) + external_id by recruiter/hierarchy email from the shared
 * employee directory. external_id is the join key into directory_employee_hierarchy.
 * @param {string[]} emails
 * @returns {Promise<Map<string, {employeeId: string, externalId: string}>>} lowercased/trimmed
 *   email -> directory identity
 */
async function fetchEmployeeDirectoryByEmails(emails, options = {}) {
  const out = new Map();
  if (!emails || emails.length === 0) return out;

  // Fixed MISC.directory_employees. Deliberately does NOT read options.datasetId/tableId — callers
  // routinely pass a deal-sheet-scoped options object, and honoring it here would query the wrong
  // table (this class of bug recurred repeatedly). Tests override via the directoryFetchFn dep.
  const datasetId = config.directoryEmployees.datasetId;
  const tableId = config.directoryEmployees.tableId;

  const uniq = [];
  const seen = new Set();
  for (const email of emails) {
    if (email == null) continue;
    const norm = String(email).trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    uniq.push(norm);
  }
  if (uniq.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `
      WITH ranked AS (
        SELECT
          LOWER(TRIM(email)) AS email_norm,
          employee_id,
          external_id,
          name_full,
          ROW_NUMBER() OVER (
            PARTITION BY LOWER(TRIM(email))
            ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
          ) AS rn
        FROM \`${config.projectId}.${datasetId}.${tableId}\`
        WHERE LOWER(TRIM(email)) IN (${inList})
          AND employee_id IS NOT NULL
      )
      SELECT email_norm, employee_id, external_id, name_full
      FROM ranked
      WHERE rn = 1
    `;
    const rows = await queryObjects(sql, chunk.length);
    for (const row of rows) {
      const emailNorm = row?.email_norm;
      const empId = row?.employee_id;
      if (emailNorm == null || String(emailNorm).trim() === "") continue;
      if (empId == null || String(empId).trim() === "") continue;
      const externalId = row?.external_id;
      const nameFull = row?.name_full;
      out.set(String(emailNorm).trim(), {
        employeeId: String(empId).trim(),
        externalId: externalId == null || String(externalId).trim() === ""
          ? null
          : String(externalId).trim(),
        nameFull: nameFull == null || String(nameFull).trim() === ""
          ? null
          : String(nameFull).trim(),
      });
    }
  }

  return out;
}

/**
 * For EXTENSION rows, find original DEAL CONTRACT_ID across active tables.
 * @param {Array<{placementId: number, candidateNexusId: number, candidateEmail?: string|null, phoneNumber?: string|null, clientId: number, startDate?: *}>} extensionRows
 * @param {object} [options]
 * @param {boolean} [options.includeExtensionSource] - when true, also treat prior EXTENSION rows
 *   (not just DEAL rows) with a non-null CONTRACT_ID as a valid source. Used so a runrate-only
 *   placement chain (no DEAL row ever inserted) still reuses the same CONTRACT_ID across repeat
 *   extensions instead of minting a new one each time (see applyExtensionRunrateBackfillForInsertRows).
 * @returns {Promise<Map<string, string|null>>} placementId string -> contract id or null
 */
async function fetchContractIdsForExtensions(extensionRows, options = {}) {
  const out = new Map();
  if (!extensionRows || extensionRows.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const tableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : "";
  const unionSql = buildActiveDealSheetsUnionSql(datasetId, tableId || undefined);
  const chunkSize = 100;

  for (let i = 0; i < extensionRows.length; i += chunkSize) {
    const chunk = extensionRows.slice(i, i + chunkSize);
    const structLiterals = [];

    for (const ext of chunk) {
      const pid = Number(ext.placementId);
      const cand = Number(ext.candidateNexusId);
      const client = Number(ext.clientId);
      if (!Number.isFinite(pid) || !Number.isFinite(cand)) continue;
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
        `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, '${email}' AS candidate_email, '${phone}' AS phone_number, ${Math.trunc(client)} AS client_id, ${startDateSql} AS start_date)`
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
          CLIENT_ID,
          START_DATE,
          EDIT_DATE
        FROM (${unionSql})
        WHERE ${options.includeExtensionSource === true
          ? "UPPER(TRIM(DEAL_TYPE)) IN ('DEAL', 'EXTENSION')"
          : "UPPER(TRIM(DEAL_TYPE)) = 'DEAL'"}
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
        cid == null || String(cid).trim() === ""
          ? null
          : String(cid).trim().toUpperCase()
      );
    }
  }

  return out;
}

/**
 * Non-recruiter hierarchy columns backfilled from all_CH_data_runrate for brand-new EXTENSION
 * rows. Recruiter identity (ASSIGNMENT_RECRUITER*, SECONDARY_RECRUITER, RECRUITER_ID/EMP_NO,
 * PREVIOUS_RECRUITER_*) is intentionally excluded per business rule — the current sync's own
 * recruiter assignment must win, not the historical one. CLIENT_RECRUITER, PRIMARY_SALES_PERSON,
 * SECONDARY_SALES_PERSON, and RECRUITER_CLUSTER are manual BigQuery-edited columns (see
 * MANUAL_COLUMNS) and are excluded for the same reason — a fuzzy runrate match must never
 * auto-fill a manually maintained field.
 * This list itself has no *_EMP_NO entries because all_CH_data_runrate (and the canada/locums
 * equivalents) never stored emp-no data, only names — there is nothing to SELECT from runrate
 * for those columns. Their EMP_NO companions are instead filled by a separate lookup, in
 * fillHierarchyEmpNosFromDirectoryByName: once a name is matched from runrate (e.g. TEAM_LEAD =
 * "Ajay Kumar"), that name + the column's known designations (recruiterHierarchyDesignations.js)
 * are matched against cynetdatabase.MISC.directory_employees (name_full + title) to resolve the
 * employee_id — see fetchExtensionRunrateBackfillByPlacementId and the runrateFields list in
 * applyExtensionInheritForInsertRows, which merges both the name and its `${col}_EMP_NO`.
 */
const EXTENSION_RUNRATE_HIERARCHY_COLUMNS = [
  "TEAM_LEAD",
  "ATL",
  "RM",
  "ACCOUNT_MANAGER",
  "SECONDARY_AM",
  "ASSOCIATE_AM",
  "GRP_DIR_ASSOC_GRP_DIR",
  "VP_SRVP",
];
Object.freeze(EXTENSION_RUNRATE_HIERARCHY_COLUMNS);

/** Placement statuses eligible as runrate backfill sources for EXTENSION insert rows. */
const EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES = Object.freeze([
  "STARTED",
  "BOOKED",
  "ENDED",
  "ENDED<30",
]);
const EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUS_SET = new Set(
  EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES
);

function isExtensionRunrateEligiblePlacementStatus(status) {
  if (status == null) return false;
  const key = String(status).trim().toUpperCase().replace(/\s+/g, " ");
  return key !== "" && EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUS_SET.has(key);
}

function buildRunrateEligiblePlacementStatusSqlPredicate(columnRef = "PLACEMENT_STATUS") {
  const list = EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES.map((s) => `'${s}'`).join(", ");
  return `UPPER(TRIM(CAST(${columnRef} AS STRING))) IN (${list})`;
}

/**
 * Snapshot fields inherited from the earliest matching parent DEAL row already in the
 * destination deal sheet table. ASSIGNMENT_RECRUITER* / RECRUITER_ID / PREVIOUS_RECRUITER_*
 * are excluded — the current Nexus assignment wins. CLIENT_RECRUITER, PRIMARY_SALES_PERSON,
 * SECONDARY_SALES_PERSON, and RECRUITER_CLUSTER are manual BigQuery-edited columns (see
 * MANUAL_COLUMNS) and are excluded for the same reason — no automated path should overwrite them.
 */
const EXTENSION_PARENT_DEAL_INHERIT_COLUMNS = [
  "NEW_HIRE_DATE",
  "TEAM_LEAD",
  "TEAM_LEAD_EMP_NO",
  "ATL",
  "ATL_EMP_NO",
  "RM",
  "RM_EMP_NO",
  "ACCOUNT_MANAGER",
  "ACCOUNT_MANAGER_EMP_NO",
  "SECONDARY_AM",
  "SECONDARY_AM_EMP_NO",
  "ASSOCIATE_AM",
  "ASSOCIATE_AM_EMP_NO",
  "GRP_DIR_ASSOC_GRP_DIR",
  "GRP_DIR_ASSOC_GRP_DIR_EMP_NO",
  "VP_SRVP",
  "VP_SRVP_EMP_NO",
  "SECONDARY_RECRUITER",
  "SECONDARY_RECRUITER_EMP_NO",
  "DELIVERY_DIRECTOR",
  "DELIVERY_DIRECTOR_EMP_NO",
  "DELIVERY_POC",
  "ACC_DIR_OR_VERT_HEAD",
  "CREDENTIALING_SPECIALIST",
  "CREDENTIALING_LEAD",
];
Object.freeze(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS);

function runrateAliasForColumn(col) {
  return `runrate_${col.toLowerCase()}`;
}

function proposedAliasForColumn(col) {
  return `proposed_${col.toLowerCase()}`;
}

function parentDealAliasForColumn(col) {
  return `parent_${col.toLowerCase()}`;
}

/**
 * True for brand-new EXTENSION rows eligible for insert-time backfill (parent DEAL inherit
 * and/or run-rate fallback). CONTRACT_ID may already be resolved from a parent DEAL.
 */
function rowNeedsExtensionInsertBackfill(row) {
  if (!row || typeof row !== "object") return false;
  if (String(row.DEAL_TYPE || "").trim().toUpperCase() !== "EXTENSION") return false;
  if (row.CANDIDATE_NEXUS_ID == null || String(row.CANDIDATE_NEXUS_ID).trim() === "") return false;
  if (row.PLACEMENT_ID == null || String(row.PLACEMENT_ID).trim() === "") return false;
  return true;
}

/** @deprecated Use rowNeedsExtensionInsertBackfill — kept for existing tests/callers. */
function rowNeedsExtensionRunrateBackfill(row) {
  return rowNeedsExtensionInsertBackfill(row);
}

/**
 * @param {object[]} rows
 * @returns {string[]}
 */
function buildExtensionContractMatchStructLiterals(rows) {
  const structLiterals = [];

  for (const row of rows) {
    const pid = Number(row.PLACEMENT_ID);
    const cand = Number(row.CANDIDATE_NEXUS_ID);
    const client = Number(row.CLIENT_ID);
    if (!Number.isFinite(pid) || !Number.isFinite(cand) || !Number.isFinite(client)) continue;

    const email = escapeSqlString(
      row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase()
    );
    const phone = escapeSqlString(
      row.PHONE_NUMBER == null ? "" : String(row.PHONE_NUMBER).trim()
    );

    structLiterals.push(
      `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, `
      + `'${email}' AS candidate_email, '${phone}' AS phone_number, ${Math.trunc(client)} AS client_id)`
    );
  }

  return structLiterals;
}

function mergeExtensionBackfillFields(row, backfill, fieldsToFill) {
  if (!backfill) return { row, changed: false };

  let next = row;
  let changed = false;
  for (const field of fieldsToFill) {
    if (!isEmptyDateFieldValue(next[field])) continue;
    const value = backfill[field];
    if (value == null || (typeof value === "string" && value.trim() === "")) continue;
    if (!changed) {
      next = { ...row };
      changed = true;
    }
    next[field] = value;
  }
  return { row: next, changed };
}

function extensionBackfillEntryHasValues(entry, fieldsToFill) {
  if (!entry) return false;
  return fieldsToFill.some((field) => {
    const value = entry[field];
    return value != null && !(typeof value === "string" && value.trim() === "");
  });
}

/** Unwrap BigQuery {value} wrappers/Date instances and blank-trim strings to null. */
function normalizeExtensionRunrateBackfillValue(value) {
  const sanitized = sanitizeValueForStreamingInsert(value);
  if (sanitized == null) return null;
  if (typeof sanitized === "string") {
    const trimmed = sanitized.trim();
    return trimmed === "" ? null : trimmed;
  }
  return sanitized;
}

/**
 * Earliest matching parent DEAL row in the destination active deal sheet table (same 4-field
 * match key as fetchContractIdsForExtensions). ORIGINAL_START_DATE uses
 * COALESCE(parent.ORIGINAL_START_DATE, parent.START_DATE).
 * @param {object[]} rows
 * @param {object} [options]
 * @param {string} [options.tableId]
 * @returns {Promise<Map<string, object>>}
 */
async function fetchExtensionParentDealInheritByPlacementId(rows, options = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const tableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : "";
  // The inner union must project the hierarchy columns this query reads (NEW_HIRE_DATE + the
  // EXTENSION_PARENT_DEAL_INHERIT_COLUMNS); the base union column set does not include them.
  const unionSql = buildActiveDealSheetsUnionSql(
    datasetId,
    tableId || undefined,
    EXTENSION_PARENT_DEAL_INHERIT_COLUMNS
  );

  const parentDealSelectColumns = EXTENSION_PARENT_DEAL_INHERIT_COLUMNS
    .map((col) => `          ${col}`)
    .join(",\n");
  const parentDealJoinedSelect = EXTENSION_PARENT_DEAL_INHERIT_COLUMNS
    .map((col) => `          d.${col}`)
    .join(",\n");
  const parentDealOuterSelect = EXTENSION_PARENT_DEAL_INHERIT_COLUMNS
    .map((col) => `        ${col}`)
    .join(",\n");

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const structLiterals = buildExtensionContractMatchStructLiterals(chunk);
    if (structLiterals.length === 0) continue;

    const sql = `
      WITH extensions AS (
        SELECT * FROM UNNEST([${structLiterals.join(", ")}])
      ),
      deals AS (
        SELECT
          CANDIDATE_NEXUS_ID,
          LOWER(IFNULL(CANDIDATE_EMAIL, '')) AS candidate_email_norm,
          IFNULL(PHONE_NUMBER, '') AS phone_norm,
          CLIENT_ID,
          START_DATE,
          PLACEMENT_ID,
          COALESCE(ORIGINAL_START_DATE, START_DATE) AS proposed_original_start_date,
${parentDealSelectColumns}
        FROM (${unionSql})
        WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      ),
      joined AS (
        SELECT
          ext.placement_id,
          d.proposed_original_start_date,
${parentDealJoinedSelect},
          ROW_NUMBER() OVER (
            PARTITION BY ext.placement_id
            ORDER BY d.START_DATE ASC NULLS LAST, d.PLACEMENT_ID ASC NULLS LAST
          ) AS rn
        FROM extensions ext
        INNER JOIN deals d
          ON d.CANDIDATE_NEXUS_ID = ext.candidate_nexus_id
         AND d.candidate_email_norm = ext.candidate_email
         AND d.phone_norm = ext.phone_number
         AND d.CLIENT_ID = ext.client_id
      )
      SELECT
        CAST(placement_id AS STRING) AS placement_id,
        proposed_original_start_date,
${parentDealOuterSelect}
      FROM joined
      WHERE rn = 1
    `;

    const bqRows = await queryObjects(sql, structLiterals.length);
    const parentFields = ["ORIGINAL_START_DATE", ...EXTENSION_PARENT_DEAL_INHERIT_COLUMNS];

    for (const bqRow of bqRows) {
      const pid = bqRow?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;

      const entry = {
        ORIGINAL_START_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_original_start_date),
      };
      for (const col of EXTENSION_PARENT_DEAL_INHERIT_COLUMNS) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[col]);
      }
      if (!extensionBackfillEntryHasValues(entry, parentFields)) continue;

      out.set(String(pid).trim(), entry);
    }
  }

  return out;
}

/**
 * Query the domain-appropriate run-rate table (see resolveRunrateTableIdForDealSheetTable —
 * all_CH_data_runrate for cynet_health, a separate table per domain for canada/locums) for a
 * batch of brand-new EXTENSION rows, porting the tiered match (exact nexus+tentative ->
 * nexus+parent+facility -> nexus+parent -> email+vms_job_id -> latest nexus before extension)
 * used to find "this candidate's prior stint at this same client". Does NOT resolve CONTRACT_ID —
 * the run-rate table's own CONTRACT_ID column is always null; see
 * applyExtensionRunrateBackfillForInsertRows for how CONTRACT_ID is resolved instead.
 * @param {object[]} rows - enriched rows eligible per rowNeedsExtensionInsertBackfill
 * @param {object} [options]
 * @param {string} [options.tableId] - destination deal sheet table, used to pick the domain's run-rate table
 * @returns {Promise<Map<string, object>>} PLACEMENT_ID string -> { ORIGINAL_START_DATE, NEW_HIRE_DATE, ...hierarchy }
 */
async function fetchExtensionRunrateBackfillByPlacementId(rows, options = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const runrateTableId =
    typeof options.runrateTableId === "string" && options.runrateTableId.trim() !== ""
      ? options.runrateTableId.trim()
      : resolveRunrateTableIdForDealSheetTable(options.tableId);
  const runrateFqn = `\`${config.projectId}.${datasetId}.${runrateTableId}\``;

  const runrateSelectHierarchy = EXTENSION_RUNRATE_HIERARCHY_COLUMNS
    .map((col) => `      ${col} AS ${runrateAliasForColumn(col)}`)
    .join(",\n");
  const bestMatchHierarchySelect = EXTENSION_RUNRATE_HIERARCHY_COLUMNS
    .map((col) => `        b.${runrateAliasForColumn(col)} AS ${proposedAliasForColumn(col)}`)
    .join(",\n");

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const structLiterals = [];

    for (const row of chunk) {
      const pid = Number(row.PLACEMENT_ID);
      const cand = Number(row.CANDIDATE_NEXUS_ID);
      if (!Number.isFinite(pid) || !Number.isFinite(cand)) continue;

      const email = escapeSqlString(
        row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase()
      );
      const parentClient = escapeSqlString(
        row.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim()
      );
      const facility = escapeSqlString(
        row.END_CLIENT_DEPT_FACILITY == null ? "" : String(row.END_CLIENT_DEPT_FACILITY).trim()
      );
      const vmsJobId = escapeSqlString(
        row.VMS_JOB_ID == null ? "" : String(row.VMS_JOB_ID).trim()
      );
      const startDateSql = (() => {
        const d = formatDateOnlyForSql(row.START_DATE);
        return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
      })();
      const tentativeDateSql = (() => {
        const d = formatDateOnlyForSql(row.TENTATIVE_DATE);
        return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
      })();

      structLiterals.push(
        `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, `
        + `'${email}' AS candidate_email, '${parentClient}' AS deal_parent_client, `
        + `'${facility}' AS deal_facility, ${startDateSql} AS extension_start_date, `
        + `${tentativeDateSql} AS extension_tentative_date, '${vmsJobId}' AS deal_vms_job_id)`
      );
    }

    if (structLiterals.length === 0) continue;

    const placementStatusPredicate = buildRunrateEligiblePlacementStatusSqlPredicate();

    // Ported from the analyst-authored matching query: same tiered match priority, same
    // client_first_assignment/sku_first_assignment fallback chain for ORIGINAL_START_DATE
    // and NEW_HIRE_DATE, and the same fixed runrate.START_DATE < 2026-05-01 cutoff (this
    // marks the boundary of the historical runrate snapshot; do not change to CURRENT_DATE()).
    // Only delta from the original one-off analysis query: `extensions` is this batch's
    // UNNEST(...) literal instead of a table scan (CONTRACT_ID IS NULL / DEAL_TYPE = EXTENSION
    // already enforced in JS).
    const sql = `
      WITH extensions AS (
        SELECT * FROM UNNEST([${structLiterals.join(", ")}])
      ),
      runrate AS (
        SELECT
          ID AS runrate_id,
          CANDIDATE_NEXUS_ID AS nexus_id,
          LOWER(TRIM(CANDIDATE_EMAIL)) AS email,
          TRIM(CAST(VMS_JOB_ID AS STRING)) AS vms_job_id,
          PARENT_CLIENT_NAME AS runrate_parent_client,
          END_CLIENT_DEPT_FACILITY AS runrate_facility,
          START_DATE AS runrate_start_date,
          TENTATIVE_DATE AS runrate_tentative_date,
          SKU_NUMBER AS runrate_sku,
          NEW_HIRE_DATE AS runrate_new_hire_date,
${runrateSelectHierarchy}
        FROM ${runrateFqn}
        WHERE START_DATE < DATE '2026-05-01'
          AND ${placementStatusPredicate}
      ),
      client_first_assignment AS (
        SELECT
          CANDIDATE_NEXUS_ID,
          LOWER(TRIM(PARENT_CLIENT_NAME)) AS parent_client_key,
          START_DATE AS client_original_start_date,
          NEW_HIRE_DATE AS client_new_hire_date,
          ROW_NUMBER() OVER (
            PARTITION BY CANDIDATE_NEXUS_ID, LOWER(TRIM(PARENT_CLIENT_NAME))
            ORDER BY START_DATE ASC, PLACEMENT_ID ASC, ID
          ) AS rn
        FROM ${runrateFqn}
        WHERE CANDIDATE_NEXUS_ID IS NOT NULL
          AND TRIM(IFNULL(PARENT_CLIENT_NAME, '')) != ''
          AND START_DATE IS NOT NULL
          AND ${placementStatusPredicate}
      ),
      sku_first_assignment AS (
        SELECT
          TRIM(SKU_NUMBER) AS sku_key,
          MIN(START_DATE) AS sku_original_start_date,
          ARRAY_AGG(NEW_HIRE_DATE IGNORE NULLS ORDER BY START_DATE ASC LIMIT 1)[SAFE_OFFSET(0)] AS sku_new_hire_date
        FROM ${runrateFqn}
        WHERE SKU_NUMBER IS NOT NULL AND TRIM(SKU_NUMBER) != '' AND START_DATE IS NOT NULL
          AND ${placementStatusPredicate}
        GROUP BY sku_key
      ),
      joined AS (
        SELECT
          e.placement_id,
          r.*,
          CASE
            WHEN e.candidate_nexus_id = r.nexus_id
             AND e.extension_tentative_date = r.runrate_tentative_date
              THEN 'EXACT_NEXUS_TENTATIVE'
            WHEN e.candidate_nexus_id = r.nexus_id
             AND LOWER(IFNULL(e.deal_parent_client, '')) = LOWER(IFNULL(r.runrate_parent_client, ''))
             AND (
               LOWER(IFNULL(e.deal_facility, '')) = LOWER(IFNULL(r.runrate_facility, ''))
               OR STRPOS(LOWER(IFNULL(r.runrate_facility, '')), LOWER(IFNULL(e.deal_facility, ''))) > 0
               OR STRPOS(LOWER(IFNULL(e.deal_facility, '')), LOWER(IFNULL(r.runrate_facility, ''))) > 0
             )
             AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
              THEN 'NEXUS_PARENT_FACILITY'
            WHEN e.candidate_nexus_id = r.nexus_id
             AND LOWER(IFNULL(e.deal_parent_client, '')) = LOWER(IFNULL(r.runrate_parent_client, ''))
             AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
              THEN 'NEXUS_PARENT_CLIENT'
            WHEN NULLIF(e.candidate_email, '') IS NOT NULL
             AND e.candidate_email = r.email
             AND NULLIF(e.deal_vms_job_id, '') IS NOT NULL
             AND e.deal_vms_job_id = NULLIF(r.vms_job_id, '')
              THEN 'EMAIL_VMS_JOB_ID'
            WHEN e.candidate_nexus_id = r.nexus_id
             AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
              THEN 'NEXUS_LATEST_BEFORE_EXT'
            ELSE NULL
          END AS match_method
        FROM extensions e
        JOIN runrate r
          ON e.candidate_nexus_id = r.nexus_id
          OR (
            NULLIF(e.candidate_email, '') IS NOT NULL
            AND e.candidate_email = r.email
            AND NULLIF(e.deal_vms_job_id, '') IS NOT NULL
            AND e.deal_vms_job_id = NULLIF(r.vms_job_id, '')
          )
      ),
      ranked AS (
        SELECT
          j.*,
          CASE j.match_method
            WHEN 'EXACT_NEXUS_TENTATIVE' THEN 1
            WHEN 'NEXUS_PARENT_FACILITY' THEN 2
            WHEN 'NEXUS_PARENT_CLIENT' THEN 3
            WHEN 'EMAIL_VMS_JOB_ID' THEN 4
            WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 5
            ELSE 99
          END AS match_priority,
          ROW_NUMBER() OVER (
            PARTITION BY j.placement_id
            ORDER BY
              CASE j.match_method
                WHEN 'EXACT_NEXUS_TENTATIVE' THEN 1
                WHEN 'NEXUS_PARENT_FACILITY' THEN 2
                WHEN 'NEXUS_PARENT_CLIENT' THEN 3
                WHEN 'EMAIL_VMS_JOB_ID' THEN 4
                WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 5
                ELSE 99
              END,
              j.runrate_start_date DESC NULLS LAST,
              j.runrate_id
          ) AS rn
        FROM joined j
        WHERE j.match_method IS NOT NULL
      ),
      best_match AS (
        SELECT * FROM ranked WHERE rn = 1
      )
      SELECT
        CAST(e.placement_id AS STRING) AS placement_id,
        COALESCE(c.client_original_start_date, s.sku_original_start_date) AS proposed_original_start_date,
        COALESCE(c.client_new_hire_date, s.sku_new_hire_date, b.runrate_new_hire_date) AS proposed_new_hire_date,
${bestMatchHierarchySelect}
      FROM extensions e
      JOIN best_match b ON e.placement_id = b.placement_id
      LEFT JOIN client_first_assignment c
        ON e.candidate_nexus_id = c.CANDIDATE_NEXUS_ID
       AND LOWER(TRIM(IFNULL(e.deal_parent_client, ''))) = c.parent_client_key
       AND c.rn = 1
      LEFT JOIN sku_first_assignment s
        ON NULLIF(TRIM(b.runrate_sku), '') = s.sku_key
    `;

    const bqRows = await queryObjects(sql, structLiterals.length);
    for (const bqRow of bqRows) {
      const pid = bqRow?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;
      const key = String(pid).trim();
      const entry = {
        ORIGINAL_START_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_original_start_date),
        NEW_HIRE_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_new_hire_date),
      };
      for (const col of EXTENSION_RUNRATE_HIERARCHY_COLUMNS) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[proposedAliasForColumn(col)]);
      }
      out.set(key, entry);
    }
  }

  await fillHierarchyEmpNosFromDirectoryByName(out, options);

  return out;
}

/**
 * Backfill *_EMP_NO for runrate-matched hierarchy names. all_CH_data_runrate (and the
 * canada/locums equivalents) only ever stored the manager's NAME, never an emp no — so the emp
 * no is found separately, by looking up cynetdatabase.MISC.directory_employees for a row whose
 * name_full matches the runrate name (case/whitespace-insensitive) AND whose title is one of the
 * known designations for that hierarchy column (see recruiterHierarchyDesignations.js). When a
 * name+designation pair has multiple directory rows (duplicate names), prefers status='ACTIVE'
 * then the most recently updated_at row — same tie-break already used for RECRUITER_EMP_NO.
 * @param {Map<string, object>} entriesByPlacementId - mutated in place, adding `${col}_EMP_NO`
 */
async function fillHierarchyEmpNosFromDirectoryByName(entriesByPlacementId, options = {}) {
  if (!entriesByPlacementId || entriesByPlacementId.size === 0) return;

  const namesByColumn = new Map();
  for (const entry of entriesByPlacementId.values()) {
    for (const col of EXTENSION_RUNRATE_HIERARCHY_COLUMNS) {
      const name = entry[col];
      if (name == null || String(name).trim() === "") continue;
      const norm = String(name).trim().toLowerCase();
      if (!namesByColumn.has(col)) namesByColumn.set(col, new Set());
      namesByColumn.get(col).add(norm);
    }
  }
  if (namesByColumn.size === 0) return;

  // Always the fixed directory_employees table — never `options`, which here carries the
  // destination deal-sheet dataset/table (from fetchExtensionRunrateBackfillByPlacementId) and
  // would make this look up name_full/title on the deal sheet ("Unrecognized name: name_full").
  const employeesFqn = `\`${config.projectId}.${config.directoryEmployees.datasetId}.${config.directoryEmployees.tableId}\``;

  const empIdByColumnAndName = new Map();

  for (const [col, nameSet] of namesByColumn) {
    const titles = HIERARCHY_DESIGNATION_SYNONYMS[col];
    if (!titles || titles.length === 0) continue;
    const names = [...nameSet];
    const nameInList = names.map((n) => `'${escapeSqlString(n)}'`).join(", ");
    const titleInList = titles.map((t) => `'${escapeSqlString(t)}'`).join(", ");

    const sql = `
      WITH ranked AS (
        SELECT
          LOWER(TRIM(name_full)) AS name_norm,
          employee_id,
          ROW_NUMBER() OVER (
            PARTITION BY LOWER(TRIM(name_full))
            ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
          ) AS rn
        FROM ${employeesFqn}
        WHERE LOWER(TRIM(name_full)) IN (${nameInList})
          AND LOWER(TRIM(title)) IN (${titleInList})
          AND employee_id IS NOT NULL
      )
      SELECT name_norm, employee_id
      FROM ranked
      WHERE rn = 1
    `;
    const bqRows = await queryObjects(sql, names.length);
    for (const row of bqRows) {
      const nameNorm = row?.name_norm;
      const empId = row?.employee_id;
      if (nameNorm == null || String(nameNorm).trim() === "") continue;
      if (empId == null || String(empId).trim() === "") continue;
      empIdByColumnAndName.set(`${col}::${String(nameNorm).trim()}`, String(empId).trim());
    }
  }
  if (empIdByColumnAndName.size === 0) return;

  for (const entry of entriesByPlacementId.values()) {
    for (const col of EXTENSION_RUNRATE_HIERARCHY_COLUMNS) {
      const name = entry[col];
      if (name == null || String(name).trim() === "") continue;
      const norm = String(name).trim().toLowerCase();
      const empId = empIdByColumnAndName.get(`${col}::${norm}`);
      if (empId != null) entry[`${col}_EMP_NO`] = empId;
    }
  }
}

/**
 * Resolve CONTRACT_ID for EXTENSION rows that matched in the run-rate table but still have no
 * CONTRACT_ID. The run-rate table's own CONTRACT_ID column is always null, so it can't be copied
 * (see fetchExtensionRunrateBackfillByPlacementId) — instead this mirrors the DEAL-row contract
 * resolution in contractIdResolver.js in two steps:
 *   1. Reuse — look for a CONTRACT_ID already on ANY prior row (DEAL or EXTENSION) for the same
 *      candidate+client identity in the destination table (fetchContractIdsForExtensions with
 *      includeExtensionSource: true). Keeps repeat extensions of the same run-rate-only placement
 *      on one CONTRACT_ID instead of minting a new one every time.
 *   2. Allocate — for rows still unresolved, mint a fresh CONTRACT_ID from the same
 *      Firestore-backed per-table sequence used for DEAL rows (one per unique candidate+client
 *      identity, so multiple rows in this same insert batch for the same underlying placement
 *      share one id).
 * @param {object[]} rows - eligible rows that had a run-rate match
 * @param {object} [options]
 * @param {string} [options.tableId] - destination deal sheet table (selects the CHC/CAC/LOC sequence)
 * @param {object} [deps]
 * @param {typeof fetchContractIdsForExtensions} [deps.fetchContractIdsForExtensionsFn]
 * @param {typeof allocateContractIds} [deps.allocateContractIdsFn]
 * @param {typeof buildSequenceOptionsForTable} [deps.buildSequenceOptionsForTableFn]
 * @returns {Promise<Map<string, string>>} PLACEMENT_ID string -> CONTRACT_ID
 */
async function resolveContractIdsForRunrateMatchedExtensions(rows, options = {}, deps = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  // Lazy require: contractIdResolver.js requires bigQueryClient.js, so a top-level require here
  // would create a circular dependency (same pattern already used for allocateContractIdsForInsertableRows).
  const { buildContractMatchKey } = require("./contractIdResolver");
  const fetchContractIdsForExtensionsFn = deps.fetchContractIdsForExtensionsFn ?? fetchContractIdsForExtensions;
  const allocateContractIdsFn = deps.allocateContractIdsFn ?? allocateContractIds;
  const buildSequenceOptionsForTableFn = deps.buildSequenceOptionsForTableFn ?? buildSequenceOptionsForTable;

  const tableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : "";

  const lookupInput = [];
  for (const row of rows) {
    const pid = Number(row.PLACEMENT_ID);
    const cand = Number(row.CANDIDATE_NEXUS_ID);
    const client = Number(row.CLIENT_ID);
    if (!Number.isFinite(pid) || !Number.isFinite(cand) || !Number.isFinite(client)) continue;
    lookupInput.push({
      placementId: pid,
      candidateNexusId: cand,
      candidateEmail: row.CANDIDATE_EMAIL,
      phoneNumber: row.PHONE_NUMBER,
      clientId: client,
      startDate: row.START_DATE,
    });
  }

  let reusedCount = 0;
  if (lookupInput.length > 0) {
    const reused = await fetchContractIdsForExtensionsFn(lookupInput, {
      datasetId: options.datasetId,
      tableId: tableId || undefined,
      includeExtensionSource: true,
    });
    for (const [pid, cid] of reused) {
      const normalized = normalizeContractIdOrNull(cid);
      if (normalized != null) {
        out.set(String(pid), normalized);
        reusedCount++;
      }
    }
  }

  const stillUnresolved = rows.filter((row) => !out.has(String(row.PLACEMENT_ID).trim()));
  if (stillUnresolved.length === 0) return out;

  const sequenceOptions = tableId ? buildSequenceOptionsForTableFn(tableId) : null;
  if (!sequenceOptions) {
    logLine(
      `[enriched sync] [BigQuery insertAll] EXTENSION runrate CONTRACT_ID allocation skipped: missing tableId sequence config (tableId=${tableId || "none"}, need=${stillUnresolved.length})`
    );
    return out;
  }

  const rowsByKey = new Map();
  const noKeyRows = [];
  for (const row of stillUnresolved) {
    const key = buildContractMatchKey(row);
    if (!key) {
      noKeyRows.push(row);
      continue;
    }
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(row);
  }

  const keys = [...rowsByKey.keys()];
  const totalToAllocate = keys.length + noKeyRows.length;

  let ids = [];
  try {
    ids = await allocateContractIdsFn(totalToAllocate, sequenceOptions);
  } catch (err) {
    logLine(
      `[enriched sync] [BigQuery insertAll] EXTENSION runrate CONTRACT_ID allocateContractIds(${totalToAllocate}) failed: ${String(err?.message || err).slice(0, 200)}`
    );
    return out;
  }

  let idx = 0;
  let allocatedCount = 0;
  for (const key of keys) {
    const contractId = normalizeContractIdOrNull(ids[idx] ?? null);
    idx++;
    if (contractId == null) continue;
    for (const row of rowsByKey.get(key) || []) {
      out.set(String(row.PLACEMENT_ID).trim(), contractId);
      allocatedCount++;
    }
  }
  for (const row of noKeyRows) {
    const contractId = normalizeContractIdOrNull(ids[idx] ?? null);
    idx++;
    if (contractId != null) {
      out.set(String(row.PLACEMENT_ID).trim(), contractId);
      allocatedCount++;
    }
  }

  logLine(
    `[enriched sync] [BigQuery insertAll] EXTENSION runrate CONTRACT_ID resolution: reused=${reusedCount} freshlyAllocated=${allocatedCount} unresolved=${stillUnresolved.length - allocatedCount}`
  );

  return out;
}

/**
 * Insert-time backfill for brand-new EXTENSION rows:
 *   1. Earliest parent DEAL row in the destination deal sheet (dates, hierarchy, *_EMP_NO)
 *   2. Run-rate table fallback for any still-empty fields
 *   3. CONTRACT_ID resolution for run-rate-matched rows still lacking an id
 * Fills only empty fields — never overwrites existing values.
 * @param {object[]} rows
 * @param {object} [options]
 * @param {object} [deps]
 * @param {typeof fetchExtensionParentDealInheritByPlacementId} [deps.parentFetchFn]
 * @param {typeof fetchExtensionRunrateBackfillByPlacementId} [deps.runrateFetchFn]
 * @param {typeof fetchExtensionRunrateBackfillByPlacementId} [deps.fetchFn]
 * @param {typeof resolveContractIdsForRunrateMatchedExtensions} [deps.resolveContractIdsFn]
 */
async function applyExtensionInheritForInsertRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const eligible = rows.filter(rowNeedsExtensionInsertBackfill);
  if (eligible.length === 0) return rows;

  const parentFetchFn = deps.parentFetchFn ?? fetchExtensionParentDealInheritByPlacementId;
  const runrateFetchFn = deps.runrateFetchFn ?? deps.fetchFn ?? fetchExtensionRunrateBackfillByPlacementId;
  const resolveContractIdsFn = deps.resolveContractIdsFn ?? resolveContractIdsForRunrateMatchedExtensions;

  const parentByPlacementId = await parentFetchFn(eligible, options);
  const runrateByPlacementId = await runrateFetchFn(eligible, options);

  const matchedRunrateRows = eligible.filter((row) =>
    runrateByPlacementId.has(String(row.PLACEMENT_ID).trim())
  );
  const contractIdByPlacementId =
    matchedRunrateRows.length > 0
      ? await resolveContractIdsFn(matchedRunrateRows, options, deps)
      : new Map();

  const parentFields = ["ORIGINAL_START_DATE", ...EXTENSION_PARENT_DEAL_INHERIT_COLUMNS];
  const runrateFields = [
    "ORIGINAL_START_DATE",
    "NEW_HIRE_DATE",
    ...EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
    ...EXTENSION_RUNRATE_HIERARCHY_COLUMNS.map((col) => `${col}_EMP_NO`),
  ];

  const eligibleSet = new Set(eligible.map((row) => String(row.PLACEMENT_ID).trim()));
  let parentBackfilledCount = 0;
  let runrateBackfilledCount = 0;

  const out = rows.map((row) => {
    const key = String(row.PLACEMENT_ID).trim();
    if (!eligibleSet.has(key)) return row;

    let current = row;
    let rowChanged = false;

    const parentMerged = mergeExtensionBackfillFields(
      current,
      parentByPlacementId.get(key),
      parentFields
    );
    if (parentMerged.changed) {
      current = parentMerged.row;
      rowChanged = true;
      parentBackfilledCount++;
    }

    const runrateMerged = mergeExtensionBackfillFields(
      current,
      runrateByPlacementId.get(key),
      runrateFields
    );
    if (runrateMerged.changed) {
      current = runrateMerged.row;
      rowChanged = true;
      runrateBackfilledCount++;
    }

    if (isEmptyDateFieldValue(current.CONTRACT_ID)) {
      const contractId = contractIdByPlacementId.get(key);
      if (contractId != null && String(contractId).trim() !== "") {
        current = { ...current, CONTRACT_ID: contractId };
        rowChanged = true;
      }
    }

    return rowChanged ? current : row;
  });

  if (parentByPlacementId.size > 0) {
    logLine(
      `[enriched sync] [BigQuery insertAll] EXTENSION parent-deal inherit: eligible=${eligible.length} matched=${parentByPlacementId.size} backfilled=${parentBackfilledCount}`
    );
  }
  if (runrateByPlacementId.size > 0) {
    logLine(
      `[enriched sync] [BigQuery insertAll] EXTENSION runrate backfill: eligible=${eligible.length} matched=${runrateByPlacementId.size} backfilled=${runrateBackfilledCount}`
    );
  }

  return out;
}

/** @deprecated Use applyExtensionInheritForInsertRows */
async function applyExtensionRunrateBackfillForInsertRows(rows, options = {}, deps = {}) {
  return applyExtensionInheritForInsertRows(rows, options, deps);
}

/** All name + emp-no fields filled by the DEAL recruiter-hierarchy backfill. */
const DEAL_RECRUITER_HIERARCHY_FIELDS = DEAL_RECRUITER_HIERARCHY_TARGETS.flatMap(
  ({ column, empNoColumn }) => [column, empNoColumn]
);

/**
 * True for brand-new DEAL rows eligible for insert-time recruiter-hierarchy backfill from the
 * employee directory. Mirrors rowNeedsExtensionInsertBackfill's shape for the DEAL side.
 */
function rowNeedsDealRecruiterHierarchyBackfill(row) {
  if (!row || typeof row !== "object") return false;
  if (normalizeDealTypeKey(row.DEAL_TYPE) !== "DEAL") return false;
  if (row.ASSIGNMENT_RECRUITER_EMAIL == null || String(row.ASSIGNMENT_RECRUITER_EMAIL).trim() === "") {
    return false;
  }
  if (row.PLACEMENT_ID == null || String(row.PLACEMENT_ID).trim() === "") return false;
  return DEAL_RECRUITER_HIERARCHY_FIELDS.some((field) => isEmptyDateFieldValue(row[field]));
}

/**
 * Format a JS date-like value as a BigQuery TIMESTAMP literal, or CAST(NULL AS TIMESTAMP).
 */
function formatTimestampLiteralForSql(value) {
  if (value == null || value === "") return "CAST(NULL AS TIMESTAMP)";
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "CAST(NULL AS TIMESTAMP)";
  return `TIMESTAMP '${escapeSqlString(d.toISOString())}'`;
}

/**
 * Shared snapshot resolver: for each {key, externalId, anchorDate} target, finds the employee's
 * hierarchy chain (all hierarchy_level rows from directory_employee_hierarchy) as of one chosen
 * synced_at snapshot.
 * direction "on_or_after" (default): earliest snapshot on/after anchorDate, else (no anchorDate,
 *   or anchorDate after every snapshot) the most recent snapshot available. Used for "what was
 *   the hierarchy as of this future-facing date" (recruiter hierarchy on hire, log-time lookups).
 * direction "on_or_before": latest snapshot on/before anchorDate, else (no anchorDate, or
 *   anchorDate before every snapshot) the earliest snapshot available. Used for "what was the
 *   hierarchy already true by this date" (CSM hierarchy on hire) — passing anchorDate=null with
 *   this direction still resolves to the earliest snapshot, not the latest, so callers that want
 *   the *current* chain regardless of direction should use direction "on_or_after" with a null
 *   anchorDate (falls back to most recent).
 * @param {Array<{key: string, externalId: string, anchorDate: *}>} targets
 * @param {object} [options]
 * @param {"on_or_after"|"on_or_before"} [options.direction]
 * @returns {Promise<Map<string, object[]>>} target key -> hierarchy_level rows (unsorted keys,
 *   rows ordered by hierarchy_level ascending)
 */
async function fetchHierarchyLevelChainsByKey(targets, options = {}) {
  const out = new Map();
  if (!targets || targets.length === 0) return out;
  const direction = options.direction === "on_or_before" ? "on_or_before" : "on_or_after";

  // Fixed MISC.directory_employee_hierarchy. Deliberately does NOT read options.datasetId/tableId
  // (only options.direction) — callers pass deal-sheet-scoped options, and honoring a table
  // override here would query the wrong table (this class of bug recurred repeatedly).
  const datasetId = config.directoryEmployeeHierarchy.datasetId;
  const tableId = config.directoryEmployeeHierarchy.tableId;
  const hierarchyFqn = `\`${config.projectId}.${datasetId}.${tableId}\``;

  const chunkSize = 100;
  for (let i = 0; i < targets.length; i += chunkSize) {
    const chunk = targets.slice(i, i + chunkSize);
    const structLiterals = chunk.map(
      (t) =>
        `STRUCT('${escapeSqlString(t.key)}' AS target_key, `
        + `'${escapeSqlString(t.externalId)}' AS external_id, `
        + `${formatTimestampLiteralForSql(t.anchorDate)} AS anchor_date)`
    );

    const sql = `
      WITH targets AS (
        SELECT * FROM UNNEST([${structLiterals.join(", ")}])
      ),
      hierarchy AS (
        SELECT
          employee_external_id,
          hierarchy_level,
          manager_name,
          manager_employee_id,
          manager_title,
          synced_at
        FROM ${hierarchyFqn}
        WHERE employee_external_id IN (SELECT DISTINCT external_id FROM targets)
      ),
      distinct_snapshots AS (
        SELECT DISTINCT employee_external_id, synced_at FROM hierarchy
      ),
      ranked_snapshots AS (
        SELECT
          t.target_key,
          s.synced_at,
          ROW_NUMBER() OVER (
            PARTITION BY t.target_key
            ORDER BY
              ${direction === "on_or_before"
                ? `CASE WHEN s.synced_at <= t.anchor_date THEN 0 ELSE 1 END,
              CASE WHEN s.synced_at <= t.anchor_date THEN s.synced_at END DESC,
              s.synced_at ASC`
                : `CASE WHEN s.synced_at >= t.anchor_date THEN 0 ELSE 1 END,
              CASE WHEN s.synced_at >= t.anchor_date THEN s.synced_at END ASC,
              s.synced_at DESC`}
          ) AS rn
        FROM targets t
        JOIN distinct_snapshots s ON s.employee_external_id = t.external_id
      ),
      chosen_snapshot AS (
        SELECT target_key, synced_at FROM ranked_snapshots WHERE rn = 1
      )
      SELECT
        cs.target_key,
        h.hierarchy_level,
        h.manager_name,
        h.manager_employee_id,
        h.manager_title
      FROM chosen_snapshot cs
      JOIN targets t ON t.target_key = cs.target_key
      JOIN hierarchy h ON h.employee_external_id = t.external_id AND h.synced_at = cs.synced_at
      ORDER BY cs.target_key, SAFE_CAST(h.hierarchy_level AS INT64)
    `;

    const bqRows = await queryObjects(sql, chunk.length * 10);
    for (const bqRow of bqRows) {
      const key = bqRow?.target_key;
      if (key == null || String(key).trim() === "") continue;
      const trimmedKey = String(key).trim();
      if (!out.has(trimmedKey)) out.set(trimmedKey, []);
      out.get(trimmedKey).push(bqRow);
    }
  }

  return out;
}

/**
 * Resolve recruiter hierarchy (TEAM_LEAD, ATL, RM, ACCOUNT_MANAGER, SECONDARY_AM, ASSOCIATE_AM,
 * GRP_DIR_ASSOC_GRP_DIR, VP_SRVP, DELIVERY_DIRECTOR, SECONDARY_RECRUITER + their *_EMP_NO
 * companions) for brand-new DEAL rows, from cynetdatabase.MISC.directory_employee_hierarchy.
 *
 * Per recruiter (employee external_id), the hierarchy table holds one full org-chart snapshot
 * (all hierarchy_level rows) per synced_at. The snapshot used is the earliest one whose
 * synced_at is on/after the row's NEW_HIRE_DATE (the hierarchy as it stood when this candidate
 * was hired); if none qualifies (no NEW_HIRE_DATE, or hire date is after every snapshot), the
 * most recent snapshot available is used instead. Each snapshot's manager_title values are then
 * matched against known designations (see recruiterHierarchyDesignations.js) to pick the column.
 *
 * @param {object[]} rows - enriched rows eligible per rowNeedsDealRecruiterHierarchyBackfill
 * @param {object} [options]
 * @returns {Promise<Map<string, object>>} PLACEMENT_ID string -> partial row of matched columns
 */
async function fetchDealRecruiterHierarchyByPlacementId(rows, options = {}, deps = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const email = row?.ASSIGNMENT_RECRUITER_EMAIL;
    if (email == null) continue;
    const norm = String(email).trim().toLowerCase();
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  if (emails.length === 0) return out;

  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  for (const row of rows) {
    const pid = row?.PLACEMENT_ID;
    if (pid == null || String(pid).trim() === "") continue;
    const email = row?.ASSIGNMENT_RECRUITER_EMAIL;
    const norm = email == null ? "" : String(email).trim().toLowerCase();
    const externalId = norm ? directoryByEmail.get(norm)?.externalId : null;
    if (!externalId) continue;
    targets.push({
      key: String(pid).trim(),
      externalId,
      anchorDate: row?.NEW_HIRE_DATE ?? null,
    });
  }
  if (targets.length === 0) return out;

  // Never forward `options` here: it carries the destination deal-sheet table's datasetId/tableId
  // (from insertEnrichedDealSheetBatch), which would make this query the wrong table entirely —
  // the hierarchy lookup always targets the fixed directory_employee_hierarchy table.
  const levelsByKey = await fetchHierarchyLevelChainsByKey(targets);

  for (const [placementId, levelRows] of levelsByKey) {
    const entry = {};
    const filledColumns = new Set();
    for (const levelRow of levelRows) {
      const column = resolveHierarchyColumnForTitle(levelRow?.manager_title);
      if (!column || filledColumns.has(column)) continue;
      const target = DEAL_RECRUITER_HIERARCHY_TARGETS.find((t) => t.column === column);
      if (!target) continue;
      const name = normalizeExtensionRunrateBackfillValue(levelRow?.manager_name);
      const empNo = normalizeExtensionRunrateBackfillValue(levelRow?.manager_employee_id);
      if (name == null && empNo == null) continue;
      filledColumns.add(column);
      entry[target.column] = name;
      entry[target.empNoColumn] = empNo;
    }
    if (Object.keys(entry).length > 0) out.set(placementId, entry);
  }

  return out;
}

/**
 * Backfill recruiter hierarchy (see fetchDealRecruiterHierarchyByPlacementId) onto brand-new
 * DEAL_TYPE=DEAL rows only. Only ever fills a column that is currently empty — a row whose
 * hierarchy columns were already carried forward from a baseline (an update-append, not a
 * first insert) is left untouched, and a manual BigQuery edit is never overwritten.
 */
async function applyDealRecruiterHierarchyForInsertRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const eligible = rows.filter(rowNeedsDealRecruiterHierarchyBackfill);
  if (eligible.length === 0) return rows;

  const fetchFn = deps.fetchFn ?? fetchDealRecruiterHierarchyByPlacementId;
  const hierarchyByPlacementId = await fetchFn(eligible, options, deps);

  const eligibleSet = new Set(eligible.map((row) => String(row.PLACEMENT_ID).trim()));
  let backfilledCount = 0;

  const out = rows.map((row) => {
    const key = String(row.PLACEMENT_ID).trim();
    if (!eligibleSet.has(key)) return row;

    const merged = mergeExtensionBackfillFields(
      row,
      hierarchyByPlacementId.get(key),
      DEAL_RECRUITER_HIERARCHY_FIELDS
    );
    if (merged.changed) backfilledCount++;
    return merged.row;
  });

  if (hierarchyByPlacementId.size > 0) {
    logLine(
      `[enriched sync] [BigQuery insertAll] DEAL recruiter-hierarchy backfill: eligible=${eligible.length} matched=${hierarchyByPlacementId.size} backfilled=${backfilledCount}`
    );
  }

  return out;
}

/**
 * Resolve LEVEL_2_CSM/LEVEL_3_CSM/LEVEL_4_CSM (ONSITE_AM's manager chain, hire-date-anchored) for
 * a batch of rows. Unlike the DEAL recruiter hierarchy, this always uses ONSITE_AM_EMAIL (never
 * recruiter email) and picks the LATEST snapshot on/before NEW_HIRE_DATE (falls back to the
 * EARLIEST snapshot if none is before hire date) — the opposite direction from recruiter
 * hierarchy, because this represents "who was already in place when this candidate was hired."
 * @param {object[]} rows - each needs ONSITE_AM_EMAIL and (optionally) NEW_HIRE_DATE
 * @returns {Promise<Map<string, {LEVEL_2_CSM, LEVEL_3_CSM, LEVEL_4_CSM}>>} row index (as string) -> levels
 */
async function fetchOnsiteAmCsmHierarchyByKey(rows, options = {}, deps = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const email = row?.ONSITE_AM_EMAIL;
    if (email == null) continue;
    const norm = String(email).trim().toLowerCase();
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  if (emails.length === 0) return out;

  // Never forward `options` to the directory/hierarchy lookups — see the same note in
  // fetchDealRecruiterHierarchyByPlacementId; these always target the fixed MISC.directory_*
  // tables, never the caller's destination deal-sheet table/dataset.
  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  rows.forEach((row, index) => {
    const email = row?.ONSITE_AM_EMAIL;
    const norm = email == null ? "" : String(email).trim().toLowerCase();
    const externalId = norm ? directoryByEmail.get(norm)?.externalId : null;
    if (!externalId) return;
    targets.push({ key: String(index), externalId, anchorDate: row?.NEW_HIRE_DATE ?? null });
  });
  if (targets.length === 0) return out;

  const hierarchyFetchFn = deps.hierarchyFetchFn ?? fetchHierarchyLevelChainsByKey;
  const levelsByKey = await hierarchyFetchFn(targets, { direction: "on_or_before" });

  for (const [key, levelRows] of levelsByKey) {
    out.set(key, resolveCsmLevelsFromChain(levelRows));
  }
  return out;
}

/**
 * Recomputes LEVEL_2_CSM/LEVEL_3_CSM/LEVEL_4_CSM on every row from the CURRENT ONSITE_AM_EMAIL
 * (unlike the recruiter hierarchy backfill, this is never frozen — it always tracks whoever the
 * current onsite AM is, same as ONSITE_AM_EMAIL itself). Rows with no ONSITE_AM_EMAIL get all
 * three columns cleared to null.
 */
async function applyOnsiteAmCsmHierarchyForRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const fetchFn = deps.fetchFn ?? fetchOnsiteAmCsmHierarchyByKey;
  const levelsByIndex = await fetchFn(rows, options, deps);

  let updatedCount = 0;
  const out = rows.map((row, index) => {
    const levels = levelsByIndex.get(String(index)) ?? { LEVEL_2_CSM: null, LEVEL_3_CSM: null, LEVEL_4_CSM: null };
    const changed =
      normalizeForCompare(row.LEVEL_2_CSM) !== normalizeForCompare(levels.LEVEL_2_CSM) ||
      normalizeForCompare(row.LEVEL_3_CSM) !== normalizeForCompare(levels.LEVEL_3_CSM) ||
      normalizeForCompare(row.LEVEL_4_CSM) !== normalizeForCompare(levels.LEVEL_4_CSM);
    if (!changed) return row;
    updatedCount++;
    return { ...row, ...levels };
  });

  if (updatedCount > 0) {
    logLine(`[enriched sync] [BigQuery insertAll] ONSITE_AM CSM hierarchy: updated=${updatedCount}/${rows.length}`);
  }
  return out;
}

/**
 * Scans active deal-sheet tables' latest row per placement for a CSM hierarchy divergence: the
 * ONSITE_AM's CURRENT (live, most-recent-snapshot) manager chain differs from what's frozen on
 * the row as LEVEL_2_CSM/LEVEL_3_CSM/LEVEL_4_CSM. Independent of any recruiter change — a
 * placement can surface here even when its recruiter never changed.
 * @returns {Promise<object[]>} candidates: {DEAL_SHEET_ID, PLACEMENT_ID, PLACEMENT_STATUS,
 *   CANDIDATE_NAME, CANDIDATE_NEXUS_ID, csmDivergedLevels: {LEVEL_2_CSM?, LEVEL_3_CSM?, LEVEL_4_CSM?}}
 */
async function fetchCsmHierarchyDivergenceCandidates(options = {}, deps = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    return `SELECT DEAL_SHEET_ID, PLACEMENT_ID, PLACEMENT_STATUS, CANDIDATE_NAME, CANDIDATE_NEXUS_ID,
                   ONSITE_AM_EMAIL, LEVEL_2_CSM, LEVEL_3_CSM, LEVEL_4_CSM, DATE_AND_TIME
            FROM ${fqn}
            WHERE DEAL_SHEET_ID IS NOT NULL AND PLACEMENT_ID IS NOT NULL
              AND TRIM(IFNULL(ONSITE_AM_EMAIL, '')) != ''
              AND (LEVEL_2_CSM IS NOT NULL OR LEVEL_3_CSM IS NOT NULL OR LEVEL_4_CSM IS NOT NULL)`;
  });

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               )
               SELECT * EXCEPT(rn) FROM (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY DATE_AND_TIME DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
               )
               WHERE rn = 1`;

  const rows = await queryObjects(sql, 100000);
  logLine(`[inorganic hierarchy logs] fetchCsmHierarchyDivergenceCandidates latest rows scanned=${rows.length}`);
  if (rows.length === 0) return [];

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const norm = String(row.ONSITE_AM_EMAIL).trim().toLowerCase();
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  // Never forward `options` — see the same note in fetchDealRecruiterHierarchyByPlacementId.
  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  rows.forEach((row, index) => {
    const norm = String(row.ONSITE_AM_EMAIL).trim().toLowerCase();
    const externalId = directoryByEmail.get(norm)?.externalId;
    if (!externalId) return;
    targets.push({ key: String(index), externalId, anchorDate: null });
  });

  const hierarchyFetchFn = deps.hierarchyFetchFn ?? fetchHierarchyLevelChainsByKey;
  const currentLevelsByKey =
    targets.length > 0 ? await hierarchyFetchFn(targets, { direction: "on_or_after" }) : new Map();

  const candidates = [];
  rows.forEach((row, index) => {
    const currentLevels = resolveCsmLevelsFromChain(currentLevelsByKey.get(String(index)));
    const diverged = {};
    for (const target of CSM_LEVEL_TARGETS) {
      const col = target.column;
      if (normalizeForCompare(row[col]) !== normalizeForCompare(currentLevels[col])) {
        diverged[col] = currentLevels[col];
      }
    }
    if (Object.keys(diverged).length === 0) return;
    candidates.push({
      DEAL_SHEET_ID: row.DEAL_SHEET_ID,
      PLACEMENT_ID: row.PLACEMENT_ID,
      PLACEMENT_STATUS: row.PLACEMENT_STATUS,
      CANDIDATE_NAME: row.CANDIDATE_NAME,
      CANDIDATE_NEXUS_ID: row.CANDIDATE_NEXUS_ID,
      csmDivergedLevels: diverged,
    });
  });

  logLine(`[inorganic hierarchy logs] fetchCsmHierarchyDivergenceCandidates diverged=${candidates.length}`);
  return candidates;
}

/**
 * Merges recruiter-change candidates and CSM-divergence candidates by DEAL_SHEET_ID+PLACEMENT_ID
 * so a placement with both signals in the same scan produces exactly one log row.
 */
function mergeInorganicHierarchyLogCandidates(recruiterCandidates, csmCandidates) {
  const byKey = new Map();
  const keyOf = (c) => buildDealSheetPlacementCompositeKey(c.DEAL_SHEET_ID, c.PLACEMENT_ID);

  for (const c of recruiterCandidates || []) {
    const key = keyOf(c);
    if (!key) continue;
    byKey.set(key, { ...c });
  }
  for (const c of csmCandidates || []) {
    const key = keyOf(c);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, csmDivergedLevels: c.csmDivergedLevels });
    } else {
      byKey.set(key, { ...c });
    }
  }
  return [...byKey.values()];
}

/**
 * Returns Map<"DEAL_SHEET_ID|PLACEMENT_ID", { latest, previous }> for placements whose latest
 * row's ASSIGNMENT_RECRUITER_EMAIL differs from the row before it (a recruiter reassignment).
 * Scans all active domain deal sheet tables, mirroring fetchContractRateChangePairsFromActive's
 * shape but partitioned by DEAL_SHEET_ID+PLACEMENT_ID instead of CONTRACT_ID.
 */
async function fetchDealSheetRecruiterChangePairsFromActive(options = {}) {
  const out = new Map();
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = buildActiveChangeScanUnionParts(datasetId);

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               ),
               ranked AS (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY DATE_AND_TIME DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
               ),
               latest AS (SELECT * FROM ranked WHERE rn = 1),
               previous AS (SELECT * FROM ranked WHERE rn = 2),
               changed_keys AS (
                 SELECT DISTINCT
                   CAST(l.DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
                   CAST(l.PLACEMENT_ID AS STRING) AS placement_id
                 FROM latest l
                 JOIN previous p
                   ON CAST(l.DEAL_SHEET_ID AS STRING) = CAST(p.DEAL_SHEET_ID AS STRING)
                  AND CAST(l.PLACEMENT_ID AS STRING) = CAST(p.PLACEMENT_ID AS STRING)
                 WHERE TRIM(IFNULL(l.ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
                   AND LOWER(TRIM(IFNULL(l.ASSIGNMENT_RECRUITER_EMAIL, ''))) !=
                       LOWER(TRIM(IFNULL(p.ASSIGNMENT_RECRUITER_EMAIL, '')))
               )
               SELECT * FROM ranked
               WHERE rn <= 2
                 AND CAST(DEAL_SHEET_ID AS STRING) IN (SELECT deal_sheet_id FROM changed_keys)
                 AND CAST(PLACEMENT_ID AS STRING) IN (SELECT placement_id FROM changed_keys)`;

  const rows = await queryObjects(sql, 100000);
  for (const raw of rows) {
    const key = buildDealSheetPlacementCompositeKey(raw?.DEAL_SHEET_ID, raw?.PLACEMENT_ID);
    if (!key) continue;
    const rn = Number(raw.rn);
    const cleaned = stripRateChangeHistoryMetaFields(raw);
    if (!out.has(key)) out.set(key, { latest: null, previous: null });
    const slot = out.get(key);
    if (rn === 1) slot.latest = cleaned;
    else if (rn === 2) slot.previous = cleaned;
  }

  for (const [key, pair] of [...out.entries()]) {
    if (!pair.latest || !pair.previous) out.delete(key);
  }

  logLine(
    `[inorganic hierarchy logs] fetchDealSheetRecruiterChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Pure candidate extraction from a recruiter-change pair. Returns null when the pair doesn't
 * actually represent a recruiter change (defensive re-check; callers normally already filtered).
 */
function buildInorganicHierarchyLogCandidate(latestRow, previousRow) {
  if (!latestRow || !previousRow) return null;
  const newEmail = latestRow.ASSIGNMENT_RECRUITER_EMAIL == null
    ? ""
    : String(latestRow.ASSIGNMENT_RECRUITER_EMAIL).trim();
  const oldEmailNorm = previousRow.ASSIGNMENT_RECRUITER_EMAIL == null
    ? ""
    : String(previousRow.ASSIGNMENT_RECRUITER_EMAIL).trim().toLowerCase();
  if (!newEmail || newEmail.toLowerCase() === oldEmailNorm) return null;

  const dealType = normalizeDealTypeKey(latestRow.DEAL_TYPE);
  return {
    DEAL_SHEET_ID: latestRow.DEAL_SHEET_ID ?? null,
    PLACEMENT_ID: latestRow.PLACEMENT_ID ?? null,
    PLACEMENT_STATUS: latestRow.PLACEMENT_STATUS ?? null,
    CANDIDATE_NAME: latestRow.CANDIDATE_NAME ?? null,
    CANDIDATE_NEXUS_ID: latestRow.CANDIDATE_NEXUS_ID ?? null,
    DEAL_TYPE: dealType,
    anchorDate: dealType === "EXTENSION" ? (latestRow.EXTENSION_DATE ?? null) : (latestRow.NEW_HIRE_DATE ?? null),
    newRecruiterEmail: newEmail,
  };
}

/** Dedupe key for the inorganic hierarchy log: same placement + same new recruiter never logged twice. */
function buildInorganicHierarchyLogDedupeKey(row) {
  const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
  const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
  if (!dsid || !pid) return "";
  const email = row?.RECRUITER_EMAIL_ID == null ? "" : String(row.RECRUITER_EMAIL_ID).trim().toLowerCase();
  const csmPart = ["INORGANIC_LEVEL_2_CSM", "INORGANIC_LEVEL_3_CSM", "INORGANIC_LEVEL_4_CSM"]
    .map((col) => (row?.[col] == null ? "" : String(row[col]).trim().toLowerCase()))
    .join(",");
  // A row with neither signal (no recruiter change, no CSM divergence) has nothing worth deduping
  // on its own identity — fall back to empty so callers skip it rather than colliding on an
  // ambiguous "DEAL_SHEET_ID|PLACEMENT_ID||,," key shared by every no-signal row.
  if (!email && csmPart === ",,") return "";
  return `${dsid}|${pid}|${email}|${csmPart}`;
}

/**
 * Returns Set of "<DEAL_SHEET_ID>|<PLACEMENT_ID>|<recruiter email>|<csm levels>" keys already logged.
 */
async function fetchExistingInorganicHierarchyLogKeysSet(candidates, options = {}) {
  const out = new Set();
  if (!candidates || candidates.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const placementIds = [];
  const seen = new Set();
  for (const c of candidates) {
    const pid = c?.PLACEMENT_ID == null ? "" : String(c.PLACEMENT_ID).trim();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    placementIds.push(pid);
  }
  if (placementIds.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < placementIds.length; i += chunkSize) {
    const chunk = placementIds.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT DEAL_SHEET_ID, PLACEMENT_ID, RECRUITER_EMAIL_ID,
                        INORGANIC_LEVEL_2_CSM, INORGANIC_LEVEL_3_CSM, INORGANIC_LEVEL_4_CSM
                 FROM \`${config.projectId}.${datasetId}.${tableId}\`
                 WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length * 5);
    for (const row of rows) {
      const key = buildInorganicHierarchyLogDedupeKey(row);
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * Resolves full inorganic_hierarchy_logs rows for a batch of recruiter-change candidates (see
 * buildInorganicHierarchyLogCandidate). For each candidate: looks up the new recruiter in
 * directory_employees (own name/employee_id -> INORGANIC_RECRUITER/_EMP_NO, RECRUITER_NAME), then
 * their manager chain in directory_employee_hierarchy (snapshot on/after the candidate's anchor
 * date — NEW_HIRE_DATE for DEAL, EXTENSION_DATE for EXTENSION — else latest available), matching
 * each level's title to a known designation (see DESIGNATION_TO_INORGANIC_LOG_COLUMN).
 * @param {object[]} candidates
 * @returns {Promise<object[]>}
 */
async function resolveInorganicHierarchyLogRows(candidates, options = {}, deps = {}) {
  if (!candidates || candidates.length === 0) return [];

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const hierarchyFetchFn = deps.hierarchyFetchFn ?? fetchHierarchyLevelChainsByKey;

  const recruiterCandidateIndexes = [];
  const emails = [];
  const emailSeen = new Set();
  candidates.forEach((c, index) => {
    if (!c.newRecruiterEmail) return;
    recruiterCandidateIndexes.push(index);
    const norm = c.newRecruiterEmail.toLowerCase();
    if (emailSeen.has(norm)) return;
    emailSeen.add(norm);
    emails.push(norm);
  });
  // Never forward `options` — see the same note in fetchDealRecruiterHierarchyByPlacementId.
  const directoryByEmail = emails.length > 0 ? await directoryFetchFn(emails) : new Map();

  const targets = [];
  for (const index of recruiterCandidateIndexes) {
    const c = candidates[index];
    const directoryEntry = directoryByEmail.get(c.newRecruiterEmail.toLowerCase());
    if (!directoryEntry?.externalId) continue;
    targets.push({ key: String(index), externalId: directoryEntry.externalId, anchorDate: c.anchorDate });
  }
  const levelsByKey = targets.length > 0 ? await hierarchyFetchFn(targets) : new Map();

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);

  return candidates.map((c, index) => {
    const directoryEntry = c.newRecruiterEmail
      ? directoryByEmail.get(c.newRecruiterEmail.toLowerCase())
      : null;
    const row = {
      DATE_AND_TIME: nowIso,
      PLACEMENT_ID: c.PLACEMENT_ID,
      PLACEMENT_STATUS: c.PLACEMENT_STATUS,
      DEAL_SHEET_ID: c.DEAL_SHEET_ID,
      CANDIDATE_NAME: c.CANDIDATE_NAME,
      CANDIDATE_NEXUS_ID: c.CANDIDATE_NEXUS_ID,
      EFFECTIVE_DATE: todayDate,
      RECRUITER_EMAIL_ID: c.newRecruiterEmail ?? null,
      RECRUITER_NAME: directoryEntry?.nameFull ?? null,
      INORGANIC_RECRUITER: directoryEntry?.nameFull ?? null,
      INORGANIC_RECRUITER_EMP_NO: directoryEntry?.employeeId ?? null,
    };

    const levelRows = levelsByKey.get(String(index));
    if (levelRows) {
      const filledColumns = new Set();
      for (const levelRow of levelRows) {
        const designation = resolveHierarchyColumnForTitle(levelRow?.manager_title);
        if (!designation || filledColumns.has(designation)) continue;
        const target = DESIGNATION_TO_INORGANIC_LOG_COLUMN[designation];
        if (!target) continue;
        const name = normalizeExtensionRunrateBackfillValue(levelRow?.manager_name);
        const empNo = normalizeExtensionRunrateBackfillValue(levelRow?.manager_employee_id);
        if (name == null && empNo == null) continue;
        filledColumns.add(designation);
        row[target.column] = name;
        row[target.empNoColumn] = empNo;
      }
    }

    if (c.csmDivergedLevels) {
      for (const [levelColumn, value] of Object.entries(c.csmDivergedLevels)) {
        const inorganicColumn = CSM_LEVEL_TO_INORGANIC_COLUMN[levelColumn];
        if (inorganicColumn) row[inorganicColumn] = value ?? null;
      }
    }

    return row;
  });
}

/**
 * Insert recruiter-reassignment audit logs (append-only; one row per detected change).
 */
async function insertInorganicHierarchyLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[inorganic hierarchy logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "ID";
  let rowsToInsert = logRows.map((row) => {
    const next = { ...row };
    const raw = next[generatedUuidField];
    const existing = raw == null ? "" : String(raw).trim();
    if (!existing) next[generatedUuidField] = randomUUID();
    return next;
  });

  const seenKeys = new Set();
  let deduped = [];
  let droppedDupBatch = 0;
  for (const row of rowsToInsert) {
    const dedupeKey = buildInorganicHierarchyLogDedupeKey(row);
    if (dedupeKey !== "") {
      if (seenKeys.has(dedupeKey)) {
        droppedDupBatch++;
        continue;
      }
      seenKeys.add(dedupeKey);
    }
    deduped.push(row);
  }
  if (droppedDupBatch > 0) {
    logLine(
      `[inorganic hierarchy logs] dedupe(same batch DEAL_SHEET_ID+PLACEMENT_ID+RECRUITER_EMAIL_ID): dropped=${droppedDupBatch} remaining=${deduped.length}`
    );
  }

  const skipExisting = options.skipExistingInorganicHierarchyLogs !== false;
  if (skipExisting && deduped.length > 0) {
    const existingKeys = await fetchExistingInorganicHierarchyLogKeysSet(deduped, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingKeys.size > 0) {
      const filtered = [];
      let skipped = 0;
      for (const row of deduped) {
        const key = buildInorganicHierarchyLogDedupeKey(row);
        if (key !== "" && existingKeys.has(key)) {
          skipped++;
          continue;
        }
        filtered.push(row);
      }
      deduped = filtered;
      logLine(
        `[inorganic hierarchy logs] [BigQuery insertAll] dedupe(existing in log table): skipped=${skipped} remaining=${deduped.length}`
      );
    }
  }

  if (!deduped.length) {
    logLine(`[inorganic hierarchy logs] [BigQuery insertAll] SKIP: nothing left after dedupe`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const rowsForInsert = deduped.map((row) => {
    const dedupeKey = buildInorganicHierarchyLogDedupeKey(row);
    return dedupeKey ? { ...row, _INSERT_ID: dedupeKey } : row;
  });

  const result = await insertAll(rowsForInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "_INSERT_ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logLine(
    `[inorganic hierarchy logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

// ===========================================================================================
// ownership_change_logs — per-role ownership handover audit (recruiter / onsite AM / CSM levels)
// ===========================================================================================

/** Lowercase/trim a value for change comparison; null/blank -> "". */
function normalizeOwnershipValueForCompare(value) {
  if (value == null) return "";
  const unwrapped = value != null && typeof value === "object" && "value" in value ? value.value : value;
  if (unwrapped == null) return "";
  return String(unwrapped).trim().toLowerCase();
}

/** Trim a display value to a non-empty string, else null. */
function ownershipDisplayValueOrNull(value) {
  const s = normalizeExtensionRunrateBackfillValue(value);
  return s == null ? null : s;
}

/** Format a DATE-ish value to YYYY-MM-DD (UTC), else null. */
function ownershipDateOnlyOrNull(value) {
  return formatDateOnlyForSql(value);
}

/** Add one calendar day (UTC) to a DATE-ish value; returns YYYY-MM-DD or null. */
function addOneDayToDateOnly(value) {
  const ymd = formatDateOnlyForSql(value);
  if (ymd == null) return null;
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Scan active deal-sheet tables for placements whose latest row differs from the row before it in
 * ANY ownership role (recruiter email, onsite AM email, or a CSM level). Returns
 * Map<"DEAL_SHEET_ID|PLACEMENT_ID", { latest, previous }>. Mirrors
 * fetchDealSheetRecruiterChangePairsFromActive but with a wider change predicate.
 */
async function fetchDealSheetOwnershipChangePairsFromActive(options = {}) {
  const out = new Map();
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = buildActiveChangeScanUnionParts(datasetId);

  // A role "changed" when latest's normalized value differs from previous AND latest is non-empty
  // (a genuine new owner — pure removals aren't logged here). Matches OWNERSHIP_CHANGE_DIFF_ROLES.
  const changePredicate = OWNERSHIP_CHANGE_DIFF_ROLES.map((r) => {
    const col = r.changeField;
    return `(LOWER(TRIM(IFNULL(l.${col}, ''))) != LOWER(TRIM(IFNULL(p.${col}, ''))) `
      + `AND TRIM(IFNULL(l.${col}, '')) != '')`;
  }).join(" OR ");

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               ),
               ranked AS (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY DATE_AND_TIME DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
               ),
               latest AS (SELECT * FROM ranked WHERE rn = 1),
               previous AS (SELECT * FROM ranked WHERE rn = 2),
               changed_keys AS (
                 SELECT DISTINCT
                   CAST(l.DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
                   CAST(l.PLACEMENT_ID AS STRING) AS placement_id
                 FROM latest l
                 JOIN previous p
                   ON CAST(l.DEAL_SHEET_ID AS STRING) = CAST(p.DEAL_SHEET_ID AS STRING)
                  AND CAST(l.PLACEMENT_ID AS STRING) = CAST(p.PLACEMENT_ID AS STRING)
                 WHERE ${changePredicate}
               )
               SELECT * FROM ranked
               WHERE rn <= 2
                 AND CAST(DEAL_SHEET_ID AS STRING) IN (SELECT deal_sheet_id FROM changed_keys)
                 AND CAST(PLACEMENT_ID AS STRING) IN (SELECT placement_id FROM changed_keys)`;

  const rows = await queryObjects(sql, 100000);
  for (const raw of rows) {
    const key = buildDealSheetPlacementCompositeKey(raw?.DEAL_SHEET_ID, raw?.PLACEMENT_ID);
    if (!key) continue;
    const rn = Number(raw.rn);
    const cleaned = stripRateChangeHistoryMetaFields(raw);
    if (!out.has(key)) out.set(key, { latest: null, previous: null });
    const slot = out.get(key);
    if (rn === 1) slot.latest = cleaned;
    else if (rn === 2) slot.previous = cleaned;
  }
  for (const [key, pair] of [...out.entries()]) {
    if (!pair.latest || !pair.previous) out.delete(key);
  }

  logLine(
    `[ownership change logs] fetchDealSheetOwnershipChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/** Shared per-row context (candidate/placement/dates) for every ownership log row of a placement. */
function buildOwnershipChangeLogContext(latestRow, nowIso) {
  const tentative = latestRow?.TENTATIVE_DATE;
  return {
    DATE_AND_TIME: nowIso,
    SKU_NO: null,
    CONTRACT_ID: ownershipDisplayValueOrNull(latestRow?.CONTRACT_ID),
    PLACEMENT_ID: latestRow?.PLACEMENT_ID == null ? null : String(latestRow.PLACEMENT_ID).trim(),
    CANDIDATE_NAME: latestRow?.CANDIDATE_NAME ?? null,
    CANDIDATE_EMAIL: latestRow?.CANDIDATE_EMAIL ?? null,
    START_DATE: ownershipDateOnlyOrNull(latestRow?.START_DATE),
    // Temporary: tentative end date + 1. Overwritten to the extension's START_DATE later, keyed by
    // CONTRACT_ID (see overwriteOwnershipChangeLogEffectiveDatesFromExtensions).
    EFFECTIVE_DATE: addOneDayToDateOnly(tentative),
    END_DATE_PREVIOUS_OWNER: ownershipDateOnlyOrNull(tentative),
    CHANGE_REASON_NOTES: null,
    STATUS_REMARKS: null,
    EDITED_BY: null,
  };
}

/**
 * Build ownership_change_logs rows for one placement's latest-vs-previous pair.
 * One row per OWNERSHIP_CHANGE_DIFF_ROLES role whose owner changed. Plus, on a RECRUITER change,
 * if the new recruiter's emp-no matches a hierarchy role the SAME person held in the previous row
 * (e.g. they were the RM), a "vacated" row for that role (NEW_OWNER = 'NA').
 */
function buildOwnershipChangeLogRows(latestRow, previousRow) {
  if (!latestRow || !previousRow) return [];
  const nowIso = new Date().toISOString();
  const ctx = buildOwnershipChangeLogContext(latestRow, nowIso);
  const rows = [];

  let recruiterChanged = false;
  for (const r of OWNERSHIP_CHANGE_DIFF_ROLES) {
    const latestKey = normalizeOwnershipValueForCompare(latestRow[r.changeField]);
    const prevKey = normalizeOwnershipValueForCompare(previousRow[r.changeField]);
    if (latestKey === "" || latestKey === prevKey) continue;
    if (r.role === "RECRUITER") recruiterChanged = true;
    rows.push({
      ...ctx,
      OWNERSHIP_ROLE: r.role,
      NEW_OWNER_NAME: ownershipDisplayValueOrNull(latestRow[r.nameField]),
      NEW_OWNER_EMP_NO: r.empField ? ownershipDisplayValueOrNull(latestRow[r.empField]) : null,
      PREVIOUS_OWNER_NAME: ownershipDisplayValueOrNull(previousRow[r.nameField]),
      PREVIOUS_OWNER_EMP_NO: r.empField ? ownershipDisplayValueOrNull(previousRow[r.empField]) : null,
    });
  }

  // Vacated-role rows: the new recruiter previously held a hierarchy role on this deal, so that
  // role's slot is now vacant (NEW_OWNER = 'NA'). Matched by emp-no on the PREVIOUS row.
  if (recruiterChanged) {
    const newRecruiterEmp = normalizeOwnershipValueForCompare(latestRow.RECRUITER_EMP_NO);
    if (newRecruiterEmp !== "") {
      for (const target of DEAL_RECRUITER_HIERARCHY_TARGETS) {
        const prevEmp = normalizeOwnershipValueForCompare(previousRow[target.empNoColumn]);
        if (prevEmp === "" || prevEmp !== newRecruiterEmp) continue;
        rows.push({
          ...ctx,
          OWNERSHIP_ROLE: target.column,
          NEW_OWNER_NAME: "NA",
          NEW_OWNER_EMP_NO: "NA",
          PREVIOUS_OWNER_NAME: ownershipDisplayValueOrNull(previousRow[target.column]),
          PREVIOUS_OWNER_EMP_NO: ownershipDisplayValueOrNull(previousRow[target.empNoColumn]),
        });
      }
    }
  }

  return rows;
}

/** Dedupe key: same placement + role + new owner + previous owner never logged twice. */
function buildOwnershipChangeLogDedupeKey(row) {
  const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
  const role = row?.OWNERSHIP_ROLE == null ? "" : String(row.OWNERSHIP_ROLE).trim().toUpperCase();
  if (!pid || !role) return "";
  const parts = [
    pid,
    role,
    normalizeOwnershipValueForCompare(row?.NEW_OWNER_NAME),
    normalizeOwnershipValueForCompare(row?.NEW_OWNER_EMP_NO),
    normalizeOwnershipValueForCompare(row?.PREVIOUS_OWNER_NAME),
    normalizeOwnershipValueForCompare(row?.PREVIOUS_OWNER_EMP_NO),
  ];
  return parts.join("|");
}

/** Returns Set of dedupe keys already present in ownership_change_logs (looked up by PLACEMENT_ID). */
async function fetchExistingOwnershipChangeLogKeysSet(logRows, options = {}) {
  const out = new Set();
  if (!logRows || logRows.length === 0) return out;

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const placementIds = [];
  const seen = new Set();
  for (const r of logRows) {
    const pid = r?.PLACEMENT_ID == null ? "" : String(r.PLACEMENT_ID).trim();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    placementIds.push(pid);
  }
  if (placementIds.length === 0) return out;

  const chunkSize = 500;
  for (let i = 0; i < placementIds.length; i += chunkSize) {
    const chunk = placementIds.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `SELECT PLACEMENT_ID, OWNERSHIP_ROLE, NEW_OWNER_NAME, NEW_OWNER_EMP_NO,
                        PREVIOUS_OWNER_NAME, PREVIOUS_OWNER_EMP_NO
                 FROM \`${config.projectId}.${datasetId}.${tableId}\`
                 WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})`;
    const rows = await queryObjects(sql, chunk.length * 10);
    for (const row of rows) {
      const key = buildOwnershipChangeLogDedupeKey(row);
      if (key) out.add(key);
    }
  }
  return out;
}

/** Insert ownership_change_logs rows (append-only; batch + existing-table dedupe). */
async function insertOwnershipChangeLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logLine(`[ownership change logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  let rowsToInsert = logRows.map((row) => {
    const next = { ...row };
    const raw = next.ID;
    if (raw == null || String(raw).trim() === "") next.ID = randomUUID();
    return next;
  });

  const seenKeys = new Set();
  let deduped = [];
  let droppedDupBatch = 0;
  for (const row of rowsToInsert) {
    const key = buildOwnershipChangeLogDedupeKey(row);
    if (key !== "") {
      if (seenKeys.has(key)) {
        droppedDupBatch++;
        continue;
      }
      seenKeys.add(key);
    }
    deduped.push(row);
  }
  if (droppedDupBatch > 0) {
    logLine(`[ownership change logs] dedupe(same batch): dropped=${droppedDupBatch} remaining=${deduped.length}`);
  }

  const skipExisting = options.skipExistingOwnershipChangeLogs !== false;
  if (skipExisting && deduped.length > 0) {
    const existingKeys = await fetchExistingOwnershipChangeLogKeysSet(deduped, {
      datasetId: options.datasetId,
      tableId: options.tableId,
    });
    if (existingKeys.size > 0) {
      const filtered = [];
      let skipped = 0;
      for (const row of deduped) {
        const key = buildOwnershipChangeLogDedupeKey(row);
        if (key !== "" && existingKeys.has(key)) {
          skipped++;
          continue;
        }
        filtered.push(row);
      }
      deduped = filtered;
      logLine(`[ownership change logs] [BigQuery insertAll] dedupe(existing in log table): skipped=${skipped} remaining=${deduped.length}`);
    }
  }

  if (!deduped.length) {
    logLine(`[ownership change logs] [BigQuery insertAll] SKIP: nothing left after dedupe`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const rowsForInsert = deduped.map((row) => {
    const key = buildOwnershipChangeLogDedupeKey(row);
    return key ? { ...row, _INSERT_ID: key } : row;
  });

  const result = await insertAll(rowsForInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "_INSERT_ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;
  logLine(
    `[ownership change logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Overwrite EFFECTIVE_DATE on ownership_change_logs rows once a real extension exists for the same
 * CONTRACT_ID: set EFFECTIVE_DATE to the earliest EXTENSION START_DATE for that contract (the
 * handover became effective when the extension started, replacing the temporary tentative+1 date).
 * Idempotent — only touches rows whose EFFECTIVE_DATE differs from the resolved extension date.
 */
async function overwriteOwnershipChangeLogEffectiveDatesFromExtensions(options = {}) {
  const dealSheetDatasetId =
    typeof options.dealSheetDatasetId === "string" && options.dealSheetDatasetId.trim() !== ""
      ? options.dealSheetDatasetId.trim()
      : config.datasetId;
  const { datasetId: logDatasetId, tableId: logTableId } = {
    datasetId:
      typeof options.datasetId === "string" && options.datasetId.trim() !== ""
        ? options.datasetId.trim()
        : config.ownershipChangeLogDatasetId,
    tableId:
      typeof options.tableId === "string" && options.tableId.trim() !== ""
        ? options.tableId.trim()
        : config.ownershipChangeLogTableId,
  };
  const unionSql = buildActiveDealSheetsUnionSql(dealSheetDatasetId);

  const sql = `
    UPDATE \`${config.projectId}.${logDatasetId}.${logTableId}\` o
    SET EFFECTIVE_DATE = ext.ext_start_date
    FROM (
      SELECT
        UPPER(TRIM(CAST(CONTRACT_ID AS STRING))) AS contract_id_norm,
        MIN(START_DATE) AS ext_start_date
      FROM (${unionSql})
      WHERE UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) = 'EXTENSION'
        AND CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
        AND START_DATE IS NOT NULL
      GROUP BY contract_id_norm
    ) ext
    WHERE o.CONTRACT_ID IS NOT NULL
      AND UPPER(TRIM(CAST(o.CONTRACT_ID AS STRING))) = ext.contract_id_norm
      AND (o.EFFECTIVE_DATE IS NULL OR o.EFFECTIVE_DATE != ext.ext_start_date)
  `;

  const [job] = await bigquery.createQueryJob({ query: sql });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  const updated = meta?.dmlStats?.updatedRowCount ?? null;
  logLine(
    `[ownership change logs] effective-date overwrite from extensions: updatedRows=${updated == null ? "n/a" : updated}`
  );
  return { updated: updated == null ? null : Number(updated) };
}

module.exports = {
  queryObjects,
  fetchExistingDealSheetIdsSet,
  fetchExistingPlacementIdsSet,
  fetchExistingRateChangeLogContractKeysSet,
  fetchContractRateChangePairsFromActive,
  buildRateChangeLogDedupeKey,
  fetchExistingDealSheetIdsSetAnyActiveTable,
  fetchExistingPlacementIdsSetAnyActiveTable,
  fetchPlacementStatusesByPlacementIds,
  fetchLatestRowsByDealSheetIds,
  fetchLatestTwoRowsByDealSheetIdsAcrossActive,
  fetchLatestRowsByDealSheetPlacementPairs,
  fetchLatestAdditionalCostLogRowsByKeys,
  buildTerminationReasonLogCompositeKey,
  fetchLatestTerminationReasonLogRowsByKeys,
  insertTerminationReasonLogBatch,
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
  buildAdditionalCostLogCompositeKey,
  normalizeMoveRunrate,
  applyMoveRunrateAppendOverride,
  applyIsRejectedResetForChangedUpdate,
  applyManualColumnsCarryForward,
  applyTentativeDateFreeze,
  applyNewHireDateFreeze,
  applyExtensionDateFreeze,
  applyExtensionStartDateForRow,
  applyExtensionStartDatesForInsertRows,
  fetchNewHireDatesFromActiveTable,
  resolveNewHireDatesForEndedRows,
  computeDealSheetFirstInsertDateStamps,
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
  fetchEmployeeDirectoryByEmails,
  buildActiveDealSheetsUnionSql,
  formatDateOnlyForSql,
  EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
  EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES,
  isExtensionRunrateEligiblePlacementStatus,
  buildRunrateEligiblePlacementStatusSqlPredicate,
  EXTENSION_PARENT_DEAL_INHERIT_COLUMNS,
  rowNeedsExtensionInsertBackfill,
  rowNeedsExtensionRunrateBackfill,
  fetchExtensionParentDealInheritByPlacementId,
  fetchExtensionRunrateBackfillByPlacementId,
  resolveContractIdsForRunrateMatchedExtensions,
  applyExtensionInheritForInsertRows,
  applyExtensionRunrateBackfillForInsertRows,
  rowNeedsDealRecruiterHierarchyBackfill,
  fetchDealRecruiterHierarchyByPlacementId,
  applyDealRecruiterHierarchyForInsertRows,
  fetchHierarchyLevelChainsByKey,
  fetchDealSheetRecruiterChangePairsFromActive,
  buildInorganicHierarchyLogCandidate,
  buildInorganicHierarchyLogDedupeKey,
  fetchExistingInorganicHierarchyLogKeysSet,
  resolveInorganicHierarchyLogRows,
  insertInorganicHierarchyLogBatch,
  fetchOnsiteAmCsmHierarchyByKey,
  applyOnsiteAmCsmHierarchyForRows,
  fetchCsmHierarchyDivergenceCandidates,
  mergeInorganicHierarchyLogCandidates,
  fetchDealSheetOwnershipChangePairsFromActive,
  buildOwnershipChangeLogRows,
  buildOwnershipChangeLogDedupeKey,
  fetchExistingOwnershipChangeLogKeysSet,
  insertOwnershipChangeLogBatch,
  overwriteOwnershipChangeLogEffectiveDatesFromExtensions,
  applyPreviousRecruiterOnRecruiterChange,
};
