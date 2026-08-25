/**
 * BigQuery Client
 * Handles BigQuery operations for deal sheet data
 */

const { BigQuery } = require("@google-cloud/bigquery");
const { randomUUID } = require("crypto");
const config = require("./config");
const { logDetail, logError } = require("./logger");
const { shouldExcludeRowFromBigQuery } = require("./bqRowExclusions");
const {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  ENDED_DEAL_SHEET_TABLE_IDS,
  resolveActiveDealSheetTableId,
  resolveActiveDealSheetTableIdForRow,
  resolvePairedActiveTableId,
  resolveRunrateTableIdForDealSheetTable,
} = require("./recruiterDomainTables");
const {
  API_OWNED_COLUMNS,
  SYSTEM_CONTROLLED_COLUMNS,
  MANUAL_COLUMNS,
  isDidNotStartPlacementStatus,
  startDateOnOrAfterUtcMin,
  effectiveMinFilterDate,
} = require("./columnMappings");
const { isCynetHealthCanadaRecruiter, isCanadaDealSheetRow, sanitizeCanadaDealSheetRow, CANADA_EXCLUDED_API_OWNED_COLUMNS } = require("./canadaDerivedPlacementFields");
const { isCynetLocumsRecruiter, sanitizeLocumsDealSheetRow, LOCUMS_EXCLUDED_API_OWNED_COLUMNS } = require("./locumsDerivedPlacementFields");

/**
 * While Cynet Health Canada is being validated, no log table should accumulate rows keyed on its
 * placements — the deal sheet is deleted and re-synced repeatedly, so those log rows would only have
 * to be cleaned up again (see sql/cleanup_canada_test_rows.sql).
 *
 * This gates the insert-time contract-chain ownership logs, which run inside insertAll and are
 * therefore reached by EVERY insert path (scheduled trigger, manual HTTP, refresh endpoint). The
 * companion switches live in index.js (SYNC_DOMAINS_WITHOUT_AUDIT_LOG_SCANS, for the table-wide
 * scans) and syncService.js (ENRICH_LOG_WRITES_DISABLED_DOMAINS, for the per-row enrich logs).
 *
 * Set to false once Canada's data is trusted; cynet health and locums are unaffected either way.
 */
const LOG_WRITES_DISABLED_FOR_CANADA = true;

/**
 * Deal sheet tables left OUT of the ch_rate_change_logs scan.
 *
 * rateChangeLogSyncTrigger is a SEPARATE scheduled function from the per-domain deal sheet triggers,
 * so the domain gates in index.js do not reach it — it scans every active table on its own schedule.
 * Canada is excluded here for the same reason its other log writes are off: its rows are deleted and
 * re-synced repeatedly while the domain is validated.
 *
 * Empty this set (or remove the option at the call sites) to let canada back in.
 */
const RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS = LOG_WRITES_DISABLED_FOR_CANADA
  ? new Set(["cynet_health_canada_deal_sheet", "cynet_health_canada_ended_deal_sheet"])
  : new Set();

/**
 * Columns each DEAL SHEET table does not have — the single source of truth for every query that
 * names columns against one of them.
 *
 * Cynet Health Canada dropped these in Aug 2026 (see sql/migrate_canada_deal_sheet_schema.sql):
 * it has no AVP role (the chain tops out at VP / Sr. VP), no 52-week tenure tracking, and no
 * Conrep client name. Any SQL that hardcodes one of them against the Canada tables fails the whole
 * run with "Unrecognized name: <col>".
 *
 * ALWAYS consult this map when writing a query that names deal-sheet columns and can run against
 * more than one domain table. Cynet health and locums are absent from it and keep every column.
 */
const DEAL_SHEET_MISSING_COLUMNS_BY_TABLE = new Map([
  [
    "cynet_health_canada_deal_sheet",
    new Set([
      "AVP",
      "AVP_EMP_NO",
      "FIFTYTWO_TENURE_RTO_LASTDATE",
      "FIFTYTWO_TENURE_CANDIDATE_STATUS",
      "CLIENT_NAME_IN_CONREP",
    ]),
  ],
  [
    "cynet_health_canada_ended_deal_sheet",
    new Set([
      "AVP",
      "AVP_EMP_NO",
      "FIFTYTWO_TENURE_RTO_LASTDATE",
      "FIFTYTWO_TENURE_CANDIDATE_STATUS",
      "CLIENT_NAME_IN_CONREP",
    ]),
  ],
]);

/**
 * Columns the given deal sheet table does not have.
 *
 * Pass the tableId a query runs against; with no tableId the query spans every active table, so the
 * union of all tables' missing columns is returned (only columns common to all are safe to name).
 *
 * EVERY query that names deal-sheet columns and can run against more than one domain table must
 * filter through this — see canadaSchemaGapGuard.test.js.
 *
 * @param {string} [tableId]
 * @returns {Set<string>}
 */
function resolveDealSheetMissingColumns(tableId) {
  const key = tableId == null ? "" : String(tableId).trim();
  if (key) return DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(key) ?? new Set();
  const all = new Set();
  for (const set of DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.values()) {
    for (const col of set) all.add(col);
  }
  return all;
}

