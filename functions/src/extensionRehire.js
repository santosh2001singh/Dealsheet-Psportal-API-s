/**
 * EXTENSION_REHIRE — derived "Extension/Rehire" column for the 6 domain deal sheet tables.
 *
 * The value describes where a placement sits in a candidate's history WITH ONE CLIENT:
 *
 *   DEAL_TYPE = DEAL
 *     - blank                 : first deal, nothing after it yet
 *     - EXTENSION             : this deal has since been extended (same client)
 *     - REHIRED               : candidate already existed (deal sheet OR run-rate) at a DIFFERENT
 *                               parent client before this deal, and this deal has no extension yet
 *   DEAL_TYPE = EXTENSION
 *     - REOFFERED             : 1st extension of the deal, not started yet (BOOKED / OFFERED, and
 *                               it stays REOFFERED if it ends up DID NOT START / DID NOT ACCEPT)
 *     - REBOOKED              : 1st extension of the deal that started (STARTED, and it stays
 *                               REBOOKED once it becomes ENDED / ENDED<30)
 *     - REBOOKED/EXTENSION    : 2nd+ extension of the same deal (extension on extension), whatever
 *                               its placement status is
 *
 * Chain identity ("same client") = candidate + client:
 *   candidate = CANDIDATE_NEXUS_ID (else CANDIDATE_EMAIL), client = CLIENT_ID (else PARENT_CLIENT_NAME).
 * This is the same identity CONTRACT_ID is allocated on (see contractIdResolver.buildContractMatchKey),
 * so it groups a DEAL with its EXTENSIONs exactly like CONTRACT_ID does — but it also works for the
 * run-rate-only placements whose extensions land here with no parent DEAL row at all.
 *
 * "Extension on extension" is counted per DEAL GENERATION: within a chain the units are ordered by
 * start date and each DEAL opens a new generation, so a chain whose deal only exists in the legacy
 * run-rate table (generation 0) still treats the first extension we hold as the 1st extension
 * (REOFFERED / REBOOKED), not as an extension-on-extension.
 *
 * A "unit" is one deal/extension event = one DEAL_SHEET_ID (PLACEMENT_ID when that is null). The deal
 * sheet is append-only, so a unit owns several rows; the unit's placement status is sticky (STARTED at
 * any point in its history wins) and every row of the unit is stamped with the same value.
 *
 * The whole thing is one idempotent multi-statement BigQuery job (see buildExtensionRehireSql): the
 * value is a pure function of the current table contents, so re-running changes nothing once settled.
 * Run from the post-sync maintenance pass — the parent DEAL row has to change (blank -> EXTENSION)
 * when a NEW extension arrives, which no insert-time rule can do.
 */

const config = require("./config");
const {
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  ENDED_DEAL_SHEET_TABLE_IDS,
} = require("./recruiterDomainTables");

/** BigQuery column name ("/" is not allowed in an identifier, so not EXTENSION/REHIRE). */
const EXTENSION_REHIRE_COLUMN = "EXTENSION_REHIRE";

const EXTENSION_REHIRE_VALUES = Object.freeze({
  EXTENSION: "EXTENSION",
  REOFFERED: "REOFFERED",
  REBOOKED: "REBOOKED",
  REBOOKED_EXTENSION: "REBOOKED/EXTENSION",
  REHIRED: "REHIRED",
});

/** All 6 domain deal sheet tables carry the column (active + ended). */
const EXTENSION_REHIRE_TABLE_IDS = Object.freeze([
  ...ACTIVE_DEAL_SHEET_TABLE_IDS,
  ...ENDED_DEAL_SHEET_TABLE_IDS,
]);

/**
 * Placement statuses that mean "the candidate actually started". ENDED / ENDED<30 are included so an
 * extension that already finished stays REBOOKED instead of falling back to REOFFERED. Everything
 * else (BOOKED, OFFERED, DID NOT START, DID NOT ACCEPT) counts as not-started -> REOFFERED.
 */
const STARTED_PLACEMENT_STATUSES = Object.freeze(["STARTED", "ACTIVE", "ENDED", "ENDED<30"]);
const STARTED_PLACEMENT_STATUS_SET = new Set(STARTED_PLACEMENT_STATUSES);

