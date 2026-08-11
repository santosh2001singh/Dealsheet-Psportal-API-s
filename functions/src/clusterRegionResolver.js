/**
 * RECRUITER_CLUSTER_REGION / CLIENT_CLUSTER_REGION / CLUSTER_TYPE — where the recruiter and the
 * client each sat AT THE TIME OF THE PLACEMENT, for the cynet health active deal sheet.
 *
 * Scope is cynet_health_deal_sheet only — see CLUSTER_REGION_TABLE_IDS for why canada, locums and the
 * ended table are all excluded.
 *
 * The two sides are independent. A recruiter can move region while the client stays put and vice
 * versa, they live in different tables, and only one of the two client tables is effective-dated.
 * They are resolved separately and only read together at the end (PROGRAMME).
 *
 * Step 1 — the placement's own date (AS_OF_DATE). One date drives both sides, so the recruiter and
 *   the client are described at the same moment:
 *     DEAL_TYPE = EXTENSION -> EXTENSION_DATE, falling back to START_DATE when null
 *     otherwise             -> SUBMISSION_DATE, falling back to START_DATE when null
 *   On an extension row START_DATE is the ORIGINAL assignment's start and can be months stale, which
 *   is why the extension date wins there. On a deal, the question is where things stood when the deal
 *   was submitted, not when the candidate walked in.
 *
 * Step 2 — recruiter (Cluster_Data.rec_cluster_historical_data, keyed on lowercased EMAIL_ID).
 *   An effective-dated change log: EMAIL_ID | EFFECTIVE_DATE | OLD_CLUSTER | NEW_CLUSTER.
 *     - latest row with EFFECTIVE_DATE <= AS_OF_DATE -> its NEW_CLUSTER          (source NEW_CLUSTER)
 *     - placement predates every row -> the EARLIEST row's OLD_CLUSTER           (source OLD_CLUSTER)
 *       That is literally where they were before the move, so it is NOT "unaligned" — 113 of 385
 *       recruiters have no baseline row, so this case is common (211 live rows today).
 *     - no rows at all -> blank                                                  (source not in log)
 *
 * Step 3 — client, tried in order, always the latest qualifying row:
 *   3a. Cluster_Data.new_cluster_model on Client_Name + MSP_Name + State, latest Date <= AS_OF_DATE.
 *       Client and MSP compare case-insensitively. State is a "/"-delimited LIST ("NC/SC"), matched
 *       by membership, not equality.
 *   3b. rr_project_data.health_system_cluster on Client_Name + State (or State = 'ALL'), only when
 *       3a found nothing. This table has NO date column, so it cannot be effective-dated — the
 *       source is labelled accordingly so a reader knows it is a CURRENT snapshot, not history.
 *   Neither matched -> blank, plus WHY_BLANK naming which check failed (client absent entirely / MSP
 *   mismatch / state not covered). MSP spellings are deliberately NOT aliased: a mismatch is reported
 *   as a data gap rather than guessed at.
 *
 * Step 4 — PROGRAMME, from the same AS_OF_DATE plus the client's type:
 *     Government client (Cluster_Type = Government, or a "Gov …" / "SLED …" code) -> Cluster rules,
 *       whatever the date and wherever the recruiter has since moved. The CLIENT decides, not the
 *       recruiter: an NCDAC placement stays Government even if its recruiter moved LOC-2 -> R1A.
 *     else AS_OF_DATE >= 2026-06-01 -> Regional      (codes R1N, R3A, SPOT-N, …)
 *     else                         -> Cluster        (codes LOC-*, ENT-*, APC-*)
 *
 * Specialty rides in the last letter of a REGIONAL code only (…N -> Nursing, …A -> Allied). Legacy
 * cluster codes predate the regional programme, so a blank specialty there is correct, not a gap —
 * it is never filled in from the recruiter's current alignment.
 *
 * Writing: the three deal sheet columns are FILL-IF-EMPTY. All three are in MANUAL_COLUMNS and stay
 * there; a hand-edited value is never overwritten, and only blanks are computed. The full per-row
 * reasoning (dates, sources, why a side is blank) goes to the trace table instead of widening the
 * deal sheet — see buildClusterRegionTraceSql.
 */

const config = require("./config");