// CONTRACT_ID allocation lives entirely in contractIdResolver.js (DEAL rows only) — this module
// only ever reuses an existing id, so it needs neither the sequence nor its options builder.
const { normalizeContractIdOrNull } = require("./contractIdFormat");
const {
  DEAL_RECRUITER_HIERARCHY_TARGETS,
  DESIGNATION_TO_INORGANIC_LOG_COLUMN,
  MANAGED_HIERARCHY_DESIGNATIONS,
  CSM_LEVEL_TARGETS,
  CSM_LEVEL_TO_INORGANIC_COLUMN,
  CSM_HIERARCHY_EXCLUDED_TITLES,
  resolveCsmLevelsFromChain,
  resolveHierarchyColumnForTitle,
  hierarchyTargetForDesignation,
  computeRecruiterHierarchyRoleChanges,
  OWNERSHIP_CHANGE_DIFF_ROLES,
} = require("./recruiterHierarchyDesignations");
const {
  fetchDepartmentEmployeesByNames,
  resolveActiveOrManager,
  isActiveStatus,
  normalizeNameKey,
} = require("./departmentDataStatus");
const { backfillExtensionRehire } = require("./extensionRehire");
const { backfillClusterRegions } = require("./clusterRegionResolver");
// Required lazily inside the wrapper: extensionParentBackfill reads
// EXTENSION_PARENT_DEAL_INHERIT_COLUMNS back off this module, so a top-level require here would be a
// cycle and would see an empty exports object.
let backfillExtensionParentInherit = null;

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
  logDetail(
    `[enriched sync] [BigQuery auth] mode=service_account client_email=${config.serviceAccount.client_email} target_table=${tableFqn}`
  );
} else {
  bigquery = new BigQuery({ projectId: config.projectId });
  logDetail(`[enriched sync] [BigQuery auth] mode=runtime_default target_table=${tableFqn}`);
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
 * Run a BigQuery query and return results as objects.
 *
 * maxResults is a PAGE size, not a total row cap, and bigquery.query() resolves with only the FIRST
 * page — so an under-sized value silently drops every row past it. Omit it (the default) to let the
 * client fetch the complete result set; pass a value only when a genuine cap is wanted.
 */
async function queryObjects(sql, maxResults) {
  const options = { query: sql };
  if (Number.isFinite(maxResults) && maxResults > 0) options.maxResults = maxResults;
  const [rows] = await bigquery.query(options);
  return rows;
}

/** Run a DML statement; returns updated/inserted/deleted row count when available. */
async function runDml(sql) {
  const [job] = await bigquery.createQueryJob({ query: sql });
  await job.getQueryResults();
  const stats = job.metadata?.statistics?.query?.dmlStats || {};
  return Number(stats.updatedRowCount ?? stats.insertedRowCount ?? stats.deletedRowCount ?? 0);
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
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
/**
 * Build schema-safe `SELECT ... UNION ALL` parts across the active domain deal-sheet tables. Those
 * tables have divergent schemas, so a plain `SELECT *` UNION breaks on column-count mismatch. This
 * projects the SUPERSET of columns (health table's ordinal order first, then any table-only columns)
 * and emits `CAST(NULL AS <type>) AS col` for columns a table doesn't have — so every branch has the
 * same columns in the same order, and downstream `SELECT *` code still sees every field.
 * @param {string} datasetId
 * @param {string} [whereClause] optional predicate appended per branch (e.g. "CONTRACT_ID IS NOT NULL")
 * @returns {Promise<string[]>}
 */
async function buildActiveDealSheetSchemaSafeUnionParts(datasetId, whereClause = "", options = {}) {
  // Callers can leave a domain's table out entirely (rate-change logs do this for canada while that
  // domain is being validated). Defaults to all three tables, so existing callers are unaffected.
  const excluded =
    options.excludeTableIds instanceof Set
      ? options.excludeTableIds
      : new Set(Array.isArray(options.excludeTableIds) ? options.excludeTableIds : []);
  const tableIds = ACTIVE_DEAL_SHEET_TABLE_IDS.filter((t) => !excluded.has(t));
  if (tableIds.length === 0) return [];

  const inList = tableIds.map((t) => `'${escapeSqlString(t)}'`).join(", ");
  const metaSql = `SELECT table_name, column_name, data_type, ordinal_position
                   FROM \`${config.projectId}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
                   WHERE table_name IN (${inList})`;
  const metaRows = await queryObjects(metaSql, 100000);

  const colsByTable = new Map();
  const typeByCol = new Map();
  const healthOrdinal = new Map();
  for (const t of tableIds) colsByTable.set(t, new Set());
  for (const r of metaRows) {
    const t = r?.table_name;
    const c = r?.column_name;
    if (t == null || c == null || !colsByTable.has(t)) continue;
    colsByTable.get(t).add(c);
    if (!typeByCol.has(c)) typeByCol.set(c, String(r.data_type || "STRING"));
    if (t === tableIds[0]) healthOrdinal.set(c, Number(r.ordinal_position));
  }

  const orderedCols = [...typeByCol.keys()].sort((a, b) => {
    const oa = healthOrdinal.has(a) ? healthOrdinal.get(a) : Number.MAX_SAFE_INTEGER;
    const ob = healthOrdinal.has(b) ? healthOrdinal.get(b) : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const where = whereClause && whereClause.trim() !== "" ? ` WHERE ${whereClause}` : "";
  return tableIds.map((t) => {
    const have = colsByTable.get(t);
    const proj = orderedCols.map((c) =>
      have.has(c) ? `\`${c}\`` : `CAST(NULL AS ${typeByCol.get(c)}) AS \`${c}\``
    );
    return `SELECT ${proj.join(", ")}, '${escapeSqlString(t)}' AS _src `
      + `FROM \`${config.projectId}.${datasetId}.${t}\`${where}`;
  });
}

async function fetchContractRateChangePairsFromActive(options = {}) {
  const out = new Map();
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  // The 3 active domain tables have DIVERGENT schemas (different column sets/counts), so a plain
  // `SELECT *` UNION ALL fails with a column-count mismatch. Build a schema-safe union: project the
  // SUPERSET of columns (health ordinal order), and for any column a given table lacks, emit a typed
  // NULL so every UNION branch has identical columns. Robust to future per-table schema drift.
  const unionParts = await buildActiveDealSheetSchemaSafeUnionParts(
    datasetId,
    "CONTRACT_ID IS NOT NULL",
    // Canada is excluded while it is being validated — no ch_rate_change_logs row should be
    // keyed on a placement that is about to be deleted and re-synced.
    { excludeTableIds: RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS }
  );

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               ),
               ranked AS (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY CONTRACT_ID
                     ORDER BY LAST_UPDATED DESC NULLS LAST
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

  logDetail(
    `[rate-change logs BQ scan] fetchContractRateChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Returns Map<dealSheetIdString, { latest, previous }> across all active domain tables.
 * latest = most recent row by LAST_UPDATED; previous = second most recent (or null).
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
                  ORDER BY LAST_UPDATED DESC NULLS LAST
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    // No maxResults cap: the query is already ROW_NUMBER()-filtered to _rn = 1, so it returns at
    // most one row per key. A cap here can only truncate the baseline set, and a missing baseline
    // makes the append-on-change gate treat an existing placement as new and re-append it.
    const dbRows = await queryObjects(sql);
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    // No maxResults cap: the query is already ROW_NUMBER()-filtered to _rn = 1, so it returns at
    // most one row per key. A cap here can only truncate the baseline set, and a missing baseline
    // makes the append-on-change gate treat an existing placement as new and re-append it.
    const dbRows = await queryObjects(sql);
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE ${wherePairs}
                 )
                 WHERE _rn = 1`;
    // No maxResults cap: the query is already ROW_NUMBER()-filtered to _rn = 1, so it returns at
    // most one row per key. A cap here can only truncate the baseline set, and a missing baseline
    // makes the append-on-change gate treat an existing placement as new and re-append it.
    const dbRows = await queryObjects(sql);
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

/**
 * True when a column must be ignored for this row's domain, because the domain's table has no such
 * column. Canada is keyed on the row (CLIENT_STATE province); locums still on the recruiter email.
 */
function shouldSkipDomainExcludedApiOwnedColumn(row, key) {
  if (isCanadaDealSheetRow(row) && CANADA_EXCLUDED_API_OWNED_COLUMNS.has(key)) return true;
  const email = row?.ASSIGNMENT_RECRUITER_EMAIL;
  if (isCynetLocumsRecruiter(email) && LOCUMS_EXCLUDED_API_OWNED_COLUMNS.has(key)) return true;
  return false;
}

function hasBusinessColumnChanges(incomingRow, existingRow, ignoreFieldsSet) {
  if (!existingRow) return true;
  const email = incomingRow?.ASSIGNMENT_RECRUITER_EMAIL;
  const isDomainTypeDerived = isCanadaDealSheetRow(incomingRow) || isCynetLocumsRecruiter(email);
  if (isDomainTypeDerived) {
    if (normalizeForCompare(incomingRow?.PAYMENT_TYPE) !== normalizeForCompare(existingRow?.PAYMENT_TYPE)) {
      return true;
    }
  }
  for (const key of API_OWNED_COLUMNS) {
    if (ignoreFieldsSet && ignoreFieldsSet.has(key)) continue;
    if (shouldSkipDomainExcludedApiOwnedColumn(incomingRow, key)) continue;
    const incomingVal = normalizeForCompare(incomingRow?.[key]);
    const existingVal = normalizeForCompare(existingRow?.[key]);
    // CONTRACT_ID is a Cynet-internal identity resolved INSIDE the insert pipeline (reused from the
    // existing row), so a freshly-enriched incoming row still has it null at compare time. Treat
    // "incoming null vs baseline populated" as unchanged — otherwise every update refresh sees a
    // false CONTRACT_ID change and re-appends a 0-diff row forever. A genuine reassignment (both
    // non-null and different) is still detected.
    // NOTE: START_DATE/END_DATE for DID NOT ACCEPT/START rows are NOT special-cased here — the refresh
    // applies applyDidNotAcceptDateOverrides to the compare row first, so the gate already sees the
    // final dates (see refreshPlacementRecordToBigQuery). Extensions keep their own START_DATE.
    if (key === "CONTRACT_ID" && incomingVal == null && existingVal != null) continue;
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
  if (!config.extensionDateFreezeEnabled) {
    const dealType = incomingRow?.DEAL_TYPE == null
      ? ""
      : String(incomingRow.DEAL_TYPE).trim().toUpperCase();
    if (dealType === "EXTENSION") {
      const incomingEd = normalizeForCompare(incomingRow?.EXTENSION_DATE);
      const existingEd = normalizeForCompare(existingRow?.EXTENSION_DATE);
      if (incomingEd !== existingEd) return true;
    }
  }
  if (isDidNotStartPlacementStatus(incomingRow?.PLACEMENT_STATUS)) {
    const incomingTent = normalizeForCompare(incomingRow?.TENTATIVE_END_DATE);
    const existingTent = normalizeForCompare(existingRow?.TENTATIVE_END_DATE);
    if (incomingTent !== existingTent) return true;
  }
  // PREVIOUS_RECRUITER_* is no longer written to the deal sheet, so there is no fill-when-empty
  // append to force here — a recruiter handover already shows up as an ASSIGNMENT_RECRUITER_EMAIL
  // change in the business-column comparison above.
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
 * Carry the baseline CONTRACT_ID onto an update-append row.
 *
 * A placement's contract identity is decided ONCE, at its first insert, and is immutable from then
 * on: ch_rate_change_logs / ownership_change_logs / ch_termination_reason_logs are all keyed on it,
 * and EXTENSION rows inherit it from their parent DEAL. An update-append is the SAME placement, so
 * it must reuse the id the baseline already carries.
 *
 * Without this the id was silently re-derived on every update. CONTRACT_ID is not in
 * MANUAL_COLUMNS, so applyManualColumnsCarryForward never copied it; a freshly-enriched row reaches
 * the insert path with CONTRACT_ID null, and the allocator further down then re-matched it against
 * the run-rate table from scratch. When that match landed on a different one of the candidate's
 * overlapping contracts, the same placement changed id between two appends — live example
 * (DEAL_SHEET_ID 5139885 / PLACEMENT_ID 1441464, Aug 2026): CHC20908 on 08-17, CHC20892 on 08-18,
 * every business field identical. Fixing the run-rate match determinism alone is not enough, since
 * the run-rate table itself changes underneath; the id has to stop being re-derived at all.
 *
 * Only fills a null: a baseline with no id leaves the row to the allocator, which is what a
 * placement with no contract identity yet is supposed to do.
 *
 * @returns {{row: object, carried: boolean}}
 */
function applyContractIdCarryForward(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, carried: false };
  }
  const baselineId = normalizeContractIdOrNull(baselineRow.CONTRACT_ID);
  if (baselineId == null) return { row: incomingRow, carried: false };
  const incomingId = normalizeContractIdOrNull(incomingRow.CONTRACT_ID);
  if (incomingId === baselineId) return { row: incomingRow, carried: false };
  return { row: { ...incomingRow, CONTRACT_ID: baselineId }, carried: true };
}

/**
 * Copy explicit MANUAL_COLUMNS from baseline onto incoming before append-on-change insert.
 * Strips enrich-spread manual keys first so baseline always wins (incl. null).
 */
function applyManualColumnsCarryForward(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, carriedCount: 0 };
  }
  const email = incomingRow?.ASSIGNMENT_RECRUITER_EMAIL;
  // PAYMENT_TYPE drives the Canada burden multiplier and the locums rate family, so those domains
  // must take the API value rather than freezing the manual one. Canada is keyed on the province.
  const skipManualType = isCanadaDealSheetRow(incomingRow) || isCynetLocumsRecruiter(email);
  const skipManualEntity = isCynetLocumsRecruiter(email);
  const out = { ...incomingRow };
  for (const key of MANUAL_COLUMNS) {
    if (skipManualType && key === "PAYMENT_TYPE") continue;
    if (skipManualEntity && key === "ENTITY") continue;
    delete out[key];
  }
  let carriedCount = 0;
  for (const key of MANUAL_COLUMNS) {
    if (skipManualType && key === "PAYMENT_TYPE") continue;
    if (skipManualEntity && key === "ENTITY") continue;
    out[key] = Object.prototype.hasOwnProperty.call(baselineRow, key)
      ? baselineRow[key]
      : null;
    carriedCount++;
  }
  return { row: out, carriedCount };
}

/**
 * Freeze TENTATIVE_END_DATE from baseline when START_DATE is unchanged; keep incoming
 * API value when START_DATE changed (then freeze again on subsequent same-start runs).
 * DID NOT START always clears TENTATIVE_END_DATE (no baseline carry-forward).
 */
function applyTentativeDateFreeze(incomingRow, baselineRow) {
  if (!baselineRow || !incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (isDidNotStartPlacementStatus(incomingRow?.PLACEMENT_STATUS)) {
    return { row: { ...incomingRow, TENTATIVE_END_DATE: null }, frozen: false };
  }
  const incomingStart = normalizeForCompare(incomingRow.START_DATE);
  const baselineStart = normalizeForCompare(baselineRow.START_DATE);
  if (incomingStart === baselineStart) {
    return {
      row: { ...incomingRow, TENTATIVE_END_DATE: baselineRow.TENTATIVE_END_DATE },
      frozen: true,
    };
  }
  return { row: incomingRow, frozen: false };
}

/**
 * On an update-append where ASSIGNMENT_RECRUITER_EMAIL changed vs baseline, capture the OUTGOING
 * recruiter's identity on the IN-MEMORY temp fields __PREV_RECRUITER_NAME/EMAIL/EMP_NO (read by
 * buildRecruiterHandoverOwnershipLogRows to emit the RECRUITER ownership log). These temp fields are
 * stripped before the BigQuery insert — PREVIOUS_RECRUITER_* is no longer written to the deal sheet
 * (the frontend derives it itself), so the deal-sheet columns are left untouched here.
 *
 * Also VACATES any frozen hierarchy role the NEW recruiter used to hold on this placement: if the
 * new recruiter's RECRUITER_EMP_NO matches a hierarchy role's emp-no on the baseline row (e.g. they
 * were the TEAM_LEAD), that column + its *_EMP_NO are set to "NA" — one person must not hold two
 * designations at once, and hierarchy is otherwise carried forward frozen. This mirrors the
 * vacated-role rows buildOwnershipChangeLogRows writes to ownership_change_logs (same
 * DEAL_RECRUITER_HIERARCHY_TARGETS, same emp-no match, same "NA"), keeping the deal sheet and the
 * ownership log in lock-step. Roles the new recruiter did NOT hold are left unchanged.
 * SECONDARY_RECRUITER* is intentionally skipped — it is a frozen manual ops field and must not be
 * vacated when the assignment recruiter changes.
 */
function applyPreviousRecruiterOnRecruiterChange(incomingRow, baselineRow) {
  if (!incomingRow || typeof incomingRow !== "object") return { row: incomingRow, changed: false };
  if (!baselineRow || typeof baselineRow !== "object") return { row: incomingRow, changed: false };
  const normEmail = (v) => (v == null ? "" : String(v).trim().toLowerCase());
  const incEmail = normEmail(incomingRow.ASSIGNMENT_RECRUITER_EMAIL);
  const baseEmail = normEmail(baselineRow.ASSIGNMENT_RECRUITER_EMAIL);
  if (baseEmail === "" || incEmail === baseEmail) return { row: incomingRow, changed: false };
  const next = {
    ...incomingRow,
    // In-memory only (stripped before insert) — feeds the RECRUITER ownership log, not the deal sheet.
    __PREV_RECRUITER_NAME: baselineRow.ASSIGNMENT_RECRUITER ?? null,
    __PREV_RECRUITER_EMAIL: baselineRow.ASSIGNMENT_RECRUITER_EMAIL ?? null,
    __PREV_RECRUITER_EMP_NO: baselineRow.RECRUITER_EMP_NO ?? null,
    // Recruiter changed -> stamp OWNERSHIP_EFFECTIVE_DATE = TENTATIVE_END_DATE + 1, the same value the
    // ownership_change_logs RECRUITER row gets. Kept in sync via overwriteDealSheetEffectiveDatesFromTentative
    // (never overwritten to extension START_DATE / MIN by CONTRACT_ID).
    OWNERSHIP_EFFECTIVE_DATE: addOneDayToDateOnly(incomingRow.TENTATIVE_END_DATE),
  };
  const newRecruiterEmp = normalizeOwnershipValueForCompare(incomingRow.RECRUITER_EMP_NO);
  if (newRecruiterEmp !== "") {
    for (const target of DEAL_RECRUITER_HIERARCHY_TARGETS) {
      if (target.column === "SECONDARY_RECRUITER") continue;
      const prevEmp = normalizeOwnershipValueForCompare(baselineRow[target.empNoColumn]);
      if (prevEmp === "" || prevEmp !== newRecruiterEmp) continue;
      next[target.column] = "NA";
      next[target.empNoColumn] = "NA";
    }
  }
  return { row: next, changed: true };
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

/**
 * Freeze OFFER_TIME_START_DATE from baseline when present (immutable once set; DEAL and EXTENSION).
 * Unlike TENTATIVE_END_DATE, START_DATE changes do NOT release this freeze — offer-time start stays
 * the first stored value. Empty baseline keeps the incoming Nexus job.start_date.
 */
function applyOfferTimeStartDateFreeze(incomingRow, baselineRow) {
  if (!incomingRow || typeof incomingRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (!baselineRow || typeof baselineRow !== "object") {
    return { row: incomingRow, frozen: false };
  }
  if (isEmptyDateFieldValue(baselineRow.OFFER_TIME_START_DATE)) {
    return { row: incomingRow, frozen: false };
  }
  return {
    row: { ...incomingRow, OFFER_TIME_START_DATE: baselineRow.OFFER_TIME_START_DATE },
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
 * Skipped when config.extensionDateFreezeEnabled is false (migration backfill).
 */
function applyExtensionDateFreeze(incomingRow, baselineRow) {
  if (!config.extensionDateFreezeEnabled) {
    return { row: incomingRow, frozen: false };
  }
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
 * For DEAL rows, INITIAL_START_DATE = START_DATE (a DEAL is the first placement, so its start IS
 * the original). Fills only when INITIAL_START_DATE is empty — a value already carried forward
 * from baseline (frozen, MANUAL_COLUMN) or hand-edited is left untouched, so it never drifts if
 * START_DATE is later corrected. EXTENSION rows are untouched here (they inherit INITIAL_START_DATE
 * from the parent DEAL / runrate). A later extension's parent-DEAL inherit picks this up via
 * COALESCE(parent.INITIAL_START_DATE, parent.START_DATE) — no repeated runrate lookup needed.
 */
function applyOriginalStartDateForDealRows(rows) {
  if (!rows || rows.length === 0) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (normalizeDealTypeKey(row.DEAL_TYPE) !== "DEAL") return row;
    if (!isEmptyDateFieldValue(row.INITIAL_START_DATE)) return row;
    if (isEmptyDateFieldValue(row.START_DATE)) return row;
    return { ...row, INITIAL_START_DATE: row.START_DATE };
  });
}

/**
 * DID NOT ACCEPT (offer-rejected) rows: the candidate never started, so the assignment has no real
 * duration — END_DATE mirrors START_DATE and there is no tentative end date (TENTATIVE_END_DATE blank).
 * Applied at insert time and in the response finalize so it lands consistently regardless of what
 * Nexus sent. Only DID NOT ACCEPT rows are touched; every other status is left as-is.
 */
function applyDidNotAcceptDateOverrides(rows) {
  if (!rows || rows.length === 0) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    if (String(row.PLACEMENT_STATUS ?? "").trim().toUpperCase() !== "DID NOT ACCEPT") return row;
    return { ...row, END_DATE: row.START_DATE ?? null, TENTATIVE_END_DATE: null };
  });
}

/** Offer-rejected EXTENSION rows (DEAL_TYPE=EXTENSION + DID NOT ACCEPT / DID NOT START) whose
 *  START_DATE/END_DATE should come from the candidate's most-recent prior ENDED placement. */
const OFFER_REJECTED_EXTENSION_ENDED_STATUSES = new Set(["DID NOT ACCEPT", "DID NOT START"]);

function rowNeedsOfferRejectedExtensionEndedDates(row) {
  if (!row || typeof row !== "object") return false;
  if (normalizeDealTypeKey(row.DEAL_TYPE) !== "EXTENSION") return false;
  if (!OFFER_REJECTED_EXTENSION_ENDED_STATUSES.has(String(row.PLACEMENT_STATUS ?? "").trim().toUpperCase())) {
    return false;
  }
  if (row.CANDIDATE_ID == null || String(row.CANDIDATE_ID).trim() === "") return false;
  if (!Number.isFinite(Number(row.CANDIDATE_ID))) return false;
  if (row.PLACEMENT_ID == null || String(row.PLACEMENT_ID).trim() === "") return false;
  return String(row.PARENT_CLIENT_NAME ?? "").trim() !== "";
}

function buildOfferRejectedEndedMatchStructLiterals(rows) {
  const out = [];
  for (const row of rows) {
    const pid = Number(row.PLACEMENT_ID);
    const cand = Number(row.CANDIDATE_ID);
    if (!Number.isFinite(pid) || !Number.isFinite(cand)) continue;
    const pc = escapeSqlString(String(row.PARENT_CLIENT_NAME).trim().toLowerCase());
    out.push(
      `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, '${pc}' AS parent_client)`
    );
  }
  return out;
}

/**
 * For offer-rejected EXTENSION rows, resolve START_DATE + END_DATE from the candidate's MOST-RECENT
 * prior ENDED placement (matched by CANDIDATE_ID + parent client name, latest by START_DATE).
 * Source priority: our own ACTIVE deal sheet table first, then the domain run-rate table for any
 * placement still unmatched. The _ended_deal_sheet archive tables are intentionally NOT referenced
 * (per business rule: only the active deal-sheet table + run-rate history). Returns
 * Map<PLACEMENT_ID string, {START_DATE, END_DATE}>.
 * @param {object[]} rows
 * @param {object} [options] - { datasetId, tableId } (tableId picks the domain run-rate fallback)
 */
async function fetchOfferRejectedExtensionEndedDatesByPlacementId(rows, options = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;
  const eligible = rows.filter(rowNeedsOfferRejectedExtensionEndedDates);
  if (eligible.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const runForSource = async (sourceSql, subset) => {
    const result = new Map();
    const chunkSize = 100;
    for (let i = 0; i < subset.length; i += chunkSize) {
      const chunk = subset.slice(i, i + chunkSize);
      const structs = buildOfferRejectedEndedMatchStructLiterals(chunk);
      if (structs.length === 0) continue;
      const sql = `
        WITH targets AS (
          SELECT * FROM UNNEST([${structs.join(", ")}])
        ),
        ended AS (
          SELECT candidate_nexus_id, pc_norm, start_date, end_date, order_ts
          FROM (${sourceSql})
          WHERE UPPER(TRIM(CAST(placement_status AS STRING))) = 'ENDED'
        ),
        ranked AS (
          SELECT
            t.placement_id,
            e.start_date,
            e.end_date,
            ROW_NUMBER() OVER (
              PARTITION BY t.placement_id
              ORDER BY e.start_date DESC NULLS LAST, e.order_ts DESC NULLS LAST
            ) AS rn
          FROM targets t
          JOIN ended e
            ON e.candidate_nexus_id = t.candidate_nexus_id
           AND e.pc_norm = t.parent_client
        )
        SELECT CAST(placement_id AS STRING) AS placement_id, start_date, end_date
        FROM ranked WHERE rn = 1
      `;
      const bqRows = await queryObjects(sql, structs.length * 2);
      for (const r of bqRows) {
        const pid = r?.placement_id;
        if (pid == null || String(pid).trim() === "") continue;
        result.set(String(pid).trim(), {
          START_DATE: normalizeExtensionRunrateBackfillValue(r?.start_date),
          END_DATE: normalizeExtensionRunrateBackfillValue(r?.end_date),
        });
      }
    }
    return result;
  };

  // Source 1: our own ACTIVE deal sheet tables only (never the _ended_deal_sheet archive).
  const dealTableIds = [...ACTIVE_DEAL_SHEET_TABLE_IDS];
  const dealUnionSql = dealTableIds
    .map(
      (t) =>
        `SELECT CANDIDATE_ID AS candidate_nexus_id, LOWER(TRIM(PARENT_CLIENT_NAME)) AS pc_norm, `
        + `PLACEMENT_STATUS AS placement_status, START_DATE AS start_date, END_DATE AS end_date, `
        + `CAST(LAST_UPDATED AS STRING) AS order_ts FROM \`${config.projectId}.${datasetId}.${t}\``
    )
    .join("\n          UNION ALL\n          ");
  const fromDealSheets = await runForSource(dealUnionSql, eligible);
  for (const [k, v] of fromDealSheets) out.set(k, v);

  // Source 2 (fallback): the domain run-rate table, for placements still unmatched.
  const unmatched = eligible.filter((row) => !out.has(String(row.PLACEMENT_ID).trim()));
  if (unmatched.length > 0) {
    const runrateTableId = resolveRunrateTableIdForDealSheetTable(options.tableId);
    const runrateSql =
      `SELECT CANDIDATE_ID AS candidate_nexus_id, LOWER(TRIM(PARENT_CLIENT_NAME)) AS pc_norm, `
      + `PLACEMENT_STATUS AS placement_status, START_DATE AS start_date, END_DATE AS end_date, `
      + `CAST(NULL AS STRING) AS order_ts FROM \`${config.projectId}.${datasetId}.${runrateTableId}\``;
    const fromRunrate = await runForSource(runrateSql, unmatched);
    for (const [k, v] of fromRunrate) if (!out.has(k)) out.set(k, v);
  }

  return out;
}

/**
 * Override START_DATE + END_DATE on offer-rejected EXTENSION rows with the candidate's most-recent
 * prior ENDED placement dates (see fetchOfferRejectedExtensionEndedDatesByPlacementId).
 *
 * NOT WIRED INTO THE INSERT PIPELINE — kept (and unit-tested) for reference only. Business decision:
 * an offer-rejected extension keeps its OWN START_DATE (the extension that was offered). Borrowing
 * the prior assignment's dates stamped these rows with 2022/2024/2025 starts, misrepresenting the
 * placement and pushing them below the START_DATE >= 2026-01-01 cutoff. Re-enable by calling this in
 * insertEnrichedDealSheetBatch + finalizeDealSheetRowForResponse + the refresh compare row (all
 * three, or the change-gate will re-append 0-diff rows forever).
 */
async function applyOfferRejectedExtensionEndedDatesForInsertRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;
  const eligible = rows.filter(rowNeedsOfferRejectedExtensionEndedDates);
  if (eligible.length === 0) return rows;

  const fetchFn = deps.fetchFn ?? fetchOfferRejectedExtensionEndedDatesByPlacementId;
  const datesByPlacementId = await fetchFn(eligible, options);
  if (!datesByPlacementId || datesByPlacementId.size === 0) return rows;

  let overridden = 0;
  const out = rows.map((row) => {
    if (!rowNeedsOfferRejectedExtensionEndedDates(row)) return row;
    const dates = datesByPlacementId.get(String(row.PLACEMENT_ID).trim());
    if (!dates) return row;
    let next = row;
    let changed = false;
    if (dates.START_DATE != null && dates.START_DATE !== "") {
      next = next === row ? { ...row } : next;
      next.START_DATE = dates.START_DATE;
      changed = true;
    }
    if (dates.END_DATE != null && dates.END_DATE !== "") {
      next = next === row ? { ...row } : next;
      next.END_DATE = dates.END_DATE;
      changed = true;
    }
    if (changed) overridden++;
    return next;
  });

  logDetail(
    `[enriched sync] [BigQuery insertAll] offer-rejected EXTENSION ended-date override: eligible=${eligible.length} matched=${datesByPlacementId.size} overridden=${overridden}`
  );
  return out;
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
  logDetail(
    `[enriched sync] [BigQuery insertAll] ended NEW_HIRE_DATE inherit from active: inherited=${inheritedCount} stillEmpty=${stillEmptyCount}`
  );
  return rows;
}

/**
 * Compute insert ID for deduplication.
 *
 * No longer used by insertAll: since the switch from streaming inserts to load jobs there is no
 * insertId to attach. Retained because it is exported. Row-level dedupe is done explicitly in the
 * insert*Batch functions (DEAL_SHEET_ID / PLACEMENT_ID / per-log dedupe keys) before insertAll runs.
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
    // Strip query-only / pipeline-internal fields: the fixed set below plus any "__"-prefixed temp
    // field (e.g. __PREV_RECRUITER_*), which never belong in the BigQuery streaming insert.
    if (k === "_rn" || k === "_INSERT_ID" || k === "rn" || k === "_src" || k === "_src_table" || k.startsWith("__")) continue;
    const inner = sanitizeValueForStreamingInsert(v);
    if (inner !== undefined) out[k] = inner;
  }
  return sanitizeLocumsDealSheetRow(sanitizeCanadaDealSheetRow(out));
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
 * Reserved for insert-time date stamps. EXTENSION_DATE is set during enrich from earliest BOOKED note.
 * NEW_HIRE_DATE is sourced from job-submittal-notes during enrich (not stamped here).
 * @returns {Record<string, string>} fields to merge into insert json (may be empty)
 */
function computeDealSheetFirstInsertDateStamps() {
  return {};
}

/**
 * Build the newline-delimited JSON payload for a load job.
 *
 * Split out from insertAll so the row shaping (sanitize + LAST_UPDATED default + date stamps) can be
 * unit-tested without touching BigQuery. Returns the NDJSON buffer plus the shaped rows.
 */
function buildLoadJobPayload(rows, options = {}) {
  // Insert-time timestamp for auditing/debugging in BigQuery (TIMESTAMP column).
  // BigQuery accepts RFC3339/ISO-8601 like "2026-04-07T15:04:05.123Z".
  const insertTs = new Date().toISOString();

  const jsonRows = rows.map((row) => {
    const clean = sanitizeRowForBigQueryStreamingInsert(row);
    const dateTime = clean?.LAST_UPDATED != null && String(clean.LAST_UPDATED).trim() !== ""
      ? clean.LAST_UPDATED
      : insertTs;
    const json = {
      ...clean,
      LAST_UPDATED: dateTime,
    };
    if (options.applyDealSheetDateStamps === true) {
      Object.assign(json, computeDealSheetFirstInsertDateStamps(clean, dateTime));
    }
    // undefined would serialize away silently; null is the explicit "no value" BigQuery expects.
    for (const [k, v] of Object.entries(json)) {
      if (v === undefined) json[k] = null;
    }
    return json;
  });

  const ndjson = jsonRows.map((r) => JSON.stringify(r)).join("\n");
  return { jsonRows, buffer: Buffer.from(ndjson, "utf8") };
}

/**
 * Insert rows to BigQuery using a LOAD JOB (not the streaming insert API).
 *
 * Streaming inserts (tabledata.insertAll) park rows in a streaming buffer for up to ~90 minutes, and
 * BigQuery refuses any UPDATE/DELETE that would touch that buffer. The post-insert backfills in this
 * pipeline (DELIVERY_POC, EXT_OR_REHIRE_BY_RMG, cluster/region) run seconds after the insert, so they
 * failed on every single run. Load jobs write straight to managed storage — no buffer, so those DML
 * steps succeed immediately.
 *
 * Two streaming-only behaviours are replaced rather than lost:
 *   - skipInvalidRows  -> maxBadRecords (bad rows are skipped, the rest still load)
 *   - insertId dedupe  -> nothing. It keyed on DEAL_SHEET_ID, but this pipeline appends multiple rows
 *                         per DEAL_SHEET_ID by design (append-on-change), and BigQuery's dedupe is
 *                         best-effort within a ~1 minute window, so it never actually fired. The real
 *                         protection is the explicit DEAL_SHEET_ID/PLACEMENT_ID dedupe in
 *                         insertEnrichedDealSheetBatch, which is untouched.
 */
async function insertAll(rows, options = {}) {
  if (!rows || rows.length === 0) return { inserted: 0, attempted: 0, errors: [] };

  const { datasetId, tableId } = resolveBqDatasetTable(options);
  const table = bigquery.dataset(datasetId).table(tableId);

  const { buffer } = buildLoadJobPayload(rows, options);

  const loadOptions = {
    sourceFormat: "NEWLINE_DELIMITED_JSON",
    writeDisposition: "WRITE_APPEND",
    createDisposition: "CREATE_NEVER",
    ignoreUnknownValues: config.bigQuery.ignoreUnknownValues,
    // Streaming used skipInvalidRows to drop bad rows and keep the rest; maxBadRecords is the load-job
    // equivalent. Unbounded so a single malformed row can never fail an otherwise good batch.
    maxBadRecords: config.bigQuery.skipInvalidRows ? rows.length : 0,
  };

  try {
    // table.load() only accepts a file path / GCS file, so feed the NDJSON through a write stream.
    const completed = await new Promise((resolve, reject) => {
      const stream = table.createWriteStream(loadOptions);
      stream.on("error", reject);
      stream.on("job", (job) => {
        job.on("error", reject);
        job.on("complete", (meta) => resolve(meta));
      });
      stream.end(buffer);
    });

    // outputRows is what actually landed; rows skipped via maxBadRecords are reported here (and in
    // status.errors) rather than thrown, mirroring how skipInvalidRows silently dropped rows before.
    const outputRows = Number(completed?.statistics?.load?.outputRows);
    const inserted = Number.isFinite(outputRows) ? outputRows : rows.length;
    const skippedErrors = completed?.status?.errors ?? [];
    if (inserted < rows.length) {
      logError(
        `[enriched sync] [BigQuery insertAll] BAD_ROWS_SKIPPED attempted=${rows.length} inserted=${inserted} sample=${JSON.stringify(skippedErrors.slice(0, 3))}`
      );
    }
    return { inserted, attempted: rows.length, errors: skippedErrors };
  } catch (e) {
    // Load jobs report row problems as job errors rather than per-row entries. Keep the same return
    // shape (and log prefix) as the streaming path so callers and log greps keep working.
    const errors = Array.isArray(e?.errors) && e.errors.length > 0 ? e.errors : null;
    if (errors) {
      logError(
        `[enriched sync] [BigQuery insertAll] LOAD_ERRORS sample=${JSON.stringify(errors.slice(0, 3))}`
      );
      return { inserted: 0, attempted: rows.length, errors };
    }
    throw e;
  }
}

/**
 * Insert enriched deal sheet batch with deduplication
 */
async function insertEnrichedDealSheetBatch(combinedRows, insertIdBase, options = {}) {
  if (!combinedRows || combinedRows.length === 0) {
    logDetail(`[enriched sync] [BigQuery insertAll] SKIP: no rows to insert`);
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
      logDetail(
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
      logDetail(
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
      logDetail(
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
      logDetail(
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
      logDetail(
        `[enriched sync] [BigQuery insertAll] insert-only first_insert_allowlist: skippedByPlacementStatus=${skippedByPlacementStatus} remaining=${rowsToInsert.length}`
      );
    }
  }

  // DID NOT ACCEPT rows have END_DATE/TENTATIVE_END_DATE overwritten further down the pipeline (END_DATE =
  // START_DATE, TENTATIVE_END_DATE blank). Apply that override BEFORE the change-gate so the gate compares
  // the FINAL dates against the stored (already-overridden) baseline — otherwise the pre-override
  // END_DATE differs from the baseline on every run and appends a 0-diff row forever. Idempotent: the
  // later call at insert time still runs (it also covers rows that skip this gate).
  rowsToInsert = applyDidNotAcceptDateOverrides(rowsToInsert);

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
    let contractIdCarriedCount = 0;
    let manualColumnsCarriedTotal = 0;
    let tentativeFrozenCount = 0;
    let newHireFrozenCount = 0;
    let extensionFrozenCount = 0;
    let offerTimeFrozenCount = 0;
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
        const offerTimeAdjusted = applyOfferTimeStartDateFreeze(extensionAdjusted.row, existing);
        if (offerTimeAdjusted.frozen) offerTimeFrozenCount++;
        const moveRunrateAdjusted = applyMoveRunrateAppendOverride(offerTimeAdjusted.row, existing);
        const withRejectedReset = applyIsRejectedResetForChangedUpdate(moveRunrateAdjusted.row, existing);
        if (moveRunrateAdjusted.forcedFalse) moveRunrateForcedFalse++;
        if (moveRunrateAdjusted.keptNull) moveRunrateKeptNull++;
        if (withRejectedReset?.IS_REJECTED === "False") isRejectedResetCount++;
        const contractIdCarried = applyContractIdCarryForward(withRejectedReset, existing);
        if (contractIdCarried.carried) contractIdCarriedCount++;
        // Mark as an update-append (has a baseline): hierarchy is carried forward verbatim and
        // must NOT be re-derived from the directory. Re-deriving would re-fill a field a
        // recruiter-hierarchy MOVE deliberately vacated (see applyRecruiterHierarchyMovesToDealSheet)
        // and put the same person in two fields. Freeze = set once at first insert.
        filtered.push({ ...contractIdCarried.row, __CARRIED_FORWARD_UPDATE: true });
        continue;
      }
      unchangedSkipped++;
    }
    rowsToInsert = filtered;
    logDetail(
      `[enriched sync] [BigQuery insertAll] append-on-change(DEAL_SHEET_ID+PLACEMENT_ID): changedIncluded=${changedIncluded} noBaselineIncluded=${noBaselineIncluded} newRowSkippedByPlacementStatus=${newRowSkippedByPlacementStatus} missingPlacementIdCount=${missingPlacementIdCount} moveRunrateForcedFalse=${moveRunrateForcedFalse} moveRunrateKeptNull=${moveRunrateKeptNull} unchangedSkipped=${unchangedSkipped} remaining=${rowsToInsert.length}`
      + ` isRejectedResetCount=${isRejectedResetCount} manualColumnsCarriedTotal=${manualColumnsCarriedTotal}`
      + ` contractIdCarriedCount=${contractIdCarriedCount}`
      + ` tentativeFrozenCount=${tentativeFrozenCount}`
      + ` newHireFrozenCount=${newHireFrozenCount}`
      + ` extensionFrozenCount=${extensionFrozenCount}`
      + ` offerTimeFrozenCount=${offerTimeFrozenCount}`
    );
  }

  // PREVIOUS_RECRUITER_* is no longer written to the deal sheet (the frontend derives it). The
  // outgoing recruiter still rides along on the in-memory __PREV_RECRUITER_* temp fields, which
  // buildRecruiterHandoverOwnershipLogRows reads to emit the RECRUITER ownership log.

  rowsToInsert = await applyDealRecruiterHierarchyForInsertRows(
    rowsToInsert,
    resolveBqDatasetTable(options)
  );

  if (!rowsToInsert || rowsToInsert.length === 0) {
    logDetail(`[enriched sync] [BigQuery insertAll] SKIP: all rows filtered by dedupe rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
  }

  const beforeTrainingFilter = rowsToInsert.length;
  rowsToInsert = rowsToInsert.filter((r) => !shouldExcludeRowFromBigQuery(r));
  const droppedTraining = beforeTrainingFilter - rowsToInsert.length;
  if (droppedTraining > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] training/dummy filter: dropped=${droppedTraining} remaining=${rowsToInsert.length}`
    );
  }

  if (!rowsToInsert.length) {
    logDetail(`[enriched sync] [BigQuery insertAll] SKIP: all rows filtered by training/dummy rules`);
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
  }

  if (options.skip_contract_id === true) {
    rowsToInsert = rowsToInsert.map((row) => ({ ...row, CONTRACT_ID: null }));
    logDetail(
      `[enriched sync] [BigQuery insertAll] skip_contract_id: CONTRACT_ID cleared for insert count=${rowsToInsert.length}`
    );
  } else {
    // Phase B: allocate Firestore-backed CONTRACT_IDs only for rows that will
    // actually be inserted (defer allocation pattern). Rows already carrying a
    // CONTRACT_ID from Phase A (resolveContractIdsForRows) are left untouched.
    // Phase B also re-checks BigQuery by DEAL_SHEET_ID before minting (safety net
    // when Phase A missed due to timing or lookup failure).
    // Lazy require to avoid module-load circular dependency with contractIdResolver.
    const { allocateContractIdsForInsertableRows } = require("./contractIdResolver");
    // bqOptions carries the dataset/table actually being written. Without it the existing-id
    // reuse inside the allocator (applyExistingContractIdsByDealSheetId ->
    // fetchContractIdsByDealSheetIds) fell back to config defaults, so a placement that already
    // had a CONTRACT_ID in the destination table looked brand new and got a freshly minted id.
    await allocateContractIdsForInsertableRows(rowsToInsert, {
      tableId: options.tableId,
      bqOptions: resolveBqDatasetTable(options),
    });
  }

  // AFTER the run-rate identity rule above, deliberately. That rule matches an EXTENSION against the
  // run-rate row's date window, which is the only thing that can tell one of a candidate's contracts
  // from the next; the tiers below match on candidate+client identity alone and cannot. Every tier
  // here is fill-if-empty, so running them second makes them a fallback for extensions the window
  // could not place (a contract whose run-rate END_DATE has not caught up with the extension yet)
  // instead of a competitor that wins by going first.
  rowsToInsert = await applyExtensionInheritForInsertRows(
    rowsToInsert,
    resolveBqDatasetTable(options)
  );

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

  // DEAL rows: INITIAL_START_DATE = START_DATE (first placement's own start is the original).
  rowsToInsert = applyOriginalStartDateForDealRows(rowsToInsert);

  // DID NOT ACCEPT rows: END_DATE = START_DATE, TENTATIVE_END_DATE blank (never started).
  rowsToInsert = applyDidNotAcceptDateOverrides(rowsToInsert);

  // NOTE: offer-rejected EXTENSION rows are NOT date-overridden from the candidate's prior ENDED
  // placement any more (applyOfferRejectedExtensionEndedDatesForInsertRows). Business decision: the
  // row keeps its OWN START_DATE — the extension that was offered. Pulling the prior assignment's
  // dates stamped these rows with 2022/2024/2025 starts, which both misrepresented the placement and
  // put them below the START_DATE >= 2026-01-01 cutoff. END_DATE for them is handled by
  // applyDidNotAcceptDateOverrides above (never worked -> end = start).

  rowsToInsert = await applyOnsiteAmCsmHierarchyForRows(rowsToInsert, resolveBqDatasetTable(options));

  // Enforce name/emp-no consistency (name "NA"/blank -> emp-no "NA") before DELIVERY_POC is derived.
  rowsToInsert = rowsToInsert.map((row) => applyHierarchyNameEmpConsistency(row));

  // Derive DELIVERY_POC from the now-final hierarchy columns (frozen on first insert).
  rowsToInsert = await applyDeliveryPocForInsertRows(rowsToInsert);

  // FINAL min-START_DATE gate. The caller's pre-insert filter (transform_rows_fn) runs on the
  // ENRICHED row, but steps above still rewrite START_DATE afterwards — most notably
  // applyOfferRejectedExtensionEndedDatesForInsertRows, which pulls START_DATE/END_DATE from the
  // candidate's most-recent PRIOR ended assignment (often years old). Those rows passed the caller's
  // filter on their own start date and then landed with a 2022/2024/2025 START_DATE. Re-check here,
  // against the FINAL value, so nothing below the cutoff can reach the table by any path.
  if (Number.isFinite(Number(options.min_start_date_ms)) && rowsToInsert.length > 0) {
    const minMs = Number(options.min_start_date_ms);
    const kept = rowsToInsert.filter((row) =>
      startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), minMs)
    );
    const droppedBelowMinStart = rowsToInsert.length - kept.length;
    if (droppedBelowMinStart > 0) {
      logDetail(
        `[enriched sync] [BigQuery insertAll] final min_start_date gate: droppedBelowMinStart=${droppedBelowMinStart}`
        + ` min_start_date=${new Date(minMs).toISOString().slice(0, 10)} remaining=${kept.length}`
      );
    }
    rowsToInsert = kept;
    if (rowsToInsert.length === 0) {
      return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
    }
  }

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

  logDetail(
    `[enriched sync] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );

  // CONTRACT_CHAIN ownership logs for the rows just written, in THIS run. The scheduled scan runs
  // once at the end of a trigger and would otherwise leave a new extension's handover row missing
  // until a later run — a visible gap where the deal exists but its ownership log does not. Non-fatal
  // and idempotent (the log batch dedupes), so the scheduled scan stays as the safety net.
  //
  // Canada rows are excluded while that domain is being validated: its deal sheet is deleted and
  // re-synced repeatedly, and each run would otherwise seed ownership_change_logs rows keyed on
  // placements that are about to disappear. Filtered on the ROWS (CLIENT_STATE province), not on a
  // caller flag, so no insert path can miss the gate. See LOG_WRITES_DISABLED_FOR_CANADA.
  let contractChainOwnershipLog = null;
  const ownershipLogRows = LOG_WRITES_DISABLED_FOR_CANADA
    ? rowsToInsert.filter((row) => !isCanadaDealSheetRow(row))
    : rowsToInsert;
  if (
    options.skipInsertTimeContractChainOwnershipLogs !== true &&
    result.inserted > 0 &&
    ownershipLogRows.length > 0
  ) {
    try {
      contractChainOwnershipLog = await insertContractChainOwnershipLogsForInsertedRows(ownershipLogRows, {
        dealSheetDatasetId: options.datasetId,
      });
    } catch (ownErr) {
      logError(
        `[enriched sync] insert-time contract-chain ownership logs FAILED (non-fatal)`,
        ownErr
      );
    }
  }

  return {
    inserted: result.inserted,
    attempted: result.attempted,
    errorBatches: hasErrors ? 1 : 0,
    insertedKeys,
    contractChainOwnershipLog,
    // Fully-derived rows exactly as written (hierarchy, DELIVERY_POC, CSM, SKU, etc.). Callers
    // that need to echo the final row (e.g. the refresh API response) use this.
    finalRows: rowsToInsert,
  };
}

/**
 * Partition enriched rows by ASSIGNMENT_RECRUITER_EMAIL domain and insert each group into its table.
 */
async function insertEnrichedDealSheetBatchRouted(combinedRows, insertIdBase, options = {}) {
  if (!combinedRows || combinedRows.length === 0) {
    logDetail(`[enriched sync] [BigQuery insertAll] routed SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0, insertedKeys: new Set() };
  }

  const groups = new Map();
  const resolveTableId =
    typeof options.resolveTableId === "function"
      ? options.resolveTableId
      : (row) => resolveActiveDealSheetTableIdForRow(row);
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
    logDetail(`[enriched sync] [BigQuery insertAll] routed partitions: ${parts.join(", ")}`);
  }

  return { inserted, attempted, errorBatches, insertedKeys };
}

/**
 * Insert rate-change logs (only RATE_CHANGE === YES; defense in depth vs transform in syncService).
 */
async function insertRateChangeLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logDetail(`[rate-change logs] [BigQuery insertAll] SKIP: no rows to insert`);
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
    logDetail(`[rate-change logs] RATE_CHANGE=YES only: dropped=${droppedNonYes} non-YES row(s)`);
  }
  if (logRows.length === 0) {
    logDetail(`[rate-change logs] [BigQuery insertAll] SKIP: no YES rows after filter`);
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
    logDetail(
      `[rate-change logs] dedupe(same batch CONTRACT_ID+OWNERSHIP_EFFECTIVE_DATE): dropped=${droppedDupBatch} remaining=${deduped.length}`
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
      logDetail(
        `[rate-change logs] [BigQuery insertAll] dedupe(existing CONTRACT_ID+OWNERSHIP_EFFECTIVE_DATE in log table): skipped=${skipped} remaining=${deduped.length}`
      );
    }
  }

  const beforeTraining = deduped.length;
  deduped = deduped.filter((r) => !shouldExcludeRowFromBigQuery(r));
  const droppedTraining = beforeTraining - deduped.length;
  if (droppedTraining > 0) {
    logDetail(
      `[rate-change logs] training/dummy filter: dropped=${droppedTraining} remaining=${deduped.length}`
    );
  }

  if (!deduped.length) {
    logDetail(`[rate-change logs] [BigQuery insertAll] SKIP: all rows filtered by training/dummy rules`);
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

  logDetail(
    `[rate-change logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Insert additional-cost line-item audit logs (append-only snapshot per sync run).
 * Streaming insertId uses the composite key when present so retries do not double-insert.
 */
async function insertAdditionalCostLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logDetail(`[additional-cost logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "ID";
  let rowsToInsert = logRows.map((row) => {
    const next = { ...row };
    if (generatedUuidField) {
      const raw = next[generatedUuidField];
      const existing = raw == null ? "" : String(raw).trim();
      if (!existing) next[generatedUuidField] = randomUUID();
    }
    const dedupeKey = buildAdditionalCostLogCompositeKey(
      next?.DEAL_SHEET_ID,
      next?.PLACEMENT_ID,
      next?.ADDITIONAL_COST_ID
    );
    if (dedupeKey) next._INSERT_ID = dedupeKey;
    return next;
  });

  const result = await insertAll(rowsToInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "_INSERT_ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logDetail(
    `[additional-cost logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Insert termination-reason audit logs (append-only snapshot per sync run).
 * Streaming insertId uses PLACEMENT_ID|TERMINATION_DETAIL_ID when present for retry safety.
 */
async function insertTerminationReasonLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logDetail(`[termination-reason logs] [BigQuery insertAll] SKIP: no rows to insert`);
    return { inserted: 0, attempted: 0, errorBatches: 0 };
  }

  const generatedUuidField =
    typeof options.generatedUuidField === "string" && options.generatedUuidField.trim() !== ""
      ? options.generatedUuidField.trim()
      : "ID";
  let rowsToInsert = logRows.map((row) => {
    const next = { ...row };
    if (generatedUuidField) {
      const raw = next[generatedUuidField];
      const existing = raw == null ? "" : String(raw).trim();
      if (!existing) next[generatedUuidField] = randomUUID();
    }
    const dedupeKey = buildTerminationReasonLogCompositeKey(
      next?.PLACEMENT_ID,
      next?.TERMINATION_DETAIL_ID
    );
    if (dedupeKey) next._INSERT_ID = dedupeKey;
    return next;
  });

  const result = await insertAll(rowsToInsert, {
    insertIdBase,
    datasetId: options.datasetId,
    tableId: options.tableId,
    insertIdField: "_INSERT_ID",
  });
  const hasErrors = result.errors && result.errors.length > 0;

  logDetail(
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

  // Domain-scoped runs pass a single table id; unscoped runs scan all three (legacy behaviour).
  const requestedTableIds = Array.isArray(options.tableIds)
    ? options.tableIds
        .map((t) => (t == null ? "" : String(t).trim()))
        .filter((t) => ACTIVE_DEAL_SHEET_TABLE_IDS.includes(t))
    : [];
  const tableIdsToScan =
    requestedTableIds.length > 0 ? requestedTableIds : ACTIVE_DEAL_SHEET_TABLE_IDS;

  for (const tableId of tableIdsToScan) {
    const sqlByDealSheet = `SELECT
      CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) AS placement_status,
      CAST(LAST_UPDATED AS STRING) AS latest_date
    FROM (
      SELECT
        DEAL_SHEET_ID,
        PLACEMENT_ID,
        PLACEMENT_STATUS,
        LAST_UPDATED,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(DEAL_SHEET_ID AS STRING)
          ORDER BY LAST_UPDATED DESC NULLS LAST
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
      const rawLatest = row?.latest_date == null ? null : String(row.latest_date).trim();
      const parsedLatestMs = rawLatest ? Date.parse(rawLatest) : null;
      const latest_date_ms = Number.isFinite(parsedLatestMs) ? parsedLatestMs : null;
      out.push({ deal_sheet_id, placement_id, table_id: tableId, placement_status, latest_date_ms });
    }

    const sqlByPlacementFallback = `SELECT
      CAST(PLACEMENT_ID AS STRING) AS placement_id,
      UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) AS placement_status,
      CAST(LAST_UPDATED AS STRING) AS latest_date
    FROM (
      SELECT
        PLACEMENT_ID,
        PLACEMENT_STATUS,
        LAST_UPDATED,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(PLACEMENT_ID AS STRING)
          ORDER BY LAST_UPDATED DESC NULLS LAST
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
      const rawLatest = row?.latest_date == null ? null : String(row.latest_date).trim();
      const parsedLatestMs = rawLatest ? Date.parse(rawLatest) : null;
      const latest_date_ms = Number.isFinite(parsedLatestMs) ? parsedLatestMs : null;
      out.push({ deal_sheet_id: null, placement_id, table_id: tableId, placement_status, latest_date_ms });
    }
  }

  logDetail(
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
      ? `AND LAST_UPDATED >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${lookbackDays} DAY)`
      : "";
  const sql = `SELECT DISTINCT CAST(PLACEMENT_ID AS STRING) AS placement_id
               FROM \`${config.projectId}.${datasetId}.${tableId}\`
               WHERE PLACEMENT_ID IS NOT NULL
               ${whereLookback}
               ${limit > 0 ? `LIMIT ${limit}` : ""}`;
  logDetail(
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
  logDetail(`[active->ended] [BigQuery] fetchDistinctPlacementIds done count=${out.length}`);
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
  logDetail(
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
                       ORDER BY LAST_UPDATED DESC NULLS LAST
                     ) AS _rn
                   FROM \`${config.projectId}.${datasetId}.${tableId}\`
                   WHERE CAST(PLACEMENT_ID AS STRING) IN (${inList})
                 )
                 WHERE _rn = 1`;
    const rows = await queryObjects(sql, chunk.length * 2);
    out.push(...rows);
  }
  logDetail(`[active->ended] [BigQuery] fetchLatestRowsByPlacementIds done rows=${out.length}`);
  return out;
}

/**
 * Upsert ended rows (idempotent by placement id).
 * Existing placement IDs are treated as updates and skipped for insert.
 */
async function upsertEndedRecordsByPlacementId(rows, insertIdBase, options = {}) {
  if (!rows || rows.length === 0) {
    logDetail(`[active->ended] [BigQuery] upsertEndedRecords SKIP: no rows`);
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
  logDetail(
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
      ? `AND a.LAST_UPDATED < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${safetyAgeHours} HOUR)`
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
  logDetail(
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
  logDetail(`[active->ended] [BigQuery] cleanup delete done deleted=${rowCount}`);
  return { attempted: rowCount, deleted: rowCount, dryRun: false };
}

/**
 * Format a date-like value as YYYY-MM-DD for BigQuery DATE literals.
 * @param {Date|string|object|null} value
 * @returns {string|null}
 */
function formatDateOnlyForSql(value) {
  if (value == null || value === "") return null;
  // BigQuery query results wrap DATE/TIMESTAMP/DATETIME columns as {value: "..."} objects
  // (BigQueryDate/BigQueryTimestamp). String(wrapper) is "[object Object]", so unwrap first —
  // otherwise every date read back OUT of BigQuery (e.g. the ownership-change-log context) is
  // silently dropped to null.
  if (value != null && typeof value === "object" && !(value instanceof Date) && "value" in value) {
    return formatDateOnlyForSql(value.value);
  }
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
  "INITIAL_START_DATE",
  "EDIT_DATE",
  "CANDIDATE_ID",
  "CANDIDATE_EMAIL",
  "CELL_PHONE",
  "INTERNAL_JOB_ID",
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
  "LAST_UPDATED",
  "DEAL_TYPE",
  "PLACEMENT_STATUS",
  "CANDIDATE_NAME",
  "CANDIDATE_EMAIL",
  "CANDIDATE_ID",
  "CONTRACT_ID",
  "SKU_NUMBER",
  "START_DATE",
  "END_DATE",
  "TENTATIVE_END_DATE",
  "NEW_HIRE_DATE",
  "EXTENSION_DATE",
  "ASSIGNMENT_RECRUITER",
  "ASSIGNMENT_RECRUITER_EMAIL",
  "RECRUITER_EMP_NO",
  // PREVIOUS_RECRUITER_EMAIL / _EMP_NO are dropped from the deal-sheet schema; only
  // PREVIOUS_RECRUITER_NAME remains (legacy values on existing rows, never written on new ones).
  "PREVIOUS_RECRUITER_NAME",
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
  "ASSOCIATE_DELIVERY_DIRECTOR", "ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO",
  "AVP", "AVP_EMP_NO",
  "VP", "VP_EMP_NO",
];
Object.freeze(ACTIVE_CHANGE_SCAN_COLUMNS);

/**
 * Columns in ACTIVE_CHANGE_SCAN_COLUMNS that a specific deal sheet table does not have.
 *
 * Cynet Health Canada has no AVP role (the chain tops out at VP / Sr. VP), so AVP / AVP_EMP_NO were
 * dropped from its tables. This scan UNIONs all three domain tables, so naming AVP unconditionally
 * failed the whole query — including the cynet health trigger that runs it — with
 * "Unrecognized name: AVP". Such a column is selected as NULL for that table instead of being
 * omitted, because a UNION ALL needs every branch to have the same shape in the same order.
 */
const ACTIVE_CHANGE_SCAN_MISSING_COLUMNS_BY_TABLE = DEAL_SHEET_MISSING_COLUMNS_BY_TABLE;

/** `col` or `CAST(NULL AS STRING) AS col` per table, so every UNION branch lines up. */
function buildActiveChangeScanColumnList(tableId) {
  const missing = ACTIVE_CHANGE_SCAN_MISSING_COLUMNS_BY_TABLE.get(tableId);
  if (!missing || missing.size === 0) return ACTIVE_CHANGE_SCAN_COLUMNS.join(", ");
  return ACTIVE_CHANGE_SCAN_COLUMNS.map((col) =>
    missing.has(col) ? `CAST(NULL AS STRING) AS ${col}` : col
  ).join(", ");
}

/**
 * Per-table SELECTs (explicit columns) for the change-detection scans, UNION ALL'd. Each row is
 * tagged with `_src` (source table id). Safe across domains with differing full schemas.
 */
function buildActiveChangeScanUnionParts(datasetId) {
  return ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const src = escapeSqlString(tableId);
    const columnList = buildActiveChangeScanColumnList(tableId);
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
  // LAST_UPDATED is NOT in ACTIVE_DEAL_SHEET_UNION_BASE_COLUMNS, but the ranking below orders by it,
  // so it has to be requested explicitly — otherwise the inner union never projects it and the query
  // fails with "Unrecognized name: LAST_UPDATED".
  const unionSql = buildActiveDealSheetsUnionSql(datasetId, undefined, ["LAST_UPDATED"]);

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
            ORDER BY LAST_UPDATED DESC NULLS LAST, CONTRACT_ID ASC
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
 *
 * A directory row qualifies when it has EITHER identifier — external_id or employee_id. It used to
 * require employee_id IS NOT NULL, which silently dropped anyone whose directory record carries an
 * external_id but no emp no (e.g. onsite AM Chelsea Waszak). Those people resolved to no
 * externalId, so fetchOnsiteAmCsmHierarchyByKey skipped them entirely and their LEVEL_*_CSM came
 * out null even though directory_employee_hierarchy held a perfectly good chain. employee_id is
 * not needed to walk the hierarchy — only external_id is — so it must not gate the lookup.
 * employeeId is null in the returned entry when the directory has none; the one consumer that
 * reads it (INORGANIC_RECRUITER_EMP_NO) already null-coalesces.
 * @param {string[]} emails
 * @returns {Promise<Map<string, {employeeId: string|null, externalId: string|null, nameFull: string|null}>>}
 *   lowercased/trimmed email -> directory identity
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
            ORDER BY (status = 'ACTIVE') DESC, (external_id IS NOT NULL) DESC, updated_at DESC
          ) AS rn
        FROM \`${config.projectId}.${datasetId}.${tableId}\`
        WHERE LOWER(TRIM(email)) IN (${inList})
          AND (external_id IS NOT NULL OR employee_id IS NOT NULL)
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
      const externalId = row?.external_id;
      const nameFull = row?.name_full;
      // Keep the entry when either identifier is present — a missing emp no must not hide an
      // external_id (that is what blocked CSM hierarchy resolution).
      const employeeIdNorm = empId == null || String(empId).trim() === "" ? null : String(empId).trim();
      const externalIdNorm =
        externalId == null || String(externalId).trim() === "" ? null : String(externalId).trim();
      if (employeeIdNorm == null && externalIdNorm == null) continue;
      out.set(String(emailNorm).trim(), {
        employeeId: employeeIdNorm,
        externalId: externalIdNorm,
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
          CANDIDATE_ID,
          ${SQL_CANDIDATE_EMAIL_NORM} AS candidate_email_norm,
          ${SQL_PHONE_NUMBER_NORM} AS phone_norm,
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
          ON d.CANDIDATE_ID = ext.candidate_nexus_id
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
 * Placement statuses that never became a working assignment, so no SKU_NUMBER belongs on the row.
 * A SKU identifies an assignment that actually ran; CONTRACT_ID identifies the contract chain and is
 * still carried onto these rows. Mirrored for DEAL rows in contractIdResolver.js.
 */
const SKU_INELIGIBLE_PLACEMENT_STATUSES = new Set(["DID NOT START", "DID NOT ACCEPT"]);

/** @returns {boolean} true when this placement status may hold a SKU_NUMBER. */
function skuAllowedForPlacementStatus(status) {
  const key = status == null ? "" : String(status).trim().toUpperCase();
  return !SKU_INELIGIBLE_PLACEMENT_STATUSES.has(key);
}

/** Trimmed SKU_NUMBER, or null when the legacy row never carried one. */
function normalizeLegacySkuOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * `YYYY-MM-DD` out of a run-rate DATE column, or null.
 *
 * BigQuery hands DATE back as a `{ value: "2026-02-02" }` wrapper, so unwrap before stringifying —
 * the same trap `assignLegacyManualColumns` documents for FIFTYTWO_TENURE_RTO_LASTDATE, where a
 * wrapper reaching date handling silently became null.
 */
function normalizeLegacyDateOnlyOrNull(value) {
  if (value == null) return null;
  const raw =
    typeof value === "object" && !(value instanceof Date) && "value" in value ? value.value : value;
  if (raw == null) return null;
  const s = (raw instanceof Date ? raw.toISOString() : String(raw)).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Manual / ops columns a DEAL row takes from its matched legacy run-rate row, fill-if-empty.
 *
 * Deliberately the same list EXTENSION rows use (EXTENSION_RUNRATE_MANUAL_COLUMNS): a placement that
 * the run-rate table already tracked carries the same hand-maintained ops detail whether this sync
 * happens to see it as a DEAL or as an EXTENSION, so the two sides must not drift apart. The list is
 * read at call time rather than copied here for that reason.
 *
 * These ride alongside CONTRACT_ID / SKU_NUMBER on the very same matched row, so they cost no extra
 * query — only extra columns in the SELECT.
 *
 * Unlike SKU_NUMBER these are NOT gated on PLACEMENT_STATUS: a DID NOT START / DID NOT ACCEPT
 * placement still belongs to the contract and still has an entity, payment terms, a mentor and so on.
 * Only the SKU (which identifies an assignment that actually ran) is withheld from those rows.
 * @returns {string[]}
 */
function legacyDealManualColumns(runrateTableId) {
  const key = runrateTableId == null ? "" : String(runrateTableId).trim();
  const extra = RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE.get(key);
  const missing = RUNRATE_MANUAL_MISSING_COLUMNS_BY_TABLE.get(key);
  if (!extra && !missing) return EXTENSION_RUNRATE_MANUAL_COLUMNS;

  const base = missing && missing.size > 0
    ? EXTENSION_RUNRATE_MANUAL_COLUMNS.filter((col) => !missing.has(col))
    : EXTENSION_RUNRATE_MANUAL_COLUMNS;
  return extra && extra.length > 0 ? [...base, ...extra] : base;
}

/** `col AS col_lower` list for the legacy lookup SELECT, plus the alias->column mapping back. */
function buildLegacyManualColumnSql(prefix = "r", runrateTableId) {
  const cols = legacyDealManualColumns(runrateTableId);
  const select = cols.map((c) => `${prefix}.${c} AS ${c.toLowerCase()}`).join(",\n          ");
  return { cols, select };
}

/**
 * Copy the manual columns off a BigQuery result row into an identity object.
 *
 * DATE/TIMESTAMP columns arrive as { value: "2025-08-31" } wrapper objects, so
 * FIFTYTWO_TENURE_RTO_LASTDATE is unwrapped here — the same trap documented on
 * formatTimestampLiteralForSql, where a wrapper reaching date handling silently became null.
 */
function assignLegacyManualColumns(target, bqRow, runrateTableId) {
  for (const col of legacyDealManualColumns(runrateTableId)) {
    const raw = bqRow?.[col.toLowerCase()];
    const value =
      raw && typeof raw === "object" && !(raw instanceof Date) && "value" in raw ? raw.value : raw;
    target[col] = value === undefined ? null : value;
  }
  return target;
}

/**
 * A Nexus client id (CLIENT_ID / NEXUS_PARENT_CLIENT_ID) as a match-key string, or "" when absent.
 *
 * Both the deal sheet and the run-rate table store these as INT64, so the string form is only for
 * key building — "" means "this row cannot match on id", which pushes it onto the name fallback.
 */
function normalizeClientIdKeyPart(value) {
  if (value == null) return "";
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n !== 0 ? String(Math.trunc(n)) : "";
}

/**
 * Lookup key for a DEAL row against the legacy run-rate table.
 *
 * `spanKey` is the primary key (the data team's own matching rule); `nexusKey` is the fallback.
 * Both are returned whenever the row can form them — which one actually decides the match is
 * settled in fetchLegacyContractIdentityForDealRows, not here.
 *
 * @returns {{rowKey: string, spanKey: object|null, nexusKey: string|null}|null}
 */
function buildLegacyContractLookupKey(row) {
  if (!row || typeof row !== "object") return null;

  const candidateId = row.CANDIDATE_ID == null ? "" : String(row.CANDIDATE_ID).trim();
  const jobId = row.INTERNAL_JOB_ID == null ? "" : String(row.INTERNAL_JOB_ID).trim();
  const nexusKey = candidateId !== "" && jobId !== "" ? `${candidateId}|${jobId}` : null;

  const email = row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase();
  const dateOnly = (v) => {
    const s = v == null ? "" : String(v).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  };
  const startDate = dateOnly(row.START_DATE);
  const endDate = dateOnly(row.END_DATE);
  const tentativeEndDate = dateOnly(row.TENTATIVE_END_DATE);
  const facility =
    row.FACILITY_NAME == null ? "" : String(row.FACILITY_NAME).trim().toLowerCase();
  const parentClient =
    row.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim().toLowerCase();
  // Nexus client ids, preferred over the names above when both sides carry them. Kept as strings so
  // a blank simply never matches, the same way the name halves behave.
  const facilityId = normalizeClientIdKeyPart(row.CLIENT_ID);
  const parentClientId = normalizeClientIdKeyPart(row.NEXUS_PARENT_CLIENT_ID);

  // Primary match rule, specified by the data team: candidate (id OR email) + facility + parent
  // client, plus ANY ONE of the deal row's three dates falling inside the run-rate row's window.
  // The candidate half is satisfied by either identifier, since 4,653 of 21,849 run-rate rows carry
  // no CANDIDATE_ID at all but every one of them has an email.
  //
  // Why any-of rather than START_DATE alone (Aug 2026): Nexus re-issues a contract mid-flight with a
  // SHIFTED start, so the deal row can begin BEFORE the run-rate row it belongs to and START_DATE
  // then falls outside the window entirely. Jemal Saleh's deal started 2026-03-15 against a run-rate
  // window of 2026-03-28..2026-12-12 — START_DATE missed, END_DATE (2026-03-31) and
  // TENTATIVE_END_DATE (2026-06-27) both landed inside, and because nothing matched the row minted a
  // second CONTRACT_ID (CHC23149) for a contract that already had one (CHC21804).
  //
  // Requiring all three dates instead was measured and rejected: it collapses matches from 1,865 to
  // 709, because a BOOKED/STARTED placement has no END_DATE yet. Any-of resolves 1,905 with the same
  // 5 ambiguous rows as before.
  // The client half is satisfied by EITHER the id pair or the name pair. Ids are preferred inside the
  // SQL (see the join below); the names stay on the key so a run-rate row carrying no ids at all —
  // 975 of 21,926 live rows — still has something to match on.
  const hasClientIds = facilityId !== "" && parentClientId !== "";
  const hasClientNames = facility !== "" && parentClient !== "";
  const spanKey =
    (candidateId !== "" || email !== "") &&
    (startDate !== "" || endDate !== "" || tentativeEndDate !== "") &&
    (hasClientIds || hasClientNames)
      ? {
          candidateId,
          email,
          startDate,
          endDate,
          tentativeEndDate,
          facility,
          parentClient,
          facilityId,
          parentClientId,
        }
      : null;

  if (!spanKey && !nexusKey) return null;

  // Row identity for the returned map: DEAL_SHEET_ID is unique per deal sheet; PLACEMENT_ID backs it
  // up, and the composite key itself is the last resort so two rows never collide.
  const rowKey =
    row.DEAL_SHEET_ID != null && String(row.DEAL_SHEET_ID).trim() !== ""
      ? `ds:${String(row.DEAL_SHEET_ID).trim()}`
      : row.PLACEMENT_ID != null && String(row.PLACEMENT_ID).trim() !== ""
        ? `pl:${String(row.PLACEMENT_ID).trim()}`
        : `k:${spanKey ? buildSpanKeyString(spanKey) : nexusKey}`;

  return { rowKey, spanKey, nexusKey };
}

/**
 * Stable string form of a spanKey, used for map lookups on both sides of the SQL round trip.
 *
 * IDENTITY ONLY — candidate + client. The three dates are deliberately NOT part of it even though
 * they travel in the same struct, because they are join INPUTS (which run-rate window does this row
 * fall inside?) and not part of who the row is.
 *
 * Including them made the key per-ROW instead of per-CONTRACT. The deal sheet is append-only, so one
 * contract owns several placement-level rows and each carries its OWN START_DATE / END_DATE /
 * TENTATIVE_END_DATE; two rows of the same contract therefore built two different keys, the SQL
 * PARTITION BY split them into two independent windows, and each resolved its own CONTRACT_ID. That
 * is the "one contract, two ids" split — deterministic on rerun, but not consistent across the rows
 * of a contract. Keying on identity alone collapses them onto one match, and the dates still do
 * their real job inside the join predicate below.
 */
function buildSpanKeyString(spanKey) {
  if (!spanKey) return "";
  return [
    spanKey.candidateId ?? "",
    spanKey.email ?? "",
    spanKey.facility ?? "",
    spanKey.parentClient ?? "",
    spanKey.facilityId ?? "",
    spanKey.parentClientId ?? "",
  ].join("|");
}

/**
 * Legacy CONTRACT_ID / SKU_NUMBER for brand-new DEAL rows that the run-rate table already knows.
 *
 * Most placements landing here as DEAL_TYPE='DEAL' are not new business — they were already tracked
 * in the legacy run-rate table with a CONTRACT_ID (and often a SKU_NUMBER). Minting a fresh Firestore
 * id for them split one real contract across two ids (run-rate CHC22144 vs newly minted CHC23016) and
 * left SKU_NUMBER empty. That then propagated: EXTENSION rows inherit CONTRACT_ID from their parent
 * DEAL, and ch_rate_change_logs / ownership_change_logs / ch_termination_reason_logs are all keyed on
 * it. This looks the row up first so the existing identity wins; only placements with no run-rate
 * history fall through to a freshly minted id.
 *
 * Two match tiers, tried in order — the first that matches wins:
 *   1. The data team's rule (primary): candidate (CANDIDATE_ID OR CANDIDATE_EMAIL) + FACILITY_NAME +
 *      PARENT_CLIENT_NAME, plus ANY ONE of the deal row's START_DATE / END_DATE /
 *      TENTATIVE_END_DATE falling inside the run-rate row's window. The window is
 *      START_DATE .. COALESCE(END_DATE, TENTATIVE_END_DATE). See buildLegacyContractLookupKey for why
 *      any-of rather than START_DATE alone, and why requiring all three was rejected.
 *   2. CANDIDATE_ID + INTERNAL_JOB_ID (fallback): exact Nexus identity, 17,005 of 21,849 run-rate
 *      rows. Tier 1 owns the decision; this only catches what it cannot see. Both tiers were
 *      measured head to head on live data: tier 1 resolves 442 rows tier 2 misses, tier 2 resolves
 *      250 rows tier 1 misses (facility/parent-client spelled differently across the two tables, or
 *      a contract that moved between facilities of one health system mid-assignment). Keeping tier 2
 *      as a net takes coverage to 2,306 of 2,354 and stops those 250 from minting a second id for a
 *      contract that already has one.
 *
 * Earlier revisions also tried CANDIDATE_EMAIL + exact START_DATE, CANDIDATE_ID + VMS_JOB_ID, and a
 * bare CANDIDATE_ID + span as separate tiers; all three are now subsumed by tier 1 and were removed.
 *
 * The key is candidate + client IDENTITY only; the dates travel alongside it as probe values for the
 * window join but are NOT part of the key. See buildSpanKeyString for why — keying on them made the
 * key per-row instead of per-contract and split one contract across two ids.
 *
 * A key mapping to more than one CONTRACT_ID resolves to an exact probe-date match first, then the
 * LATEST START_DATE, then the lowest CONTRACT_ID, then the lowest ID — deterministic across reruns.
 * Latest rather than earliest because the span is inclusive: a re-booking at the same facility also
 * falls inside the window of the contract it replaced. Tier 2 uses the same LATEST ordering.
 *
 * NOTE: this resolves the contract for a placement that has NO id yet. A placement that already has
 * one keeps it — applyContractIdCarryForward copies the baseline id onto every update-append, so a
 * re-derivation here can never change an existing placement's contract identity.
 *
 * @param {object[]} rows - DEAL rows needing an id
 * @param {object} [options]
 * @param {string} [options.datasetId]
 * @param {string} [options.tableId] - destination deal sheet table (selects the domain's run-rate table)
 * @param {string} [options.runrateTableId]
 * @returns {Promise<Map<string, {CONTRACT_ID: string|null, SKU_NUMBER: string|null}>>} rowKey -> legacy identity
 */
async function fetchLegacyContractIdentityForDealRows(rows, options = {}) {
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

  const keyed = [];
  const nexusKeys = new Set();
  // Identity string -> the span key plus the UNION of every date those rows contributed.
  //
  // The key is now identity-only, so all the placement-level rows of one contract land on the same
  // entry. Their dates still differ, and each one is a legitimate probe into the run-rate window —
  // a BOOKED row has no END_DATE, a re-issued row has a shifted START_DATE — so they are collected
  // rather than overwritten. Taking just one row's dates ("last wins") would throw away the only
  // date that lands inside the window and lose the match entirely.
  const spanKeysByString = new Map();
  for (const row of rows) {
    const key = buildLegacyContractLookupKey(row);
    if (!key) continue;
    keyed.push(key);
    if (key.nexusKey) nexusKeys.add(key.nexusKey);
    if (!key.spanKey) continue;
    const keyString = buildSpanKeyString(key.spanKey);
    let entry = spanKeysByString.get(keyString);
    if (!entry) {
      entry = { spanKey: key.spanKey, dates: new Set() };
      spanKeysByString.set(keyString, entry);
    }
    for (const d of [key.spanKey.startDate, key.spanKey.endDate, key.spanKey.tentativeEndDate]) {
      if (d) entry.dates.add(d);
    }
  }
  if (keyed.length === 0) return out;

  const bySpanKey = new Map();
  const byNexusKey = new Map();

  if (spanKeysByString.size > 0) {
    // Every date the contract's rows contributed, as an ARRAY. An empty array simply never satisfies
    // the EXISTS below, which is the same "absent date never matches" behaviour the three nullable
    // scalar columns had.
    const dateArrayLit = (dates) => {
      const lits = [...dates]
        .sort()
        .map((d) => `DATE '${escapeSqlString(d)}'`);
      return lits.length === 0 ? "CAST([] AS ARRAY<DATE>)" : `[${lits.join(", ")}]`;
    };
    const structs = [...spanKeysByString.values()].map(
      ({ spanKey: k, dates }) =>
        `STRUCT('${escapeSqlString(k.candidateId)}' AS cand, '${escapeSqlString(k.email)}' AS em, ` +
        `${dateArrayLit(dates)} AS probe_dates, '${escapeSqlString(k.facility)}' AS fac, ` +
        `'${escapeSqlString(k.parentClient)}' AS pc, ` +
        `'${escapeSqlString(k.facilityId)}' AS fac_id, ` +
        `'${escapeSqlString(k.parentClientId)}' AS pc_id)`
    );
    // The candidate half matches on either identifier; a blank one on the deal row simply never
    // matches, since the run-rate side is compared against a non-empty value.
    // ROW_NUMBER picks one contract per IDENTITY (see the PARTITION BY below); an exact probe-date
    // hit wins, then the latest START_DATE, then CONTRACT_ID and ID break ties so repeated runs
    // always resolve identically.
    const { cols: manualCols, select: manualSelect } = buildLegacyManualColumnSql("r", runrateTableId);
    const manualOut = manualCols.map((c) => c.toLowerCase()).join(", ");
    const sql = `
      WITH wanted_keys AS (SELECT * FROM UNNEST([${structs.join(", ")}])),
      -- One row per (identity, probe date). A contract whose placement rows contributed four dates
      -- gets four chances at the run-rate window; the PARTITION BY on identity below then collapses
      -- however many of them hit back down to a single chosen contract.
      wanted AS (
        SELECT k.* EXCEPT(probe_dates), k.probe_dates AS probe_dates, probe
        FROM wanted_keys k CROSS JOIN UNNEST(k.probe_dates) AS probe
      ),
      ranked AS (
        SELECT
          w.cand AS cand,
          w.em AS em,
          w.fac AS fac,
          w.pc AS pc,
          w.fac_id AS fac_id,
          w.pc_id AS pc_id,
          r.CONTRACT_ID AS contract_id,
          r.SKU_NUMBER AS sku_number,
          -- The matched run-rate row is the contract, so its START_DATE is the contract's true
          -- initial start. A deal sheet splits one contract into several placement-level rows on
          -- every rate / ownership change, and each of those carries its OWN start; taking it from
          -- here keeps every row of the contract on the same INITIAL_START_DATE.
          r.START_DATE AS initial_start_date,
          ${manualSelect},
          ROW_NUMBER() OVER (
            -- Identity only (candidate + client), matching buildSpanKeyString. The dates are join
            -- inputs, not identity: partitioning by them gave every placement-level row of one
            -- contract its own window and let each pick a different CONTRACT_ID.
            PARTITION BY w.cand, w.em, w.fac, w.pc, w.fac_id, w.pc_id
            -- An exact hit on ANY of the contract's probe dates wins over a merely-spanning one. The
            -- window is inclusive, so a re-booking at the same facility sits inside its own
            -- predecessor's window too (the previous contract runs to 2026-02-28, the new one starts
            -- 2026-02-23) and ordering by START_DATE alone would hand the row to the contract it just
            -- replaced. Preferring the exact match keeps the window as what it was meant to be: a
            -- fallback for shifted dates.
            --
            -- Then: the run-rate row whose window covers the MOST of the contract's probe dates
            -- wins. Two rows can share a START_DATE while one is the real contract and the other a
            -- stub that was opened and closed the same day — live example (CANDIDATE_ID 20118086,
            -- Aug 2026): CHC20908 runs 2026-01-05..2026-01-31 (tentative 04-04) and carries SKU
            -- H14319, while CHC20892 runs 2026-01-05..2026-01-05 with no SKU. START_DATE ties, so
            -- CONTRACT_ID ASC used to break it and handed the placement to the stub. Coverage is the
            -- discriminator that actually distinguishes them: the real contract spans every one of
            -- the placement's dates, the stub spans one.
            ORDER BY
              CASE WHEN r.START_DATE IN UNNEST(w.probe_dates) THEN 0 ELSE 1 END ASC,
              (
                SELECT COUNT(1) FROM UNNEST(w.probe_dates) AS pd
                WHERE pd BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
              ) DESC,
              r.START_DATE DESC,
              r.CONTRACT_ID ASC,
              r.ID ASC
          ) AS rn
        FROM ${runrateFqn} r
        JOIN wanted w
          ON ( (w.cand != '' AND CAST(r.CANDIDATE_ID AS STRING) = w.cand)
               OR (w.em != '' AND LOWER(TRIM(r.CANDIDATE_EMAIL)) = w.em) )
         -- ANY ONE of the contract's probe dates inside the run-rate window is enough. A shifted
         -- re-issue can push START_DATE outside it while END/TENTATIVE_END still land inside, and a
         -- BOOKED row has no END_DATE at all — so every date from every placement-level row of the
         -- contract gets a shot at the window.
         -- The probe column comes from the CROSS JOIN UNNEST in the wanted CTE rather than an EXISTS
         -- subquery, which BigQuery rejects inside a join predicate. One matching probe date is
         -- enough, and the PARTITION BY collapses the duplicate rows a multi-probe hit produces.
         AND probe BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
         -- Client half: Nexus ids when BOTH sides carry them, else the names. Ids are exact where
         -- names are not — the two tables spell the same facility differently often enough that
         -- 749 candidate/client pairs match by id and fail by name, with none matching by name
         -- alone. The name arm only engages when either side is missing an id, so a genuine id
         -- mismatch is never papered over by a coincidental name hit.
         AND ( CASE
                 WHEN w.fac_id != '' AND w.pc_id != ''
                  AND r.CLIENT_ID IS NOT NULL AND r.NEXUS_PARENT_CLIENT_ID IS NOT NULL
                   THEN CAST(r.CLIENT_ID AS STRING) = w.fac_id
                    AND CAST(r.NEXUS_PARENT_CLIENT_ID AS STRING) = w.pc_id
                 ELSE LOWER(TRIM(r.FACILITY_NAME)) = w.fac
                  AND LOWER(TRIM(r.PARENT_CLIENT_NAME)) = w.pc
               END )
        WHERE r.CONTRACT_ID IS NOT NULL AND TRIM(r.CONTRACT_ID) != ''
          AND r.START_DATE IS NOT NULL
          -- The window needs an end: END_DATE preferred, TENTATIVE_END_DATE when it is absent.
          AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE) IS NOT NULL
      )
      SELECT cand, em, fac, pc, fac_id, pc_id, contract_id, sku_number, initial_start_date, ${manualOut}
      FROM ranked WHERE rn = 1
    `;
    const found = await queryObjects(sql, spanKeysByString.size);
    for (const r of found) {
      // Same identity-only shape as buildSpanKeyString — the dates were join inputs and never
      // came back out.
      const keyString = [
        r.cand ?? "",
        r.em ?? "",
        r.fac ?? "",
        r.pc ?? "",
        r.fac_id ?? "",
        r.pc_id ?? "",
      ].join("|");
      bySpanKey.set(
        keyString,
        assignLegacyManualColumns(
          {
            CONTRACT_ID: normalizeContractIdOrNull(r.contract_id),
            SKU_NUMBER: normalizeLegacySkuOrNull(r.sku_number),
            INITIAL_START_DATE: normalizeLegacyDateOnlyOrNull(r.initial_start_date),
          },
          r,
          runrateTableId
        )
      );
    }
  }

  if (nexusKeys.size > 0) {
    const pairs = [...nexusKeys].map((k) => {
      const [cand, job] = k.split("|");
      return `STRUCT('${escapeSqlString(cand)}' AS cand, '${escapeSqlString(job)}' AS job)`;
    });
    // ROW_NUMBER picks the LATEST contract per key; CONTRACT_ID then ID break ties so repeated runs
    // always resolve identically. Latest, not earliest, to match the span tier above: the two tiers
    // resolve the same candidate's rows (whichever one a given row falls to), so opposite orderings
    // had them pick contracts from opposite ends of the candidate's history and hand two rows of one
    // contract two different ids.
    const { cols: manualCols, select: manualSelect } = buildLegacyManualColumnSql("r", runrateTableId);
    const manualOut = manualCols.map((c) => c.toLowerCase()).join(", ");
    const sql = `
      WITH wanted AS (SELECT * FROM UNNEST([${pairs.join(", ")}])),
      ranked AS (
        SELECT
          CAST(r.CANDIDATE_ID AS STRING) AS cand,
          CAST(r.INTERNAL_JOB_ID AS STRING) AS job,
          r.CONTRACT_ID AS contract_id,
          r.SKU_NUMBER AS sku_number,
          r.START_DATE AS initial_start_date,
          ${manualSelect},
          ROW_NUMBER() OVER (
            PARTITION BY CAST(r.CANDIDATE_ID AS STRING), CAST(r.INTERNAL_JOB_ID AS STRING)
            ORDER BY r.START_DATE DESC, r.CONTRACT_ID ASC, r.ID ASC
          ) AS rn
        FROM ${runrateFqn} r
        JOIN wanted w
          ON CAST(r.CANDIDATE_ID AS STRING) = w.cand
         AND CAST(r.INTERNAL_JOB_ID AS STRING) = w.job
        WHERE r.CONTRACT_ID IS NOT NULL AND TRIM(r.CONTRACT_ID) != ''
      )
      SELECT cand, job, contract_id, sku_number, initial_start_date, ${manualOut} FROM ranked WHERE rn = 1
    `;
    const found = await queryObjects(sql, nexusKeys.size);
    for (const r of found) {
      byNexusKey.set(
        `${r.cand}|${r.job}`,
        assignLegacyManualColumns(
          {
            CONTRACT_ID: normalizeContractIdOrNull(r.contract_id),
            SKU_NUMBER: normalizeLegacySkuOrNull(r.sku_number),
            INITIAL_START_DATE: normalizeLegacyDateOnlyOrNull(r.initial_start_date),
          },
          r,
          runrateTableId
        )
      );
    }
  }

  // Tier 1 (the data team's rule) decides; tier 2 only fills what it could not match.
  let spanHits = 0;
  let nexusHits = 0;
  for (const key of keyed) {
    const tier1 = key.spanKey ? bySpanKey.get(buildSpanKeyString(key.spanKey)) : null;
    const tier2 = tier1 ? null : key.nexusKey ? byNexusKey.get(key.nexusKey) : null;
    const hit = tier1 ?? tier2;
    if (!hit || hit.CONTRACT_ID == null) continue;
    if (tier1) spanHits++;
    else nexusHits++;
    out.set(key.rowKey, hit);
  }

  logDetail(
    `[legacy contract lookup] runrate=${runrateTableId} dealRows=${rows.length} keyed=${keyed.length} matched=${out.size} (spanKey=${spanHits} nexusKey=${nexusHits})`
  );

  return out;
}

/**
 * Non-assignment hierarchy columns backfilled from all_CH_data_runrate for brand-new EXTENSION
 * rows. ASSIGNMENT_RECRUITER* / RECRUITER_ID / RECRUITER_EMP_NO / PREVIOUS_RECRUITER_* stay
 * excluded — the current Nexus assignment wins. Sales / credentialing / payment / SECONDARY_RECRUITER
 * come from EXTENSION_RUNRATE_MANUAL_COLUMNS (fill-if-empty, same as SKU_NUMBER).
 * This list holds only the NAME columns, but each one's `${col}_EMP_NO` companion is now read
 * straight from the run-rate table too (all_CH_data_runrate and all_Health_Canada_data_Runrate
 * both carry the *_EMP_NO columns) — see fetchExtensionRunrateBackfillByPlacementId, which selects
 * both and puts them in the entry, and the runrateFields list in applyExtensionInheritForInsertRows,
 * which merges the name and its `${col}_EMP_NO`. (Earlier this emp-no was resolved by a separate
 * name+designation lookup against MISC.directory_employees; that lookup has been removed.)
 */
const EXTENSION_RUNRATE_HIERARCHY_COLUMNS = [
  "TEAM_LEAD",
  "ATL",
  "RM",
  "ACCOUNT_MANAGER",
  "SECONDARY_AM",
  "ASSOCIATE_AM",
  "ASSOCIATE_DELIVERY_DIRECTOR",
  "DELIVERY_DIRECTOR",
  "AVP",
  "VP",
];
Object.freeze(EXTENSION_RUNRATE_HIERARCHY_COLUMNS);

/**
 * Manual / ops columns copied onto brand-new EXTENSION rows fill-if-empty from the matched
 * run-rate row (and also from parent DEAL / prior EXTENSION inherit). Same merge semantics as
 * SKU_NUMBER / INITIAL_START_DATE — never overwrites a non-empty value.
 * ASSIGNMENT_RECRUITER* / RECRUITER_ID / RECRUITER_EMP_NO / PREVIOUS_RECRUITER_* / RECRUITER_CLUSTER_REGION
 * stay out (Nexus or hand-edit only).
 */
const EXTENSION_RUNRATE_MANUAL_COLUMNS = [
  "CLIENT_RECRUITER",
  "CREDENTIALING_SPECIALIST",
  "CREDENTIALING_LEAD",
  "PRIMARY_SALES_PERSON",
  "SECONDARY_SALES_PERSON",
  "RECRUITMENT_MENTOR",
  "INVOICE_CYCLE_TO_CLIENT",
  "CLIENT_PAYMENT_TERMS",
  "CANDIDATE_PAYMENT_TERMS",
  "SECONDARY_RECRUITER",
  "SECONDARY_RECRUITER_EMP_NO",
  // Added Aug 2026 alongside extending this list to DEAL rows. All five are hand-maintained ops
  // fields that live on the contract rather than the individual booking, so an extension or a
  // re-tracked deal should keep whatever the run-rate row already recorded.
  // CLIENT_NAME_IN_CONREP was INT64 on the deal sheet while the run-rate column is a STRING of client
  // names; the deal sheet column was empty in all six tables, so it was altered to STRING rather than
  // dropping the data on the floor.
  "ENTITY",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
  "ST_DT_PUSHBACK_REASON",
  "CLIENT_NAME_IN_CONREP",
  // Both are hand-written narrative that only ever existed on the run-rate side: every one of the
  // 2,387 DEAL and 2,074 EXTENSION rows in cynet_health_deal_sheet has them null, against 19,844
  // and 21,613 populated run-rate rows. Nexus does not supply either, so without carrying them
  // across the deal sheet simply never has them.
  "BACKOUT_OR_TERMINATION",
  "COMMENTS",
  // Added Aug 2026: the remaining hand-maintained ops columns. Measured on live data — each is
  // well populated on the run-rate side and 100% EMPTY on every deal sheet row (e.g. TYPE_OF_CLIENT
  // 21,926/21,926 vs 0/5,053; ACC_DIR_OR_VERT_HEAD 21,896; the BGC_* and ONB_* groups 12-14k each),
  // so without carrying them across the deal sheet simply never has them. Nexus supplies none of
  // them. Same fill-if-empty semantics as everything above: a hand-edit on the deal sheet always
  // wins.
  "TYPE_OF_CLIENT",
  "ACC_DIR_OR_VERT_HEAD",
  "WEEKLY_WALLET_MONEY",
  "DIVERSITY_STATUS",
  "PO_RECEIVED",
  "PAYLOCITY_ID",
  // Background-check group: category/amount triplets plus the agency and rolled-up cost.
  "BGC_CATEGORY1",
  "BGC_AMOUNT1",
  "BGC_CATEGORY2",
  "BGC_AMOUNT2",
  "BGC_CATEGORY3",
  "BGC_AMOUNT3",
  "BGC_TOTAL_BGV_COST",
  "BGC_AGENCY_NAME",
  // Onboarding document group. ONB_SUPP_DOC2_EXP_DT is sparse (4 live rows) but belongs with its
  // sibling — splitting the pair would leave a document with no expiry.
  "ONB_CAND_DOB",
  "ONB_I9_RECIEVED",
  "ONB_E_VERIFY",
  "ONB_SUPP_DOC1",
  "ONB_SUPP_DOC1_EXP_DT",
  "ONB_SUPP_DOC2",
  "ONB_SUPP_DOC2_EXP_DT",
];
Object.freeze(EXTENSION_RUNRATE_MANUAL_COLUMNS);

/**
 * Per-runrate-table schema gaps: columns in EXTENSION_RUNRATE_HIERARCHY_COLUMNS that a specific
 * run-rate table does not have (confirmed via INFORMATION_SCHEMA.COLUMNS). all_locums_runrate has
 * every hierarchy column except AVP/AVP_EMP_NO — selecting it throws "Unrecognized name: AVP".
 * Add an entry here (never edit EXTENSION_RUNRATE_HIERARCHY_COLUMNS itself) if another domain's
 * run-rate table turns out to be missing a different column.
 */
const RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE = new Map([
  ["all_locums_runrate", new Set(["AVP"])],
  // Cynet Health Canada has no AVP role — the hierarchy tops out at VP / Sr. VP — so neither the
  // Canada run-rate table nor the Canada deal sheet tables carry AVP / AVP_EMP_NO. Selecting it
  // would fail the extension backfill query with "Unrecognized name: AVP".
  ["all_Health_Canada_data_Runrate", new Set(["AVP"])],
]);

/**
 * Extra manual columns to carry, for one run-rate table only.
 *
 * The inverse of RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE: instead of removing a column a table
 * lacks, this adds columns only a specific domain has. A column can only be carried when BOTH sides
 * have it, and these five exist on the Canada pair but not on health's or locums' — so putting them
 * in EXTENSION_RUNRATE_MANUAL_COLUMNS would break the health SELECT with "Unrecognized name".
 * Keeping them here leaves cynet health's behaviour byte-identical.
 *
 * Verified on live data (all_Health_Canada_data_Runrate, 620 rows):
 *   CLIENT_AVERAGING_AGREEMENT     301 populated
 *   CANDIDATE_AVERAGING_AGREEMENT  301
 *   NO_OF_TIME_EXTENSION_RECEIVED  116
 *   DT_RATE / CLIENT_DT_RATE       612 each
 *
 * DT_RATE / CLIENT_DT_RATE do exist on the health tables, but adding them to the shared list would
 * change what health carries; Canada asked for them, health did not, so they ride here too.
 */
const RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE = new Map([
  [
    "all_Health_Canada_data_Runrate",
    Object.freeze([
      "CLIENT_AVERAGING_AGREEMENT",
      "CANDIDATE_AVERAGING_AGREEMENT",
      "NO_OF_TIME_EXTENSION_RECEIVED",
      "DT_RATE",
      "CLIENT_DT_RATE",
    ]),
  ],
]);

/**
 * Manual columns a specific run-rate table does NOT have, so they must be left out of its SELECT.
 *
 * Same idea as RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE but for the manual/ops list. Confirmed
 * against all_Health_Canada_data_Runrate's schema: these three are the only members of
 * EXTENSION_RUNRATE_MANUAL_COLUMNS it lacks, and all three are also columns Canada dropped from its
 * own deal sheet tables, so there is nothing to carry either way.
 */
const RUNRATE_MANUAL_MISSING_COLUMNS_BY_TABLE = new Map([
  [
    "all_Health_Canada_data_Runrate",
    new Set([
      "CLIENT_NAME_IN_CONREP",
      "FIFTYTWO_TENURE_RTO_LASTDATE",
      "FIFTYTWO_TENURE_CANDIDATE_STATUS",
    ]),
  ],
]);

/** Hierarchy columns that actually exist on `runrateTableId`, safe to reference in a SELECT. */
function resolveExtensionRunrateHierarchyColumns(runrateTableId) {
  const missing = RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE.get(runrateTableId);
  if (!missing || missing.size === 0) return EXTENSION_RUNRATE_HIERARCHY_COLUMNS;
  return EXTENSION_RUNRATE_HIERARCHY_COLUMNS.filter((col) => !missing.has(col));
}

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
 * are excluded — the current Nexus assignment wins. Sales / credentialing / payment /
 * SECONDARY_RECRUITER mirror EXTENSION_RUNRATE_MANUAL_COLUMNS (fill-if-empty only).
 * RECRUITER_CLUSTER_REGION stays manual-only (not auto-inherited).
 */
const EXTENSION_PARENT_DEAL_INHERIT_COLUMNS = [
  // The parent DEAL is the authoritative source of the contract identity, so it must be able to
  // supply CONTRACT_ID directly — the run-rate tier below also proposes one now (Aug 2026), and
  // fill-if-empty means whichever tier runs first wins. Parent runs first, as it should.
  "CONTRACT_ID",
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
  "ASSOCIATE_DELIVERY_DIRECTOR",
  "ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO",
  "VP",
  "VP_EMP_NO",
  "SECONDARY_RECRUITER",
  "SECONDARY_RECRUITER_EMP_NO",
  "DELIVERY_DIRECTOR",
  "DELIVERY_DIRECTOR_EMP_NO",
  "DELIVERY_POC",
  "ACC_DIR_OR_VERT_HEAD",
  "CREDENTIALING_SPECIALIST",
  "CREDENTIALING_LEAD",
  "CLIENT_RECRUITER",
  "PRIMARY_SALES_PERSON",
  "SECONDARY_SALES_PERSON",
  "RECRUITMENT_MENTOR",
  "INVOICE_CYCLE_TO_CLIENT",
  "CLIENT_PAYMENT_TERMS",
  "CANDIDATE_PAYMENT_TERMS",
  // Contract-level ops detail that was already inheritable from the run-rate row but not from a
  // parent DEAL, so an extension whose contract the run-rate window could not place lost it. These
  // describe the contract, not the individual booking, so the parent DEAL is just as valid a source.
  // extensionParentBackfill.js listed the first five separately as EXTRA_PARENT_BACKFILL_COLUMNS;
  // holding them here instead keeps the insert path and the post-sync repair on one list.
  "ENTITY",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
  "ST_DT_PUSHBACK_REASON",
  "CLIENT_NAME_IN_CONREP",
  "BACKOUT_OR_TERMINATION",
  "COMMENTS",
  // Added Aug 2026: the remaining hand-maintained ops columns. Measured on live data — each is
  // well populated on the run-rate side and 100% EMPTY on every deal sheet row (e.g. TYPE_OF_CLIENT
  // 21,926/21,926 vs 0/5,053; ACC_DIR_OR_VERT_HEAD 21,896; the BGC_* and ONB_* groups 12-14k each),
  // so without carrying them across the deal sheet simply never has them. Nexus supplies none of
  // them. Same fill-if-empty semantics as everything above: a hand-edit on the deal sheet always
  // wins.
  "TYPE_OF_CLIENT",
  // ACC_DIR_OR_VERT_HEAD is NOT repeated here — it is already listed above, next to
  // DELIVERY_POC. Listing it twice put the name twice in the `deals` CTE select list and
  // BigQuery rejected EVERY insert batch with "Name ACC_DIR_OR_VERT_HEAD is ambiguous inside
  // d", stalling the entire sync (TIMER_FAIL / checkpoint error_paused, Aug 18 2026).
  "WEEKLY_WALLET_MONEY",
  "DIVERSITY_STATUS",
  "PO_RECEIVED",
  "PAYLOCITY_ID",
  // Background-check group: category/amount triplets plus the agency and rolled-up cost.
  "BGC_CATEGORY1",
  "BGC_AMOUNT1",
  "BGC_CATEGORY2",
  "BGC_AMOUNT2",
  "BGC_CATEGORY3",
  "BGC_AMOUNT3",
  "BGC_TOTAL_BGV_COST",
  "BGC_AGENCY_NAME",
  // Onboarding document group. ONB_SUPP_DOC2_EXP_DT is sparse (4 live rows) but belongs with its
  // sibling — splitting the pair would leave a document with no expiry.
  "ONB_CAND_DOB",
  "ONB_I9_RECIEVED",
  "ONB_E_VERIFY",
  "ONB_SUPP_DOC1",
  "ONB_SUPP_DOC1_EXP_DT",
  "ONB_SUPP_DOC2",
  "ONB_SUPP_DOC2_EXP_DT",
  "SKU_NUMBER",
];
Object.freeze(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS);

/**
 * Parent-DEAL inherit columns a specific deal sheet table does not have.
 *
 * The cynet health canada tables dropped these three (Aug 2026), so selecting them off a Canada
 * parent DEAL row failed the extension-inherit query with "Unrecognized name:
 * FIFTYTWO_TENURE_RTO_LASTDATE". Unlike the change-scan union, these queries run against ONE table
 * at a time, so the column is simply left out rather than selected as NULL.
 *
 * cynet health and locums are absent from this map and keep the full 61-column list.
 */
const PARENT_DEAL_INHERIT_MISSING_COLUMNS_BY_TABLE = DEAL_SHEET_MISSING_COLUMNS_BY_TABLE;

/**
 * Parent-DEAL inherit columns that exist on ONE domain's tables only.
 *
 * EXTENSION_PARENT_DEAL_INHERIT_COLUMNS is shared across all three domains, so a column only canada
 * has cannot live in it — naming it against cynet health would fail the query. These three are
 * canada-only sheet columns with no API source, and they describe the CONTRACT rather than the
 * individual booking: an extension of the same contract must keep whatever its parent DEAL recorded.
 *
 * They already come across from the run-rate row (RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE); this adds
 * the second path, so a placement whose contract has no run-rate history still inherits them from
 * the parent deal already in the table.
 */
const PARENT_DEAL_INHERIT_EXTRA_COLUMNS_BY_TABLE = new Map([
  [
    "cynet_health_canada_deal_sheet",
    Object.freeze([
      "CLIENT_AVERAGING_AGREEMENT",
      "CANDIDATE_AVERAGING_AGREEMENT",
      "NO_OF_TIME_EXTENSION_RECEIVED",
    ]),
  ],
  [
    "cynet_health_canada_ended_deal_sheet",
    Object.freeze([
      "CLIENT_AVERAGING_AGREEMENT",
      "CANDIDATE_AVERAGING_AGREEMENT",
      "NO_OF_TIME_EXTENSION_RECEIVED",
    ]),
  ],
]);

/**
 * Parent-DEAL inherit columns that actually exist on `tableId`, safe to name in a SELECT.
 *
 * With no tableId the query spans every active table, so only columns common to all of them are
 * safe — the Canada-missing three are dropped in that case too.
 *
 * @param {string} [tableId]
 * @returns {string[]}
 */
function resolveExtensionParentDealInheritColumns(tableId) {
  const missing = resolveDealSheetMissingColumns(tableId);
  const extra = PARENT_DEAL_INHERIT_EXTRA_COLUMNS_BY_TABLE.get(
    tableId == null ? "" : String(tableId).trim()
  );
  const base =
    missing.size === 0
      ? EXTENSION_PARENT_DEAL_INHERIT_COLUMNS
      : EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.filter((col) => !missing.has(col));
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base);
  return [...base, ...extra.filter((col) => !seen.has(col))];
}

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
  // Update-appends carry hierarchy forward verbatim (frozen at first insert); never re-derive it
  // from the prior-extension inherit, or a field a recruiter-hierarchy MOVE deliberately vacated
  // (see applyRecruiterHierarchyMovesToDealSheet) gets re-filled every run — the MOVE re-vacates it
  // the next run, and the two writers flap forever, appending a duplicate row each cycle. Mirrors
  // rowNeedsDealRecruiterHierarchyBackfill's __CARRIED_FORWARD_UPDATE guard on the DEAL side.
  if (row.__CARRIED_FORWARD_UPDATE === true) return false;
  if (String(row.DEAL_TYPE || "").trim().toUpperCase() !== "EXTENSION") return false;
  if (row.CANDIDATE_ID == null || String(row.CANDIDATE_ID).trim() === "") return false;
  if (row.PLACEMENT_ID == null || String(row.PLACEMENT_ID).trim() === "") return false;
  return true;
}

/** @deprecated Use rowNeedsExtensionInsertBackfill — kept for existing tests/callers. */
function rowNeedsExtensionRunrateBackfill(row) {
  return rowNeedsExtensionInsertBackfill(row);
}

/**
 * Shared BQ identity-normalize fragments for EXTENSION match joins (parent DEAL, prior
 * EXTENSION, CONTRACT_ID reuse). Must mirror the JS `.trim()` / `.toLowerCase()` applied when
 * building extension UNNEST structs — without TRIM on the stored-row side, trailing whitespace
 * on CANDIDATE_EMAIL / CELL_PHONE silently drops the parent match.
 */
const SQL_CANDIDATE_EMAIL_NORM = "LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, '')))";
const SQL_PHONE_NUMBER_NORM = "TRIM(IFNULL(CELL_PHONE, ''))";

/**
 * @param {object[]} rows
 * @returns {string[]}
 */
function buildExtensionContractMatchStructLiterals(rows) {
  const structLiterals = [];

  for (const row of rows) {
    const pid = Number(row.PLACEMENT_ID);
    const cand = Number(row.CANDIDATE_ID);
    const client = Number(row.CLIENT_ID);
    if (!Number.isFinite(pid) || !Number.isFinite(cand) || !Number.isFinite(client)) continue;

    const email = escapeSqlString(
      row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase()
    );
    const phone = escapeSqlString(
      row.CELL_PHONE == null ? "" : String(row.CELL_PHONE).trim()
    );
    // Carried so the parent-DEAL join can reject DEALs that start after this extension; a row with
    // no usable START_DATE yields NULL and the date guard simply lets every candidate through.
    const startDateSql = (() => {
      const d = formatDateOnlyForSql(row.START_DATE);
      return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
    })();

    structLiterals.push(
      `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, `
      + `'${email}' AS candidate_email, '${phone}' AS phone_number, ${Math.trunc(client)} AS client_id, `
      + `${startDateSql} AS extension_start_date)`
    );
  }

  return structLiterals;
}

/**
 * @param {object} row
 * @param {object} backfill
 * @param {string[]} fieldsToFill Filled only when the row's own value is empty.
 * @param {string[]} [fieldsToOverwrite] Filled even over a non-empty row value. Used for the
 *   parent-DEAL hierarchy on EXTENSION rows: Nexus ships the extension with whatever hierarchy the
 *   candidate's *earlier* contract carried, so fill-if-empty leaves that stale name in place and the
 *   parent DEAL's correct hierarchy never lands (an extension of CHC22062 kept the CHC17277
 *   associate delivery director). The parent DEAL is authoritative for its own contract chain.
 */
function mergeExtensionBackfillFields(row, backfill, fieldsToFill, fieldsToOverwrite = []) {
  if (!backfill) return { row, changed: false };

  let next = row;
  let changed = false;
  const applyField = (field, allowOverwrite) => {
    if (!allowOverwrite && !isEmptyDateFieldValue(next[field])) return;
    const value = backfill[field];
    if (value == null || (typeof value === "string" && value.trim() === "")) return;
    if (isSameExtensionBackfillValue(next[field], value)) return;
    if (!changed) {
      next = { ...row };
      changed = true;
    }
    next[field] = value;
  };

  for (const field of fieldsToFill) applyField(field, false);
  for (const field of fieldsToOverwrite) applyField(field, true);
  return { row: next, changed };
}

/** True when an inherit value would be a no-op against what the row already holds. */
function isSameExtensionBackfillValue(current, incoming) {
  if (current == null || incoming == null) return false;
  const a = typeof current === "string" ? current.trim() : current;
  const b = typeof incoming === "string" ? incoming.trim() : incoming;
  return String(a) === String(b);
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
 * match key as fetchContractIdsForExtensions). INITIAL_START_DATE uses
 * COALESCE(parent.INITIAL_START_DATE, parent.START_DATE).
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
  // EXTENSION_PARENT_DEAL_INHERIT_COLUMNS) plus LAST_UPDATED for the latest-append tiebreaker;
  // the base union column set does not include them.
  // Canada dropped three of these columns, so the list is resolved per table before it reaches the
  // SQL (see PARENT_DEAL_INHERIT_MISSING_COLUMNS_BY_TABLE). Health/locums get the full list.
  const inheritColumns = resolveExtensionParentDealInheritColumns(tableId);
  const unionSql = buildActiveDealSheetsUnionSql(
    datasetId,
    tableId || undefined,
    [...inheritColumns, "LAST_UPDATED"]
  );

  const parentDealSelectColumns = inheritColumns
    .map((col) => `          ${col}`)
    .join(",\n");
  const parentDealJoinedSelect = inheritColumns
    .map((col) => `          d.${col}`)
    .join(",\n");
  const parentDealOuterSelect = inheritColumns
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
          CANDIDATE_ID,
          ${SQL_CANDIDATE_EMAIL_NORM} AS candidate_email_norm,
          ${SQL_PHONE_NUMBER_NORM} AS phone_norm,
          CLIENT_ID,
          START_DATE,
          LAST_UPDATED,
          PLACEMENT_ID,
          COALESCE(INITIAL_START_DATE, START_DATE) AS proposed_original_start_date,
${parentDealSelectColumns}
        FROM (${unionSql})
        WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      ),
      joined AS (
        SELECT
          ext.placement_id,
          d.proposed_original_start_date,
${parentDealJoinedSelect},
          -- LATEST qualifying DEAL, not the earliest. The 4-field identity cannot tell one contract
          -- from another (CLIENT_ID is identical across a candidate's successive contracts at the
          -- same client), so the extension's own START_DATE is what separates them: the parent is
          -- the most recent DEAL that had already begun. Earliest-wins handed a Feb-02 contract's
          -- identity to an extension of the Aug-04 contract that replaced it.
          ROW_NUMBER() OVER (
            PARTITION BY ext.placement_id
            ORDER BY d.START_DATE DESC NULLS LAST, d.LAST_UPDATED DESC NULLS LAST, d.PLACEMENT_ID DESC NULLS LAST
          ) AS rn
        FROM extensions ext
        INNER JOIN deals d
          ON d.CANDIDATE_ID = ext.candidate_nexus_id
         AND d.candidate_email_norm = ext.candidate_email
         AND d.phone_norm = ext.phone_number
         AND d.CLIENT_ID = ext.client_id
         -- A DEAL starting AFTER this extension belongs to a LATER contract and must never be its
         -- parent. Without this, an extension inserted before its own contract's DEAL rows landed
         -- picked up a future contract's CONTRACT_ID / SKU_NUMBER / INITIAL_START_DATE, leaving an
         -- INITIAL_START_DATE ahead of the row's own START_DATE — impossible on its face.
         AND (ext.extension_start_date IS NULL OR d.START_DATE IS NULL
              OR d.START_DATE <= ext.extension_start_date)
         -- Only a DEAL that already carries the contract identity can pass it on; an unresolved
         -- parent would otherwise "match" and hand down nulls.
         AND d.CONTRACT_ID IS NOT NULL AND TRIM(d.CONTRACT_ID) != ''
      )
      SELECT
        CAST(placement_id AS STRING) AS placement_id,
        proposed_original_start_date,
${parentDealOuterSelect}
      FROM joined
      WHERE rn = 1
    `;

    const bqRows = await queryObjects(sql, structLiterals.length);
    // Same per-table list the SELECT used, or a column the query never projected reads as undefined.
    const parentFields = ["INITIAL_START_DATE", ...inheritColumns];

    for (const bqRow of bqRows) {
      const pid = bqRow?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;

      const entry = {
        INITIAL_START_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_original_start_date),
      };
      for (const col of inheritColumns) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[col]);
      }
      if (!extensionBackfillEntryHasValues(entry, parentFields)) continue;

      out.set(String(pid).trim(), entry);
    }
  }

  return out;
}