/** Run-rate rows worth treating as real history (mirrors bigQueryClient's run-rate predicate). */
const RUNRATE_ELIGIBLE_PLACEMENT_STATUSES = Object.freeze([
  "STARTED",
  "BOOKED",
  "ENDED",
  "ENDED<30",
]);

/** Historical run-rate tables searched for prior placements, one per domain. */
const RUNRATE_HISTORY_TABLE_IDS = Object.freeze([
  config.runrateTableId,
  config.runrateCanadaTableId,
  config.runrateLocumsTableId,
]);

function normalizeKey(value) {
  if (value == null) return "";
  return String(value).trim().toUpperCase().replace(/\s+/g, " ");
}

/** @returns {boolean} true when this placement status means the assignment started. */
function isStartedPlacementStatus(status) {
  const key = normalizeKey(status);
  return key !== "" && STARTED_PLACEMENT_STATUS_SET.has(key);
}

/**
 * Single source of truth for the classification, evaluated top-down. `js` reads a facts object,
 * `sql` reads the identically-named columns of the `units` CTE in buildExtensionRehireSql, so the
 * two can never disagree about order or spelling.
 *
 * Facts per unit:
 *   dealType                 - "DEAL" | "EXTENSION" | other/blank
 *   extensionRank            - 1 for the 1st extension of the deal generation, 2+ after that
 *   everStarted              - the unit reached a started status at any point in its history
 *   generationExtensionCount - extensions belonging to this DEAL (0 = not extended yet)
 *   hasPriorOtherClient      - candidate has earlier history at a different parent client
 */
const EXTENSION_REHIRE_RULES = Object.freeze([
  {
    value: EXTENSION_REHIRE_VALUES.REBOOKED_EXTENSION,
    js: (f) => f.dealType === "EXTENSION" && Number(f.extensionRank) >= 2,
    sql: "deal_type = 'EXTENSION' AND extension_rank >= 2",
  },
  {
    value: EXTENSION_REHIRE_VALUES.REBOOKED,
    js: (f) => f.dealType === "EXTENSION" && f.everStarted === true,
    sql: "deal_type = 'EXTENSION' AND ever_started",
  },
  {
    value: EXTENSION_REHIRE_VALUES.REOFFERED,
    js: (f) => f.dealType === "EXTENSION",
    sql: "deal_type = 'EXTENSION'",
  },
  {
    // Wins over REHIRED: once the new client's deal is extended it is an EXTENSION parent, and the
    // rehire is still readable from the extension rows below it.
    value: EXTENSION_REHIRE_VALUES.EXTENSION,
    js: (f) => f.dealType === "DEAL" && Number(f.generationExtensionCount) > 0,
    sql: "deal_type = 'DEAL' AND generation_extension_count > 0",
  },
  {
    value: EXTENSION_REHIRE_VALUES.REHIRED,
    js: (f) => f.dealType === "DEAL" && f.hasPriorOtherClient === true,
    sql: "deal_type = 'DEAL' AND has_prior_other_client",
  },
]);

/**
 * Pure classifier — the JS mirror of the generated SQL CASE.
 * @param {object} facts - see EXTENSION_REHIRE_RULES
 * @returns {string|null} column value, or null when the row must stay blank
 */
function classifyExtensionRehire(facts = {}) {
  const normalized = {
    dealType: normalizeKey(facts.dealType),
    extensionRank: facts.extensionRank == null ? 0 : Number(facts.extensionRank),
    everStarted: facts.everStarted === true,
    generationExtensionCount:
      facts.generationExtensionCount == null ? 0 : Number(facts.generationExtensionCount),
    hasPriorOtherClient: facts.hasPriorOtherClient === true,
  };
  for (const rule of EXTENSION_REHIRE_RULES) {
    if (rule.js(normalized)) return rule.value;
  }
  return null;
}

function escapeSqlString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function fqn(projectId, datasetId, tableId) {
  return `\`${projectId}.${datasetId}.${tableId}\``;
}

function sqlStringList(values) {
  return values.map((v) => `'${escapeSqlString(v)}'`).join(", ");
}