const RECRUITER_HISTORY_TABLE = "Cluster_Data.rec_cluster_historical_data";
const NEW_CLUSTER_MODEL_TABLE = "Cluster_Data.new_cluster_model";
/** Lives in the deal sheet dataset, not Cluster_Data (there is a stale copy under Cluster_Data). */
const HEALTH_SYSTEM_CLUSTER_TABLE = "health_system_cluster";

/**
 * cynet health ACTIVE only.
 *
 * Canada and locums are out of scope — the cluster/region programme is cynet health's.
 * cynet_health_ended_deal_sheet is excluded for a different reason: the live table predates all three
 * columns (181 columns vs the active table's 199; it still carries the older RECRUITER_CLUSTER and has
 * neither CLIENT_CLUSTER_REGION nor CLUSTER_TYPE), even though the ended DDL declares them. Adding it
 * back means ALTERing that table first — until then, referencing it here fails with
 * "Unrecognized name: RECRUITER_CLUSTER_REGION".
 */
const CLUSTER_REGION_TABLE_IDS = Object.freeze(["cynet_health_deal_sheet"]);

/** Trace table holding the per-placement reasoning that does not fit the deal sheet's 3 columns. */
const CLUSTER_TRACE_TABLE_ID = "deal_sheet_cluster_trace";

/** The date the Regional Incentive Program took over from the legacy cluster rules. */
const REGIONAL_PROGRAMME_START_DATE = "2026-06-01";

const PROGRAMME = Object.freeze({
  REGIONAL: "Regional",
  CLUSTER: "Cluster",
  GOVERNMENT: "Government",
});

const AS_OF_DATE_SOURCE = Object.freeze({
  SUBMISSION_DATE: "SUBMISSION_DATE",
  EXTENSION_DATE: "EXTENSION_DATE",
  START_DATE: "START_DATE",
});

const RECRUITER_CODE_SOURCE = Object.freeze({
  NEW_CLUSTER: "NEW_CLUSTER",
  OLD_CLUSTER: "OLD_CLUSTER fallback",
  NOT_IN_LOG: "not in log",
});

const CLIENT_CODE_SOURCE = Object.freeze({
  NEW_CLUSTER_MODEL: "new_cluster_model",
  // Spelled out because this table has no date column: the value is today's alignment, not the
  // alignment as of the placement date.
  HEALTH_SYSTEM_CLUSTER: "health_system_cluster (not effective-dated)",
  NO_MATCH: "no match",
});

const WHY_BLANK = Object.freeze({
  RECRUITER_NOT_IN_LOG: "recruiter not in cluster history",
  CLIENT_ABSENT: "client absent from cluster tables",
  MSP_MISMATCH: "MSP mismatch",
  STATE_NOT_COVERED: "state not covered",
  NO_AS_OF_DATE: "no resolvable placement date",
});

/** @returns {string} `project.dataset.table` backticked. */
function fqn(datasetId, tableId, projectId) {
  const p = String(projectId || config.projectId || "").trim();
  const d = String(datasetId || config.datasetId || "").trim();
  return `\`${p}.${d}.${tableId}\``;
}

/** Cluster_Data lives beside the deal sheet dataset, not inside it. */
function clusterDataFqn(qualifiedName, projectId) {
  const p = String(projectId || config.projectId || "").trim();
  return `\`${p}.${qualifiedName}\``;
}

/**
 * True when a client code / cluster type means "government", which pins the row to the legacy
 * cluster rules regardless of date. Matches the Cluster_Type as well as the code shapes seen in
 * new_cluster_model today: `Gov Region 1..4` and `Gov School` (SLED * is covered for future rows).
 */
function isGovernmentClient(clusterType, clientCode) {
  const type = clusterType == null ? "" : String(clusterType).trim().toUpperCase();
  if (type === "GOVERNMENT") return true;
  const code = clientCode == null ? "" : String(clientCode).trim().toUpperCase();
  return code.startsWith("GOV ") || code.startsWith("GOV-") || code.startsWith("SLED");
}

/**
 * Specialty carried by the last letter of a REGIONAL code (R1N / SPOT-A). Legacy cluster codes
 * (LOC-*, ENT-*, APC-*, Gov *) carry none, and a blank there is the correct answer.
 * @returns {"Nursing"|"Allied"|null}
 */