/**
 * Same-table EXTENSION chain inherit: covers the case where a candidate's original placement
 * only ever exists in the legacy run-rate table (never as a DEAL_TYPE='DEAL' row here), but an
 * EARLIER EXTENSION for that same candidate+client identity already sits in our own destination
 * table. Rather than re-deriving from run-rate's stale hierarchy text on every subsequent
 * extension, this treats that existing EXTENSION chain as the source:
 *   - CONTRACT_ID / INITIAL_START_DATE / NEW_HIRE_DATE / SKU_NUMBER: taken from the EARLIEST
 *     (lowest START_DATE) prior EXTENSION row — these describe the original placement and must
 *     never drift extension-to-extension.
 *   - Hierarchy (the DEAL_RECRUITER_HIERARCHY_FIELDS name+EMP_NO pairs) and
 *     EXTENSION_RUNRATE_MANUAL_COLUMNS (sales/credentialing/payment): taken from the LATEST
 *     (highest START_DATE) prior EXTENSION row, copied as-is with no fresh directory lookup, so
 *     hierarchy / ops fields roll forward to whatever the most recent extension already resolved.
 * Matched by the same 4-field identity as fetchExtensionParentDealInheritByPlacementId
 * (CANDIDATE_ID + email + phone + CLIENT_ID) — the incoming row has no CONTRACT_ID yet at
 * this point, so identity is the only usable key, but since every row in a chain was itself
 * linked via this same identity, it lands on the same set of rows CONTRACT_ID would.
 * @param {object[]} rows
 * @param {object} [options]
 * @param {string} [options.tableId]
 * @returns {Promise<Map<string, object>>}
 */