/** candidate identity: nexus id, else email. NULL when neither is usable. */
const CANDIDATE_KEY_SQL = `CASE
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END`;

/** parent-client identity used for REHIRED (name only — the run-rate side has no CLIENT_ID). */
const PARENT_CLIENT_KEY_SQL = `NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '')`;

/** SQL for the deal-sheet unit key; `alias` is the table alias holding DEAL_SHEET_ID/PLACEMENT_ID. */
function buildUnitKeySql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `CASE
        WHEN ${p}DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(${p}DEAL_SHEET_ID AS STRING))
        WHEN ${p}PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(${p}PLACEMENT_ID AS STRING))
      END`;
}

/** CASE expression producing the column value from the `units` CTE columns. */
function buildExtensionRehireCaseSql(indent = "        ") {
  const branches = EXTENSION_REHIRE_RULES.map(
    (rule) => `${indent}  WHEN ${rule.sql} THEN '${escapeSqlString(rule.value)}'`
  ).join("\n");
  return `CASE\n${branches}\n${indent}END`;
}

/**
 * Build the idempotent multi-statement job that recomputes EXTENSION_REHIRE on every row of every
 * deal sheet table. Statement order:
 *   1. ds_rows              — normalized union of the deal sheet tables (one row per stored row)
 *   2. ext_rehire_values    — one row per unit with its computed value (NULL = must be blank)
 *   3. ext_rehire_pending   — per-table count of rows whose stored value is about to change
 *   4. UPDATE per table     — stamps every row of the unit
 *   5. SELECT               — returns ext_rehire_pending as the job result
 *
 * @param {object} [options]
 * @param {string} [options.projectId]
 * @param {string} [options.datasetId]
 * @param {string[]} [options.tableIds] - deal sheet tables to read + update
 * @param {string[]} [options.runrateTableIds] - run-rate history tables that actually exist
 * @returns {{sql: string, tableIds: string[], runrateTableIds: string[]}}
 */