function recruiterSpecialtyFromCode(code) {
  const raw = code == null ? "" : String(code).trim().toUpperCase();
  if (raw === "") return null;
  // Legacy families never encode specialty, whatever letter they happen to end on.
  if (/^(LOC|ENT|APC|EXC|SPC|GOV|SLED)\b/.test(raw) || raw.startsWith("GOV ")) return null;
  if (raw.endsWith("N")) return "Nursing";
  if (raw.endsWith("A")) return "Allied";
  return null;
}

/**
 * Programme governing a row. The client's government status wins over the date; only then does the
 * regional cutover apply.
 * @param {string|null} asOfDate - YYYY-MM-DD
 */
function resolveProgramme(asOfDate, clusterType, clientCode) {
  if (isGovernmentClient(clusterType, clientCode)) return PROGRAMME.GOVERNMENT;
  const d = asOfDate == null ? "" : String(asOfDate).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return PROGRAMME.CLUSTER;
  return d >= REGIONAL_PROGRAMME_START_DATE ? PROGRAMME.REGIONAL : PROGRAMME.CLUSTER;
}

/**
 * SQL for the resolved view of one deal sheet table: AS_OF_DATE + both sides + sources + WHY_BLANK.
 * Shared by the deal sheet fill and the trace table so the two can never disagree.
 *
 * Returned as a CTE body (no trailing semicolon) selecting one row per deal sheet row.
 * @param {string} tableId
 * @param {object} [options] - { projectId, datasetId }
 * @returns {string}
 */