async function fetchExtensionPriorExtensionInheritByPlacementId(rows, options = {}) {
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

  const priorExtensionDateSkuFields = ["CONTRACT_ID", "INITIAL_START_DATE", "NEW_HIRE_DATE", "SKU_NUMBER"];
  // Manual ops columns not already covered by DEAL_RECRUITER_HIERARCHY_FIELDS (SECONDARY_RECRUITER*
  // is in both lists — hierarchy path already selects them).
  const priorManualExtraColumns = EXTENSION_RUNRATE_MANUAL_COLUMNS.filter(
    (col) => !DEAL_RECRUITER_HIERARCHY_FIELDS.includes(col)
  );
  // Filter to columns THIS deal sheet table actually has. Canada has no AVP / AVP_EMP_NO, and
  // DEAL_RECRUITER_HIERARCHY_FIELDS names both — selecting them failed the whole run with
  // "Unrecognized name: AVP". With no tableId the query spans every active table, so only columns
  // common to all of them are safe.
  const priorMissing = resolveDealSheetMissingColumns(tableId);
  const priorLatestFields = [...DEAL_RECRUITER_HIERARCHY_FIELDS, ...priorManualExtraColumns].filter(
    (col) => !priorMissing.has(col)
  );
  const unionSql = buildActiveDealSheetsUnionSql(datasetId, tableId || undefined, [
    ...priorExtensionDateSkuFields,
    ...priorLatestFields,
    "LAST_UPDATED",
  ]);

  const dateSkuSelect = priorExtensionDateSkuFields.map((col) => `          ${col}`).join(",\n");
  const hierarchySelect = priorLatestFields.map((col) => `          ${col}`).join(",\n");
  const dateSkuJoinedSelect = priorExtensionDateSkuFields.map((col) => `          p.${col}`).join(",\n");
  const hierarchyJoinedSelect = priorLatestFields.map((col) => `          p.${col}`).join(",\n");
  const hierarchyOuterSelect = priorLatestFields
    .map((col) => `        hr.${col} AS proposed_${col.toLowerCase()}`)
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
      prior_extensions AS (
        SELECT
          DEAL_SHEET_ID,
          LAST_UPDATED,
          CANDIDATE_ID,
          ${SQL_CANDIDATE_EMAIL_NORM} AS candidate_email_norm,
          ${SQL_PHONE_NUMBER_NORM} AS phone_norm,
          CLIENT_ID,
          START_DATE,
${dateSkuSelect},
${hierarchySelect}
        FROM (${unionSql})
        WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
      ),
      -- Same underlying extension gets re-appended on every update; collapse to its single
      -- most-recent row per DEAL_SHEET_ID first so stale duplicate rows can't multiply the
      -- number of tied candidates below.
      latest_prior_extension AS (
        SELECT * EXCEPT(dedup_rn) FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY DEAL_SHEET_ID
            ORDER BY LAST_UPDATED DESC NULLS LAST
          ) AS dedup_rn
          FROM prior_extensions
        )
        WHERE dedup_rn = 1
      ),
      date_sku_ranked AS (
        SELECT
          ext.placement_id,
${dateSkuJoinedSelect},
          ROW_NUMBER() OVER (
            PARTITION BY ext.placement_id
            ORDER BY p.START_DATE DESC NULLS LAST, p.LAST_UPDATED DESC NULLS LAST
          ) AS rn
        FROM extensions ext
        INNER JOIN latest_prior_extension p
          ON p.CANDIDATE_ID = ext.candidate_nexus_id
         AND p.candidate_email_norm = ext.candidate_email
         AND p.phone_norm = ext.phone_number
         AND p.CLIENT_ID = ext.client_id
         -- Same contract-boundary guard as the parent-DEAL tier: a prior extension that starts after
         -- this one belongs to a later contract. Ranked DESC so the nearest preceding extension of
         -- the SAME contract wins, rather than the oldest extension the identity can reach.
         AND (ext.extension_start_date IS NULL OR p.START_DATE IS NULL
              OR p.START_DATE <= ext.extension_start_date)
         AND p.CONTRACT_ID IS NOT NULL AND TRIM(p.CONTRACT_ID) != ''
      ),
      hierarchy_ranked AS (
        SELECT
          ext.placement_id,
${hierarchyJoinedSelect},
          ROW_NUMBER() OVER (
            PARTITION BY ext.placement_id
            ORDER BY p.START_DATE DESC NULLS LAST, p.LAST_UPDATED DESC NULLS LAST
          ) AS rn
        FROM extensions ext
        INNER JOIN latest_prior_extension p
          ON p.CANDIDATE_ID = ext.candidate_nexus_id
         AND p.candidate_email_norm = ext.candidate_email
         AND p.phone_norm = ext.phone_number
         AND p.CLIENT_ID = ext.client_id
         AND (ext.extension_start_date IS NULL OR p.START_DATE IS NULL
              OR p.START_DATE <= ext.extension_start_date)
      )
      SELECT
        CAST(ds.placement_id AS STRING) AS placement_id,
        ds.CONTRACT_ID AS proposed_contract_id,
        ds.INITIAL_START_DATE AS proposed_original_start_date,
        ds.NEW_HIRE_DATE AS proposed_new_hire_date,
        ds.SKU_NUMBER AS proposed_sku_number,