function buildExtensionRehireSql(options = {}) {
  const projectId =
    typeof options.projectId === "string" && options.projectId.trim() !== ""
      ? options.projectId.trim()
      : config.projectId;
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;
  const tableIds =
    Array.isArray(options.tableIds) && options.tableIds.length > 0
      ? [...options.tableIds]
      : [...EXTENSION_REHIRE_TABLE_IDS];
  const runrateTableIds = Array.isArray(options.runrateTableIds)
    ? [...new Set(options.runrateTableIds.filter((t) => typeof t === "string" && t.trim() !== ""))]
    : [];

  const dealSheetUnion = tableIds
    .map(
      (tableId) => `      SELECT
        '${escapeSqlString(tableId)}' AS table_id,
        ${buildUnitKeySql()} AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN (${sqlStringList(STARTED_PLACEMENT_STATUSES)}) AS status_started,
        ${CANDIDATE_KEY_SQL} AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN ${PARENT_CLIENT_KEY_SQL} IS NOT NULL THEN CONCAT('pc:', ${PARENT_CLIENT_KEY_SQL})
        END AS client_key,
        ${PARENT_CLIENT_KEY_SQL} AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        ${EXTENSION_REHIRE_COLUMN} AS current_value
      FROM ${fqn(projectId, datasetId, tableId)}`
    )
    .join("\n      UNION ALL\n");

  // Prior placements at OTHER parent clients. Deal-sheet units plus the legacy run-rate tables (a
  // candidate's first assignment often exists only there).
  const runrateHistoryUnion = runrateTableIds
    .map(
      (tableId) => `  UNION ALL
  SELECT
    ${CANDIDATE_KEY_SQL} AS candidate_key,
    ${PARENT_CLIENT_KEY_SQL} AS parent_client_key,
    START_DATE AS hist_start
  FROM ${fqn(projectId, datasetId, tableId)}
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN (${sqlStringList(RUNRATE_ELIGIBLE_PLACEMENT_STATUSES)})`
    )
    .join("\n");

  const updates = tableIds
    .map(
      (tableId) => `UPDATE ${fqn(projectId, datasetId, tableId)} t
SET ${EXTENSION_REHIRE_COLUMN} = v.value
FROM ext_rehire_values v
WHERE v.unit_key = ${buildUnitKeySql("t")}
  AND t.${EXTENSION_REHIRE_COLUMN} IS DISTINCT FROM v.value;`
    )
    .join("\n\n");

  const sql = `-- Recompute EXTENSION_REHIRE for every deal sheet row (idempotent; see extensionRehire.js).
CREATE TEMP TABLE ds_rows AS
  SELECT * FROM (
${dealSheetUnion}
  )
  WHERE unit_key IS NOT NULL;

CREATE TEMP TABLE ext_rehire_values AS
  WITH units AS (
    -- One row per deal/extension event. Identity + dates come from the unit's LATEST appended row;
    -- ever_started is sticky across its whole history.
    SELECT
      unit_key,
      IFNULL(LOGICAL_OR(status_started), FALSE) AS ever_started,
      ARRAY_AGG(
        STRUCT(deal_type, candidate_key, client_key, parent_client_key, start_key)
        ORDER BY date_and_time DESC NULLS LAST, table_id ASC
        LIMIT 1
      )[SAFE_OFFSET(0)] AS latest
    FROM ds_rows
    GROUP BY unit_key
  ),
  units_flat AS (
    SELECT
      unit_key,
      ever_started,
      latest.deal_type AS deal_type,
      latest.candidate_key AS candidate_key,
      latest.parent_client_key AS parent_client_key,
      latest.start_key AS start_key,
      IF(
        latest.candidate_key IS NULL OR latest.client_key IS NULL,
        NULL,
        CONCAT(latest.candidate_key, '|', latest.client_key)
      ) AS chain_key
    FROM units
  ),
  candidate_history AS (
    SELECT candidate_key, parent_client_key, start_key AS hist_start
    FROM units_flat
    WHERE candidate_key IS NOT NULL AND parent_client_key IS NOT NULL
${runrateHistoryUnion}
  ),
  rehire AS (
    -- DEAL units whose candidate has an EARLIER placement at a different parent client.
    SELECT u.unit_key, TRUE AS has_prior_other_client
    FROM units_flat u
    JOIN candidate_history h
      ON h.candidate_key = u.candidate_key
     AND h.parent_client_key IS NOT NULL
     AND h.parent_client_key != u.parent_client_key
     AND h.hist_start IS NOT NULL
     AND (u.start_key IS NULL OR h.hist_start < u.start_key)
    WHERE u.deal_type = 'DEAL'
      AND u.candidate_key IS NOT NULL
      AND u.parent_client_key IS NOT NULL
    GROUP BY u.unit_key
  ),
  generations AS (
    -- Each DEAL opens a generation; extensions inherit the generation of the DEAL they follow.
    -- Generation 0 = extensions of a placement whose DEAL is not in the deal sheet at all (run-rate
    -- only), so its first extension is still the 1st extension.
    SELECT
      unit_key,
      ever_started,
      deal_type,
      chain_key,
      start_key,
      COUNTIF(deal_type = 'DEAL') OVER (
        PARTITION BY chain_key
        ORDER BY start_key ASC NULLS FIRST, IF(deal_type = 'DEAL', 0, 1) ASC, unit_key ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS deal_generation
    FROM units_flat
    WHERE chain_key IS NOT NULL
  ),
  ranked AS (
    SELECT
      unit_key,
      ever_started,
      deal_type,
      ROW_NUMBER() OVER (
        PARTITION BY chain_key, deal_generation, deal_type
        ORDER BY start_key ASC NULLS FIRST, unit_key ASC
      ) AS extension_rank,
      COUNTIF(deal_type = 'EXTENSION') OVER (
        PARTITION BY chain_key, deal_generation
      ) AS generation_extension_count
    FROM generations
  )
  SELECT
    r.unit_key,
    ${buildExtensionRehireCaseSql("    ")} AS value
  FROM ranked r
  LEFT JOIN rehire h USING (unit_key);

-- Counted BEFORE the updates below, and always one row per table (0 when nothing changed) so an
-- empty job result means "counts unavailable", never "nothing changed".
CREATE TEMP TABLE ext_rehire_pending AS
  WITH changed AS (
    SELECT r.table_id, COUNT(*) AS changed_rows
    FROM ds_rows r
    JOIN ext_rehire_values v USING (unit_key)
    WHERE r.current_value IS DISTINCT FROM v.value
    GROUP BY r.table_id
  )
  SELECT t AS table_id, IFNULL(c.changed_rows, 0) AS changed_rows
  FROM UNNEST([${sqlStringList(tableIds)}]) AS t
  LEFT JOIN changed c ON c.table_id = t;

${updates}

SELECT table_id, changed_rows FROM ext_rehire_pending ORDER BY table_id;
`;

  return { sql, tableIds, runrateTableIds };
}