function buildClusterRegionResolvedSql(tableId, options = {}) {
  const projectId = options.projectId;
  const datasetId = options.datasetId;
  const dealFqn = fqn(datasetId, tableId, projectId);
  const recFqn = clusterDataFqn(RECRUITER_HISTORY_TABLE, projectId);
  const ncmFqn = clusterDataFqn(NEW_CLUSTER_MODEL_TABLE, projectId);
  const hscFqn = fqn(datasetId, HEALTH_SYSTEM_CLUSTER_TABLE, projectId);

  return `
    WITH base AS (
      -- EXACTLY ONE ROW PER DEAL_SHEET_ID. The deal sheet is append-only, so a placement owns several
      -- rows (4,686 rows over 4,410 ids today) and emitting all of them makes the UPDATE below fail
      -- with "UPDATE/MERGE must match at most one source row for each target row". The newest row wins:
      -- LAST_UPDATED, then EDIT_DATE, so the resolution reflects the placement's current state.
      SELECT * EXCEPT(rn) FROM (
        SELECT
          DEAL_SHEET_ID,
          PLACEMENT_ID,
          RECRUITER_CLUSTER_REGION AS existing_recruiter_region,
          CLIENT_CLUSTER_REGION    AS existing_client_region,
          CLUSTER_TYPE             AS existing_cluster_type,
          LOWER(TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, ''))) AS rec_email,
          LOWER(TRIM(IFNULL(PARENT_CLIENT_NAME, '')))         AS client_key,
          LOWER(TRIM(IFNULL(MSP_NAME, '')))                   AS msp_key,
          UPPER(TRIM(IFNULL(CLIENT_STATE, '')))               AS state_key,
          -- Step 1: one date for both sides. EXTENSION rows use the extension's own date because
          -- START_DATE there belongs to the original assignment.
          CASE
            WHEN UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'EXTENSION'
              THEN COALESCE(DATE(EXTENSION_DATE), START_DATE)
            ELSE COALESCE(DATE(SUBMISSION_DATE), START_DATE)
          END AS as_of_date,
          CASE
            WHEN UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'EXTENSION'
              THEN IF(EXTENSION_DATE IS NOT NULL, '${AS_OF_DATE_SOURCE.EXTENSION_DATE}',
                      IF(START_DATE IS NOT NULL, '${AS_OF_DATE_SOURCE.START_DATE}', NULL))
            ELSE IF(SUBMISSION_DATE IS NOT NULL, '${AS_OF_DATE_SOURCE.SUBMISSION_DATE}',
                    IF(START_DATE IS NOT NULL, '${AS_OF_DATE_SOURCE.START_DATE}', NULL))
          END AS as_of_date_source,
          ROW_NUMBER() OVER (
            PARTITION BY DEAL_SHEET_ID
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST
          ) AS rn
        FROM ${dealFqn}
        WHERE DEAL_SHEET_ID IS NOT NULL
      )
      WHERE rn = 1
    ),
    rec_log AS (
      SELECT
        LOWER(TRIM(EMAIL_ID)) AS rec_email,
        EFFECTIVE_DATE,
        NULLIF(TRIM(IFNULL(OLD_CLUSTER, '')), '') AS old_cluster,
        NULLIF(TRIM(IFNULL(NEW_CLUSTER, '')), '') AS new_cluster
      FROM ${recFqn}
      WHERE EMAIL_ID IS NOT NULL AND TRIM(EMAIL_ID) != '' AND EFFECTIVE_DATE IS NOT NULL
    ),
    -- Step 2a: latest change on or before the placement date.
    rec_on_before AS (
      SELECT DEAL_SHEET_ID, new_cluster AS code
      FROM (
        SELECT
          b.DEAL_SHEET_ID,
          r.new_cluster,
          ROW_NUMBER() OVER (
            PARTITION BY b.DEAL_SHEET_ID
            ORDER BY r.EFFECTIVE_DATE DESC, r.new_cluster ASC
          ) AS rn
        FROM base b
        JOIN rec_log r USING (rec_email)
        WHERE b.as_of_date IS NOT NULL AND r.EFFECTIVE_DATE <= b.as_of_date
      )
      WHERE rn = 1
    ),
    -- Step 2b: placement predates every row -> the earliest row's OLD_CLUSTER (where they were before).
    rec_earliest AS (
      SELECT DEAL_SHEET_ID, old_cluster AS code
      FROM (
        SELECT
          b.DEAL_SHEET_ID,
          r.old_cluster,
          ROW_NUMBER() OVER (
            PARTITION BY b.DEAL_SHEET_ID
            ORDER BY r.EFFECTIVE_DATE ASC, r.old_cluster ASC
          ) AS rn
        FROM base b
        JOIN rec_log r USING (rec_email)
      )
      WHERE rn = 1
    ),
    -- Step 3a: new_cluster_model, effective-dated. State is a "/"-delimited list, matched by membership.
    client_ncm AS (
      SELECT DEAL_SHEET_ID, code, cluster_type
      FROM (
        SELECT
          b.DEAL_SHEET_ID,
          NULLIF(TRIM(IFNULL(n.Cluster_Code, '')), '') AS code,
          NULLIF(TRIM(IFNULL(n.Cluster_Type, '')), '') AS cluster_type,
          ROW_NUMBER() OVER (
            PARTITION BY b.DEAL_SHEET_ID
            ORDER BY n.Date DESC, n.Cluster_Code ASC
          ) AS rn
        FROM base b
        JOIN ${ncmFqn} n
          ON LOWER(TRIM(IFNULL(n.Client_Name, ''))) = b.client_key
         AND LOWER(TRIM(IFNULL(n.MSP_Name, '')))    = b.msp_key
         AND b.state_key IN UNNEST(SPLIT(UPPER(TRIM(IFNULL(n.State, ''))), '/'))
         AND n.Date <= b.as_of_date
        WHERE b.as_of_date IS NOT NULL AND b.client_key != ''
      )
      WHERE rn = 1
    ),
    -- Step 3b: health_system_cluster fallback. No date column here, so this is a CURRENT snapshot.
    client_hsc AS (
      SELECT DEAL_SHEET_ID, code
      FROM (
        SELECT
          b.DEAL_SHEET_ID,
          NULLIF(TRIM(IFNULL(h.Cluster_Code, '')), '') AS code,
          ROW_NUMBER() OVER (
            PARTITION BY b.DEAL_SHEET_ID
            ORDER BY h.Cluster_Code ASC
          ) AS rn
        FROM base b
        JOIN ${hscFqn} h
          ON LOWER(TRIM(IFNULL(h.Client_Name, ''))) = b.client_key
         AND (
              b.state_key IN UNNEST(SPLIT(UPPER(TRIM(IFNULL(h.State, ''))), '/'))
              OR UPPER(TRIM(IFNULL(h.State, ''))) = 'ALL'
             )
        WHERE b.client_key != ''
      )
      WHERE rn = 1
    ),
    -- WHY_BLANK diagnostics: which of the three checks actually failed on the client side.
    ncm_clients AS (
      SELECT DISTINCT LOWER(TRIM(IFNULL(Client_Name, ''))) AS client_key FROM ${ncmFqn}
    ),
    hsc_clients AS (
      SELECT DISTINCT LOWER(TRIM(IFNULL(Client_Name, ''))) AS client_key FROM ${hscFqn}
    ),
    ncm_client_msp AS (
      SELECT DISTINCT
        LOWER(TRIM(IFNULL(Client_Name, ''))) AS client_key,
        LOWER(TRIM(IFNULL(MSP_Name, '')))    AS msp_key
      FROM ${ncmFqn}
    ),
    resolved AS (
      SELECT
        b.DEAL_SHEET_ID,
        b.PLACEMENT_ID,
        b.existing_recruiter_region,
        b.existing_client_region,
        b.existing_cluster_type,
        b.as_of_date,
        b.as_of_date_source,
        -- Recruiter: on/before wins, then the OLD_CLUSTER fallback.
        COALESCE(rob.code, rea.code) AS recruiter_code,
        CASE
          WHEN rob.code IS NOT NULL THEN '${RECRUITER_CODE_SOURCE.NEW_CLUSTER}'
          WHEN rea.code IS NOT NULL THEN '${RECRUITER_CODE_SOURCE.OLD_CLUSTER}'
          ELSE '${RECRUITER_CODE_SOURCE.NOT_IN_LOG}'
        END AS recruiter_code_source,
        -- Client: 3a wins over 3b.
        COALESCE(cn.code, ch.code) AS client_code,
        CASE
          WHEN cn.code IS NOT NULL THEN '${CLIENT_CODE_SOURCE.NEW_CLUSTER_MODEL}'
          WHEN ch.code IS NOT NULL THEN '${CLIENT_CODE_SOURCE.HEALTH_SYSTEM_CLUSTER}'
          ELSE '${CLIENT_CODE_SOURCE.NO_MATCH}'
        END AS client_code_source,
        cn.cluster_type AS client_cluster_type,
        b.client_key,
        b.msp_key,
        b.rec_email
      FROM base b
      LEFT JOIN rec_on_before rob USING (DEAL_SHEET_ID)
      LEFT JOIN rec_earliest  rea USING (DEAL_SHEET_ID)
      LEFT JOIN client_ncm    cn  USING (DEAL_SHEET_ID)
      LEFT JOIN client_hsc    ch  USING (DEAL_SHEET_ID)
    )
    SELECT
      r.DEAL_SHEET_ID,
      r.PLACEMENT_ID,
      r.existing_recruiter_region,
      r.existing_client_region,
      r.existing_cluster_type,
      r.as_of_date,
      r.as_of_date_source,
      r.recruiter_code,
      r.recruiter_code_source,
      -- Specialty lives in the last letter of a REGIONAL code only; legacy families carry none.
      CASE
        WHEN r.recruiter_code IS NULL THEN NULL
        WHEN REGEXP_CONTAINS(UPPER(r.recruiter_code), r'^(LOC|ENT|APC|EXC|SPC|GOV|SLED)') THEN NULL
        WHEN UPPER(r.recruiter_code) LIKE '%N' THEN 'Nursing'
        WHEN UPPER(r.recruiter_code) LIKE '%A' THEN 'Allied'
        ELSE NULL
      END AS recruiter_specialty,
      r.client_code,
      r.client_code_source,
      r.client_cluster_type,
      -- Step 4: a government client pins the row to Cluster rules whatever the date.
      CASE
        WHEN UPPER(IFNULL(r.client_cluster_type, '')) = 'GOVERNMENT'
          OR REGEXP_CONTAINS(UPPER(IFNULL(r.client_code, '')), r'^(GOV[ -]|SLED)')
          THEN '${PROGRAMME.GOVERNMENT}'
        WHEN r.as_of_date >= DATE '${REGIONAL_PROGRAMME_START_DATE}' THEN '${PROGRAMME.REGIONAL}'
        ELSE '${PROGRAMME.CLUSTER}'
      END AS programme,
      -- WHY_BLANK: one line naming every check that failed, so a gap is actionable.
      NULLIF(
        ARRAY_TO_STRING(
          ARRAY(
            SELECT x FROM UNNEST([
              IF(r.as_of_date IS NULL, '${WHY_BLANK.NO_AS_OF_DATE}', NULL),
              IF(r.recruiter_code IS NULL, '${WHY_BLANK.RECRUITER_NOT_IN_LOG}', NULL),
              IF(r.client_code IS NULL
                 AND r.client_key NOT IN (SELECT client_key FROM ncm_clients)
                 AND r.client_key NOT IN (SELECT client_key FROM hsc_clients),
                 '${WHY_BLANK.CLIENT_ABSENT}', NULL),
              IF(r.client_code IS NULL
                 AND r.client_key IN (SELECT client_key FROM ncm_clients)
                 AND NOT EXISTS (
                   SELECT 1 FROM ncm_client_msp m
                   WHERE m.client_key = r.client_key AND m.msp_key = r.msp_key
                 ),
                 '${WHY_BLANK.MSP_MISMATCH}', NULL),
              IF(r.client_code IS NULL
                 AND EXISTS (
                   SELECT 1 FROM ncm_client_msp m
                   WHERE m.client_key = r.client_key AND m.msp_key = r.msp_key
                 ),
                 '${WHY_BLANK.STATE_NOT_COVERED}', NULL)
            ]) AS x
            WHERE x IS NOT NULL
          ),
          '; '
        ),
        ''
      ) AS why_blank
    FROM resolved r`;
}