${hierarchyOuterSelect}
      FROM date_sku_ranked ds
      JOIN hierarchy_ranked hr ON hr.placement_id = ds.placement_id AND hr.rn = 1
      WHERE ds.rn = 1
    `;

    const bqRows = await queryObjects(sql, structLiterals.length);
    const priorExtensionFields = [
      "CONTRACT_ID",
      "INITIAL_START_DATE",
      "NEW_HIRE_DATE",
      "SKU_NUMBER",
      ...priorLatestFields,
    ];

    for (const bqRow of bqRows) {
      const pid = bqRow?.placement_id;
      if (pid == null || String(pid).trim() === "") continue;

      const entry = {
        CONTRACT_ID: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_contract_id),
        INITIAL_START_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_original_start_date),
        NEW_HIRE_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_new_hire_date),
        SKU_NUMBER: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_sku_number),
      };
      for (const col of priorLatestFields) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[`proposed_${col.toLowerCase()}`]);
      }
      if (!extensionBackfillEntryHasValues(entry, priorExtensionFields)) continue;

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
 * used to find "this candidate's prior stint at this same client".
 *
 * CONTRACT_ID comes from the matched run-rate row, exactly like SKU_NUMBER (Aug 2026). Both
 * identify the original contract chain, so an EXTENSION of a run-rate-only placement inherits the
 * pair together. The run-rate CONTRACT_ID is sparsely populated, so a null just means "no id to
 * inherit" — the row stays null and picks one up later if a parent DEAL lands. Nothing here ever
 * mints an id; that happens for DEAL_TYPE='DEAL' rows only (see contractIdResolver.js).
 * @param {object[]} rows - enriched rows eligible per rowNeedsExtensionInsertBackfill
 * @param {object} [options]
 * @param {string} [options.tableId] - destination deal sheet table, used to pick the domain's run-rate table
 * @returns {Promise<Map<string, object>>} PLACEMENT_ID string -> { CONTRACT_ID, INITIAL_START_DATE, NEW_HIRE_DATE, SKU_NUMBER, ...hierarchy }
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
  const runrateHierarchyColumns = resolveExtensionRunrateHierarchyColumns(runrateTableId);

  // Pull each hierarchy name AND its *_EMP_NO straight from the run-rate table (both columns exist
  // there now); no directory-by-name emp-no lookup anymore. Columns this specific run-rate table
  // doesn't have (see RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE) are left out of the SELECT — the
  // caller still gets an entry for them below, just with a null value, same as no match at all.
  // EXTENSION_RUNRATE_MANUAL_COLUMNS (sales/credentialing/payment/SECONDARY_RECRUITER) are selected
  // the same way — fill-if-empty on the JS merge side.
  const runrateHierarchyAndEmpNoColumns = runrateHierarchyColumns.flatMap((col) => [
    col,
    `${col}_EMP_NO`,
  ]);
  // Use the per-table manual list, NOT the raw one: the canada run-rate table has no
  // FIFTYTWO_TENURE_* / CLIENT_NAME_IN_CONREP columns, and naming them failed the whole run with
  // "Unrecognized name: FIFTYTWO_TENURE_RTO_LASTDATE". legacyDealManualColumns() also adds the
  // columns only canada has (averaging agreements, DT rates), which this SELECT should pick up too.
  const runrateSelectColumns = [
    ...runrateHierarchyAndEmpNoColumns,
    ...legacyDealManualColumns(runrateTableId),
  ];
  // Dedupe SECONDARY_RECRUITER* if it ever appears in both lists (it doesn't today for hierarchy).
  const runrateSelectColumnsUnique = [...new Set(runrateSelectColumns)];
  const runrateSelectHierarchy = runrateSelectColumnsUnique
    .map((col) => `      ${col} AS ${runrateAliasForColumn(col)}`)
    .join(",\n");
  const bestMatchHierarchySelect = runrateSelectColumnsUnique
    .map((col) => `        b.${runrateAliasForColumn(col)} AS ${proposedAliasForColumn(col)}`)
    .join(",\n");

  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const structLiterals = [];

    for (const row of chunk) {
      const pid = Number(row.PLACEMENT_ID);
      const cand = Number(row.CANDIDATE_ID);
      if (!Number.isFinite(pid) || !Number.isFinite(cand)) continue;

      const email = escapeSqlString(
        row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase()
      );
      const parentClient = escapeSqlString(
        row.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim()
      );
      const facility = escapeSqlString(
        row.FACILITY_NAME == null ? "" : String(row.FACILITY_NAME).trim()
      );
      // Nexus client ids for the id-first tiers below; "" falls back to the name comparison.
      const facilityId = escapeSqlString(normalizeClientIdKeyPart(row.CLIENT_ID));
      const parentClientId = escapeSqlString(
        normalizeClientIdKeyPart(row.NEXUS_PARENT_CLIENT_ID)
      );
      const vmsJobId = escapeSqlString(
        row.VMS_JOB_ID == null ? "" : String(row.VMS_JOB_ID).trim()
      );
      const startDateSql = (() => {
        const d = formatDateOnlyForSql(row.START_DATE);
        return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
      })();
      const tentativeDateSql = (() => {
        const d = formatDateOnlyForSql(row.TENTATIVE_END_DATE);
        return d == null ? "CAST(NULL AS DATE)" : `DATE '${escapeSqlString(d)}'`;
      })();

      structLiterals.push(
        `STRUCT(${Math.trunc(pid)} AS placement_id, ${Math.trunc(cand)} AS candidate_nexus_id, `
        + `'${email}' AS candidate_email, '${parentClient}' AS deal_parent_client, `
        + `'${facility}' AS deal_facility, ${startDateSql} AS extension_start_date, `
        + `${tentativeDateSql} AS extension_tentative_date, '${vmsJobId}' AS deal_vms_job_id, `
        + `'${facilityId}' AS deal_facility_id, '${parentClientId}' AS deal_parent_client_id)`
      );
    }

    if (structLiterals.length === 0) continue;

    const placementStatusPredicate = buildRunrateEligiblePlacementStatusSqlPredicate();

    // Ported from the analyst-authored matching query: same tiered match priority, same
    // client_first_assignment/sku_first_assignment fallback chain for INITIAL_START_DATE
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
          CANDIDATE_ID AS nexus_id,
          LOWER(TRIM(CANDIDATE_EMAIL)) AS email,
          TRIM(CAST(VMS_JOB_ID AS STRING)) AS vms_job_id,
          PARENT_CLIENT_NAME AS runrate_parent_client,
          FACILITY_NAME AS runrate_facility,
          CLIENT_ID AS runrate_client_id,
          NEXUS_PARENT_CLIENT_ID AS runrate_parent_client_id,
          START_DATE AS runrate_start_date,
          TENTATIVE_END_DATE AS runrate_tentative_date,
          SKU_NUMBER AS runrate_sku,
          CONTRACT_ID AS runrate_contract_id,
          NEW_HIRE_DATE AS runrate_new_hire_date,
${runrateSelectHierarchy}
        FROM ${runrateFqn}
        WHERE START_DATE < DATE '2026-05-01'
          AND ${placementStatusPredicate}
      ),
      -- Keyed on the parent client id where the run-rate row has one, falling back to the lowered
      -- name otherwise, so this "candidate's first assignment at this client" fallback groups the
      -- same way the match tiers above do. The join below builds its probe key identically.
      client_first_assignment AS (
        SELECT
          CANDIDATE_ID,
          COALESCE(
            CAST(NEXUS_PARENT_CLIENT_ID AS STRING),
            LOWER(TRIM(PARENT_CLIENT_NAME))
          ) AS parent_client_key,
          START_DATE AS client_original_start_date,
          NEW_HIRE_DATE AS client_new_hire_date,
          ROW_NUMBER() OVER (
            PARTITION BY CANDIDATE_ID, COALESCE(
              CAST(NEXUS_PARENT_CLIENT_ID AS STRING),
              LOWER(TRIM(PARENT_CLIENT_NAME))
            )
            ORDER BY START_DATE ASC, PLACEMENT_ID ASC, ID
          ) AS rn
        FROM ${runrateFqn}
        WHERE CANDIDATE_ID IS NOT NULL
          AND (
            NEXUS_PARENT_CLIENT_ID IS NOT NULL
            OR TRIM(IFNULL(PARENT_CLIENT_NAME, '')) != ''
          )
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
            -- Id-based client tiers come FIRST: CLIENT_ID / NEXUS_PARENT_CLIENT_ID are exact where
            -- the names are not (the same facility is spelled differently across the two tables).
            -- Each id tier is immediately followed by its name-based twin, so a row whose ids are
            -- missing on either side still resolves exactly as it did before.
            WHEN e.candidate_nexus_id = r.nexus_id
             AND NULLIF(e.deal_parent_client_id, '') IS NOT NULL
             AND r.runrate_parent_client_id IS NOT NULL
             AND CAST(r.runrate_parent_client_id AS STRING) = e.deal_parent_client_id
             AND NULLIF(e.deal_facility_id, '') IS NOT NULL
             AND r.runrate_client_id IS NOT NULL
             AND CAST(r.runrate_client_id AS STRING) = e.deal_facility_id
             AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
              THEN 'NEXUS_PARENT_FACILITY_ID'
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
             AND NULLIF(e.deal_parent_client_id, '') IS NOT NULL
             AND r.runrate_parent_client_id IS NOT NULL
             AND CAST(r.runrate_parent_client_id AS STRING) = e.deal_parent_client_id
             AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
              THEN 'NEXUS_PARENT_CLIENT_ID'
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
            WHEN 'NEXUS_PARENT_FACILITY_ID' THEN 2
            WHEN 'NEXUS_PARENT_FACILITY' THEN 3
            WHEN 'NEXUS_PARENT_CLIENT_ID' THEN 4
            WHEN 'NEXUS_PARENT_CLIENT' THEN 5
            WHEN 'EMAIL_VMS_JOB_ID' THEN 6
            WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 7
            ELSE 99
          END AS match_priority,
          ROW_NUMBER() OVER (
            PARTITION BY j.placement_id
            ORDER BY
              CASE j.match_method
                WHEN 'EXACT_NEXUS_TENTATIVE' THEN 1
                WHEN 'NEXUS_PARENT_FACILITY_ID' THEN 2
                WHEN 'NEXUS_PARENT_FACILITY' THEN 3
                WHEN 'NEXUS_PARENT_CLIENT_ID' THEN 4
                WHEN 'NEXUS_PARENT_CLIENT' THEN 5
                WHEN 'EMAIL_VMS_JOB_ID' THEN 6
                WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 7
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
        -- Prefer the SKU-based origin over the parent-client-based one. SKU_NUMBER (from the MATCHED
        -- parent b) identifies the specific contract chain, whereas the parent-client-only key is too
        -- broad: a candidate can have SEPARATE engagements at the same client years apart (e.g. an
        -- old 2022 assignment + a new 2026 one), and client-first wrongly reaches back to the oldest,
        -- putting a stale 2022 INITIAL_START_DATE / NEW_HIRE_DATE on a 2026 extension.
        COALESCE(s.sku_original_start_date, c.client_original_start_date) AS proposed_original_start_date,
        COALESCE(s.sku_new_hire_date, c.client_new_hire_date, b.runrate_new_hire_date) AS proposed_new_hire_date,
        b.runrate_sku AS proposed_sku_number,
        -- Same source and same matched row as the SKU above: both identify the original contract
        -- chain, so they are inherited together. Sparsely populated in run-rate, so this is often
        -- null — which simply means there is no id to inherit yet.
        b.runrate_contract_id AS proposed_contract_id,
${bestMatchHierarchySelect}
      FROM extensions e
      JOIN best_match b ON e.placement_id = b.placement_id
      LEFT JOIN client_first_assignment c
        ON e.candidate_nexus_id = c.CANDIDATE_ID
       AND COALESCE(
             NULLIF(e.deal_parent_client_id, ''),
             LOWER(TRIM(IFNULL(e.deal_parent_client, '')))
           ) = c.parent_client_key
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
        INITIAL_START_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_original_start_date),
        NEW_HIRE_DATE: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_new_hire_date),
        SKU_NUMBER: normalizeExtensionRunrateBackfillValue(bqRow?.proposed_sku_number),
        CONTRACT_ID: normalizeContractIdOrNull(
          normalizeExtensionRunrateBackfillValue(bqRow?.proposed_contract_id)
        ),
      };
      // Both loops must read exactly what the SELECT above projected for THIS run-rate table —
      // a column the query never selected is always undefined on the result row.
      for (const col of runrateHierarchyColumns) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[proposedAliasForColumn(col)]);
        entry[`${col}_EMP_NO`] = normalizeExtensionRunrateBackfillValue(
          bqRow?.[proposedAliasForColumn(`${col}_EMP_NO`)]
        );
      }
      for (const col of legacyDealManualColumns(runrateTableId)) {
        entry[col] = normalizeExtensionRunrateBackfillValue(bqRow?.[proposedAliasForColumn(col)]);
      }
      out.set(key, entry);
    }
  }

  return out;
}

/**
 * Resolve CONTRACT_ID for EXTENSION rows that matched in the run-rate table but still have no
 * CONTRACT_ID. The run-rate table's own CONTRACT_ID column is always null, so it can't be copied
 * (see fetchExtensionRunrateBackfillByPlacementId).
 *
 * REUSE ONLY — a CONTRACT_ID is minted exclusively for DEAL_TYPE='DEAL' rows (Aug 2026). This looks
 * for an id already on ANY prior row (DEAL or EXTENSION) for the same candidate+client identity in
 * the destination table (fetchContractIdsForExtensions with includeExtensionSource: true), which
 * keeps repeat extensions of the same run-rate-only placement on one CONTRACT_ID. When nothing
 * matches, the row is left with CONTRACT_ID = null rather than getting a fresh id: an EXTENSION with
 * no originating DEAL has no contract of its own to identify, and minting one here used to create
 * standalone ids that no DEAL row ever shared. Such a row picks up its id later — as soon as the
 * parent DEAL lands in the table and applyExtensionInheritForInsertRows can inherit from it.
 *
 * This mirrors how SKU_NUMBER works: inherited down a contract chain, never generated for an
 * EXTENSION.
 * @param {object[]} rows - eligible rows that had a run-rate match
 * @param {object} [options]
 * @param {string} [options.tableId] - destination deal sheet table
 * @param {object} [deps]
 * @param {typeof fetchContractIdsForExtensions} [deps.fetchContractIdsForExtensionsFn]
 * @returns {Promise<Map<string, string>>} PLACEMENT_ID string -> CONTRACT_ID
 */
async function resolveContractIdsForRunrateMatchedExtensions(rows, options = {}, deps = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  const fetchContractIdsForExtensionsFn = deps.fetchContractIdsForExtensionsFn ?? fetchContractIdsForExtensions;

  const tableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : "";

  const lookupInput = [];
  for (const row of rows) {
    const pid = Number(row.PLACEMENT_ID);
    const cand = Number(row.CANDIDATE_ID);
    const client = Number(row.CLIENT_ID);
    if (!Number.isFinite(pid) || !Number.isFinite(cand) || !Number.isFinite(client)) continue;
    lookupInput.push({
      placementId: pid,
      candidateNexusId: cand,
      candidateEmail: row.CANDIDATE_EMAIL,
      phoneNumber: row.CELL_PHONE,
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

  const unresolvedCount = rows.length - out.size;
  logDetail(
    `[enriched sync] [BigQuery insertAll] EXTENSION runrate CONTRACT_ID resolution (reuse-only): reused=${reusedCount} unresolved=${unresolvedCount}`
  );

  return out;
}

/**
 * Insert-time backfill for brand-new EXTENSION rows:
 *   1. Earliest parent DEAL row in the destination deal sheet (dates, hierarchy, *_EMP_NO)
 *   2. Same-table prior EXTENSION chain for the same candidate+client identity (when no DEAL
 *      row exists) — CONTRACT_ID/INITIAL_START_DATE/NEW_HIRE_DATE/SKU_NUMBER from the earliest
 *      prior extension, hierarchy name+EMP_NO pairs copied as-is from the latest prior extension
 *   3. Run-rate table fallback for any still-empty fields (only reached when neither a DEAL nor
 *      a prior EXTENSION exists for this candidate+client identity) — CONTRACT_ID comes from the
 *      matched run-rate row alongside SKU_NUMBER, both describing the same original contract chain
 *   4. Last resort for a row still lacking an id: reuse one from any prior row of the same
 *      candidate+client identity already in the destination table
 * Fills only empty fields — never overwrites existing values. No step here mints a CONTRACT_ID;
 * allocation is for DEAL_TYPE='DEAL' rows only (contractIdResolver.js).
 * @param {object[]} rows
 * @param {object} [options]
 * @param {object} [deps]
 * @param {typeof fetchExtensionParentDealInheritByPlacementId} [deps.parentFetchFn]
 * @param {typeof fetchExtensionPriorExtensionInheritByPlacementId} [deps.priorExtensionFetchFn]
 * @param {typeof fetchExtensionRunrateBackfillByPlacementId} [deps.runrateFetchFn]
 * @param {typeof fetchExtensionRunrateBackfillByPlacementId} [deps.fetchFn]
 * @param {typeof resolveContractIdsForRunrateMatchedExtensions} [deps.resolveContractIdsFn]
 */
async function applyExtensionInheritForInsertRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;

  const eligible = rows.filter(rowNeedsExtensionInsertBackfill);
  if (eligible.length === 0) return rows;

  const parentFetchFn = deps.parentFetchFn ?? fetchExtensionParentDealInheritByPlacementId;
  const priorExtensionFetchFn =
    deps.priorExtensionFetchFn ?? fetchExtensionPriorExtensionInheritByPlacementId;
  const runrateFetchFn = deps.runrateFetchFn ?? deps.fetchFn ?? fetchExtensionRunrateBackfillByPlacementId;
  const resolveContractIdsFn = deps.resolveContractIdsFn ?? resolveContractIdsForRunrateMatchedExtensions;

  const parentByPlacementId = await parentFetchFn(eligible, options);
  const priorExtensionByPlacementId = await priorExtensionFetchFn(eligible, options);
  const runrateByPlacementId = await runrateFetchFn(eligible, options);

  const matchedRunrateRows = eligible.filter((row) =>
    runrateByPlacementId.has(String(row.PLACEMENT_ID).trim())
  );
  const contractIdByPlacementId =
    matchedRunrateRows.length > 0
      ? await resolveContractIdsFn(matchedRunrateRows, options, deps)
      : new Map();

  // Hierarchy the parent DEAL owns outright: overwrite it on the extension rather than filling only
  // when empty, so a stale name carried over from the candidate's previous contract cannot survive.
  // Restricted to fields the parent-DEAL query actually selects; everything else stays fill-if-empty.
  // Must match the list fetchExtensionParentDealInheritByPlacementId actually selected for this
  // table — Canada drops three of them, and a column the query never projected is always undefined.
  const parentInheritColumns = resolveExtensionParentDealInheritColumns(options?.tableId);
  const parentMissingColumns = resolveDealSheetMissingColumns(options?.tableId);
  const parentHierarchyOverwriteFields = DEAL_RECRUITER_HIERARCHY_FIELDS.filter((col) =>
    parentInheritColumns.includes(col)
  );
  const parentFields = ["INITIAL_START_DATE", ...parentInheritColumns].filter(
    (col) => !parentHierarchyOverwriteFields.includes(col)
  );
  const priorManualExtraColumns = EXTENSION_RUNRATE_MANUAL_COLUMNS.filter(
    (col) => !DEAL_RECRUITER_HIERARCHY_FIELDS.includes(col)
  );
  // Must match what fetchExtensionPriorExtensionInheritByPlacementId actually selected for this
  // table — a column the query never projected is always undefined on the result row.
  const priorExtensionFields = [
    "CONTRACT_ID",
    "INITIAL_START_DATE",
    "NEW_HIRE_DATE",
    "SKU_NUMBER",
    ...DEAL_RECRUITER_HIERARCHY_FIELDS,
    ...priorManualExtraColumns,
  ].filter((col) => !parentMissingColumns.has(col));
  const runrateFields = [
    // CONTRACT_ID rides along with SKU_NUMBER: same matched run-rate row, same contract chain.
    // Fill-if-empty like every other field here, so a parent DEAL's id already on the row wins.
    "CONTRACT_ID",
    "INITIAL_START_DATE",
    "NEW_HIRE_DATE",
    "SKU_NUMBER",
    ...EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
    ...EXTENSION_RUNRATE_HIERARCHY_COLUMNS.map((col) => `${col}_EMP_NO`),
    ...EXTENSION_RUNRATE_MANUAL_COLUMNS,
  ];

  const eligibleSet = new Set(eligible.map((row) => String(row.PLACEMENT_ID).trim()));
  let parentBackfilledCount = 0;
  let priorExtensionBackfilledCount = 0;
  let runrateBackfilledCount = 0;
  let skuClearedCount = 0;
  let selfReferenceVacatedCount = 0;
  let duplicatePersonVacatedCount = 0;

  const out = rows.map((row) => {
    const key = String(row.PLACEMENT_ID).trim();
    if (!eligibleSet.has(key)) return row;

    let current = row;
    let rowChanged = false;

    const parentMerged = mergeExtensionBackfillFields(
      current,
      parentByPlacementId.get(key),
      parentFields,
      parentHierarchyOverwriteFields
    );
    if (parentMerged.changed) {
      current = parentMerged.row;
      rowChanged = true;
      parentBackfilledCount++;
    }

    const priorExtensionMerged = mergeExtensionBackfillFields(
      current,
      priorExtensionByPlacementId.get(key),
      priorExtensionFields
    );
    if (priorExtensionMerged.changed) {
      current = priorExtensionMerged.row;
      rowChanged = true;
      priorExtensionBackfilledCount++;
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

    // A DID NOT START / DID NOT ACCEPT extension never became a working assignment, so it must not
    // carry a SKU_NUMBER — undo whatever the three inherit sources above filled in. Applied after the
    // merges rather than inside each one because all three (parent DEAL, prior EXTENSION, run-rate)
    // can supply it. CONTRACT_ID is deliberately left alone: that identifies the contract chain the
    // row belongs to, which is still true for a placement that fell through.
    if (!skuAllowedForPlacementStatus(current.PLACEMENT_STATUS) && !isEmptyDateFieldValue(current.SKU_NUMBER)) {
      const inheritedSku = isEmptyDateFieldValue(row.SKU_NUMBER);
      if (inheritedSku) {
        current = { ...current, SKU_NUMBER: null };
        rowChanged = true;
        skuClearedCount++;
      }
    }

    // One person cannot hold two roles on one placement. Applied after all three inherit tiers for
    // the same reason the SKU clearing above is: any of them can introduce the collision.
    //
    // How it happens: the recruiter gets promoted into the slot that used to be their own manager's.
    // The parent DEAL rows still record the pre-promotion truth, and hierarchy is OVERWRITTEN from
    // the parent (not fill-if-empty), so the extension inherits the recruiter's own name into a
    // manager column — live example (CANDIDATE_ID 30947933, Aug 2026): Srijana Chhetri was ATL over
    // recruiter Yuvraj Gupta on placements 1445680 / 1452652, then took over as recruiter on
    // extension 1465994 and inherited ATL='Srijana Chhetri' from those parents, becoming her own ATL.
    // Run-rate and the prior extension both carried the correct 'NA' but are fill-if-empty, so
    // neither could correct it.
    const vacated = vacateSelfReferencedHierarchyRoles(current);
    if (vacated.changed) {
      current = vacated.row;
      rowChanged = true;
      selfReferenceVacatedCount += vacated.vacatedColumns.length;
    }

    // Same reason, one step further: the collision above is the recruiter appearing as their own
    // manager, this one is any ONE person appearing in TWO manager columns because the inherit tiers
    // disagree about their designation (promoted since the older source was written).
    const deduped = vacateDuplicatePersonHierarchyRoles(current);
    if (deduped.changed) {
      current = deduped.row;
      rowChanged = true;
      duplicatePersonVacatedCount += deduped.vacatedColumns.length;
    }

    return rowChanged ? current : row;
  });

  if (parentByPlacementId.size > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION parent-deal inherit: eligible=${eligible.length} matched=${parentByPlacementId.size} backfilled=${parentBackfilledCount}`
    );
  }
  if (priorExtensionByPlacementId.size > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION prior-extension inherit: eligible=${eligible.length} matched=${priorExtensionByPlacementId.size} backfilled=${priorExtensionBackfilledCount}`
    );
  }
  if (runrateByPlacementId.size > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION runrate backfill: eligible=${eligible.length} matched=${runrateByPlacementId.size} backfilled=${runrateBackfilledCount}`
    );
  }
  if (skuClearedCount > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION SKU_NUMBER cleared on DID NOT START / DID NOT ACCEPT: ${skuClearedCount}`
    );
  }
  if (selfReferenceVacatedCount > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION hierarchy roles vacated to NA (held by the row's own recruiter): ${selfReferenceVacatedCount}`
    );
  }
  if (duplicatePersonVacatedCount > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] EXTENSION hierarchy roles vacated to NA (same person in a more senior column): ${duplicatePersonVacatedCount}`
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

/** The placeholder the business uses for a hierarchy role nobody holds. */
const HIERARCHY_ROLE_VACANT = "NA";

/**
 * Recruiter name as a comparison key. The deal sheet stores ASSIGNMENT_RECRUITER with a cluster-code
 * suffix ("Srijana Chhetri (R1N)") while the manager columns hold the bare name ("Srijana Chhetri"),
 * so the suffix has to come off before the two can be compared.
 */
function normalizeHierarchyPersonName(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
}

/** Emp-no as a comparison key; "" when absent. */
function normalizeHierarchyEmpNo(value) {
  if (value == null) return "";
  return String(value).trim().toUpperCase();
}

/**
 * Set to NA any hierarchy role held by the row's own ASSIGNMENT_RECRUITER.
 *
 * A placement's recruiter cannot also be their own manager: one person, one role per placement. When
 * a recruiter is promoted into the slot their manager used to hold, inherited hierarchy can put their
 * name in both places (see the caller for the live case). The role is vacated to NA — the same
 * placeholder the business uses elsewhere — rather than nulled, so it reads as "nobody holds this"
 * instead of "not yet resolved", and the emp-no companion is cleared with it.
 *
 * Matching prefers RECRUITER_EMP_NO over the name: emp numbers are exact, whereas the name columns
 * differ in formatting (see normalizeHierarchyPersonName). ASSIGNMENT_RECRUITER itself is never
 * touched — the Nexus assignment is the authority on who the recruiter is.
 *
 * @returns {{row: object, changed: boolean, vacatedColumns: string[]}}
 */
function vacateSelfReferencedHierarchyRoles(row) {
  const vacatedColumns = [];
  if (!row || typeof row !== "object") return { row, changed: false, vacatedColumns };

  const recruiterEmpNo = normalizeHierarchyEmpNo(row.RECRUITER_EMP_NO);
  const recruiterName = normalizeHierarchyPersonName(row.ASSIGNMENT_RECRUITER);
  if (recruiterEmpNo === "" && recruiterName === "") {
    return { row, changed: false, vacatedColumns };
  }

  let next = row;
  for (const { column, empNoColumn } of DEAL_RECRUITER_HIERARCHY_TARGETS) {
    const heldName = normalizeHierarchyPersonName(next[column]);
    if (heldName === "" || heldName === HIERARCHY_ROLE_VACANT.toLowerCase()) continue;

    const heldEmpNo = normalizeHierarchyEmpNo(next[empNoColumn]);
    // Emp-no is the reliable signal; fall back to the name only when one side has no emp-no, so two
    // different people who share a name are not merged on the strength of the name alone.
    const isSelf =
      recruiterEmpNo !== "" && heldEmpNo !== ""
        ? heldEmpNo === recruiterEmpNo
        : recruiterName !== "" && heldName === recruiterName;
    if (!isSelf) continue;

    if (next === row) next = { ...row };
    next[column] = HIERARCHY_ROLE_VACANT;
    next[empNoColumn] = null;
    vacatedColumns.push(column);
  }

  return { row: next, changed: vacatedColumns.length > 0, vacatedColumns };
}

/**
 * Hierarchy columns ordered least -> most senior, for deciding which of two seats held by one
 * person is the real one. NOT the same order as DEAL_RECRUITER_HIERARCHY_TARGETS, which groups
 * related columns rather than ranking them (it lists ASSOCIATE_DELIVERY_DIRECTOR after
 * DELIVERY_DIRECTOR, and SECONDARY_RECRUITER after ATL).
 */
const HIERARCHY_COLUMN_SENIORITY_ORDER = Object.freeze([
  "SECONDARY_RECRUITER",
  "ATL",
  "TEAM_LEAD",
  "RM",
  "ASSOCIATE_AM",
  "SECONDARY_AM",
  "ACCOUNT_MANAGER",
  "ASSOCIATE_DELIVERY_DIRECTOR",
  "DELIVERY_DIRECTOR",
  "AVP",
  "VP",
]);
const HIERARCHY_COLUMN_SENIORITY_RANK = new Map(
  HIERARCHY_COLUMN_SENIORITY_ORDER.map((col, index) => [col, index])
);

/** Seniority rank of a hierarchy column; -1 for anything unranked (never wins a tie). */
function hierarchySeniorityRank(column) {
  const rank = HIERARCHY_COLUMN_SENIORITY_RANK.get(column);
  return rank == null ? -1 : rank;
}

/**
 * Set to NA every DUPLICATE hierarchy field held by the same person (matched on emp-no), keeping
 * only their most senior seat.
 *
 * One person, one designation per placement. The insert-time inherit tiers can each supply a
 * hierarchy field independently, and they disagree whenever somebody was promoted between when the
 * older source was written and now: the run-rate row still records the pre-promotion designation
 * while the live directory already has the new one, so the same emp-no lands in BOTH columns.
 *
 * Live example (placement 1466750, Aug 2026): Mohit Arora was promoted from Associate Delivery
 * Director to Delivery Director. Run-rate supplied ASSOCIATE_DELIVERY_DIRECTOR='Mohit Arora' and
 * the directory supplied DELIVERY_DIRECTOR='Mohit Arora', so the row went in holding one person in
 * two designations. The scheduled MOVE reconciliation (computeRecruiterHierarchyRoleChanges) later
 * vacated the stale one, but only hours after the row was already visible — this applies the same
 * rule at insert time so the row is never stored wrong in the first place.
 *
 * Seniority (HIERARCHY_COLUMN_SENIORITY_RANK) decides which seat is kept, matching what the MOVE
 * reconciliation converges on: the promotion is the newer truth, so the higher role wins and the
 * stale lower one is vacated.
 *
 * Emp-no only, deliberately: two different people can share a name, and vacating a real manager's
 * seat is worse than leaving a duplicate for the scheduled scan to clean up. Rows whose emp-no is
 * missing on one side are left alone.
 */
function vacateDuplicatePersonHierarchyRoles(row) {
  const vacatedColumns = [];
  if (!row || typeof row !== "object") return { row, changed: false, vacatedColumns };

  // emp-no -> the most senior target this person currently occupies.
  const mostSeniorByEmpNo = new Map();
  for (const target of DEAL_RECRUITER_HIERARCHY_TARGETS) {
    const heldName = normalizeHierarchyPersonName(row[target.column]);
    if (heldName === "" || heldName === HIERARCHY_ROLE_VACANT.toLowerCase()) continue;
    const empNo = normalizeHierarchyEmpNo(row[target.empNoColumn]);
    if (empNo === "" || empNo === HIERARCHY_ROLE_VACANT) continue;
    const incumbent = mostSeniorByEmpNo.get(empNo);
    if (
      incumbent == null ||
      hierarchySeniorityRank(target.column) > hierarchySeniorityRank(incumbent)
    ) {
      mostSeniorByEmpNo.set(empNo, target.column);
    }
  }

  let next = row;
  for (const target of DEAL_RECRUITER_HIERARCHY_TARGETS) {
    const empNo = normalizeHierarchyEmpNo(row[target.empNoColumn]);
    if (empNo === "" || empNo === HIERARCHY_ROLE_VACANT) continue;
    const keeper = mostSeniorByEmpNo.get(empNo);
    if (keeper == null || keeper === target.column) continue;

    if (next === row) next = { ...row };
    next[target.column] = HIERARCHY_ROLE_VACANT;
    next[target.empNoColumn] = null;
    vacatedColumns.push(target.column);
  }

  return { row: next, changed: vacatedColumns.length > 0, vacatedColumns };
}

/**
 * True for brand-new DEAL rows eligible for insert-time recruiter-hierarchy backfill from the
 * employee directory. Mirrors rowNeedsExtensionInsertBackfill's shape for the DEAL side.
 */
function rowNeedsDealRecruiterHierarchyBackfill(row) {
  if (!row || typeof row !== "object") return false;
  // Update-appends carry hierarchy forward verbatim (frozen at first insert); never re-derive,
  // or a MOVE-vacated field would be re-filled from the hire-date snapshot.
  if (row.__CARRIED_FORWARD_UPDATE === true) return false;
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
  // BigQuery timestamp/datetime columns come back as { value: "..." } wrapper objects. On an
  // update-append NEW_HIRE_DATE is carried from the baseline (a wrapper), and `new Date(wrapper)` is
  // Invalid → this used to emit CAST(NULL) → null anchor → the hierarchy/CSM lookup fell back to the
  // EARLIEST snapshot (months-old, e.g. a since-departed manager) instead of the hire-date snapshot.
  const raw = value && typeof value === "object" && !(value instanceof Date) && "value" in value ? value.value : value;
  if (raw == null || raw === "") return "CAST(NULL AS TIMESTAMP)";
  const d = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(d.getTime())) return "CAST(NULL AS TIMESTAMP)";
  return `TIMESTAMP '${escapeSqlString(d.toISOString())}'`;
}

/**
 * Shared hierarchy resolver: for each {key, externalId, anchorDate} target, returns the employee's
 * manager chain (one row per hierarchy_level) picking, PER LEVEL independently, that level's
 * snapshot nearest the anchor. Per-level (not one shared synced_at) is deliberate: partial syncs
 * mean a given synced_at may only contain some levels (e.g. a 2026-06-05 pull with only level 1),
 * so pinning the whole chain to one synced_at would drop the levels absent from it. Resolving each
 * level on its own nearest snapshot keeps the chain complete.
 * direction "on_or_after" (default): each level's earliest snapshot on/after anchorDate, else (no
 *   anchorDate, or anchorDate after all of that level's snapshots) that level's most recent.
 * direction "on_or_before": each level's latest snapshot on/before anchorDate, else that level's
 *   earliest. (null anchorDate + on_or_before still yields earliest; for the current chain use
 *   on_or_after with a null anchorDate, which yields most recent.)
 * @param {Array<{key: string, externalId: string, anchorDate: *}>} targets
 * @param {object} [options]
 * @param {"on_or_after"|"on_or_before"} [options.direction]
 * @returns {Promise<Map<string, object[]>>} target key -> hierarchy_level rows (rows ordered by
 *   hierarchy_level ascending)
 */
/**
 * SQL predicate mirroring isCsmHierarchyExcludedTitle for a title column: normalized
 * (lower + collapsed whitespace) substring match against CSM_HIERARCHY_EXCLUDED_TITLES. Generated
 * from that same set so the JS and SQL sides can never drift apart.
 * @param {string} titleColumn - column expression holding the manager title
 * @returns {string} boolean SQL expression (FALSE for NULL titles)
 */
function csmExcludedTitleSqlPredicate(titleColumn) {
  // LOWER + collapse-whitespace + TRIM, matching normalizeDesignationTitle exactly.
  const normalized = `LOWER(TRIM(REGEXP_REPLACE(${titleColumn}, r'\\s+', ' ')))`;
  const clauses = [...CSM_HIERARCHY_EXCLUDED_TITLES].map(
    (title) => `${normalized} LIKE '%${escapeSqlString(title)}%'`
  );
  return `COALESCE(${titleColumn} IS NOT NULL AND (${clauses.join(" OR ")}), FALSE)`;
}

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

    // Rank each level's rows independently (PARTITION BY target_key, hierarchy_level) so a level
    // missing from the "best" snapshot of another level is still resolved from its own snapshots.
    const rankOrder = direction === "on_or_before"
      ? `CASE WHEN h.synced_at <= t.anchor_date THEN 0 ELSE 1 END,
              CASE WHEN h.synced_at <= t.anchor_date THEN h.synced_at END DESC,
              h.synced_at ASC`
      : `CASE WHEN h.synced_at >= t.anchor_date THEN 0 ELSE 1 END,
              CASE WHEN h.synced_at >= t.anchor_date THEN h.synced_at END ASC,
              h.synced_at DESC`;

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
      -- Person-level CSM exclusion flag. manager_title is unreliable per-snapshot (the same manager
      -- shows up as "Chief Growth Officer (CGO)", "CGO - Chief Growth Officer", "Permanent", and
      -- NULL across snapshots), so a per-row title test let C-level managers leak into
      -- LEVEL_3_CSM/LEVEL_4_CSM on snapshots where their title was NULL. Scan EVERY snapshot of
      -- each manager across the whole table: once a manager has ever carried an excluded title,
      -- they are excluded on every row, NULL title included.
      manager_exclusions AS (
        SELECT
          manager_employee_id,
          LOGICAL_OR(${csmExcludedTitleSqlPredicate("manager_title")}) AS manager_excluded_ever
        FROM ${hierarchyFqn}
        WHERE manager_employee_id IS NOT NULL
        GROUP BY manager_employee_id
      ),
      ranked AS (
        SELECT
          t.target_key,
          h.hierarchy_level,
          h.manager_name,
          h.manager_employee_id,
          h.manager_title,
          COALESCE(x.manager_excluded_ever, FALSE) AS manager_excluded_ever,
          ROW_NUMBER() OVER (
            PARTITION BY t.target_key, h.hierarchy_level
            ORDER BY ${rankOrder}
          ) AS rn
        FROM targets t
        JOIN hierarchy h ON h.employee_external_id = t.external_id
        LEFT JOIN manager_exclusions x ON x.manager_employee_id = h.manager_employee_id
      )
      SELECT target_key, hierarchy_level, manager_name, manager_employee_id, manager_title,
             manager_excluded_ever
      FROM ranked
      WHERE rn = 1
      ORDER BY target_key, SAFE_CAST(hierarchy_level AS INT64)
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
 * ASSOCIATE_DELIVERY_DIRECTOR, VP, DELIVERY_DIRECTOR, SECONDARY_RECRUITER + their *_EMP_NO
 * companions) for brand-new DEAL rows, from cynetdatabase.MISC.directory_employee_hierarchy.
 *
 * Per recruiter (employee external_id), the hierarchy table holds one full org-chart snapshot
 * (all hierarchy_level rows) per synced_at. The snapshot used is the LATEST one whose synced_at
 * is on/before the row's NEW_HIRE_DATE (the hierarchy as it actually stood on the day this
 * candidate was hired — not a later reorg that happened to sync shortly after); if none qualifies
 * (no NEW_HIRE_DATE, or hire date is before every snapshot), the earliest snapshot available is
 * used instead. Same direction as fetchOnsiteAmCsmHierarchyByKey. Each snapshot's manager_title
 * values are then matched against known designations (see recruiterHierarchyDesignations.js) to
 * pick the column. Any drift after this snapshot (the SAME recruiter's manager chain changing
 * post-hire) is reconciled separately and continuously by fetchRecruiterHierarchyReconciliation
 * (role changes move the regular field; brand-new people go to the inorganic log).
 *
 * @param {object[]} rows - enriched rows eligible per rowNeedsDealRecruiterHierarchyBackfill
 * @param {object} [options]
 * @returns {Promise<Map<string, object>>} PLACEMENT_ID string -> partial row of matched columns
 */
async function fetchDealRecruiterHierarchyByPlacementId(rows, options = {}, deps = {}) {
  const out = new Map();
  if (!rows || rows.length === 0) return out;

  // Hierarchy is resolved from the DEAL-SHEET (current/Assignment) recruiter's chain. (Previously it
  // preferred PREVIOUS_RECRUITER on a submittal handover; that handover path was removed — the
  // deal-sheet recruiter is the owner, so its chain is the hierarchy.)
  const hierarchyEmailForRow = (row) => {
    const cur = row?.ASSIGNMENT_RECRUITER_EMAIL;
    return cur == null ? "" : String(cur).trim().toLowerCase();
  };

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const norm = hierarchyEmailForRow(row);
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  if (emails.length === 0) return out;

  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  const currentRecruiterEmpByKey = new Map();
  for (const row of rows) {
    const pid = row?.PLACEMENT_ID;
    if (pid == null || String(pid).trim() === "") continue;
    const norm = hierarchyEmailForRow(row);
    const externalId = norm ? directoryByEmail.get(norm)?.externalId : null;
    if (!externalId) continue;
    const key = String(pid).trim();
    targets.push({ key, externalId, anchorDate: row?.NEW_HIRE_DATE ?? null });
    const curEmp = normalizeExtensionRunrateBackfillValue(row?.RECRUITER_EMP_NO);
    if (curEmp != null) currentRecruiterEmpByKey.set(key, String(curEmp).trim().toUpperCase());
  }
  if (targets.length === 0) return out;

  // Never forward `options` here: it carries the destination deal-sheet table's datasetId/tableId
  // (from insertEnrichedDealSheetBatch), which would make this query the wrong table entirely —
  // the hierarchy lookup always targets the fixed directory_employee_hierarchy table.
  const levelsByKey = await fetchHierarchyLevelChainsByKey(targets, { direction: "on_or_before" });

  for (const [placementId, levelRows] of levelsByKey) {
    const entry = {};
    const filledColumns = new Set();
    const newRecruiterEmp = currentRecruiterEmpByKey.get(placementId) ?? null;
    for (const levelRow of levelRows) {
      const column = resolveHierarchyColumnForTitle(levelRow?.manager_title);
      if (!column || filledColumns.has(column)) continue;
      const target = DEAL_RECRUITER_HIERARCHY_TARGETS.find((t) => t.column === column);
      if (!target) continue;
      const name = normalizeExtensionRunrateBackfillValue(levelRow?.manager_name);
      const empNo = normalizeExtensionRunrateBackfillValue(levelRow?.manager_employee_id);
      if (name == null && empNo == null) continue;
      filledColumns.add(column);
      // Vacate: this chain came from the PREVIOUS recruiter, and the person sitting here is the
      // NEW recruiter (matched by emp-no) — they can't be both, so their old slot is now "NA".
      const isNowRecruiter =
        newRecruiterEmp != null && empNo != null && String(empNo).trim().toUpperCase() === newRecruiterEmp;
      if (isNowRecruiter) {
        entry[target.column] = "NA";
        entry[target.empNoColumn] = "NA";
      } else {
        entry[target.column] = name;
        entry[target.empNoColumn] = empNo;
      }
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
  let selfReferenceVacatedCount = 0;
  let duplicatePersonVacatedCount = 0;

  const out = rows.map((row) => {
    const key = String(row.PLACEMENT_ID).trim();
    if (!eligibleSet.has(key)) return row;

    const merged = mergeExtensionBackfillFields(
      row,
      hierarchyByPlacementId.get(key),
      DEAL_RECRUITER_HIERARCHY_FIELDS
    );
    if (merged.changed) backfilledCount++;

    // Same one-person-one-role rule the EXTENSION path applies. The directory snapshot is anchored on
    // NEW_HIRE_DATE, so a recruiter promoted since then can still be listed as their own manager in
    // it; that has to be vacated here rather than stored.
    let current = merged.row;
    const vacated = vacateSelfReferencedHierarchyRoles(current);
    if (vacated.changed) {
      current = vacated.row;
      selfReferenceVacatedCount += vacated.vacatedColumns.length;
    }

    // One person in two manager columns — see vacateDuplicatePersonHierarchyRoles. The directory
    // chain alone can produce this when a stale hierarchy value is already on the row.
    const deduped = vacateDuplicatePersonHierarchyRoles(current);
    if (deduped.changed) {
      current = deduped.row;
      duplicatePersonVacatedCount += deduped.vacatedColumns.length;
    }
    return current;
  });

  if (hierarchyByPlacementId.size > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] DEAL recruiter-hierarchy backfill: eligible=${eligible.length} matched=${hierarchyByPlacementId.size} backfilled=${backfilledCount}`
    );
  }
  if (selfReferenceVacatedCount > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] DEAL hierarchy roles vacated to NA (held by the row's own recruiter): ${selfReferenceVacatedCount}`
    );
  }
  if (duplicatePersonVacatedCount > 0) {
    logDetail(
      `[enriched sync] [BigQuery insertAll] DEAL hierarchy roles vacated to NA (same person in a more senior column): ${duplicatePersonVacatedCount}`
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
  const unresolvedEmails = new Set();
  rows.forEach((row, index) => {
    const email = row?.ONSITE_AM_EMAIL;
    const norm = email == null ? "" : String(email).trim().toLowerCase();
    const externalId = norm ? directoryByEmail.get(norm)?.externalId : null;
    // No external_id means no hierarchy chain to walk, so LEVEL_*_CSM stay null. Log it — this
    // skip used to be silent, which is why a whole class of onsite AMs sat with null CSM levels
    // unnoticed.
    if (!externalId) {
      if (norm) unresolvedEmails.add(norm);
      return;
    }
    targets.push({ key: String(index), externalId, anchorDate: row?.NEW_HIRE_DATE ?? null });
  });
  if (unresolvedEmails.size > 0) {
    logDetail(
      `[csm hierarchy] no directory external_id for ${unresolvedEmails.size} onsite AM email(s); `
        + `LEVEL_*_CSM left null: ${[...unresolvedEmails].slice(0, 10).join(", ")}`
    );
  }
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
    logDetail(`[enriched sync] [BigQuery insertAll] ONSITE_AM CSM hierarchy: updated=${updatedCount}/${rows.length}`);
  }
  return out;
}

/**
 * DELIVERY_POC priority chain: the first available (non-blank, non-"NA") delivery-side owner above
 * the recruiter. Each entry maps to the deal-sheet name + emp-no columns; the recruiter is the
 * final fallback and carries an email column directly (others resolve email from directory).
 */
const DELIVERY_POC_PRIORITY = [
  { nameCol: "VP", empCol: "VP_EMP_NO" },
  { nameCol: "AVP", empCol: "AVP_EMP_NO" },
  { nameCol: "ASSOCIATE_DELIVERY_DIRECTOR", empCol: "ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO" },
  { nameCol: "DELIVERY_DIRECTOR", empCol: "DELIVERY_DIRECTOR_EMP_NO" },
  { nameCol: "ACCOUNT_MANAGER", empCol: "ACCOUNT_MANAGER_EMP_NO" },
  { nameCol: "SECONDARY_AM", empCol: "SECONDARY_AM_EMP_NO" },
  { nameCol: "ASSOCIATE_AM", empCol: "ASSOCIATE_AM_EMP_NO" },
  { nameCol: "RM", empCol: "RM_EMP_NO" },
  { nameCol: "TEAM_LEAD", empCol: "TEAM_LEAD_EMP_NO" },
  { nameCol: "ATL", empCol: "ATL_EMP_NO" },
  { nameCol: "ASSIGNMENT_RECRUITER", empCol: "RECRUITER_EMP_NO", emailCol: "ASSIGNMENT_RECRUITER_EMAIL", isRecruiter: true },
];

/** A hierarchy slot is "available" when non-null, non-blank, and not the literal "NA". */
function isAvailableHierarchyValue(value) {
  if (value == null) return false;
  const s = String(value).trim();
  return s !== "" && s.toUpperCase() !== "NA";
}

/**
 * Same priority chain as DELIVERY_POC but over the INORGANIC_* columns of an inorganic_hierarchy_logs
 * row (no SECONDARY_AM / DELIVERY_DIRECTOR / AVP — mirrors DELIVERY_POC_PRIORITY exactly). Used to
 * derive INORGANIC_DELIVERY_POC = the highest-seniority person present in the recruiter's live chain.
 */