/**
 * Keep only the table ids that actually exist in the dataset (the Locums run-rate table is still a
 * placeholder, and a missing table would fail the whole job).
 * @param {string[]} tableIds
 * @param {object} [options] - { projectId, datasetId }
 * @param {object} deps - { queryFn(sql): Promise<object[]> }
 * @returns {Promise<string[]>}
 */
async function filterExistingTableIds(tableIds, options = {}, deps = {}) {
  const wanted = [...new Set((tableIds || []).filter((t) => typeof t === "string" && t.trim() !== ""))];
  if (wanted.length === 0) return [];
  const queryFn = deps.queryFn;
  if (typeof queryFn !== "function") throw new Error("filterExistingTableIds requires deps.queryFn");

  const projectId =
    typeof options.projectId === "string" && options.projectId.trim() !== ""
      ? options.projectId.trim()
      : config.projectId;
  const datasetId =
    typeof options.datasetId === "string" && options.datasetId.trim() !== ""
      ? options.datasetId.trim()
      : config.datasetId;

  const sql = `
    SELECT table_name
    FROM \`${projectId}.${datasetId}.INFORMATION_SCHEMA.TABLES\`
    WHERE table_name IN (${sqlStringList(wanted)})
  `;
  const rows = await queryFn(sql);
  const present = new Set((rows || []).map((r) => String(r?.table_name || "").trim()));
  return wanted.filter((t) => present.has(t));
}

/**
 * Recompute EXTENSION_REHIRE across the deal sheet tables. Idempotent — steady state updates 0 rows.
 * @param {object} [options] - { projectId, datasetId, tableIds, runrateTableIds }
 * @param {object} deps - { queryFn(sql): Promise<object[]> }
 * @returns {Promise<{updated:number, byTable:Object<string,number>, runrateTableIds:string[]}>}
 */
async function backfillExtensionRehire(options = {}, deps = {}) {
  const queryFn = deps.queryFn;
  if (typeof queryFn !== "function") throw new Error("backfillExtensionRehire requires deps.queryFn");

  const runrateCandidates = Array.isArray(options.runrateTableIds)
    ? options.runrateTableIds
    : RUNRATE_HISTORY_TABLE_IDS;
  const runrateTableIds = await filterExistingTableIds(runrateCandidates, options, deps);

  const { sql, tableIds } = buildExtensionRehireSql({ ...options, runrateTableIds });
  const rows = (await queryFn(sql)) || [];

  // The updates already ran; an empty result only means the counts could not be read back.
  if (rows.length === 0) return { updated: null, byTable: {}, runrateTableIds };

  const byTable = {};
  for (const tableId of tableIds) byTable[tableId] = 0;
  let updated = 0;
  for (const row of rows) {
    const tableId = row?.table_id == null ? "" : String(row.table_id).trim();
    const count = Number(row?.changed_rows ?? 0);
    if (!tableId || !Number.isFinite(count)) continue;
    byTable[tableId] = count;
    updated += count;
  }

  return { updated, byTable, runrateTableIds };
}

module.exports = {
  EXTENSION_REHIRE_COLUMN,
  EXTENSION_REHIRE_VALUES,
  EXTENSION_REHIRE_TABLE_IDS,
  EXTENSION_REHIRE_RULES,
  STARTED_PLACEMENT_STATUSES,
  RUNRATE_HISTORY_TABLE_IDS,
  isStartedPlacementStatus,
  classifyExtensionRehire,
  buildUnitKeySql,
  buildExtensionRehireCaseSql,
  buildExtensionRehireSql,
  filterExistingTableIds,
  backfillExtensionRehire,
};