/**
 * Multi-statement SQL filling the three deal sheet columns FILL-IF-EMPTY on both cynet health
 * tables, and reporting how many rows each UPDATE touched. Idempotent: a settled table updates 0.
 * @param {object} [options] - { projectId, datasetId, tableIds }
 * @returns {{sql: string, tableIds: string[]}}
 */
function buildClusterRegionFillSql(options = {}) {
  const tableIds =
    Array.isArray(options.tableIds) && options.tableIds.length > 0
      ? [...new Set(options.tableIds.map((t) => String(t).trim()).filter(Boolean))]
      : [...CLUSTER_REGION_TABLE_IDS];

  const statements = [];
  const selects = [];
  tableIds.forEach((tableId, i) => {
    const dealFqn = fqn(options.datasetId, tableId, options.projectId);
    const resolved = buildClusterRegionResolvedSql(tableId, options);
    const src = `resolved_${i}`;
    const counter = `changed_${i}_rows`;
    // The eligibility predicate is spelled once and reused by the count and the UPDATE, so the two can
    // never disagree. It is counted BEFORE the UPDATE runs: @@row_count cannot be used here because
    // `SET x = @@row_count` is itself a statement, so it would report the SET's own row count (0), not
    // the UPDATE's — which is exactly the bug this shape avoids.
    const eligible = `
    (NULLIF(TRIM(IFNULL(d.RECRUITER_CLUSTER_REGION, '')), '') IS NULL AND s.recruiter_code IS NOT NULL)
    OR (NULLIF(TRIM(IFNULL(d.CLIENT_CLUSTER_REGION, '')), '') IS NULL AND s.client_code IS NOT NULL)
    OR (NULLIF(TRIM(IFNULL(d.CLUSTER_TYPE, '')), '') IS NULL AND s.client_cluster_type IS NOT NULL)`;

    statements.push(`
CREATE TEMP TABLE ${src} AS ${resolved};

SET ${counter} = (
  SELECT COUNT(*)
  FROM ${dealFqn} d
  JOIN ${src} s ON d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  WHERE ${eligible}
);

UPDATE ${dealFqn} d
SET
  RECRUITER_CLUSTER_REGION = IFNULL(
    NULLIF(TRIM(IFNULL(d.RECRUITER_CLUSTER_REGION, '')), ''), s.recruiter_code
  ),
  CLIENT_CLUSTER_REGION = IFNULL(
    NULLIF(TRIM(IFNULL(d.CLIENT_CLUSTER_REGION, '')), ''), s.client_code
  ),
  CLUSTER_TYPE = IFNULL(
    NULLIF(TRIM(IFNULL(d.CLUSTER_TYPE, '')), ''), s.client_cluster_type
  )
FROM ${src} s
WHERE d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  -- Only touch rows where at least one of the three is blank AND we resolved something for it.
  AND (${eligible}
  );`);
    selects.push(`SELECT '${tableId}' AS table_id, ${counter} AS changed_rows`);
  });

  const declares = tableIds
    .map((_, i) => `DECLARE changed_${i}_rows INT64 DEFAULT 0;`)
    .join("\n");
  const sql = `${declares}\n${statements.join("\n")}\n\n${selects.join("\nUNION ALL\n")};`;
  return { sql, tableIds };
}