const INORGANIC_DELIVERY_POC_PRIORITY = [
  { nameCol: "INORGANIC_VP_SR_VP", empCol: "INORGANIC_VP_SR_VP_EMP_NO" },
  { nameCol: "INORGANIC_AVP", empCol: "INORGANIC_AVP_EMP_NO" },
  { nameCol: "INORGANIC_ASSOCIATE_GROUP_DIRECTOR", empCol: "INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO" },
  { nameCol: "INORGANIC_DELIVERY_DIRECTOR", empCol: "INORGANIC_DELIVERY_DIRECTOR_EMP_NO" },
  { nameCol: "INORGANIC_ACCOUNT_MANAGER", empCol: "INORGANIC_ACCOUNT_MANAGER_EMP_NO" },
  { nameCol: "INORGANIC_ASSOCIATE_AM", empCol: "INORGANIC_ASSOCIATE_AM_EMP_NO" },
  { nameCol: "INORGANIC_RM", empCol: "INORGANIC_RM_EMP_NO" },
  { nameCol: "INORGANIC_TL", empCol: "INORGANIC_TL_EMP_NO" },
  { nameCol: "INORGANIC_ATL", empCol: "INORGANIC_ATL_EMP_NO" },
  { nameCol: "INORGANIC_RECRUITER", empCol: "INORGANIC_RECRUITER_EMP_NO", isRecruiter: true },
];

/**
 * Pick the delivery-POC owner for a row from a priority chain: first slot with an available name.
 * Returns { nameCol, name, empNo, isRecruiter } or null when the whole chain is empty.
 */
function pickPocForRow(row, priority) {
  if (!row || typeof row !== "object") return null;
  for (const slot of priority) {
    if (!isAvailableHierarchyValue(row[slot.nameCol])) continue;
    const empRaw = row[slot.empCol];
    return {
      nameCol: slot.nameCol,
      name: String(row[slot.nameCol]).trim(),
      empNo: isAvailableHierarchyValue(empRaw) ? String(empRaw).trim() : null,
      isRecruiter: slot.isRecruiter === true,
    };
  }
  return null;
}

/** Deal-sheet DELIVERY_POC pick (see DELIVERY_POC_PRIORITY). */
function pickDeliveryPocForRow(row) {
  return pickPocForRow(row, DELIVERY_POC_PRIORITY);
}

/**
 * Inorganic DELIVERY_POC: restricted priority for inorganic deals (only VP, AVP, DELIVERY_DIRECTOR, ASSOCIATE_DELIVERY_DIRECTOR).
 * Used to populate DELIVERY_POC for inorganic rows — other designations are excluded.
 */
const INORGANIC_RESTRICTED_DELIVERY_POC_PRIORITY = [
  { nameCol: "VP", empCol: "VP_EMP_NO" },
  { nameCol: "AVP", empCol: "AVP_EMP_NO" },
  { nameCol: "DELIVERY_DIRECTOR", empCol: "DELIVERY_DIRECTOR_EMP_NO" },
  { nameCol: "ASSOCIATE_DELIVERY_DIRECTOR", empCol: "ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO" },
];

/** Inorganic deal DELIVERY_POC pick (restricted to VP, AVP, DELIVERY_DIRECTOR, ASSOCIATE_DELIVERY_DIRECTOR only). */
function pickInorganicRestrictedDeliveryPocForRow(row) {
  return pickPocForRow(row, INORGANIC_RESTRICTED_DELIVERY_POC_PRIORITY);
}

/** Hierarchy name+emp-no column pairs whose consistency is enforced (name is master). */
const HIERARCHY_NAME_EMP_PAIRS = [
  ...DEAL_RECRUITER_HIERARCHY_TARGETS.map((t) => ({ column: t.column, empNoColumn: t.empNoColumn })),
  { column: "DELIVERY_POC", empNoColumn: "DELIVERY_POC_EMP_NO" },
];

/**
 * Keep each hierarchy NAME/EMP_NO pair consistent: when the NAME is null/blank/"NA", force its
 * *_EMP_NO to "NA" too (name is master). Prevents the "name = NA but emp-no still populated" state
 * that leaks in from run-rate rows (which carry a real emp-no alongside a "NA" name) via
 * mergeExtensionBackfillFields. A present name is left untouched.
 */
function applyHierarchyNameEmpConsistency(row) {
  if (!row || typeof row !== "object") return row;
  let next = row;
  let changed = false;
  for (const { column, empNoColumn } of HIERARCHY_NAME_EMP_PAIRS) {
    if (isAvailableHierarchyValue(next[column])) continue; // name present -> leave emp-no as-is
    const empRaw = next[empNoColumn];
    if (empRaw == null) continue;
    const emp = String(empRaw).trim();
    if (emp === "" || emp.toUpperCase() === "NA") continue;
    if (!changed) {
      next = { ...row };
      changed = true;
    }
    next[empNoColumn] = "NA";
  }
  return next;
}

/**
 * Resolve emails for DELIVERY_POC owners from directory_employees, by employee_id first and by
 * name_full as a fallback. Returns { byEmp, byName } maps (both keyed lowercased/trimmed for name,
 * trimmed for emp). Prefers status='ACTIVE' then latest updated_at on duplicates.
 */
async function fetchDeliveryPocEmails(empNos, names) {
  const byEmp = new Map();
  const byName = new Map();
  const employeesFqn = `\`${config.projectId}.${config.directoryEmployees.datasetId}.${config.directoryEmployees.tableId}\``;

  const uniqEmp = [...new Set((empNos || []).filter((e) => e != null && String(e).trim() !== "").map((e) => String(e).trim()))];
  for (let i = 0; i < uniqEmp.length; i += 500) {
    const chunk = uniqEmp.slice(i, i + 500);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `
      SELECT employee_id, email
      FROM ${employeesFqn}
      WHERE CAST(employee_id AS STRING) IN (${inList})
        AND email IS NOT NULL AND TRIM(email) != ''
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY CAST(employee_id AS STRING)
        ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
      ) = 1
    `;
    const rows = await queryObjects(sql, chunk.length);
    for (const r of rows) {
      const emp = r?.employee_id == null ? "" : String(r.employee_id).trim();
      const email = r?.email == null ? "" : String(r.email).trim();
      if (emp && email) byEmp.set(emp, email);
    }
  }

  const uniqName = [...new Set((names || []).filter((n) => n != null && String(n).trim() !== "").map((n) => String(n).trim().toLowerCase()))];
  for (let i = 0; i < uniqName.length; i += 500) {
    const chunk = uniqName.slice(i, i + 500);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `
      SELECT LOWER(TRIM(name_full)) AS name_norm, email
      FROM ${employeesFqn}
      WHERE LOWER(TRIM(name_full)) IN (${inList})
        AND email IS NOT NULL AND TRIM(email) != ''
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(name_full))
        ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
      ) = 1
    `;
    const rows = await queryObjects(sql, chunk.length);
    for (const r of rows) {
      const nameNorm = r?.name_norm == null ? "" : String(r.name_norm).trim();
      const email = r?.email == null ? "" : String(r.email).trim();
      if (nameNorm && email) byName.set(nameNorm, email);
    }
  }

  return { byEmp, byName };
}

/**
 * Derive DELIVERY_POC / DELIVERY_POC_EMP_NO / DELIVERY_POC_EMAIL from a row's hierarchy columns,
 * for rows where DELIVERY_POC is currently empty (freeze-on-first-insert: a value already carried
 * forward from baseline or hand-edited is left untouched). Email is the recruiter's own email when
 * the POC is the recruiter, else resolved from directory_employees by emp-no (then name).
 */
async function applyDeliveryPocForInsertRows(rows, options = {}, deps = {}) {
  if (!rows || rows.length === 0) return rows;
  const fetchEmailsFn = deps.fetchEmailsFn ?? fetchDeliveryPocEmails;

  const chosenByIndex = new Map();
  const empNos = [];
  const names = [];
  rows.forEach((row, i) => {
    if (!row || typeof row !== "object") return;
    if (isAvailableHierarchyValue(row.DELIVERY_POC)) return; // frozen — already set
    const picked = pickDeliveryPocForRow(row);
    if (!picked) return;
    chosenByIndex.set(i, picked);
    if (picked.isRecruiter) return;
    if (picked.empNo) empNos.push(picked.empNo);
    else names.push(picked.name);
  });
  if (chosenByIndex.size === 0) return rows;

  const { byEmp, byName } = await fetchEmailsFn(empNos, names);

  let filledCount = 0;
  const out = rows.map((row, i) => {
    const picked = chosenByIndex.get(i);
    if (!picked) return row;
    let email = null;
    if (picked.isRecruiter) {
      email = isAvailableHierarchyValue(row.ASSIGNMENT_RECRUITER_EMAIL) ? String(row.ASSIGNMENT_RECRUITER_EMAIL).trim() : null;
    } else if (picked.empNo && byEmp.has(picked.empNo)) {
      email = byEmp.get(picked.empNo);
    } else if (byName.has(picked.name.toLowerCase())) {
      email = byName.get(picked.name.toLowerCase());
    }
    filledCount++;
    return {
      ...row,
      DELIVERY_POC: picked.name,
      DELIVERY_POC_EMP_NO: picked.empNo ?? null,
      DELIVERY_POC_EMAIL: email,
    };
  });

  logDetail(`[enriched sync] [BigQuery insertAll] DELIVERY_POC derived: filled=${filledCount}/${rows.length}`);
  return out;
}

/**
 * Scans active deal-sheet tables' latest row per placement for a CSM hierarchy divergence: the
 * ONSITE_AM's CURRENT (live, most-recent-snapshot) manager chain differs from what's frozen on
 * the row as LEVEL_2_CSM/LEVEL_3_CSM/LEVEL_4_CSM. Independent of any recruiter change — a
 * placement can surface here even when its recruiter never changed.
 * @returns {Promise<object[]>} candidates: {DEAL_SHEET_ID, PLACEMENT_ID, PLACEMENT_STATUS,
 *   CANDIDATE_NAME, CANDIDATE_ID, csmDivergedLevels: {LEVEL_2_CSM?, LEVEL_3_CSM?, LEVEL_4_CSM?}}
 */
// @deprecated Not used by the sync path anymore (EXTENSION inorganic now comes from run-rate +
// Department_Data via resolveExtensionInorganicLogRows). Kept only for existing unit tests.
async function fetchCsmHierarchyDivergenceCandidates(options = {}, deps = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    return `SELECT DEAL_SHEET_ID, PLACEMENT_ID, PLACEMENT_STATUS, CANDIDATE_NAME, CANDIDATE_ID,
                   ONSITE_AM_EMAIL, LEVEL_2_CSM, LEVEL_3_CSM, LEVEL_4_CSM, LAST_UPDATED
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
                     ORDER BY LAST_UPDATED DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
               )
               WHERE rn = 1`;

  const rows = await queryObjects(sql, 100000);
  logDetail(`[inorganic hierarchy logs] fetchCsmHierarchyDivergenceCandidates latest rows scanned=${rows.length}`);
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
      CANDIDATE_ID: row.CANDIDATE_ID,
      csmDivergedLevels: diverged,
    });
  });

  logDetail(`[inorganic hierarchy logs] fetchCsmHierarchyDivergenceCandidates diverged=${candidates.length}`);
  return candidates;
}

/**
 * Person-centric (emp-no) reconciliation of every active, non-ENDED placement's FROZEN regular
 * recruiter-hierarchy fields against the CURRENT recruiter's live manager chain. This is the single
 * scan that drives three outputs (see computeRecruiterHierarchyRoleChanges for the exact rules):
 *   - moves: a person already in a regular field was promoted/re-designated into a DIFFERENT managed
 *     role -> the deal-sheet regular fields are updated (old field vacated, new field filled, same
 *     emp-no) via an appended row, and ownership_change_logs gets a vacate + a fill row.
 *   - newPersons: an emp-no in the live chain that was NOT in the frozen set -> inorganic log only.
 *   - a frozen person who simply vanished from the chain is LEFT frozen (never vacated).
 *
 * Stops at PLACEMENT_STATUS ENDED (LIKE 'ENDED%'): once a placement ends, its hierarchy is final.
 * The comparison is stored-frozen-values vs the recruiter's LATEST snapshot, so the anchor date the
 * hierarchy was originally frozen at (NEW_HIRE_DATE for DEAL, START_DATE for EXTENSION) is already
 * baked into the stored values — every change detected here is inherently "after" that freeze.
 * SECONDARY_RECRUITER/SECONDARY_AM are excluded (manual fields).
 *
 * @returns {Promise<object[]>} per-placement reconciliation:
 *   {srcTable, DEAL_SHEET_ID, PLACEMENT_ID, PLACEMENT_STATUS, CANDIDATE_NAME, CANDIDATE_ID,
 *    recruiterEmail, moves, updatedFields, newPersons}
 */
async function fetchRecruiterHierarchyReconciliation(options = {}, deps = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const checkedDesignations = MANAGED_HIERARCHY_DESIGNATIONS;
  const nonBlankPredicate = checkedDesignations.map((col) => `TRIM(IFNULL(${col}, '')) != ''`).join(" OR ");
  const unionParts = buildActiveChangeScanUnionParts(datasetId);

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               )
               SELECT * EXCEPT(rn) FROM (
                 SELECT *, ROW_NUMBER() OVER (
                   PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                   ORDER BY LAST_UPDATED DESC NULLS LAST
                 ) AS rn
                 FROM all_rows
               )
               WHERE rn = 1
                 AND TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
                 AND NOT (UPPER(TRIM(IFNULL(PLACEMENT_STATUS, ''))) LIKE 'ENDED%')
                 AND (${nonBlankPredicate})`;

  const rows = await queryObjects(sql, 100000);
  logDetail(`[inorganic hierarchy logs] fetchRecruiterHierarchyReconciliation latest active rows scanned=${rows.length}`);
  if (rows.length === 0) return [];

  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const norm = String(row.ASSIGNMENT_RECRUITER_EMAIL).trim().toLowerCase();
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  rows.forEach((row, index) => {
    const norm = String(row.ASSIGNMENT_RECRUITER_EMAIL).trim().toLowerCase();
    const externalId = directoryByEmail.get(norm)?.externalId;
    if (!externalId) return;
    targets.push({ key: String(index), externalId, anchorDate: null });
  });

  const hierarchyFetchFn = deps.hierarchyFetchFn ?? fetchHierarchyLevelChainsByKey;
  const currentLevelsByKey =
    targets.length > 0 ? await hierarchyFetchFn(targets, { direction: "on_or_after" }) : new Map();

  const results = [];
  rows.forEach((row, index) => {
    const levelRows = currentLevelsByKey.get(String(index));
    if (!levelRows) return;

    // Map the CURRENT chain to designation -> {name, empNo}; closest level (first match) wins,
    // same rule as fetchDealRecruiterHierarchyByPlacementId.
    const currentByDesignation = {};
    const filled = new Set();
    for (const levelRow of levelRows) {
      const designation = resolveHierarchyColumnForTitle(levelRow?.manager_title);
      if (!designation || filled.has(designation) || !DESIGNATION_TO_INORGANIC_LOG_COLUMN[designation]) continue;
      filled.add(designation);
      currentByDesignation[designation] = {
        name: normalizeExtensionRunrateBackfillValue(levelRow?.manager_name),
        empNo: normalizeExtensionRunrateBackfillValue(levelRow?.manager_employee_id),
      };
    }

    const analysis = computeRecruiterHierarchyRoleChanges(row, currentByDesignation);
    if (!analysis.changed && analysis.newPersons.length === 0) return;

    results.push({
      srcTable: row._src ?? null,
      DEAL_SHEET_ID: row.DEAL_SHEET_ID,
      PLACEMENT_ID: row.PLACEMENT_ID,
      PLACEMENT_STATUS: row.PLACEMENT_STATUS,
      CANDIDATE_NAME: row.CANDIDATE_NAME,
      CANDIDATE_ID: row.CANDIDATE_ID,
      recruiterEmail: String(row.ASSIGNMENT_RECRUITER_EMAIL).trim(),
      latestScanRow: stripRateChangeHistoryMetaFields(row),
      moves: analysis.moves,
      updatedFields: analysis.updatedFields,
      newPersons: analysis.newPersons,
    });
  });

  const withMoves = results.filter((r) => r.moves.length > 0).length;
  const withNew = results.filter((r) => r.newPersons.length > 0).length;
  logDetail(
    `[inorganic hierarchy logs] fetchRecruiterHierarchyReconciliation placements=${results.length} withMoves=${withMoves} withNewPersons=${withNew}`
  );
  return results;
}

/**
 * Map a reconciliation result's newPersons to the inorganic-log candidate shape
 * ({..., recruiterHierarchyDiverged: {designation: {name, empNo}}}), or null when there are none.
 */
// @deprecated Reconciliation newPersons are no longer routed to the inorganic log. Kept for tests.
function buildInorganicCandidateFromReconciliation(reconResult) {
  if (!reconResult || !reconResult.newPersons || reconResult.newPersons.length === 0) return null;
  const diverged = {};
  for (const p of reconResult.newPersons) {
    if (!p || !p.designation || !DESIGNATION_TO_INORGANIC_LOG_COLUMN[p.designation]) continue;
    diverged[p.designation] = { name: p.name ?? null, empNo: p.empNoRaw ?? null };
  }
  if (Object.keys(diverged).length === 0) return null;
  return {
    DEAL_SHEET_ID: reconResult.DEAL_SHEET_ID,
    PLACEMENT_ID: reconResult.PLACEMENT_ID,
    PLACEMENT_STATUS: reconResult.PLACEMENT_STATUS,
    CANDIDATE_NAME: reconResult.CANDIDATE_NAME,
    CANDIDATE_ID: reconResult.CANDIDATE_ID,
    recruiterHierarchyDiverged: diverged,
  };
}

/**
 * Ownership-change-log rows for one reconciliation result's moves. Each move produces two rows:
 *   - a VACATE row for the role the person left  (PREVIOUS_OWNER = the mover, NEW_OWNER = 'NA')
 *   - a FILL   row for the role the person took  (PREVIOUS_OWNER = displaced occupant or 'NA',
 *                                                 NEW_OWNER = the mover)
 * Dates/candidate context come from the placement's latest scan row (same shape as the recruiter/
 * CSM ownership rows), so OWNERSHIP_EFFECTIVE_DATE etc. are populated identically.
 */
function buildOwnershipChangeLogRowsForHierarchyMoves(reconResult, nowIso) {
  if (!reconResult || !reconResult.moves || reconResult.moves.length === 0) return [];
  const ctx = buildOwnershipChangeLogContext(reconResult.latestScanRow || {}, nowIso);
  const rows = [];
  for (const mv of reconResult.moves) {
    rows.push({
      ...ctx,
      OWNERSHIP_ROLE: mv.fromRole,
      NEW_OWNER_NAME: "NA",
      NEW_OWNER_EMP_NO: "NA",
      PREVIOUS_OWNER_NAME: ownershipDisplayValueOrNull(mv.name),
      PREVIOUS_OWNER_EMP_NO: ownershipDisplayValueOrNull(mv.empNoRaw),
    });
    rows.push({
      ...ctx,
      OWNERSHIP_ROLE: mv.toRole,
      NEW_OWNER_NAME: ownershipDisplayValueOrNull(mv.name),
      NEW_OWNER_EMP_NO: ownershipDisplayValueOrNull(mv.empNoRaw),
      PREVIOUS_OWNER_NAME: mv.displacedName ? ownershipDisplayValueOrNull(mv.displacedName) : "NA",
      PREVIOUS_OWNER_EMP_NO: mv.displacedEmpNoRaw ? ownershipDisplayValueOrNull(mv.displacedEmpNoRaw) : "NA",
    });
  }
  return rows;
}

/**
 * Write recruiter-hierarchy MOVES back to the deal sheet. For each placement with moves, fetch its
 * FULL current latest row from the source domain table, apply the moved regular-hierarchy field
 * values (updatedFields — old fields cleared, new fields set), stamp a fresh LAST_UPDATED + ID, and
 * append it (append-only update, exactly like a normal sync-append). Only the hierarchy columns
 * change; every other column is carried forward verbatim from the latest row.
 * @returns {Promise<{appended:number, placements:number}>}
 */
async function applyRecruiterHierarchyMovesToDealSheet(reconResults, options = {}) {
  const withMoves = (reconResults || []).filter((r) => r && r.moves && r.moves.length > 0 && r.srcTable);
  if (withMoves.length === 0) return { appended: 0, placements: 0 };

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  // Group by source table so each domain table is queried/inserted once.
  const byTable = new Map();
  for (const r of withMoves) {
    const t = String(r.srcTable).trim();
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t).push(r);
  }

  const nowIso = new Date().toISOString();
  let appended = 0;

  for (const [tableId, group] of byTable) {
    // Fetch each placement's FULL latest row (SELECT *) so the appended copy keeps all columns.
    const keyPairs = group
      .map((r) => {
        const ds = r.DEAL_SHEET_ID == null ? "" : String(r.DEAL_SHEET_ID).trim();
        const pid = r.PLACEMENT_ID == null ? "" : String(r.PLACEMENT_ID).trim();
        if (!ds || !pid) return null;
        return `(CAST(DEAL_SHEET_ID AS STRING) = '${escapeSqlString(ds)}' AND CAST(PLACEMENT_ID AS STRING) = '${escapeSqlString(pid)}')`;
      })
      .filter(Boolean);
    if (keyPairs.length === 0) continue;

    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const sql = `SELECT * EXCEPT(rn) FROM (
                   SELECT *, ROW_NUMBER() OVER (
                     PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY LAST_UPDATED DESC NULLS LAST
                   ) AS rn
                   FROM ${fqn}
                   WHERE ${keyPairs.join(" OR ")}
                 ) WHERE rn = 1`;
    const fullRows = await queryObjects(sql, group.length * 2);

    const fullByKey = new Map();
    for (const fr of fullRows) {
      const k = buildDealSheetPlacementCompositeKey(fr?.DEAL_SHEET_ID, fr?.PLACEMENT_ID);
      if (k) fullByKey.set(k, fr);
    }

    const rowsToInsert = [];
    for (const r of group) {
      const k = buildDealSheetPlacementCompositeKey(r.DEAL_SHEET_ID, r.PLACEMENT_ID);
      const full = k ? fullByKey.get(k) : null;
      if (!full) {
        logDetail(`[recruiter hierarchy moves] WARN full latest row not found placement=${r.PLACEMENT_ID} table=${tableId}`);
        continue;
      }
      const next = sanitizeRowForBigQueryStreamingInsert(full);
      for (const [col, val] of Object.entries(r.updatedFields)) {
        next[col] = val == null ? null : val;
      }
      next.LAST_UPDATED = nowIso;
      next.ID = randomUUID();
      rowsToInsert.push(next);
    }

    if (rowsToInsert.length === 0) continue;
    const result = await insertAll(rowsToInsert, { insertIdBase: 0, datasetId, tableId });
    appended += result.inserted;
    const hasErrors = result.errors && result.errors.length > 0;
    logDetail(
      `[recruiter hierarchy moves] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} table=${tableId} attempted=${result.attempted} inserted=${result.inserted}`
    );
  }

  return { appended, placements: withMoves.length };
}

/**
 * Merges recruiter-change, CSM-divergence, and recruiter-hierarchy-divergence candidates by
 * DEAL_SHEET_ID+PLACEMENT_ID so a placement with multiple signals in the same scan produces
 * exactly one log row.
 */
// @deprecated Superseded by resolveExtensionInorganicLogRows (run-rate sourced). Kept for tests.
function mergeInorganicHierarchyLogCandidates(recruiterCandidates, csmCandidates, recruiterHierarchyCandidates) {
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
  for (const c of recruiterHierarchyCandidates || []) {
    const key = keyOf(c);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, { ...existing, recruiterHierarchyDiverged: c.recruiterHierarchyDiverged });
    } else {
      byKey.set(key, { ...c });
    }
  }
  return [...byKey.values()];
}

/**
 * Returns Map<"DEAL_SHEET_ID|PLACEMENT_ID", { latest, previous }> for placements whose latest
 * row's ASSIGNMENT_RECRUITER_EMAIL differs from the row before it (a recruiter reassignment).
 * Scans all active domain deal sheet tables (DEAL + EXTENSION). Feeds inorganic_hierarchy_logs
 * via buildInorganicHierarchyLogCandidate + resolveInorganicHierarchyLogRows.
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
                     ORDER BY LAST_UPDATED DESC NULLS LAST
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

  logDetail(
    `[inorganic hierarchy logs] fetchDealSheetRecruiterChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Pure candidate extraction from a recruiter-change pair. Returns null when the pair doesn't
 * actually represent a recruiter change (defensive re-check; callers normally already filtered).
 * Used by syncInorganicHierarchyLogsFromBigQuery for DEAL and EXTENSION recruiter reassignments.
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
    CANDIDATE_ID: latestRow.CANDIDATE_ID ?? null,
    DEAL_TYPE: dealType,
    anchorDate: dealType === "EXTENSION" ? (latestRow.EXTENSION_DATE ?? null) : (latestRow.NEW_HIRE_DATE ?? null),
    newRecruiterEmail: newEmail,
  };
}

/**
 * After resolving a new recruiter's live chain into INORGANIC_* columns, drop any slot that already
 * matches the frozen organic hierarchy on the deal sheet (same role, same emp-no or same name).
 * If no divergent hierarchy slots remain, hasDivergence=false → caller should skip the insert
 * (same hierarchy = no inorganic change; INORGANIC_RECRUITER alone is not enough).
 *
 * @param {object} inorganicRow - row shaped like inorganic_hierarchy_logs
 * @param {object|null|undefined} frozenDealSheetRow - latest deal-sheet row (organic TL/RM/AM/…)
 * @returns {{ row: object, hasDivergence: boolean }}
 */
function filterInorganicHierarchyAgainstFrozenOrganic(inorganicRow, frozenDealSheetRow) {
  if (!inorganicRow || typeof inorganicRow !== "object") {
    return { row: inorganicRow, hasDivergence: false };
  }
  const frozen = frozenDealSheetRow && typeof frozenDealSheetRow === "object" ? frozenDealSheetRow : {};
  const next = { ...inorganicRow };
  let hasDivergence = false;

  const normEmp = (v) => {
    if (v == null) return "";
    const s = String(v).trim().toUpperCase();
    return s === "" || s === "NA" ? "" : s;
  };
  const normName = (v) => {
    if (v == null) return "";
    const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
    return s === "" || s === "na" ? "" : s;
  };

  for (const designation of Object.keys(DESIGNATION_TO_INORGANIC_LOG_COLUMN)) {
    const inorganicTarget = DESIGNATION_TO_INORGANIC_LOG_COLUMN[designation];
    const organicTarget = DEAL_RECRUITER_HIERARCHY_TARGETS.find((t) => t.column === designation);
    if (!inorganicTarget || !organicTarget) continue;

    const inorgEmp = normEmp(next[inorganicTarget.empNoColumn]);
    const inorgName = normName(next[inorganicTarget.column]);
    // Empty inorganic slot — nothing to keep or clear.
    if (!inorgEmp && !inorgName) continue;

    const orgEmp = normEmp(frozen[organicTarget.empNoColumn]);
    const orgName = normName(frozen[organicTarget.column]);

    const sameByEmp = inorgEmp !== "" && orgEmp !== "" && inorgEmp === orgEmp;
    const sameByName = !sameByEmp && inorgName !== "" && orgName !== "" && inorgName === orgName;
    if (sameByEmp || sameByName) {
      next[inorganicTarget.column] = null;
      next[inorganicTarget.empNoColumn] = null;
      continue;
    }
    hasDivergence = true;
  }

  // POC was derived from the full live chain; recompute from remaining divergent slots only.
  if (hasDivergence) {
    const prevPocEmp = next.INORGANIC_DELIVERY_POC_EMP_NO;
    const picked = pickPocForRow(next, INORGANIC_DELIVERY_POC_PRIORITY);
    if (picked) {
      next.INORGANIC_DELIVERY_POC = picked.name;
      next.INORGANIC_DELIVERY_POC_EMP_NO = picked.empNo;
      if (picked.isRecruiter) {
        next.INORGANIC_DELIVERY_POC_EMAIL = next.RECRUITER_EMAIL_ID ?? null;
      } else if (
        prevPocEmp != null &&
        String(prevPocEmp).trim() === String(picked.empNo ?? "").trim()
      ) {
        // Non-recruiter: keep previously resolved email when the same emp remains POC.
      } else {
        next.INORGANIC_DELIVERY_POC_EMAIL = null;
      }
    } else {
      next.INORGANIC_DELIVERY_POC = null;
      next.INORGANIC_DELIVERY_POC_EMP_NO = null;
      next.INORGANIC_DELIVERY_POC_EMAIL = null;
    }
  } else {
    next.INORGANIC_DELIVERY_POC = null;
    next.INORGANIC_DELIVERY_POC_EMP_NO = null;
    next.INORGANIC_DELIVERY_POC_EMAIL = null;
  }

  return { row: next, hasDivergence };
}

/** INORGANIC_* name columns for the 8 recruiter-hierarchy designations, used in the dedupe key. */
const INORGANIC_HIERARCHY_DEDUPE_COLUMNS = [
  "INORGANIC_ACCOUNT_MANAGER",
  "INORGANIC_ASSOCIATE_AM",
  "INORGANIC_RM",
  "INORGANIC_TL",
  "INORGANIC_ATL",
  "INORGANIC_ASSOCIATE_GROUP_DIRECTOR",
  "INORGANIC_DELIVERY_DIRECTOR",
  "INORGANIC_AVP",
  "INORGANIC_VP_SR_VP",
];
const INORGANIC_HIERARCHY_DEDUPE_ALL_BLANK = INORGANIC_HIERARCHY_DEDUPE_COLUMNS.map(() => "").join(",");

/** Dedupe key for the inorganic hierarchy log: same placement + same signal values never logged twice. */
function buildInorganicHierarchyLogDedupeKey(row) {
  const dsid = row?.DEAL_SHEET_ID == null ? "" : String(row.DEAL_SHEET_ID).trim();
  const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
  if (!dsid || !pid) return "";
  const email = row?.RECRUITER_EMAIL_ID == null ? "" : String(row.RECRUITER_EMAIL_ID).trim().toLowerCase();
  const csmPart = ["INORGANIC_LEVEL_2_CSM", "INORGANIC_LEVEL_3_CSM", "INORGANIC_LEVEL_4_CSM"]
    .map((col) => (row?.[col] == null ? "" : String(row[col]).trim().toLowerCase()))
    .join(",");
  const hierarchyPart = INORGANIC_HIERARCHY_DEDUPE_COLUMNS
    .map((col) => (row?.[col] == null ? "" : String(row[col]).trim().toLowerCase()))
    .join(",");
  // A row with no signal at all (no recruiter change, no CSM divergence, no hierarchy divergence)
  // has nothing worth deduping on its own identity — fall back to empty so callers skip it rather
  // than colliding on an ambiguous key shared by every no-signal row.
  if (!email && csmPart === ",," && hierarchyPart === INORGANIC_HIERARCHY_DEDUPE_ALL_BLANK) return "";
  return `${dsid}|${pid}|${email}|${csmPart}|${hierarchyPart}`;
}

/**
 * Returns Set of dedupe keys ("<DEAL_SHEET_ID>|<PLACEMENT_ID>|<recruiter email>|<csm levels>|
 * <hierarchy designations>") already present in the log table.
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
                        INORGANIC_LEVEL_2_CSM, INORGANIC_LEVEL_3_CSM, INORGANIC_LEVEL_4_CSM,
                        ${INORGANIC_HIERARCHY_DEDUPE_COLUMNS.join(", ")}
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
 * Callers should then filter against frozen organic hierarchy via
 * filterInorganicHierarchyAgainstFrozenOrganic before insert.
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

  const rows = candidates.map((c, index) => {
    const directoryEntry = c.newRecruiterEmail
      ? directoryByEmail.get(c.newRecruiterEmail.toLowerCase())
      : null;
    const row = {
      LAST_UPDATED: nowIso,
      PLACEMENT_ID: c.PLACEMENT_ID,
      PLACEMENT_STATUS: c.PLACEMENT_STATUS,
      DEAL_SHEET_ID: c.DEAL_SHEET_ID,
      CANDIDATE_NAME: c.CANDIDATE_NAME,
      CANDIDATE_ID: c.CANDIDATE_ID,
      OWNERSHIP_EFFECTIVE_DATE: todayDate,
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

    if (c.recruiterHierarchyDiverged) {
      for (const [designation, divergedValue] of Object.entries(c.recruiterHierarchyDiverged)) {
        const target = DESIGNATION_TO_INORGANIC_LOG_COLUMN[designation];
        if (!target) continue;
        row[target.column] = divergedValue?.name ?? null;
        row[target.empNoColumn] = divergedValue?.empNo ?? null;
      }
    }

    return row;
  });

  // INORGANIC_DELIVERY_POC = highest-seniority person present in the recruiter's live chain (same
  // priority as the deal-sheet DELIVERY_POC). Name + emp-no picked synchronously; email resolved from
  // directory by emp-no (recruiter POC uses its own RECRUITER_EMAIL_ID).
  const pocByRowIndex = new Map();
  const pocEmpNos = [];
  rows.forEach((row, i) => {
    const picked = pickPocForRow(row, INORGANIC_DELIVERY_POC_PRIORITY);
    if (!picked) return;
    pocByRowIndex.set(i, picked);
    row.INORGANIC_DELIVERY_POC = picked.name;
    row.INORGANIC_DELIVERY_POC_EMP_NO = picked.empNo;
    if (!picked.isRecruiter && picked.empNo) pocEmpNos.push(picked.empNo);
  });
  if (pocByRowIndex.size > 0) {
    const fetchEmailsFn = deps.fetchEmailsFn ?? fetchDeliveryPocEmails;
    const { byEmp } = await fetchEmailsFn(pocEmpNos, []);
    rows.forEach((row, i) => {
      const picked = pocByRowIndex.get(i);
      if (!picked) return;
      if (picked.isRecruiter) {
        row.INORGANIC_DELIVERY_POC_EMAIL = row.RECRUITER_EMAIL_ID ?? null;
      } else if (picked.empNo && byEmp.has(picked.empNo)) {
        row.INORGANIC_DELIVERY_POC_EMAIL = byEmp.get(picked.empNo);
      } else {
        row.INORGANIC_DELIVERY_POC_EMAIL = null;
      }
    });
  }

  return rows;
}

/**
 * Latest active-table row per placement for DEAL_TYPE = EXTENSION (fields needed to seed inorganic
 * from run-rate). One row per DEAL_SHEET_ID + PLACEMENT_ID (newest LAST_UPDATED).
 * @param {object} [options] - { datasetId }
 * @param {object} [deps] - { queryFn }
 * @returns {Promise<object[]>}
 */
