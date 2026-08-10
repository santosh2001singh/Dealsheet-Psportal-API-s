/**
 * EXT_OR_REHIRE_BY_RMG — derived "Extension/Rehire" column for the 6 domain deal sheet tables.
 *
 * The value describes where a placement sits in the candidate's OVERALL history with us:
 *
 *   DEAL_TYPE = DEAL
 *     - blank                 : the candidate's FIRST deal. Stays blank forever — extending it no
 *                               longer stamps anything on the deal itself.
 *     - REOFFERED             : a REPEAT deal (we have earlier history for this candidate) that has
 *                               not started yet — BOOKED / OFFERED.
 *     - REBOOKED              : a repeat deal that started. Sticky: stays REBOOKED through
 *                               ENDED / ENDED<30.
 *   DEAL_TYPE = EXTENSION
 *     - EXTENSION             : extension of the candidate's FIRST deal.
 *     - REBOOKED/EXTENSION    : extension of a REPEAT deal.
 *     Both apply at ANY placement status (BOOKED, STARTED, ENDED, DNS) and to EVERY extension in
 *     the run — the 1st, 2nd and Nth extension of the same deal all read the same value.
 *
 * Two independent questions drive everything:
 *
 *   1. Is this DEAL a repeat? — CANDIDATE-level, CLIENT-AGNOSTIC. Any earlier placement for this
 *      candidate (deal sheet OR legacy run-rate), at the SAME client or a different one, makes the
 *      next deal a repeat. A candidate who comes back to the same hospital is just as much a
 *      repeat as one who moves to a new one.
 *   2. Which DEAL does this EXTENSION hang off? — the extension inherits its parent deal's
 *      standing: first deal -> EXTENSION, repeat deal -> REBOOKED/EXTENSION.
 *
 * Chain identity (which extensions belong to which deal) = candidate + client + VMS job:
 *   candidate = CANDIDATE_ID (else CANDIDATE_EMAIL),
 *   client    = CLIENT_ID (else PARENT_CLIENT_NAME),
 *   job       = VMS_JOB_ID (absent -> the chain is candidate+client only).
 * Extensions are attached to the newest DEAL at or before their start date within that chain; an
 * extension whose DEAL exists only in the legacy run-rate table has no parent here and is treated
 * as an extension of a first deal (EXTENSION).
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
const EXT_OR_REHIRE_COLUMN = "EXT_OR_REHIRE_BY_RMG";

const EXT_OR_REHIRE_VALUES = Object.freeze({
  EXTENSION: "EXTENSION",
  REOFFERED: "REOFFERED",
  REBOOKED: "REBOOKED",
  REBOOKED_EXTENSION: "REBOOKED/EXTENSION",
});

/** All 6 domain deal sheet tables carry the column (active + ended). */
const EXT_OR_REHIRE_TABLE_IDS = Object.freeze([
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
 * `sql` reads the identically-named columns of the `ranked` CTE in buildExtensionRehireSql, so the
 * two can never disagree about order or spelling.
 *
 * Facts per unit:
 *   dealType          - "DEAL" | "EXTENSION" | other/blank
 *   everStarted       - the unit reached a started status at any point in its history (sticky)
 *   isRepeatDeal      - a DEAL with EARLIER history for this candidate anywhere (any client).
 *                       Drives REOFFERED/REBOOKED. Deliberately client-agnostic.
 *   parentIsRepeatDeal- for an EXTENSION: the DEAL it hangs off is itself a repeat deal.
 *                       Drives REBOOKED/EXTENSION vs plain EXTENSION.
 *
 * Extension RANK is deliberately absent: the 2nd, 3rd, Nth extension of the same deal all carry
 * the same value as the 1st. What separates EXTENSION from REBOOKED/EXTENSION is which DEAL the
 * extension belongs to, not how many came before it.
 */
const EXT_OR_REHIRE_RULES = Object.freeze([
  {
    // Extension of a repeat deal — every extension of it, at any placement status (BOOKED,
    // STARTED, ENDED, DNS).
    value: EXT_OR_REHIRE_VALUES.REBOOKED_EXTENSION,
    js: (f) => f.dealType === "EXTENSION" && f.parentIsRepeatDeal === true,
    sql: "deal_type = 'EXTENSION' AND parent_is_repeat_deal",
  },
  {
    // Extension of the candidate's FIRST deal — again at any status, and for every extension in
    // the run (1st, 2nd, 3rd ... all read EXTENSION).
    value: EXT_OR_REHIRE_VALUES.EXTENSION,
    js: (f) => f.dealType === "EXTENSION",
    sql: "deal_type = 'EXTENSION'",
  },
  {
    // Repeat deal that has started (STARTED / ACTIVE / ENDED / ENDED<30 — sticky, so it never
    // falls back to REOFFERED once started).
    value: EXT_OR_REHIRE_VALUES.REBOOKED,
    js: (f) => f.dealType === "DEAL" && f.isRepeatDeal === true && f.everStarted === true,
    sql: "deal_type = 'DEAL' AND is_repeat_deal AND ever_started",
  },
  {
    // Repeat deal not started yet (BOOKED / OFFERED).
    value: EXT_OR_REHIRE_VALUES.REOFFERED,
    js: (f) => f.dealType === "DEAL" && f.isRepeatDeal === true,
    sql: "deal_type = 'DEAL' AND is_repeat_deal",
  },
  // Everything else stays blank — most importantly the candidate's FIRST deal, whatever happens
  // to it afterwards (being extended no longer stamps EXTENSION on the deal; that value now
  // belongs to the extension rows).
]);

/**
 * Pure classifier — the JS mirror of the generated SQL CASE.
 * @param {object} facts - see EXT_OR_REHIRE_RULES
 * @returns {string|null} column value, or null when the row must stay blank
 */
function classifyExtensionRehire(facts = {}) {
  const normalized = {
    dealType: normalizeKey(facts.dealType),
    everStarted: facts.everStarted === true,
    isRepeatDeal: facts.isRepeatDeal === true,
    parentIsRepeatDeal: facts.parentIsRepeatDeal === true,
  };
  for (const rule of EXT_OR_REHIRE_RULES) {
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
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END`;

/** parent-client identity used by the rehire rule (name only — run-rate has no CLIENT_ID). */
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
  const branches = EXT_OR_REHIRE_RULES.map(
    (rule) => `${indent}  WHEN ${rule.sql} THEN '${escapeSqlString(rule.value)}'`
  ).join("\n");
  return `CASE\n${branches}\n${indent}END`;
}

/**
 * Build the idempotent multi-statement job that recomputes EXT_OR_REHIRE_BY_RMG on every row of every
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
      : [...EXT_OR_REHIRE_TABLE_IDS];
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
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        ${PARENT_CLIENT_KEY_SQL} AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        ${EXT_OR_REHIRE_COLUMN} AS current_value
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
SET ${EXT_OR_REHIRE_COLUMN} = v.value
FROM ext_rehire_values v
WHERE v.unit_key = ${buildUnitKeySql("t")}
  AND t.${EXT_OR_REHIRE_COLUMN} IS DISTINCT FROM v.value;`
    )
    .join("\n\n");

  const sql = `-- Recompute EXT_OR_REHIRE_BY_RMG for every deal sheet row (idempotent; see extensionRehire.js).
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
        STRUCT(deal_type, candidate_key, client_key, vms_job_key, parent_client_key, start_key)
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
      -- Chain = candidate + client + VMS job: which extensions belong to which deal. The VMS job
      -- segment is dropped when the row has none, so those rows still chain on candidate+client.
      IF(
        latest.candidate_key IS NULL OR latest.client_key IS NULL,
        NULL,
        CONCAT(
          latest.candidate_key, '|', latest.client_key,
          IF(latest.vms_job_key IS NULL, '', CONCAT('|vms:', latest.vms_job_key))
        )
      ) AS chain_key
    FROM units
  ),
  candidate_history AS (
    -- Prior placements for the candidate ANYWHERE. No parent-client filter: the repeat-deal rule
    -- is client-agnostic, so a row with no parent client still counts as history.
    SELECT candidate_key, parent_client_key, start_key AS hist_start
    FROM units_flat
    WHERE candidate_key IS NOT NULL
${runrateHistoryUnion}
  ),
  repeat_deals AS (
    -- A DEAL is a REPEAT when the candidate has ANY strictly earlier placement — same client or a
    -- different one (deliberately client-agnostic, unlike the old rehire rule) — from the deal
    -- sheet or the legacy run-rate tables.
    SELECT u.unit_key, TRUE AS is_repeat_deal
    FROM units_flat u
    JOIN candidate_history h
      ON h.candidate_key = u.candidate_key
     AND h.hist_start IS NOT NULL
     AND u.start_key IS NOT NULL
     AND h.hist_start < u.start_key
    WHERE u.deal_type = 'DEAL'
      AND u.candidate_key IS NOT NULL
    GROUP BY u.unit_key
  ),
  deals_in_chain AS (
    -- Every DEAL of a chain, tagged with whether it is a repeat, so extensions can inherit it.
    SELECT
      u.unit_key AS deal_unit_key,
      u.chain_key,
      u.start_key AS deal_start,
      IFNULL(rd.is_repeat_deal, FALSE) AS is_repeat_deal
    FROM units_flat u
    LEFT JOIN repeat_deals rd USING (unit_key)
    WHERE u.chain_key IS NOT NULL AND u.deal_type = 'DEAL'
  ),
  extension_parents AS (
    -- Attach each EXTENSION to the newest DEAL of its chain starting at or before it. An extension
    -- with no such DEAL here (the deal lives only in run-rate) gets no row and falls through to
    -- FALSE below -> plain EXTENSION.
    SELECT
      e.unit_key,
      ARRAY_AGG(d.is_repeat_deal ORDER BY d.deal_start DESC NULLS LAST, d.deal_unit_key DESC LIMIT 1)[
        SAFE_OFFSET(0)
      ] AS parent_is_repeat_deal
    FROM units_flat e
    JOIN deals_in_chain d
      ON d.chain_key = e.chain_key
     AND (
       e.start_key IS NULL
       OR d.deal_start IS NULL
       OR d.deal_start <= e.start_key
     )
    WHERE e.deal_type = 'EXTENSION' AND e.chain_key IS NOT NULL
    GROUP BY e.unit_key
  ),
  ranked AS (
    SELECT
      u.unit_key,
      u.ever_started,
      u.deal_type,
      IFNULL(rd.is_repeat_deal, FALSE) AS is_repeat_deal,
      IFNULL(ep.parent_is_repeat_deal, FALSE) AS parent_is_repeat_deal
    FROM units_flat u
    LEFT JOIN repeat_deals rd USING (unit_key)
    LEFT JOIN extension_parents ep USING (unit_key)
  )
  SELECT
    unit_key,
    ${buildExtensionRehireCaseSql("    ")} AS value
  FROM ranked;

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
 * Recompute EXT_OR_REHIRE_BY_RMG across the deal sheet tables. Idempotent — steady state updates 0 rows.
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
  EXT_OR_REHIRE_COLUMN,
  EXT_OR_REHIRE_VALUES,
  EXT_OR_REHIRE_TABLE_IDS,
  EXT_OR_REHIRE_RULES,
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