/**
 * SQL rebuilding the trace table from scratch (CREATE OR REPLACE) with one row per deal sheet row
 * across both cynet health tables. Full reasoning lives here rather than on the deal sheet.
 * @param {object} [options] - { projectId, datasetId, tableIds, traceTableId }
 * @returns {{sql: string, tableIds: string[], traceTableId: string}}
 */
function buildClusterRegionTraceSql(options = {}) {
  const tableIds =
    Array.isArray(options.tableIds) && options.tableIds.length > 0
      ? [...new Set(options.tableIds.map((t) => String(t).trim()).filter(Boolean))]
      : [...CLUSTER_REGION_TABLE_IDS];
  const traceTableId = String(options.traceTableId || CLUSTER_TRACE_TABLE_ID).trim();
  const traceFqn = fqn(options.datasetId, traceTableId, options.projectId);

  const parts = tableIds.map((tableId) => {
    const resolved = buildClusterRegionResolvedSql(tableId, options);
    return `
SELECT
  '${tableId}' AS SOURCE_TABLE,
  DEAL_SHEET_ID,
  PLACEMENT_ID,
  as_of_date            AS AS_OF_DATE,
  as_of_date_source     AS AS_OF_DATE_SOURCE,
  recruiter_code        AS RECRUITER_CODE,
  recruiter_code_source AS RECRUITER_CODE_SOURCE,
  recruiter_specialty   AS RECRUITER_SPECIALTY,
  client_code           AS CLIENT_CODE,
  client_code_source    AS CLIENT_CODE_SOURCE,
  client_cluster_type   AS CLIENT_CLUSTER_TYPE,
  programme             AS PROGRAMME,
  why_blank             AS WHY_BLANK,
  CURRENT_TIMESTAMP()   AS COMPUTED_AT
FROM (${resolved})`;
  });

  const sql = `CREATE OR REPLACE TABLE ${traceFqn} AS\n${parts.join("\nUNION ALL\n")};`;
  return { sql, tableIds, traceTableId };
}