async function fetchActiveExtensionRowsForInorganic(options = {}, deps = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const queryFn = deps.queryFn ?? queryObjects;

  const cols = [
    "DEAL_SHEET_ID",
    "PLACEMENT_ID",
    "LAST_UPDATED",
    "DEAL_TYPE",
    "PLACEMENT_STATUS",
    "CANDIDATE_NAME",
    "CANDIDATE_ID",
    "SKU_NUMBER",
    "CONTRACT_ID",
  ];
  const columnList = cols.join(", ");
  const unionParts = ACTIVE_DEAL_SHEET_TABLE_IDS.map((tableId) => {
    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    return `SELECT ${columnList} FROM ${fqn}
            WHERE DEAL_SHEET_ID IS NOT NULL AND PLACEMENT_ID IS NOT NULL
              AND UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'EXTENSION'`;
  });

  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               )
               SELECT * EXCEPT(rn) FROM (
                 SELECT *, ROW_NUMBER() OVER (
                   PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
                   ORDER BY LAST_UPDATED DESC NULLS LAST
                 ) AS rn
                 FROM all_rows
               )
               WHERE rn = 1`;
  return await queryFn(sql, 100000);
}

/**
 * Runrate INORGANIC_* name columns -> the designation key used to resolve status/remap, and (for
 * recruiter) the direct log column. `designation` is a DESIGNATION_TO_INORGANIC_LOG_COLUMN key.
 */
const RUNRATE_INORGANIC_SOURCE_COLUMNS = [
  { runrateCol: "INORGANIC_RECRUITER", designation: null },
  { runrateCol: "INORGANIC_ACCOUNT_MANAGER", designation: "ACCOUNT_MANAGER" },
  { runrateCol: "INORGANIC_ASSOCIATE_AM", designation: "ASSOCIATE_AM" },
  { runrateCol: "INORGANIC_RM", designation: "RM" },
  { runrateCol: "INORGANIC_TL", designation: "TEAM_LEAD" },
  { runrateCol: "INORGANIC_ATL", designation: "ATL" },
  { runrateCol: "INORGANIC_ASSOCIATE_GROUP_DIRECTOR", designation: "ASSOCIATE_DELIVERY_DIRECTOR" },
  { runrateCol: "INORGANIC_DELIVERY_DIRECTOR", designation: "DELIVERY_DIRECTOR" },
  { runrateCol: "INORGANIC_VP_SR_VP", designation: "VP" },
];

/** Treat null / blank / "NA" runrate inorganic values as absent. */
function realInorganicName(value) {
  const v = normalizeExtensionRunrateBackfillValue(value);
  if (v == null) return null;
  return String(v).trim().toUpperCase() === "NA" ? null : String(v).trim();
}

/**
 * Read the INORGANIC_* names from the domain run-rate table for a batch of EXTENSION rows, matched by
 * CANDIDATE_ID + SKU_NUMBER. For each placement the latest matching runrate row (by
 * EXTENSION_START_DATE, then START_DATE) that carries any inorganic value wins.
 * @param {object[]} extRows - active EXTENSION deal-sheet rows (need PLACEMENT_ID, CANDIDATE_ID, SKU_NUMBER)
 * @param {object} [options] - { datasetId, tableId/runrateTableId }
 * @param {object} [deps] - { queryFn }
 * @returns {Promise<Map<string, object>>} PLACEMENT_ID string -> { <runrateCol>: name }
 */
async function fetchRunrateInorganicForExtensions(extRows, options = {}, deps = {}) {
  const out = new Map();
  if (!extRows || extRows.length === 0) return out;

  const eligible = extRows.filter((r) => {
    const pid = r?.PLACEMENT_ID;
    const nexus = r?.CANDIDATE_ID;
    const sku = r?.SKU_NUMBER;
    return (
      pid != null && String(pid).trim() !== "" &&
      nexus != null && String(nexus).trim() !== "" &&
      sku != null && String(sku).trim() !== ""
    );
  });
  if (eligible.length === 0) return out;

  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const runrateTableId =
    typeof options.runrateTableId === "string" && options.runrateTableId.trim() !== ""
      ? options.runrateTableId.trim()
      : resolveRunrateTableIdForDealSheetTable(options.tableId);
  const runrateFqn = `\`${config.projectId}.${datasetId}.${runrateTableId}\``;
  const queryFn = deps.queryFn ?? queryObjects;

  const nameCols = RUNRATE_INORGANIC_SOURCE_COLUMNS.map((c) => c.runrateCol);
  const nonNullPredicate = nameCols.map((c) => `${c} IS NOT NULL`).join(" OR ");
  const selectCols = [
    "CAST(CANDIDATE_ID AS STRING) AS nexus",
    "CAST(SKU_NUMBER AS STRING) AS sku",
    "CAST(EXTENSION_START_DATE AS STRING) AS ext_start",
    "CAST(START_DATE AS STRING) AS start_date",
    ...nameCols,
  ].join(", ");

  // key = nexus||sku -> chosen runrate row (latest by ext_start/start_date with any inorganic)
  const chosenByKey = new Map();
  const upsertChosen = (r) => {
    const nexus = r?.nexus == null ? "" : String(r.nexus).trim();
    const sku = r?.sku == null ? "" : String(r.sku).trim();
    if (!nexus || !sku) return;
    const hasAny = nameCols.some((c) => realInorganicName(r[c]) != null);
    if (!hasAny) return;
    const key = `${nexus}||${sku}`;
    const orderTs = String(r?.ext_start ?? "") + "|" + String(r?.start_date ?? "");
    const prev = chosenByKey.get(key);
    if (!prev || orderTs > prev.__orderTs) {
      chosenByKey.set(key, { ...r, __orderTs: orderTs });
    }
  };

  const nexusSet = [];
  const seenNexus = new Set();
  for (const r of eligible) {
    const nx = String(r.CANDIDATE_ID).trim();
    if (!seenNexus.has(nx)) {
      seenNexus.add(nx);
      nexusSet.push(nx);
    }
  }

  const chunkSize = 200;
  for (let i = 0; i < nexusSet.length; i += chunkSize) {
    const chunk = nexusSet.slice(i, i + chunkSize);
    const inList = chunk.map((n) => `'${escapeSqlString(n)}'`).join(", ");
    const sql = `
      SELECT ${selectCols}
      FROM ${runrateFqn}
      WHERE CAST(CANDIDATE_ID AS STRING) IN (${inList})
        AND (${nonNullPredicate})
    `;
    const rows = await queryFn(sql);
    for (const r of rows || []) upsertChosen(r);
  }

  for (const r of eligible) {
    const nexus = String(r.CANDIDATE_ID).trim();
    const sku = String(r.SKU_NUMBER).trim();
    const chosen = chosenByKey.get(`${nexus}||${sku}`);
    if (!chosen) continue;
    const inorganic = {};
    for (const col of nameCols) {
      const name = realInorganicName(chosen[col]);
      if (name != null) inorganic[col] = name;
    }
    if (Object.keys(inorganic).length > 0) {
      out.set(String(r.PLACEMENT_ID).trim(), inorganic);
    }
  }
  return out;
}

/**
 * Build inorganic_hierarchy_logs rows for EXTENSION placements from the run-rate INORGANIC_* columns,
 * validated against Department_Data."Ph and India": each inorganic person is looked up by name (+
 * designation); Active -> kept with emp-no; Inactive -> replaced by the first Active IMMEDIATE_MANAGER
 * up the chain (placed in the column their designation maps to); nobody active -> dropped (NA).
 * @param {object[]} extRows - active EXTENSION deal-sheet rows
 * @param {object} [options] - { datasetId, tableId }
 * @param {object} [deps] - { queryFn, runrateFetchFn, departmentFetchFn, fetchEmailsFn }
 * @returns {Promise<object[]>}
 */
async function resolveExtensionInorganicLogRows(extRows, options = {}, deps = {}) {
  if (!extRows || extRows.length === 0) return [];

  const runrateFetchFn = deps.runrateFetchFn ?? fetchRunrateInorganicForExtensions;
  const departmentFetchFn = deps.departmentFetchFn ?? fetchDepartmentEmployeesByNames;
  const queryFn = deps.queryFn ?? queryObjects;

  const runrateByPlacement = await runrateFetchFn(extRows, options, { queryFn });
  if (runrateByPlacement.size === 0) return [];

  // Collect every inorganic name so Department_Data is queried once.
  const allNames = new Set();
  for (const inorganic of runrateByPlacement.values()) {
    for (const name of Object.values(inorganic)) {
      if (name) allNames.add(name);
    }
  }
  const byName = await departmentFetchFn([...allNames], { queryFn });

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const rows = [];

  for (const extRow of extRows) {
    const pid = extRow?.PLACEMENT_ID == null ? "" : String(extRow.PLACEMENT_ID).trim();
    if (!pid) continue;
    const inorganic = runrateByPlacement.get(pid);
    if (!inorganic) continue;

    const row = {
      LAST_UPDATED: nowIso,
      PLACEMENT_ID: extRow.PLACEMENT_ID,
      PLACEMENT_STATUS: extRow.PLACEMENT_STATUS ?? null,
      DEAL_SHEET_ID: extRow.DEAL_SHEET_ID ?? null,
      CANDIDATE_NAME: extRow.CANDIDATE_NAME ?? null,
      CANDIDATE_ID: extRow.CANDIDATE_ID ?? null,
      OWNERSHIP_EFFECTIVE_DATE: todayDate,
    };

    let filled = 0;
    for (const source of RUNRATE_INORGANIC_SOURCE_COLUMNS) {
      const name = inorganic[source.runrateCol];
      if (!name) continue;

      // Recruiter is an identity slot, not a manager role: keep unless found Inactive.
      if (source.designation == null) {
        const entries = byName.get(normalizeNameKey(name));
        const entry = entries && entries.length > 0 ? entries[0] : null;
        if (entry && !isActiveStatus(entry.status)) continue; // inactive recruiter -> NA
        // Prefer GOES_BY_NAME (e.g. "Amy Gupta") over full EMPLOYEE_NAME.
        row.INORGANIC_RECRUITER = entry?.goesByName || entry?.name || name;
        row.INORGANIC_RECRUITER_EMP_NO = entry?.empNo ?? null;
        filled++;
        continue;
      }

      const resolved = resolveActiveOrManager(name, source.designation, byName);
      if (!resolved) continue; // inactive with no active manager -> NA
      const target = DESIGNATION_TO_INORGANIC_LOG_COLUMN[resolved.column];
      if (!target) continue;
      row[target.column] = resolved.name;
      row[target.empNoColumn] = resolved.empNo ?? null;
      filled++;
    }

    if (filled === 0) continue;

    // INORGANIC_DELIVERY_POC = highest-seniority present inorganic person (same priority chain).
    const picked = pickPocForRow(row, INORGANIC_DELIVERY_POC_PRIORITY);
    if (picked) {
      row.INORGANIC_DELIVERY_POC = picked.name;
      row.INORGANIC_DELIVERY_POC_EMP_NO = picked.empNo;
    }
    rows.push(row);
  }

  // Resolve INORGANIC_DELIVERY_POC_EMAIL from directory by emp-no (recruiter POC uses its own email).
  const fetchEmailsFn = deps.fetchEmailsFn ?? fetchDeliveryPocEmails;
  const pocEmpNos = [];
  for (const row of rows) {
    if (row.INORGANIC_DELIVERY_POC_EMP_NO) pocEmpNos.push(String(row.INORGANIC_DELIVERY_POC_EMP_NO).trim());
  }
  if (pocEmpNos.length > 0) {
    const { byEmp } = await fetchEmailsFn(pocEmpNos, []);
    for (const row of rows) {
      const emp = row.INORGANIC_DELIVERY_POC_EMP_NO ? String(row.INORGANIC_DELIVERY_POC_EMP_NO).trim() : null;
      row.INORGANIC_DELIVERY_POC_EMAIL = emp && byEmp.has(emp) ? byEmp.get(emp) : null;
    }
  }

  return rows;
}

/**
 * Insert recruiter-reassignment audit logs (append-only; one row per detected change).
 */
async function insertInorganicHierarchyLogBatch(logRows, insertIdBase, options = {}) {
  if (!logRows || logRows.length === 0) {
    logDetail(`[inorganic hierarchy logs] [BigQuery insertAll] SKIP: no rows to insert`);
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
    logDetail(
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
      logDetail(
        `[inorganic hierarchy logs] [BigQuery insertAll] dedupe(existing in log table): skipped=${skipped} remaining=${deduped.length}`
      );
    }
  }

  if (!deduped.length) {
    logDetail(`[inorganic hierarchy logs] [BigQuery insertAll] SKIP: nothing left after dedupe`);
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

  logDetail(
    `[inorganic hierarchy logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

// ===========================================================================================
// ownership_change_logs — per-role ownership handover audit (recruiter / onsite AM / CSM levels)
// ===========================================================================================

/** Marker on ownership_change_logs from the CONTRACT_ID placement-chain scan (skip date overwrite). */
const OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN = "CONTRACT_CHAIN";

/**
 * Rate fields compared across consecutive placements under the same CONTRACT_ID. Aligns with the
 * snapshot columns buildRateChangeLogRow / extractRateSnapshotFields read from deal sheets.
 */
const CONTRACT_SEGMENT_RATE_COMPARE_FIELDS = Object.freeze([
  "GUARANTEED_HOURS",
  "PROJECT_DURATION",
  "NBO_HOURS",
  "BILLABLE_ORIENTATION_HRS",
  "BILLABLE_ORIENTATION",
  "ADDITIONAL_BONUS",
  "PAY_RATE",
  "WEEKLY_PER_DIEM_NON_TAXED",
  "W2_PAY_RATE",
  "FINAL_PAY_RATE",
  "FINAL_COST",
  "BILL_RATE",
  "FINAL_BILL_RATE",
  "NET_MARGIN",
  "MARGIN",
  "CLIENT_MSP_FEE",
]);

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

/** YYYY-MM-DD one day BEFORE the given date-only value; null when unparseable. */
function subtractOneDayFromDateOnly(value) {
  const ymd = formatDateOnlyForSql(value);
  if (ymd == null) return null;
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms - 86400000);
  return d.toISOString().slice(0, 10);
}

/** True when any OWNERSHIP_CHANGE_DIFF_ROLES change-field differs (latest non-empty). */
function ownershipChangeRolesDiffer(latestRow, previousRow) {
  if (!latestRow || !previousRow) return false;
  for (const r of OWNERSHIP_CHANGE_DIFF_ROLES) {
    const latestKey = normalizeOwnershipValueForCompare(latestRow[r.changeField]);
    const prevKey = normalizeOwnershipValueForCompare(previousRow[r.changeField]);
    if (latestKey !== "" && latestKey !== prevKey) return true;
  }
  return false;
}

/** Normalize a rate-snapshot cell for equality (floats rounded; strings trimmed lower). */
function normalizeRateCompareValue(value) {
  if (value == null) return "";
  const unwrapped = value != null && typeof value === "object" && "value" in value ? value.value : value;
  if (unwrapped == null) return "";
  if (typeof unwrapped === "number" && Number.isFinite(unwrapped)) {
    return String(Math.round(unwrapped * 1e6) / 1e6);
  }
  const s = String(unwrapped).trim();
  if (s === "") return "";
  const n = Number(s);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(s)) {
    return String(Math.round(n * 1e6) / 1e6);
  }
  return s.toLowerCase();
}

/** True when any CONTRACT_SEGMENT_RATE_COMPARE_FIELDS value differs, or next has RATE_CHANGE=YES. */
function contractSegmentRateFieldsDiffer(nextRow, previousRow) {
  if (!nextRow || !previousRow) return false;
  if (String(nextRow.RATE_CHANGE || "").trim().toUpperCase() === "YES") return true;
  for (const field of CONTRACT_SEGMENT_RATE_COMPARE_FIELDS) {
    if (normalizeRateCompareValue(nextRow[field]) !== normalizeRateCompareValue(previousRow[field])) {
      return true;
    }
  }
  return false;
}

function compareContractPlacementSegmentOrder(a, b) {
  const sa = ownershipDateOnlyOrNull(a?.START_DATE) || "";
  const sb = ownershipDateOnlyOrNull(b?.START_DATE) || "";
  if (sa !== sb) return sa < sb ? -1 : 1;
  const pa = a?.PLACEMENT_ID == null ? "" : String(a.PLACEMENT_ID).trim();
  const pb = b?.PLACEMENT_ID == null ? "" : String(b.PLACEMENT_ID).trim();
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Group latest-per-placement rows by CONTRACT_ID, sort by START_DATE, emit consecutive pairs that
 * pass `shouldPair(prev, next)`.
 * @returns {Map<string, { latest: object, previous: object }>}
 */
function buildConsecutiveContractPlacementPairs(latestPerPlacementRows, shouldPair) {
  const out = new Map();
  if (!latestPerPlacementRows || latestPerPlacementRows.length === 0) return out;

  const byContract = new Map();
  for (const row of latestPerPlacementRows) {
    const cid = row?.CONTRACT_ID == null ? "" : String(row.CONTRACT_ID).trim().toUpperCase();
    if (!cid) continue;
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    if (!pid) continue;
    if (!byContract.has(cid)) byContract.set(cid, []);
    byContract.get(cid).push(row);
  }

  for (const [cid, rows] of byContract) {
    rows.sort(compareContractPlacementSegmentOrder);
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1];
      const latest = rows[i];
      if (!shouldPair(latest, previous)) continue;
      const prevPid = String(previous.PLACEMENT_ID).trim();
      const nextPid = String(latest.PLACEMENT_ID).trim();
      out.set(`${cid}|${prevPid}|${nextPid}`, { latest, previous });
    }
  }
  return out;
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
                     ORDER BY LAST_UPDATED DESC NULLS LAST
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

  logDetail(
    `[ownership change logs] fetchDealSheetOwnershipChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Latest deal-sheet row per CONTRACT_ID|PLACEMENT_ID across active tables (ownership scan columns).
 * @returns {Promise<object[]>}
 */
async function fetchLatestOwnershipRowsPerContractPlacement(options = {}) {
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
                     PARTITION BY UPPER(TRIM(CAST(CONTRACT_ID AS STRING))), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY LAST_UPDATED DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
                 WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
                   AND PLACEMENT_ID IS NOT NULL
               )
               SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1`;
  const rows = await queryObjects(sql, 500000);
  return rows.map((raw) => stripRateChangeHistoryMetaFields(raw));
}

/**
 * Consecutive placements under the same CONTRACT_ID (ordered by START_DATE) whose ownership roles
 * differ. Map key: "CONTRACT_ID|prevPlacementId|nextPlacementId" -> { latest: next, previous: prev }.
 */
async function fetchContractOwnershipChangePairsFromActive(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const latestRows = await fetchLatestOwnershipRowsPerContractPlacement({ datasetId });
  const out = buildConsecutiveContractPlacementPairs(latestRows, ownershipChangeRolesDiffer);
  logDetail(
    `[ownership change logs] fetchContractOwnershipChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/**
 * Consecutive placements under the same CONTRACT_ID whose rate snapshot differs (or next has
 * RATE_CHANGE=YES). Uses schema-safe union so rate columns exist across domains.
 * Map key: "CONTRACT_ID|prevPlacementId|nextPlacementId" -> { latest: next, previous: prev }.
 */
async function fetchContractSegmentRateChangePairsFromActive(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const unionParts = await buildActiveDealSheetSchemaSafeUnionParts(
    datasetId,
    "CONTRACT_ID IS NOT NULL",
    // Canada is excluded while it is being validated — no ch_rate_change_logs row should be
    // keyed on a placement that is about to be deleted and re-synced.
    { excludeTableIds: RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS }
  );
  const sql = `WITH all_rows AS (
                 ${unionParts.join("\n                 UNION ALL\n                 ")}
               ),
               ranked AS (
                 SELECT
                   *,
                   ROW_NUMBER() OVER (
                     PARTITION BY UPPER(TRIM(CAST(CONTRACT_ID AS STRING))), CAST(PLACEMENT_ID AS STRING)
                     ORDER BY LAST_UPDATED DESC NULLS LAST
                   ) AS rn
                 FROM all_rows
                 WHERE PLACEMENT_ID IS NOT NULL
               )
               SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1`;
  const rows = (await queryObjects(sql, 500000)).map((raw) => stripRateChangeHistoryMetaFields(raw));
  const out = buildConsecutiveContractPlacementPairs(rows, contractSegmentRateFieldsDiffer);
  logDetail(
    `[rate-change logs] fetchContractSegmentRateChangePairsFromActive dataset=${datasetId} pairs=${out.size}`
  );
  return out;
}

/** Shared per-row context (candidate/placement/dates) for every ownership log row of a placement. */
function buildOwnershipChangeLogContext(latestRow, nowIso) {
  const tentative = latestRow?.TENTATIVE_END_DATE;
  return {
    LAST_UPDATED: nowIso,
    SKU_NO: ownershipDisplayValueOrNull(latestRow?.SKU_NUMBER),
    CONTRACT_ID: ownershipDisplayValueOrNull(latestRow?.CONTRACT_ID),
    PLACEMENT_ID: latestRow?.PLACEMENT_ID == null ? null : String(latestRow.PLACEMENT_ID).trim(),
    CANDIDATE_NAME: latestRow?.CANDIDATE_NAME ?? null,
    CANDIDATE_EMAIL: latestRow?.CANDIDATE_EMAIL ?? null,
    START_DATE: ownershipDateOnlyOrNull(latestRow?.START_DATE),
    // Temporary: tentative end date + 1. Overwritten to the extension's START_DATE later, keyed by
    // CONTRACT_ID (see overwriteOwnershipChangeLogEffectiveDatesFromExtensions).
    OWNERSHIP_EFFECTIVE_DATE: addOneDayToDateOnly(tentative),
    END_DATE_PREVIOUS_OWNER: ownershipDateOnlyOrNull(tentative),
    CHANGE_REASON_NOTES: null,
    STATUS_REMARKS: null,
    EDITED_BY: null,
  };
}

/**
 * Context for ownership logs across consecutive placements on the same CONTRACT_ID.
 *
 * Both dates come from the NEW placement's START_DATE — the handover happens when the new
 * placement begins, not when the previous segment's tentative end falls:
 *   OWNERSHIP_EFFECTIVE_DATE          = next.START_DATE       (the new owner's first day)
 *   END_DATE_PREVIOUS_OWNER = next.START_DATE - 1   (the previous owner's last day)
 * so the two are always adjacent. This differs from the same-placement path
 * (buildOwnershipChangeLogContext), which uses that placement's TENTATIVE_END_DATE / TENTATIVE_END_DATE + 1.
 *
 * Deliberately NOT derived from the previous placement's END/TENTATIVE: an ownership row is stamped
 * with the NEW placement's PLACEMENT_ID, so dating it from the previous segment mixed two
 * placements into one row (e.g. placement 1465103 carried START_DATE 2026-09-12 with
 * OWNERSHIP_EFFECTIVE_DATE 2026-06-14, three months before its own placement started).
 */
// eslint-disable-next-line no-unused-vars -- previousRow kept for signature parity with the
// same-placement builder; both dates now come from nextRow alone.
function buildContractOwnershipChangeLogContext(nextRow, previousRow, nowIso) {
  const nextStart = ownershipDateOnlyOrNull(nextRow?.START_DATE);
  return {
    LAST_UPDATED: nowIso,
    SKU_NO: ownershipDisplayValueOrNull(nextRow?.SKU_NUMBER),
    CONTRACT_ID: ownershipDisplayValueOrNull(nextRow?.CONTRACT_ID),
    PLACEMENT_ID: nextRow?.PLACEMENT_ID == null ? null : String(nextRow.PLACEMENT_ID).trim(),
    CANDIDATE_NAME: nextRow?.CANDIDATE_NAME ?? null,
    CANDIDATE_EMAIL: nextRow?.CANDIDATE_EMAIL ?? null,
    START_DATE: nextStart,
    END_DATE_PREVIOUS_OWNER: subtractOneDayFromDateOnly(nextStart),
    OWNERSHIP_EFFECTIVE_DATE: nextStart,
    CHANGE_REASON_NOTES: OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN,
    STATUS_REMARKS: null,
    EDITED_BY: null,
  };
}

/**
 * Build ownership_change_logs rows for one latest-vs-previous pair using a prebuilt context.
 */
function buildOwnershipChangeLogRowsWithContext(latestRow, previousRow, ctx) {
  if (!latestRow || !previousRow || !ctx) return [];
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
  return buildOwnershipChangeLogRowsWithContext(latestRow, previousRow, ctx);
}

/**
 * Ownership logs for consecutive placements under the same CONTRACT_ID (e.g. extension chain
 * ONSITE_AM handovers). Dates come from the NEW placement's START_DATE (effective = START_DATE,
 * previous owner ends START_DATE - 1); CHANGE_REASON_NOTES marks CONTRACT_CHAIN so the placement
 * date overwrite applies the chain rule to these rows instead of the tentative-based one.
 */
function buildContractOwnershipChangeLogRows(latestRow, previousRow, lastUpdatedIso) {
  if (!latestRow || !previousRow) return [];
  // Callers that already know the deal row's own LAST_UPDATED pass it in, so the log row carries the
  // SAME timestamp as the deal-sheet row that caused it (insert-time path). The scheduled scan omits
  // it and falls back to scan time, as before.
  const nowIso =
    typeof lastUpdatedIso === "string" && lastUpdatedIso.trim() !== ""
      ? lastUpdatedIso.trim()
      : new Date().toISOString();
  const ctx = buildContractOwnershipChangeLogContext(latestRow, previousRow, nowIso);
  return buildOwnershipChangeLogRowsWithContext(latestRow, previousRow, ctx);
}

/**
 * Latest row per placement for a specific set of CONTRACT_IDs (ownership scan columns).
 * Scoped lookup — the table-wide equivalent is fetchLatestOwnershipRowsPerContractPlacement.
 * @param {string[]} contractIds
 * @returns {Promise<object[]>}
 */
async function fetchLatestOwnershipRowsForContractIds(contractIds, options = {}) {
  if (!contractIds || contractIds.length === 0) return [];
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const uniq = [];
  const seen = new Set();
  for (const raw of contractIds) {
    if (raw == null) continue;
    const cid = String(raw).trim().toUpperCase();
    if (cid === "" || seen.has(cid)) continue;
    seen.add(cid);
    uniq.push(cid);
  }
  if (uniq.length === 0) return [];

  const unionParts = buildActiveChangeScanUnionParts(datasetId);
  const out = [];
  const chunkSize = 500;
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const inList = chunk.map((v) => `'${escapeSqlString(v)}'`).join(", ");
    const sql = `WITH all_rows AS (
                   ${unionParts.join("\n                   UNION ALL\n                   ")}
                 ),
                 ranked AS (
                   SELECT
                     *,
                     ROW_NUMBER() OVER (
                       PARTITION BY UPPER(TRIM(CAST(CONTRACT_ID AS STRING))), CAST(PLACEMENT_ID AS STRING)
                       ORDER BY LAST_UPDATED DESC NULLS LAST
                     ) AS rn
                   FROM all_rows
                   WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
                     AND PLACEMENT_ID IS NOT NULL
                     AND UPPER(TRIM(CAST(CONTRACT_ID AS STRING))) IN (${inList})
                 )
                 SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1`;
    const rows = await queryObjects(sql, 100000);
    for (const raw of rows) out.push(stripRateChangeHistoryMetaFields(raw));
  }
  return out;
}

/**
 * Build CONTRACT_CHAIN ownership log rows for rows that were JUST inserted, without waiting for the
 * next scheduled scan.
 *
 * Why this exists: the scheduled ownership scan runs once at the END of a trigger run and reads the
 * deal-sheet tables with SQL. A new extension inserted on a late submittal page (or on a run that
 * stops at max_pages) is not part of that scan's pair set, so its handover row only appears on a
 * LATER run — hours after the deal itself is visible to users. In that window the deal sheet shows
 * an extension whose ownership_change_logs entry does not exist yet, which reads as a data bug.
 *
 * The fix is to build the pair from the row we already hold in memory: the freshly-inserted row is
 * the chain's NEW segment, and its PREVIOUS segment is read back per CONTRACT_ID (a scoped lookup,
 * not a table-wide scan). The in-memory row also supplies LAST_UPDATED, so the log row carries the
 * same timestamp as the deal row that caused it.
 *
 * Safe to run alongside the scheduled scan: insertOwnershipChangeLogBatch dedupes on
 * (placement, role, new owner, previous owner), so whichever path runs second inserts nothing.
 *
 * @param {object[]} insertedRows - fully-derived rows exactly as written (insertResult.finalRows)
 * @returns {Promise<{built:number, inserted:number, contractIds:number, errorBatches:number}>}
 */
async function insertContractChainOwnershipLogsForInsertedRows(insertedRows, options = {}, deps = {}) {
  // Injected in tests so the pairing/stamping logic can be exercised without BigQuery.
  const fetchStoredRows =
    typeof deps.fetchLatestOwnershipRowsForContractIds === "function"
      ? deps.fetchLatestOwnershipRowsForContractIds
      : fetchLatestOwnershipRowsForContractIds;
  const insertLogBatch =
    typeof deps.insertOwnershipChangeLogBatch === "function"
      ? deps.insertOwnershipChangeLogBatch
      : insertOwnershipChangeLogBatch;

  const empty = { built: 0, inserted: 0, contractIds: 0, errorBatches: 0 };
  if (!insertedRows || insertedRows.length === 0) return empty;

  // Only rows that can actually form a chain segment: both a CONTRACT_ID and a PLACEMENT_ID.
  const newRowsByContract = new Map();
  for (const row of insertedRows) {
    const cid = row?.CONTRACT_ID == null ? "" : String(row.CONTRACT_ID).trim().toUpperCase();
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    if (cid === "" || pid === "") continue;
    if (!newRowsByContract.has(cid)) newRowsByContract.set(cid, []);
    newRowsByContract.get(cid).push(row);
  }
  if (newRowsByContract.size === 0) return empty;

  const contractIds = [...newRowsByContract.keys()];
  const storedRows = await fetchStoredRows(contractIds, {
    datasetId: options.dealSheetDatasetId,
  });

  // Stored rows win over the in-memory copy of the SAME placement (the stored row went through the
  // same derivation and may already carry a later append), so seed the map with stored rows first
  // and only add an in-memory row when its placement is not there yet.
  const rowsByContract = new Map();
  const seenPlacementByContract = new Map();
  for (const row of storedRows) {
    const cid = row?.CONTRACT_ID == null ? "" : String(row.CONTRACT_ID).trim().toUpperCase();
    const pid = row?.PLACEMENT_ID == null ? "" : String(row.PLACEMENT_ID).trim();
    if (cid === "" || pid === "") continue;
    if (!rowsByContract.has(cid)) {
      rowsByContract.set(cid, []);
      seenPlacementByContract.set(cid, new Set());
    }
    rowsByContract.get(cid).push(row);
    seenPlacementByContract.get(cid).add(pid);
  }

  const lastUpdatedByPlacement = new Map();
  for (const [cid, rows] of newRowsByContract) {
    if (!rowsByContract.has(cid)) {
      rowsByContract.set(cid, []);
      seenPlacementByContract.set(cid, new Set());
    }
    const seenPids = seenPlacementByContract.get(cid);
    for (const row of rows) {
      const pid = String(row.PLACEMENT_ID).trim();
      // The deal row's own LAST_UPDATED, so the log row is stamped with the same instant.
      const lu = row?.LAST_UPDATED;
      const luStr = lu == null ? "" : String(lu.value ?? lu).trim();
      if (luStr !== "") lastUpdatedByPlacement.set(`${cid}|${pid}`, luStr);
      if (seenPids.has(pid)) continue;
      seenPids.add(pid);
      rowsByContract.get(cid).push(row);
    }
  }

  const allRows = [];
  for (const rows of rowsByContract.values()) allRows.push(...rows);

  const pairs = buildConsecutiveContractPlacementPairs(allRows, ownershipChangeRolesDiffer);
  if (pairs.size === 0) {
    logDetail(
      `[ownership change logs] insert-time contract chain: contracts=${contractIds.length} pairs=0 (no ownership diff)`
    );
    return { ...empty, contractIds: contractIds.length };
  }

  // Only pairs whose NEW segment is one of the rows we just inserted — an older pair on the same
  // contract is the scheduled scan's job and may already be logged.
  const insertedPlacementKeys = new Set();
  for (const [cid, rows] of newRowsByContract) {
    for (const row of rows) insertedPlacementKeys.add(`${cid}|${String(row.PLACEMENT_ID).trim()}`);
  }

  const logRows = [];
  for (const { latest, previous } of pairs.values()) {
    const cid = String(latest.CONTRACT_ID).trim().toUpperCase();
    const key = `${cid}|${String(latest.PLACEMENT_ID).trim()}`;
    if (!insertedPlacementKeys.has(key)) continue;
    logRows.push(...buildContractOwnershipChangeLogRows(latest, previous, lastUpdatedByPlacement.get(key)));
  }

  if (logRows.length === 0) {
    logDetail(
      `[ownership change logs] insert-time contract chain: contracts=${contractIds.length} pairs=${pairs.size} builtRows=0`
    );
    return { ...empty, contractIds: contractIds.length };
  }

  const result = await insertLogBatch(logRows, 0, {
    datasetId: options.logDatasetId,
    tableId: options.logTableId,
  });
  logDetail(
    `[ownership change logs] insert-time contract chain: contracts=${contractIds.length} pairs=${pairs.size} builtRows=${logRows.length} inserted=${result.inserted}`
  );
  return {
    built: logRows.length,
    inserted: result.inserted,
    contractIds: contractIds.length,
    errorBatches: result.errorBatches,
  };
}

/**
 * Build the recruiter-handover ownership log rows for an explicit set of deal rows (each a
 * DEAL_TYPE=DEAL carrying the in-memory __PREV_RECRUITER_EMAIL captured by
 * applyPreviousRecruiterOnRecruiterChange, differing from ASSIGNMENT_RECRUITER_EMAIL). Builds:
 *   (1) OWNERSHIP_ROLE=RECRUITER — PREVIOUS_OWNER = previous recruiter, NEW_OWNER = current recruiter.
 *   (2) the vacated hierarchy role — if the CURRENT recruiter used to sit in the PREVIOUS recruiter's
 *       manager chain (matched by emp-no), PREVIOUS_OWNER = current recruiter, NEW_OWNER = 'NA'.
 * OWNERSHIP_EFFECTIVE_DATE / END_DATE_PREVIOUS_OWNER come from buildOwnershipChangeLogContext (tentative+1 /
 * tentative), so the extension effective-date overwrite applies here identically.
 *
 * Source is the in-memory row, NOT a deal-sheet column: PREVIOUS_RECRUITER_* is no longer written to
 * the deal sheet, so there is no table-wide scan for handovers — a handover is logged when the sync
 * observes the recruiter change on an update-append (or via the single-placement refresh endpoint).
 */
async function buildRecruiterHandoverOwnershipLogRows(inputRows, deps = {}) {
  const rows = (inputRows || []).filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (String(row.DEAL_TYPE || "").trim().toUpperCase() !== "DEAL") return false;
    const prev = row.__PREV_RECRUITER_EMAIL == null ? "" : String(row.__PREV_RECRUITER_EMAIL).trim();
    const cur = row.ASSIGNMENT_RECRUITER_EMAIL == null ? "" : String(row.ASSIGNMENT_RECRUITER_EMAIL).trim();
    return prev !== "" && prev.toLowerCase() !== cur.toLowerCase();
  });
  if (rows.length === 0) return [];

  // Resolve each placement's PREVIOUS recruiter manager chain (same anchor/direction as the deal
  // hierarchy) so we can locate the role the CURRENT recruiter used to hold (to vacate it).
  const directoryFetchFn = deps.directoryFetchFn ?? fetchEmployeeDirectoryByEmails;
  const hierarchyFetchFn = deps.hierarchyFetchFn ?? fetchHierarchyLevelChainsByKey;

  const emails = [];
  const emailSeen = new Set();
  for (const row of rows) {
    const norm = String(row.__PREV_RECRUITER_EMAIL).trim().toLowerCase();
    if (!norm || emailSeen.has(norm)) continue;
    emailSeen.add(norm);
    emails.push(norm);
  }
  const directoryByEmail = await directoryFetchFn(emails);

  const targets = [];
  rows.forEach((row, index) => {
    const norm = String(row.__PREV_RECRUITER_EMAIL).trim().toLowerCase();
    const externalId = directoryByEmail.get(norm)?.externalId;
    if (!externalId) return;
    targets.push({ key: String(index), externalId, anchorDate: row?.NEW_HIRE_DATE ?? null });
  });
  const levelsByKey =
    targets.length > 0 ? await hierarchyFetchFn(targets, { direction: "on_or_before" }) : new Map();

  const nowIso = new Date().toISOString();
  const out = [];
  rows.forEach((row, index) => {
    const ctx = buildOwnershipChangeLogContext(row, nowIso);

    // (1) recruiter handover
    out.push({
      ...ctx,
      OWNERSHIP_ROLE: "RECRUITER",
      NEW_OWNER_NAME: ownershipDisplayValueOrNull(row.ASSIGNMENT_RECRUITER),
      NEW_OWNER_EMP_NO: ownershipDisplayValueOrNull(row.RECRUITER_EMP_NO),
      PREVIOUS_OWNER_NAME: ownershipDisplayValueOrNull(row.__PREV_RECRUITER_NAME),
      PREVIOUS_OWNER_EMP_NO: ownershipDisplayValueOrNull(row.__PREV_RECRUITER_EMP_NO),
    });

    // (2) vacated role — where the current recruiter (by emp-no) sat in the previous chain
    const newRecruiterEmp = normalizeExtensionRunrateBackfillValue(row.RECRUITER_EMP_NO);
    const newEmpKey = newRecruiterEmp == null ? "" : String(newRecruiterEmp).trim().toUpperCase();
    const levelRows = levelsByKey.get(String(index));
    if (newEmpKey !== "" && levelRows) {
      const filled = new Set();
      for (const levelRow of levelRows) {
        const column = resolveHierarchyColumnForTitle(levelRow?.manager_title);
        if (!column || filled.has(column)) continue;
        const target = DEAL_RECRUITER_HIERARCHY_TARGETS.find((t) => t.column === column);
        if (!target) continue;
        filled.add(column);
        const empNo = normalizeExtensionRunrateBackfillValue(levelRow?.manager_employee_id);
        if (empNo != null && String(empNo).trim().toUpperCase() === newEmpKey) {
          out.push({
            ...ctx,
            OWNERSHIP_ROLE: target.column,
            NEW_OWNER_NAME: "NA",
            NEW_OWNER_EMP_NO: "NA",
            PREVIOUS_OWNER_NAME: ownershipDisplayValueOrNull(row.ASSIGNMENT_RECRUITER),
            PREVIOUS_OWNER_EMP_NO: ownershipDisplayValueOrNull(row.RECRUITER_EMP_NO),
          });
          break;
        }
      }
    }
  });

  logDetail(`[ownership handover] built log rows=${out.length}`);
  return out;
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
    logDetail(`[ownership change logs] [BigQuery insertAll] SKIP: no rows to insert`);
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
    logDetail(`[ownership change logs] dedupe(same batch): dropped=${droppedDupBatch} remaining=${deduped.length}`);
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
      logDetail(`[ownership change logs] [BigQuery insertAll] dedupe(existing in log table): skipped=${skipped} remaining=${deduped.length}`);
    }
  }

  if (!deduped.length) {
    logDetail(`[ownership change logs] [BigQuery insertAll] SKIP: nothing left after dedupe`);
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
  logDetail(
    `[ownership change logs] [BigQuery insertAll] ${hasErrors ? "PARTIAL" : "OK"} attempted=${result.attempted} inserted=${result.inserted}`
  );
  return { inserted: result.inserted, attempted: result.attempted, errorBatches: hasErrors ? 1 : 0 };
}

/**
 * Overwrite OWNERSHIP_EFFECTIVE_DATE on ownership_change_logs rows once a real extension exists for the same
 * CONTRACT_ID: set OWNERSHIP_EFFECTIVE_DATE to the earliest EXTENSION START_DATE for that contract (the
 * handover became effective when the extension started, replacing the temporary tentative+1 date).
 * Idempotent — only touches rows whose OWNERSHIP_EFFECTIVE_DATE differs from the resolved extension date.
 */
/**
 * Sync CANDIDATE_NAME / CANDIDATE_EMAIL onto ownership_change_logs from the LATEST deal-sheet row of
 * each placement. The deal sheet appends a new row when a candidate's name/email changes, but the
 * ownership log must keep ONE row per (placement, role) — so this OVERWRITES the existing log rows in
 * place (matched by PLACEMENT_ID), rather than adding new ones. Only touches rows whose stored name/
 * email actually differs (no no-op DML).
 */
async function overwriteOwnershipChangeLogCandidateInfoFromDealSheet(options = {}) {
  const dealSheetDatasetId =
    typeof options.dealSheetDatasetId === "string" && options.dealSheetDatasetId.trim() !== ""
      ? options.dealSheetDatasetId.trim()
      : config.datasetId;
  const logDatasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.ownershipChangeLogDatasetId;
  const logTableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : config.ownershipChangeLogTableId;

  // Base union lacks CANDIDATE_NAME / LAST_UPDATED — project them so we can pick the latest row.
  const unionSql = buildActiveDealSheetsUnionSql(dealSheetDatasetId, undefined, [
    "CANDIDATE_NAME",
    "LAST_UPDATED",
  ]);

  const sql = `
    UPDATE \`${config.projectId}.${logDatasetId}.${logTableId}\` o
    SET o.CANDIDATE_NAME = latest.CANDIDATE_NAME, o.CANDIDATE_EMAIL = latest.CANDIDATE_EMAIL
    FROM (
      SELECT placement_id_norm, CANDIDATE_NAME, CANDIDATE_EMAIL FROM (
        SELECT
          TRIM(CAST(PLACEMENT_ID AS STRING)) AS placement_id_norm,
          CANDIDATE_NAME,
          CANDIDATE_EMAIL,
          ROW_NUMBER() OVER (
            PARTITION BY TRIM(CAST(PLACEMENT_ID AS STRING))
            ORDER BY LAST_UPDATED DESC NULLS LAST
          ) AS rn
        FROM (${unionSql})
        WHERE PLACEMENT_ID IS NOT NULL AND TRIM(CAST(PLACEMENT_ID AS STRING)) != ''
      )
      WHERE rn = 1
    ) latest
    WHERE o.PLACEMENT_ID IS NOT NULL
      AND TRIM(CAST(o.PLACEMENT_ID AS STRING)) = latest.placement_id_norm
      AND (
        IFNULL(o.CANDIDATE_NAME, '') != IFNULL(latest.CANDIDATE_NAME, '')
        OR IFNULL(o.CANDIDATE_EMAIL, '') != IFNULL(latest.CANDIDATE_EMAIL, '')
      )
  `;

  const [job] = await bigquery.createQueryJob({ query: sql });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  const updated = meta?.dmlStats?.updatedRowCount ?? null;
  logDetail(
    `[ownership change logs] candidate name/email overwrite from deal sheet: updatedRows=${updated == null ? "n/a" : updated}`
  );
  return { updated: updated == null ? null : Number(updated) };
}

/**
 * Keep deal-sheet OWNERSHIP_EFFECTIVE_DATE aligned with ownership_change_logs for recruiter-change rows:
 * OWNERSHIP_EFFECTIVE_DATE = TENTATIVE_END_DATE + 1 day. Only touches rows that already carry an OWNERSHIP_EFFECTIVE_DATE
 * (stamped on recruiter change), so ordinary rows stay null. Idempotent — repairs rows previously
 * overwritten to a wrong CONTRACT_ID MIN(extension START_DATE). Deliberate in-place UPDATE of the
 * otherwise append-only deal sheet.
 */
async function overwriteDealSheetEffectiveDatesFromTentative(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  let totalUpdated = 0;

  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const sql = `
      UPDATE \`${config.projectId}.${datasetId}.${tableId}\` d
      SET OWNERSHIP_EFFECTIVE_DATE = DATE_ADD(d.TENTATIVE_END_DATE, INTERVAL 1 DAY)
      WHERE d.OWNERSHIP_EFFECTIVE_DATE IS NOT NULL
        AND d.TENTATIVE_END_DATE IS NOT NULL
        AND d.OWNERSHIP_EFFECTIVE_DATE IS DISTINCT FROM DATE_ADD(d.TENTATIVE_END_DATE, INTERVAL 1 DAY)
    `;
    const [job] = await bigquery.createQueryJob({ query: sql });
    await job.getQueryResults();
    totalUpdated += Number(job.metadata?.statistics?.query?.dmlStats?.updatedRowCount ?? 0);
  }

  logDetail(`[deal sheet] OWNERSHIP_EFFECTIVE_DATE overwrite from tentative+1: updatedRows=${totalUpdated}`);
  return { updated: totalUpdated };
}

/** @deprecated Use overwriteDealSheetEffectiveDatesFromTentative — extension MIN START overwrite removed. */
async function overwriteDealSheetEffectiveDatesFromExtensions(options = {}) {
  return overwriteDealSheetEffectiveDatesFromTentative(options);
}

/**
 * Pure expected deal-sheet / ownership OWNERSHIP_EFFECTIVE_DATE for a recruiter-change row:
 * TENTATIVE_END_DATE + 1 calendar day (YYYY-MM-DD), else null. Never extension START_DATE.
 */
function dealSheetEffectiveDateFromTentative(tentativeDate) {
  return addOneDayToDateOnly(tentativeDate);
}

/**
 * One-time backfill: enforce hierarchy NAME/EMP_NO consistency on existing active rows. Wherever a
 * hierarchy NAME is null/blank/"NA" but its *_EMP_NO still holds a real value, set the emp-no to "NA"
 * (name is master — mirrors applyHierarchyNameEmpConsistency). Idempotent: steady state updates 0 rows.
 * @param {object} [options] - { datasetId }
 * @returns {Promise<{updated:number}>}
 */
async function backfillHierarchyEmpNoNaForActive(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const nameIsBlankOrNa = (nameCol) =>
    `(${nameCol} IS NULL OR TRIM(CAST(${nameCol} AS STRING)) = '' OR UPPER(TRIM(CAST(${nameCol} AS STRING))) = 'NA')`;
  const empIsPopulated = (empCol) =>
    `${empCol} IS NOT NULL AND UPPER(TRIM(CAST(${empCol} AS STRING))) NOT IN ('', 'NA')`;

  const setClauses = HIERARCHY_NAME_EMP_PAIRS.map(
    ({ column, empNoColumn }) =>
      `${empNoColumn} = CASE WHEN ${nameIsBlankOrNa(column)} AND (${empIsPopulated(empNoColumn)}) THEN 'NA' ELSE ${empNoColumn} END`
  );
  const whereClauses = HIERARCHY_NAME_EMP_PAIRS.map(
    ({ column, empNoColumn }) => `(${nameIsBlankOrNa(column)} AND (${empIsPopulated(empNoColumn)}))`
  );

  let totalUpdated = 0;
  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    const sql = `
      UPDATE \`${config.projectId}.${datasetId}.${tableId}\`
      SET ${setClauses.join(",\n          ")}
      WHERE ${whereClauses.join("\n         OR ")}
    `;
    const [job] = await bigquery.createQueryJob({ query: sql });
    await job.getQueryResults();
    totalUpdated += Number(job.metadata?.statistics?.query?.dmlStats?.updatedRowCount ?? 0);
  }
  logDetail(`[deal sheet] hierarchy emp-no NA consistency backfill: updatedRows=${totalUpdated}`);
  return { updated: totalUpdated };
}

/**
 * One-time backfill: recompute DELIVERY_POC on existing active rows using the corrected priority
 * (which now includes AVP and DELIVERY_DIRECTOR). Only rows where AVP or DELIVERY_DIRECTOR is present
 * can change, so those are the only candidates fetched. For each changed row DELIVERY_POC /
 * DELIVERY_POC_EMP_NO / DELIVERY_POC_EMAIL are overwritten (a one-time correction to the frozen POC).
 * @param {object} [options] - { datasetId }
 * @param {object} [deps] - { fetchEmailsFn }
 * @returns {Promise<{updated:number}>}
 */
async function backfillDeliveryPocForActive(options = {}, deps = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const fetchEmailsFn = deps.fetchEmailsFn ?? fetchDeliveryPocEmails;

  const available = (c) =>
    `(${c} IS NOT NULL AND TRIM(CAST(${c} AS STRING)) != '' AND UPPER(TRIM(CAST(${c} AS STRING))) != 'NA')`;

  let totalUpdated = 0;
  for (const tableId of ACTIVE_DEAL_SHEET_TABLE_IDS) {
    // Column set is per table: Canada has no AVP / AVP_EMP_NO (its hierarchy tops out at VP), so
    // naming them here failed the whole run with "Unrecognized name: AVP". Health and locums keep
    // the full priority list. See DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.
    const missing = DEAL_SHEET_MISSING_COLUMNS_BY_TABLE.get(tableId) ?? new Set();
    const pocCols = [];
    for (const slot of DELIVERY_POC_PRIORITY) {
      if (missing.has(slot.nameCol)) continue;
      pocCols.push(slot.nameCol, slot.empCol);
    }
    const selectCols = [
      ...new Set([
        "ID",
        "DELIVERY_POC",
        "DELIVERY_POC_EMP_NO",
        "DELIVERY_POC_EMAIL",
        "ASSIGNMENT_RECRUITER_EMAIL",
        ...pocCols,
      ]),
    ].join(", ");
    // The WHERE mirrors the same rule: a table without AVP filters on DELIVERY_DIRECTOR alone.
    const whereParts = [];
    if (!missing.has("AVP")) whereParts.push(available("AVP"));
    whereParts.push(available("DELIVERY_DIRECTOR"));

    const fqn = `\`${config.projectId}.${datasetId}.${tableId}\``;
    const rows = await queryObjects(
      `SELECT ${selectCols} FROM ${fqn} WHERE ${whereParts.join(" OR ")}`,
      1000000
    );

    const updates = [];
    const empNos = [];
    const names = [];
    for (const row of rows || []) {
      const picked = pickDeliveryPocForRow(row);
      if (!picked) continue;
      const curName = row.DELIVERY_POC == null ? "" : String(row.DELIVERY_POC).trim();
      const curEmp = row.DELIVERY_POC_EMP_NO == null ? "" : String(row.DELIVERY_POC_EMP_NO).trim();
      if (curName === picked.name && curEmp === (picked.empNo ?? "")) continue; // unchanged
      updates.push({ id: row.ID, picked, recruiterEmail: row.ASSIGNMENT_RECRUITER_EMAIL, email: null });
      if (!picked.isRecruiter) {
        if (picked.empNo) empNos.push(picked.empNo);
        else names.push(picked.name);
      }
    }
    if (updates.length === 0) continue;

    const { byEmp, byName } = await fetchEmailsFn(empNos, names);
    for (const u of updates) {
      const p = u.picked;
      if (p.isRecruiter) {
        u.email = isAvailableHierarchyValue(u.recruiterEmail) ? String(u.recruiterEmail).trim() : null;
      } else if (p.empNo && byEmp.has(p.empNo)) {
        u.email = byEmp.get(p.empNo);
      } else if (byName.has(p.name.toLowerCase())) {
        u.email = byName.get(p.name.toLowerCase());
      } else {
        u.email = null;
      }
    }

    const sqlLit = (v) => (v == null ? "NULL" : `'${escapeSqlString(String(v))}'`);
    const chunkSize = 500;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      const structs = chunk.map(
        (u) =>
          `STRUCT(${sqlLit(u.id)} AS id, ${sqlLit(u.picked.name)} AS poc, ` +
          `${sqlLit(u.picked.empNo)} AS emp, ${sqlLit(u.email)} AS email)`
      );
      const sqlU = `
        UPDATE ${fqn} d
        SET DELIVERY_POC = s.poc, DELIVERY_POC_EMP_NO = s.emp, DELIVERY_POC_EMAIL = s.email
        FROM UNNEST([${structs.join(", ")}]) s
        WHERE CAST(d.ID AS STRING) = s.id
      `;
      const [job] = await bigquery.createQueryJob({ query: sqlU });
      await job.getQueryResults();
      totalUpdated += Number(job.metadata?.statistics?.query?.dmlStats?.updatedRowCount ?? 0);
    }
  }
  logDetail(`[deal sheet] DELIVERY_POC recompute backfill (AVP/DELIVERY_DIRECTOR): updatedRows=${totalUpdated}`);
  return { updated: totalUpdated };
}

/**
 * Recompute the derived EXT_OR_REHIRE_BY_RMG ("Extension/Rehire") column on every row of all 6 domain
 * deal sheet tables (active + ended). Must run as a post-sync pass, not at insert time: a brand-new
 * EXTENSION has to flip its PARENT DEAL row from blank to 'EXTENSION', and an extension's own value
 * moves REOFFERED -> REBOOKED when it starts. Idempotent — steady state updates 0 rows.
 * See extensionRehire.js for the full rule set.
 * @param {object} [options] - { datasetId }
 * @returns {Promise<{updated:number, byTable:Object<string,number>, runrateTableIds:string[]}>}
 */
async function backfillExtensionRehireForDealSheets(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const result = await backfillExtensionRehire(
    { projectId: config.projectId, datasetId },
    // Multi-statement script: bigquery.query returns the rows of the final SELECT (per-table counts).
    { queryFn: (sql) => queryObjects(sql, 100) }
  );

  const byTableStr = Object.entries(result.byTable)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  logDetail(
    `[deal sheet] EXT_OR_REHIRE_BY_RMG recompute: updatedRows=${result.updated} ${byTableStr} runrateHistory=${result.runrateTableIds.join(",") || "none"}`
  );
  return result;
}

/**
 * Fill inherited fields on EXTENSION rows whose parent DEAL was synced AFTER them.
 *
 * applyExtensionInheritForInsertRows only looks for the parent at insert time, so an extension that
 * arrives first is written with CONTRACT_ID / SKU_NUMBER / hierarchy / ops all null and nothing ever
 * goes back for it. Fill-if-empty, UPDATE-only, idempotent — see extensionParentBackfill.js.
 * @param {object} [options] - { datasetId }
 * @returns {Promise<{updated:number|null, byTable:Object<string,number>}>}
 */
async function backfillExtensionParentInheritForDealSheets(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  if (backfillExtensionParentInherit == null) {
    ({ backfillExtensionParentInherit } = require("./extensionParentBackfill"));
  }

  const result = await backfillExtensionParentInherit(
    { projectId: config.projectId, datasetId },
    // Multi-statement script: bigquery.query returns the rows of the final SELECT (per-table counts).
    { queryFn: (sql) => queryObjects(sql, 100) }
  );

  const byTableStr = Object.entries(result.byTable)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  logDetail(
    `[deal sheet] EXTENSION parent-deal late-arrival backfill: filledRows=${result.updated == null ? "n/a" : result.updated} ${byTableStr}`
  );
  return result;
}

/**
 * Fill RECRUITER_CLUSTER_REGION / CLIENT_CLUSTER_REGION / CLUSTER_TYPE on the cynet health deal sheet
 * (active + ended) with where each side sat AT THE TIME OF THE PLACEMENT, then rebuild the trace table
 * holding the full per-row reasoning. See clusterRegionResolver.js for the rules.
 *
 * FILL-IF-EMPTY: all three stay in MANUAL_COLUMNS and a hand-edited value is never overwritten, so
 * this is safe to re-run. Post-sync rather than insert-time, because the recruiter history and the
 * client cluster tables move independently of any one placement — a recruiter's region change has to
 * be picked up by rows that were inserted before it was recorded.
 * @param {object} [options] - { datasetId, skipTrace }
 * @returns {Promise<{updated:number|null, byTable:Object<string,number>, traceTableId:string|null}>}
 */
async function backfillClusterRegionsForDealSheets(options = {}) {
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const result = await backfillClusterRegions(
    { projectId: config.projectId, datasetId, skipTrace: options.skipTrace === true },
    // Multi-statement script: bigquery.query returns the rows of the final SELECT (per-table counts).
    { queryFn: (sql) => queryObjects(sql, 100) }
  );

  const byTableStr = Object.entries(result.byTable)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  logDetail(
    `[deal sheet] cluster/region fill: updatedRows=${result.updated == null ? "n/a" : result.updated} ${byTableStr} trace=${result.traceTableId || "skipped"}`
  );
  return result;
}

/**
 * Keep ownership_change_logs' placement dates in sync with the placement's CURRENT (latest)
 * deal-sheet row, matched by PLACEMENT_ID. Every row for that PLACEMENT_ID is overwritten, with the
 * two date columns following the row's own rule (both anchored on the SAME placement, so the two
 * are always adjacent):
 *
 *   CONTRACT_CHAIN rows (handover between consecutive placements of one contract):
 *     START_DATE               = latest deal-sheet START_DATE
 *     END_DATE_PREVIOUS_OWNER  = START_DATE - 1 day   (previous owner's last day)
 *     OWNERSHIP_EFFECTIVE_DATE           = START_DATE           (new owner's first day)
 *
 *   Every other row (ownership changed within one placement):
 *     START_DATE               = latest deal-sheet START_DATE
 *     END_DATE_PREVIOUS_OWNER  = latest deal-sheet TENTATIVE_END_DATE
 *     OWNERSHIP_EFFECTIVE_DATE           = TENTATIVE_END_DATE + 1 day
 *
 * This replaces the older CONTRACT_ID -> extension-START_DATE OWNERSHIP_EFFECTIVE_DATE overwrite for the log
 * table (they would otherwise fight each run). Only rows whose stored dates actually differ are
 * updated (IS DISTINCT FROM), so a steady state writes zero rows.
 */
async function overwriteOwnershipChangeLogDatesFromPlacements(options = {}) {
  const dealSheetDatasetId =
    typeof options.dealSheetDatasetId === "string" && options.dealSheetDatasetId.trim() !== ""
      ? options.dealSheetDatasetId.trim()
      : config.datasetId;
  const logDatasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.ownershipChangeLogDatasetId;
  const logTableId =
    typeof options.tableId === "string" && options.tableId.trim() !== ""
      ? options.tableId.trim()
      : config.ownershipChangeLogTableId;

  // START_DATE + PLACEMENT_ID are in the base union columns; TENTATIVE_END_DATE + LAST_UPDATED are not.
  const unionSql = buildActiveDealSheetsUnionSql(dealSheetDatasetId, undefined, [
    "TENTATIVE_END_DATE",
    "LAST_UPDATED",
  ]);

  const sql = `
    UPDATE \`${config.projectId}.${logDatasetId}.${logTableId}\` o
    SET
      START_DATE = p.start_date,
      END_DATE_PREVIOUS_OWNER = IF(
        o.CHANGE_REASON_NOTES = '${OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN}',
        p.chain_end_date_previous_owner,
        p.tentative_date
      ),
      OWNERSHIP_EFFECTIVE_DATE = IF(
        o.CHANGE_REASON_NOTES = '${OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN}',
        p.start_date,
        p.effective_date
      )
    FROM (
      SELECT * EXCEPT(rn) FROM (
        SELECT
          CAST(PLACEMENT_ID AS STRING) AS placement_id_norm,
          START_DATE AS start_date,
          TENTATIVE_END_DATE AS tentative_date,
          DATE_ADD(TENTATIVE_END_DATE, INTERVAL 1 DAY) AS effective_date,
          DATE_SUB(START_DATE, INTERVAL 1 DAY) AS chain_end_date_previous_owner,
          ROW_NUMBER() OVER (
            PARTITION BY CAST(PLACEMENT_ID AS STRING)
            ORDER BY LAST_UPDATED DESC NULLS LAST
          ) AS rn
        FROM (${unionSql})
        WHERE PLACEMENT_ID IS NOT NULL
      )
      WHERE rn = 1
    ) p
    WHERE o.PLACEMENT_ID IS NOT NULL
      AND CAST(o.PLACEMENT_ID AS STRING) = p.placement_id_norm
      -- Compare against the SAME targets the SET clause writes, per row type; otherwise a settled
      -- row would be rewritten on every run.
      AND (
        o.START_DATE IS DISTINCT FROM p.start_date
        OR o.END_DATE_PREVIOUS_OWNER IS DISTINCT FROM IF(
          o.CHANGE_REASON_NOTES = '${OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN}',
          p.chain_end_date_previous_owner,
          p.tentative_date
        )
        OR o.OWNERSHIP_EFFECTIVE_DATE IS DISTINCT FROM IF(
          o.CHANGE_REASON_NOTES = '${OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN}',
          p.start_date,
          p.effective_date
        )
      )
  `;

  const [job] = await bigquery.createQueryJob({ query: sql });
  await job.getQueryResults();
  const updated = job.metadata?.statistics?.query?.dmlStats?.updatedRowCount ?? null;
  logDetail(
    `[ownership change logs] date sync from placements (by PLACEMENT_ID): updatedRows=${updated == null ? "n/a" : updated}`
  );
  return { updated: updated == null ? null : Number(updated) };
}

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
    SET OWNERSHIP_EFFECTIVE_DATE = ext.ext_start_date
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
      AND (o.OWNERSHIP_EFFECTIVE_DATE IS NULL OR o.OWNERSHIP_EFFECTIVE_DATE != ext.ext_start_date)
  `;

  const [job] = await bigquery.createQueryJob({ query: sql });
  await job.getQueryResults();
  const meta = job.metadata?.statistics?.query;
  const updated = meta?.dmlStats?.updatedRowCount ?? null;
  logDetail(
    `[ownership change logs] effective-date overwrite from extensions: updatedRows=${updated == null ? "n/a" : updated}`
  );
  return { updated: updated == null ? null : Number(updated) };
}

/**
 * Produce the fully-derived deal-sheet row for an API response (e.g. refreshDealSheetByPlacementId's
 * `data`) WITHOUT writing to BigQuery — mirrors the field-derivation insertEnrichedDealSheetBatch
 * applies, so the response shows the same values the table would hold. When a baseline exists
 * (existing placement), manual columns are carried forward + frozen exactly like the update-append
 * path (so hierarchy/DELIVERY_POC/SKU reflect the stored frozen values, not a re-derivation);
 * always then runs the insert-time fill steps for any still-empty derived fields.
 * @param {object} row - enriched row (from buildEnrichedRowsFromDealSheetCandidates)
 * @param {object|null} baseline - latest existing BigQuery row for this placement, or null
 * @param {object} [options] - { datasetId, tableId } of the destination deal-sheet table
 */
async function finalizeDealSheetRowForResponse(row, baseline, options = {}) {
  if (!row || typeof row !== "object") return row;
  let current = row;
  if (baseline && typeof baseline === "object") {
    current = applyManualColumnsCarryForward(current, baseline).row;
    current = applyPreviousRecruiterOnRecruiterChange(current, baseline).row;
    current = applyTentativeDateFreeze(current, baseline).row;
    current = applyNewHireDateFreeze(current, baseline).row;
    current = applyExtensionDateFreeze(current, baseline).row;
    current = applyOfferTimeStartDateFreeze(current, baseline).row;
    // Match the update-append path: hierarchy is frozen/carried-forward, not re-derived.
    current = { ...current, __CARRIED_FORWARD_UPDATE: true };
  }
  let arr = [current];
  arr = await applyExtensionInheritForInsertRows(arr, options);
  arr = await applyDealRecruiterHierarchyForInsertRows(arr, options);
  arr = applyExtensionStartDatesForInsertRows(arr);
  arr = applyOriginalStartDateForDealRows(arr);
  arr = applyDidNotAcceptDateOverrides(arr);
  // Prior-ended-placement date override intentionally not applied — see insertEnrichedDealSheetBatch.
  arr = await applyOnsiteAmCsmHierarchyForRows(arr, options);
  arr = arr.map((row) => applyHierarchyNameEmpConsistency(row));
  arr = await applyDeliveryPocForInsertRows(arr, options);
  const finalized = arr[0];
  if (finalized && typeof finalized === "object" && "__CARRIED_FORWARD_UPDATE" in finalized) {
    delete finalized.__CARRIED_FORWARD_UPDATE;
  }
  return finalized;
}

module.exports = {
  escapeSqlString,
  queryObjects,
  runDml,
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
  buildLoadJobPayload,
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
  applyContractIdCarryForward,
  vacateSelfReferencedHierarchyRoles,
  normalizeHierarchyPersonName,
  applyManualColumnsCarryForward,
  applyTentativeDateFreeze,
  applyNewHireDateFreeze,
  applyOfferTimeStartDateFreeze,
  applyExtensionDateFreeze,
  applyExtensionStartDateForRow,
  applyExtensionStartDatesForInsertRows,
  applyOriginalStartDateForDealRows,
  applyDidNotAcceptDateOverrides,
  rowNeedsOfferRejectedExtensionEndedDates,
  fetchOfferRejectedExtensionEndedDatesByPlacementId,
  applyOfferRejectedExtensionEndedDatesForInsertRows,
  fetchNewHireDatesFromActiveTable,
  resolveNewHireDatesForEndedRows,
  computeDealSheetFirstInsertDateStamps,
  fetchContractIdsByDealSheetIds,
  fetchContractIdsForExtensions,
  fetchLegacyContractIdentityForDealRows,
  buildLegacyContractLookupKey,
  normalizeClientIdKeyPart,
  skuAllowedForPlacementStatus,
  legacyDealManualColumns,
  fetchEmployeeDirectoryByEmails,
  buildActiveDealSheetsUnionSql,
  formatDateOnlyForSql,
  EXTENSION_RUNRATE_HIERARCHY_COLUMNS,
  EXTENSION_RUNRATE_MANUAL_COLUMNS,
  DEAL_SHEET_MISSING_COLUMNS_BY_TABLE,
  resolveDealSheetMissingColumns,
  RATE_CHANGE_LOG_EXCLUDED_TABLE_IDS,
  buildActiveDealSheetSchemaSafeUnionParts,
  DELIVERY_POC_PRIORITY,
  RUNRATE_HIERARCHY_MISSING_COLUMNS_BY_TABLE,
  ACTIVE_CHANGE_SCAN_MISSING_COLUMNS_BY_TABLE,
  buildActiveChangeScanColumnList,
  buildActiveChangeScanUnionParts,
  RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE,
  RUNRATE_MANUAL_MISSING_COLUMNS_BY_TABLE,
  resolveExtensionRunrateHierarchyColumns,
  EXTENSION_RUNRATE_ELIGIBLE_PLACEMENT_STATUSES,
  isExtensionRunrateEligiblePlacementStatus,
  buildRunrateEligiblePlacementStatusSqlPredicate,
  EXTENSION_PARENT_DEAL_INHERIT_COLUMNS,
  PARENT_DEAL_INHERIT_MISSING_COLUMNS_BY_TABLE,
  PARENT_DEAL_INHERIT_EXTRA_COLUMNS_BY_TABLE,
  resolveExtensionParentDealInheritColumns,
  SQL_CANDIDATE_EMAIL_NORM,
  SQL_PHONE_NUMBER_NORM,
  rowNeedsExtensionInsertBackfill,
  rowNeedsExtensionRunrateBackfill,
  fetchExtensionParentDealInheritByPlacementId,
  fetchExtensionPriorExtensionInheritByPlacementId,
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
  filterInorganicHierarchyAgainstFrozenOrganic,
  buildInorganicHierarchyLogDedupeKey,
  fetchExistingInorganicHierarchyLogKeysSet,
  resolveInorganicHierarchyLogRows,
  fetchActiveExtensionRowsForInorganic,
  fetchRunrateInorganicForExtensions,
  resolveExtensionInorganicLogRows,
  insertInorganicHierarchyLogBatch,
  fetchOnsiteAmCsmHierarchyByKey,
  applyOnsiteAmCsmHierarchyForRows,
  pickDeliveryPocForRow,
  pickInorganicRestrictedDeliveryPocForRow,
  applyDeliveryPocForInsertRows,
  fetchCsmHierarchyDivergenceCandidates,
  fetchRecruiterHierarchyReconciliation,
  buildInorganicCandidateFromReconciliation,
  buildOwnershipChangeLogRowsForHierarchyMoves,
  applyRecruiterHierarchyMovesToDealSheet,
  mergeInorganicHierarchyLogCandidates,
  fetchDealSheetOwnershipChangePairsFromActive,
  fetchContractOwnershipChangePairsFromActive,
  fetchContractSegmentRateChangePairsFromActive,
  buildRecruiterHandoverOwnershipLogRows,
  vacateDuplicatePersonHierarchyRoles,
  buildOwnershipChangeLogRows,
  buildContractOwnershipChangeLogRows,
  fetchLatestOwnershipRowsForContractIds,
  insertContractChainOwnershipLogsForInsertedRows,
  buildConsecutiveContractPlacementPairs,
  ownershipChangeRolesDiffer,
  contractSegmentRateFieldsDiffer,
  OWNERSHIP_CHANGE_REASON_CONTRACT_CHAIN,
  buildOwnershipChangeLogDedupeKey,
  fetchExistingOwnershipChangeLogKeysSet,
  insertOwnershipChangeLogBatch,
  overwriteOwnershipChangeLogEffectiveDatesFromExtensions,
  overwriteOwnershipChangeLogDatesFromPlacements,
  overwriteOwnershipChangeLogCandidateInfoFromDealSheet,
  overwriteDealSheetEffectiveDatesFromTentative,
  overwriteDealSheetEffectiveDatesFromExtensions,
  dealSheetEffectiveDateFromTentative,
  addOneDayToDateOnly,
  applyHierarchyNameEmpConsistency,
  backfillHierarchyEmpNoNaForActive,
  backfillDeliveryPocForActive,
  backfillExtensionRehireForDealSheets,
  backfillClusterRegionsForDealSheets,
  backfillExtensionParentInheritForDealSheets,
  applyPreviousRecruiterOnRecruiterChange,
  finalizeDealSheetRowForResponse,
};