/**
 * Fill the three deal sheet columns, then rebuild the trace table. Both idempotent.
 * @param {object} [options] - { projectId, datasetId, tableIds, skipTrace }
 * @param {object} deps - { queryFn(sql): Promise<object[]> }
 * @returns {Promise<{updated:number|null, byTable:Object<string,number>, traceTableId:string|null}>}
 */
async function backfillClusterRegions(options = {}, deps = {}) {
  const queryFn = deps.queryFn;
  if (typeof queryFn !== "function") {
    throw new Error("backfillClusterRegions requires deps.queryFn");
  }

  const { sql, tableIds } = buildClusterRegionFillSql(options);
  const rows = (await queryFn(sql)) || [];

  const byTable = {};
  for (const tableId of tableIds) byTable[tableId] = 0;
  let updated = rows.length === 0 ? null : 0;
  for (const row of rows) {
    const tableId = row?.table_id == null ? "" : String(row.table_id).trim();
    const count = Number(row?.changed_rows ?? 0);
    if (!tableId || !Number.isFinite(count)) continue;
    byTable[tableId] = count;
    updated = (updated ?? 0) + count;
  }

  // The trace table is diagnostics: failing to rebuild it must not fail the fill that already ran.
  let traceTableId = null;
  if (options.skipTrace !== true) {
    const trace = buildClusterRegionTraceSql(options);
    await queryFn(trace.sql);
    traceTableId = trace.traceTableId;
  }

  return { updated, byTable, traceTableId };
}

module.exports = {
  CLUSTER_REGION_TABLE_IDS,
  CLUSTER_TRACE_TABLE_ID,
  REGIONAL_PROGRAMME_START_DATE,
  PROGRAMME,
  AS_OF_DATE_SOURCE,
  RECRUITER_CODE_SOURCE,
  CLIENT_CODE_SOURCE,
  WHY_BLANK,
  isGovernmentClient,
  recruiterSpecialtyFromCode,
  resolveProgramme,
  buildClusterRegionResolvedSql,
  buildClusterRegionFillSql,
  buildClusterRegionTraceSql,
  backfillClusterRegions,
};
