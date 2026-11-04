/**
 * RECRUITER_CLUSTER_REGION / CLIENT_CLUSTER_REGION / CLUSTER_TYPE — the same values the RR-Dashboard
 * incentive report (RecruiterIncentiveView) shows in its "Recruiter Cluster/Region", "Cluster
 * Code/Client Region" and "Cluster Type" columns, for the cynet health active deal sheet.
 *
 * The rules are ported from RR-Dashboad (clusterIncentiveCalculator.js, clientClusterLookup.js,
 * placementRegion.js, RecruiterIncentiveView.jsx). When they change there, change them here.
 *
 * Scope is cynet_health_deal_sheet only — see CLUSTER_REGION_TABLE_IDS.
 *
 * Step 1 — recruiter's CLUSTER (keyed on ASSIGNMENT_RECRUITER_EMAIL) from rr_project_data.Recruiter_Region_logs
 *   since 2026-11-04, as a change log: a blank / NA region is "NA"; an END_DATE on/after 2026-05-31 with
 *   nothing covering the next day adds "NA" from that day; archived rows are skipped. While that table
 *   is empty, Cluster_Data.rec_cluster_historical_data is read instead.
 *   As-of date (resolveAlignmentAsOfDate):
 *     Government client and a SUBMISSION_DATE      -> SUBMISSION_DATE
 *   For an EXTENSION, "start" is the original start: INITIAL_START_DATE (the report's START_DATE).
 *     EXTENSION started before 2026-06-01, EXTENSION_DATE on/after -> SUBMISSION_DATE, else start
 *     EXTENSION started on/after 2026-06-01 -> start (its Deal weeks' region, for every extension)
 *     other EXTENSION -> EXTENSION_DATE (or start) when >= cutover, else SUBMISSION_DATE,
 *                        else EXTENSION_DATE / start
 *     DEAL            -> START_DATE when >= cutover, else SUBMISSION_DATE, else START_DATE
 *   Lookup (resolveRegionFromHistoryEntries):
 *     latest row on/before the date -> its NEW_CLUSTER. A blank NEW_CLUSTER is a REMOVAL: blank.
 *     nothing yet, date < 2025-01-01 -> the cluster in force on 2025-10-31
 *     nothing yet otherwise          -> blank (the log starts after the placement)
 *     recruiter not in the log       -> Cluster_Data.rec_cluster (their standing assignment)
 *   OLD_CLUSTER is never used.
 *
 * Step 2 — client's CLUSTER, as of SUBMISSION_DATE (extension: EXTENSION_DATE; then START_DATE):
 *   a. Allied override: APC recruiter + Allied OFFERING + date before the cutover -> the APC
 *      region row covering the placement's state (WI -> Mid West -> APC-2).
 *   b. Cluster_Data.health_system_cluster, only for SUBMISSION_DATE 2025-01-01..2025-05-31.
 *   c. Cluster_Data.new_cluster_model (resolveClientCluster): client + state, MSP narrows when it
 *      matches; region rows excluded; APC rows only for an Allied placement whose recruiter is APC
 *      or unknown; the lone "Gov School" slip skipped; latest row in force (tie: Government, then
 *      the narrower state list, then the recruiter's own code); blank when a newer row for the same
 *      MSP dropped the state, or the client's data stopped before the table's did; before the
 *      log: pre-2025 -> the 2025-10-31 row, else the client's earliest row unless the client was
 *      added to the table later than the table began.
 *   CLUSTER_TYPE comes from (a) or (c); (b) has no type.
 *
 * Step 3 — Regional rows show REGION codes instead (isRegionalProgramRow):
 *   cynethealth recruiter, commercial (non-Government) client, not a post-cutover extension of an
 *   assignment whose INITIAL_START_DATE is before the cutover, and
 *   the Step 1 date >= 2026-06-01 (or the recruiter is on a special project code).
 *     recruiter -> the Step 1 log code, without the rec_cluster fallback
 *     client    -> SPOT recruiter whose Region_alignment client list holds the client -> recruiter's
 *                  code; else client_alignment block matching state + OFFERING (DIVISION); else any
 *                  block for that state + OFFERING; then a dated client_logs_new move overrides
 *     type      -> "Regional"
 *
 * Retired EXC-n codes display as "Gov Region n", as the report does.
 *
 * Known gaps versus the report: the regional anchor freeze (rebooking chains), the stored
 * finalized-row fallbacks, the speciality from combine_deal_head_count (OFFERING is used), the
 * ownership-updated recruiter email (ASSIGNMENT_RECRUITER_EMAIL is used), and the Firestore
 * override of the special-project list.
 *
 * Writing: FILL-IF-EMPTY by default — all three columns are MANUAL_COLUMNS. options.overwrite
 * replaces existing values with the resolved ones (a blank resolution never erases a value).
 * The full per-row reasoning goes to the trace table — see buildClusterRegionTraceSql.
 */

const config = require("./config");

/** The report's recruiter region history since 2026-11-04 (recruiterRegionHistoryMap.js). */
const RECRUITER_REGION_LOGS_TABLE_ID = "Recruiter_Region_logs";
/** Read only while Recruiter Region Logs is empty, as the report does. */
const RECRUITER_HISTORY_TABLE = "Cluster_Data.rec_cluster_historical_data";
const REGION_LOG_NA = "NA";
const REGION_LOG_REMOVALS_FROM = "2026-06-01";
const RECRUITER_SNAPSHOT_TABLE = "Cluster_Data.rec_cluster";
const NEW_CLUSTER_MODEL_TABLE = "Cluster_Data.new_cluster_model";
/** The report reads the Cluster_Data copy, not the rr_project_data one. */
const HEALTH_SYSTEM_CLUSTER_TABLE = "Cluster_Data.health_system_cluster";
const CLIENT_ALIGNMENT_TABLE = "Cluster_Data.client_alignment";
const CLIENT_LOG_TABLE = "Cluster_Data.client_logs_new";
const REGION_ALIGNMENT_TABLE = "Cluster_Data.Region_alignment";

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
/** Recruiter and client logs both start here; earlier placements read PRE_LOG_REFERENCE_DATE. */
const LOG_ERA_START_DATE = "2025-01-01";
const PRE_LOG_REFERENCE_DATE = "2025-10-31";
/** The report reads health_system_cluster only for submissions in this window. */
const HEALTH_SYSTEM_CLUSTER_WINDOW = Object.freeze({ from: "2025-01-01", to: "2025-05-31" });

/** RR-Dashboad _regionalConfig.spotProjects defaults, compared without spaces. */
const SPOT_PROJECT_CODES = Object.freeze(["SPOT-N", "SPOT-A", "SPURMC-N", "SPURMC-A", "SPUP-N", "SPUP-A"]);

/** placementRegion.js APC_CLUSTERS: the region each state's Allied cluster covers. */
const APC_STATE_REGIONS = Object.freeze([
  { region: "North East", states: "PA/NY/VT/ME/MA/RI/NJ/NH/CT" },
  { region: "Midwest", states: "ND/SD/NE/KS/MN/IA/MO/WI/IL/IN/MI/OH" },
  { region: "South East/ Mid Atlantic", states: "AR/LA/MS/AL/GA/SC/NC/VA/WV/KY/TN/FL/DE/MD/DC" },
  { region: "South West/ Pacific West", states: "WA/OR/ID/MT/WY/CA/NV/UT/CO/AZ/NM/OK/TX/AK/HI" },
]);

/** Every half of a region name, upper-cased with spaces removed ("Mid West" == "Midwest"). */
const REGION_NAME_PARTS = Object.freeze([
  "NORTHEAST",
  "MIDWEST",
  "SOUTHEAST",
  "MIDATLANTIC",
  "SOUTHWEST",
  "PACIFICWEST",
]);

/** legacyClientAliases.js: the health_system_cluster lookup reads these clients under another name. */
const LEGACY_CLIENT_ALIASES = Object.freeze({ NCDAC: "State of NC", NCDPS: "State of NC" });

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
  LOG: "recruiter region log",
  PRE_LOG_REFERENCE: "log as of 2025-10-31 (pre-2025 placement)",
  SNAPSHOT: "rec_cluster (not in log)",
  REMOVED: "removed in log",
  BEFORE_LOG: "log starts after placement",
  NO_RECRUITER: "no recruiter email",
  NOT_FOUND: "not in log or rec_cluster",
});

const CLIENT_CODE_SOURCE = Object.freeze({
  ALLIED_REGION: "new_cluster_model APC region row",
  HEALTH_SYSTEM_CLUSTER: "health_system_cluster (Jan-May 2025 submission)",
  NEW_CLUSTER_MODEL: "new_cluster_model",
  SPOT_PROJECT: "special project client (recruiter code)",
  CLIENT_LOG: "client_logs_new",
  CLIENT_ALIGNMENT: "client_alignment",
  REGION_BY_STATE: "client_alignment state + speciality",
  NO_MATCH: "no match",
});

const WHY_BLANK = Object.freeze({
  NO_AS_OF_DATE: "no resolvable placement date",
  NO_RECRUITER: "no recruiter email",
  RECRUITER_REMOVED: "recruiter removed from cluster in log",
  RECRUITER_BEFORE_LOG: "recruiter log starts after placement",
  RECRUITER_NOT_FOUND: "recruiter not in cluster history or rec_cluster",
  CLIENT_ABSENT: "client absent from new_cluster_model",
  CLIENT_NO_ROW: "no new_cluster_model row for client/state/date",
  CLIENT_DATA_ENDED: "client data ended before placement",
  CLIENT_ADDED_LATER: "client added to new_cluster_model after placement",
  CLIENT_SUPERSEDED: "newer client row no longer covers the state",
  REGION_NOT_ALIGNED: "no client_alignment block for state + speciality",
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

/** getClusterType: a code naming GOV / SLED that is not a LOC / ENT / APC code. */
function isGovernmentCode(code) {
  const c = code == null ? "" : String(code).trim().toUpperCase();
  if (c === "" || c.includes("LOC") || c.includes("ENT") || c.includes("APC")) return false;
  return c.includes("GOV") || c.includes("SLED");
}

/**
 * True when a client code / cluster type means "government" (getClusterTypeFromField /
 * getClusterType in the report). The client decides the programme, not the recruiter.
 */
function isGovernmentClient(clusterType, clientCode) {
  const type = clusterType == null ? "" : String(clusterType).trim().toUpperCase();
  if (type !== "TARGET" && type !== "TERRITORY" && type !== "ENTERPRISE" && type.includes("GOV")) return true;
  return isGovernmentCode(clientCode);
}

/**
 * Specialty a recruiter code carries (resolveSpecialtyFromRegionCode): APC is Allied, a regional
 * code's last letter is N / A. Legacy cluster codes carry none, and a blank there is correct.
 * @returns {"Nursing"|"Allied"|null}
 */
function recruiterSpecialtyFromCode(code) {
  const raw = code == null ? "" : String(code).trim().toUpperCase();
  if (raw === "" || raw === "NA") return null;
  if (raw.startsWith("APC")) return "Allied";
  // Legacy families never encode specialty, whatever letter they happen to end on.
  if (/^(LOC|ENT|EXC|SPC|GOV|SLED)\b/.test(raw) || raw.startsWith("GOV ")) return null;
  if (raw.endsWith("N")) return "Nursing";
  if (raw.endsWith("A")) return "Allied";
  return null;
}

/**
 * Programme governing a row, from its recruiter as-of date. A Government client wins over the date.
 * Simplified: the SQL also takes post-cutover extensions, non-cynethealth recruiters and special
 * project codes into account.
 * @param {string|null} asOfDate - YYYY-MM-DD
 */
function resolveProgramme(asOfDate, clusterType, clientCode) {
  if (isGovernmentClient(clusterType, clientCode)) return PROGRAMME.GOVERNMENT;
  const d = asOfDate == null ? "" : String(asOfDate).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return PROGRAMME.CLUSTER;
  return d >= REGIONAL_PROGRAMME_START_DATE ? PROGRAMME.REGIONAL : PROGRAMME.CLUSTER;
}

const sqlStr = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const sqlList = (values) => values.map(sqlStr).join(", ");

/** SQL: a code is Government (isGovernmentCode). */
const govCodeSql = (expr) => `(
  NOT REGEXP_CONTAINS(UPPER(IFNULL(${expr}, '')), r'LOC|ENT|APC')
  AND REGEXP_CONTAINS(UPPER(IFNULL(${expr}, '')), r'GOV|SLED'))`;

/** SQL: a cluster type is Government (getClusterTypeFromField). */
const govTypeSql = (expr) => `(
  UPPER(TRIM(IFNULL(${expr}, ''))) NOT IN ('TARGET', 'TERRITORY', 'ENTERPRISE')
  AND STRPOS(UPPER(IFNULL(${expr}, '')), 'GOV') > 0)`;

/** SQL: retired EXC-n reads as "Gov Region n" (normaliseLegacyClusterCode). */
const displayCodeSql = (expr) => `IF(
  REGEXP_CONTAINS(UPPER(TRIM(IFNULL(${expr}, ''))), r'^EXC-[0-9]+$'),
  CONCAT('Gov Region ', REGEXP_EXTRACT(UPPER(TRIM(${expr})), r'^EXC-([0-9]+)$')),
  ${expr})`;

/** SQL: a region code compared the way the report compares special-project codes. */
const compactCodeSql = (expr) =>
  `UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(IFNULL(${expr}, '')), r'\\s*-\\s*', '-'), r'\\s+', ''))`;

/** SQL: a "/"-delimited name split into upper-cased, space-free parts. */
const namePartsSql = (expr) =>
  `ARRAY(SELECT REGEXP_REPLACE(p, r'\\s+', '') FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(${expr}, ''))), '/')) p WHERE TRIM(p) != '')`;

/** SQL: a "/"-delimited state list as an upper-cased array. */
const stateListSql = (expr) =>
  `ARRAY(SELECT TRIM(s) FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(${expr}, ''))), '/')) s WHERE TRIM(s) != '')`;

/**
 * One pass of resolveClientCluster over new_cluster_model, as CTEs named `${p}_*`, ending in
 * `${p}_out` (DEAL_SHEET_ID, code, ctype, matched_on). `req` names a CTE with DEAL_SHEET_ID,
 * client_up, req_msp, state_key, L (lookup date), apc_ok, rec_code_up.
 *
 * Run twice: once without APC rows to learn whether the client is Government (which moves the
 * recruiter's as-of date), and once with the recruiter known.
 */
function clientClusterPassSql(p, req) {
  const pickOrder = "d DESC, is_gov_type DESC, IF(width = 0, 9999, width), code_up";
  return `
    ${p}_cand AS (
      SELECT
        r.DEAL_SHEET_ID, r.L, r.req_msp, r.rec_code_up, r.client_up,
        n.msp_up, n.code, n.code_up, n.ctype, n.d, n.width, n.is_gov_type,
        o.code_up IS NOT NULL AS is_outlier
      FROM ${req} r
      JOIN ncm_rows n
        ON n.client_up = r.client_up
       AND NOT n.is_region_row
       AND (r.apc_ok OR NOT n.is_apc)
       AND (n.state_up = 'ALL' OR r.state_key IN UNNEST(n.state_list))
      LEFT JOIN ncm_outliers o ON o.client_up = n.client_up AND o.code_up = n.code_up
      WHERE r.client_up != '' AND r.state_key != '' AND r.L IS NOT NULL
    ),
    -- The lone "Gov School" slip is skipped, unless it is all the placement has.
    ${p}_pool AS (
      SELECT * EXCEPT(has_clean) FROM (
        SELECT c.*, COUNTIF(NOT c.is_outlier) OVER (PARTITION BY c.DEAL_SHEET_ID) > 0 AS has_clean
        FROM ${p}_cand c
      )
      WHERE NOT is_outlier OR NOT has_clean
    ),
    ${p}_flag AS (
      SELECT
        x.*,
        x.d <= x.L AS in_force,
        x.req_msp != '' AND x.msp_up = x.req_msp AS msp_hit,
        COUNTIF(x.d <= x.L) OVER w AS n_in_force,
        COUNTIF(x.d <= x.L AND x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_in_force_msp,
        COUNTIF(x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_msp
      FROM ${p}_pool x
      WINDOW w AS (PARTITION BY x.DEAL_SHEET_ID)
    ),
    -- Latest row in force; MSP narrows only when it matches something.
    ${p}_matched AS (
      SELECT * FROM ${p}_flag
      WHERE in_force AND (n_in_force_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY ${pickOrder}) = 1
    ),
    -- Among rows tied on the winning date, the recruiter's own code wins.
    ${p}_tie AS (
      SELECT f.DEAL_SHEET_ID, f.code, f.ctype
      FROM ${p}_flag f
      JOIN ${p}_matched m ON m.DEAL_SHEET_ID = f.DEAL_SHEET_ID
      WHERE f.in_force AND (f.n_in_force_msp = 0 OR f.msp_hit)
        AND f.d = m.d AND f.rec_code_up != '' AND f.code_up = f.rec_code_up
      QUALIFY ROW_NUMBER() OVER (PARTITION BY f.DEAL_SHEET_ID ORDER BY f.code_up) = 1
    ),
    -- A newer row for the same MSP that no longer covers the state supersedes the match.
    ${p}_superseded AS (
      SELECT DISTINCT m.DEAL_SHEET_ID
      FROM ${p}_matched m
      JOIN ncm_rows n
        ON n.client_up = m.client_up AND n.msp_up = m.msp_up AND n.d > m.d AND n.d <= m.L
    ),
    ${p}_pre AS (
      SELECT * FROM ${p}_flag
      WHERE n_in_force = 0 AND L < DATE '${LOG_ERA_START_DATE}'
        AND (n_msp = 0 OR msp_hit) AND d <= DATE '${PRE_LOG_REFERENCE_DATE}'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY ${pickOrder}) = 1
    ),
    ${p}_earliest AS (
      SELECT * FROM ${p}_flag
      WHERE n_in_force = 0 AND (n_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d ASC, is_gov_type DESC, code_up) = 1
    ),
    ${p}_decided AS (
      SELECT
        r.DEAL_SHEET_ID,
        CASE
          WHEN m.DEAL_SHEET_ID IS NOT NULL THEN
            CASE
              WHEN cs.client_last < nb.table_last
                AND FORMAT_DATE('%Y-%m', r.L) > FORMAT_DATE('%Y-%m', cs.client_last) THEN 'client_data_ended'
              WHEN sup.DEAL_SHEET_ID IS NOT NULL THEN 'superseded'
              WHEN t.DEAL_SHEET_ID IS NOT NULL THEN 'recruiter_tie'
              WHEN m.n_in_force_msp > 0 THEN 'msp'
              ELSE 'state'
            END
          WHEN pre.DEAL_SHEET_ID IS NOT NULL THEN 'pre_log_reference'
          WHEN e.DEAL_SHEET_ID IS NULL THEN 'no_row'
          WHEN cs.client_first > nb.table_first THEN 'client_added_later'
          ELSE 'earliest'
        END AS matched_on,
        m.code AS m_code, m.ctype AS m_ctype,
        t.code AS t_code, t.ctype AS t_ctype,
        pre.code AS pre_code, pre.ctype AS pre_ctype,
        e.code AS e_code, e.ctype AS e_ctype
      FROM ${req} r
      CROSS JOIN ncm_bounds nb
      LEFT JOIN ncm_clients cs ON cs.client_up = r.client_up
      LEFT JOIN ${p}_matched m ON m.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ${p}_tie t ON t.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ${p}_superseded sup ON sup.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ${p}_pre pre ON pre.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ${p}_earliest e ON e.DEAL_SHEET_ID = r.DEAL_SHEET_ID
    ),
    ${p}_out AS (
      SELECT
        DEAL_SHEET_ID,
        matched_on,
        CASE matched_on
          WHEN 'recruiter_tie' THEN t_code
          WHEN 'msp' THEN m_code
          WHEN 'state' THEN m_code
          WHEN 'pre_log_reference' THEN pre_code
          WHEN 'earliest' THEN e_code
        END AS code,
        CASE matched_on
          WHEN 'recruiter_tie' THEN t_ctype
          WHEN 'msp' THEN m_ctype
          WHEN 'state' THEN m_ctype
          WHEN 'pre_log_reference' THEN pre_ctype
          WHEN 'earliest' THEN e_ctype
        END AS ctype
      FROM ${p}_decided
    )`;
}

/**
 * Recruiter log lookup as CTEs `${p}_*`, ending in `${p}_out` (DEAL_SHEET_ID, found, log_code,
 * via_pre_ref, has_log). `req` names a CTE with DEAL_SHEET_ID, rec_email, as_of_date.
 */
function recruiterLogPassSql(p, req) {
  return `
    -- On one date a region beats an "NA", as in the report's ascending sort.
    ${p}_on_before AS (
      SELECT r.DEAL_SHEET_ID, l.new_code
      FROM ${req} r
      JOIN rec_log l ON l.rec_email = r.rec_email
      WHERE r.as_of_date IS NOT NULL AND l.eff <= r.as_of_date
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY r.DEAL_SHEET_ID ORDER BY l.eff DESC, IF(l.new_code = '${REGION_LOG_NA}', 1, 0), l.new_code
      ) = 1
    ),
    -- Pre-2025 placements read the alignment in force on the reference date.
    ${p}_pre_ref AS (
      SELECT r.DEAL_SHEET_ID, l.new_code
      FROM ${req} r
      JOIN rec_log l ON l.rec_email = r.rec_email
      WHERE r.as_of_date < DATE '${LOG_ERA_START_DATE}' AND l.eff <= DATE '${PRE_LOG_REFERENCE_DATE}'
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY r.DEAL_SHEET_ID ORDER BY l.eff DESC, IF(l.new_code = '${REGION_LOG_NA}', 1, 0), l.new_code
      ) = 1
    ),
    ${p}_out AS (
      SELECT
        r.DEAL_SHEET_ID,
        ob.DEAL_SHEET_ID IS NOT NULL OR pr.DEAL_SHEET_ID IS NOT NULL AS found,
        COALESCE(ob.new_code, pr.new_code) AS log_code,
        ob.DEAL_SHEET_ID IS NULL AND pr.DEAL_SHEET_ID IS NOT NULL AS via_pre_ref,
        hl.rec_email IS NOT NULL AS has_log
      FROM ${req} r
      LEFT JOIN ${p}_on_before ob ON ob.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ${p}_pre_ref pr ON pr.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN (SELECT DISTINCT rec_email FROM rec_log) hl ON hl.rec_email = r.rec_email
    )`;
}

/**
 * SQL for the resolved view of one deal sheet table: one row per DEAL_SHEET_ID with the three
 * column values plus the reasoning. Shared by the deal sheet fill and the trace table so the two can
 * never disagree.
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
  const rrlFqn = fqn(datasetId, RECRUITER_REGION_LOGS_TABLE_ID, projectId);
  const recSnapFqn = clusterDataFqn(RECRUITER_SNAPSHOT_TABLE, projectId);
  const ncmFqn = clusterDataFqn(NEW_CLUSTER_MODEL_TABLE, projectId);
  const hscFqn = clusterDataFqn(HEALTH_SYSTEM_CLUSTER_TABLE, projectId);
  const caFqn = clusterDataFqn(CLIENT_ALIGNMENT_TABLE, projectId);
  const clogFqn = clusterDataFqn(CLIENT_LOG_TABLE, projectId);
  const raFqn = clusterDataFqn(REGION_ALIGNMENT_TABLE, projectId);
  const cut = `DATE '${REGIONAL_PROGRAMME_START_DATE}'`;

  const stateRegionStructs = APC_STATE_REGIONS.flatMap(({ region, states }) =>
    states.split("/").map((s) => `STRUCT(${sqlStr(s)} AS state, ${sqlStr(region)} AS region)`)
  ).join(",\n        ");
  const aliasCases = Object.entries(LEGACY_CLIENT_ALIASES)
    .map(([from, to]) => `WHEN ${sqlStr(from)} THEN ${sqlStr(to)}`)
    .join(" ");

  return `
    WITH base AS (
      -- EXACTLY ONE ROW PER DEAL_SHEET_ID. The deal sheet is append-only, so a placement owns several
      -- rows and emitting all of them makes the UPDATE below fail with "UPDATE/MERGE must match at
      -- most one source row for each target row". The newest row wins.
      SELECT * EXCEPT(rn) FROM (
        SELECT
          DEAL_SHEET_ID,
          PLACEMENT_ID,
          RECRUITER_CLUSTER_REGION AS existing_recruiter_region,
          CLIENT_CLUSTER_REGION    AS existing_client_region,
          CLUSTER_TYPE             AS existing_cluster_type,
          LOWER(TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, ''))) AS rec_email,
          TRIM(IFNULL(PARENT_CLIENT_NAME, ''))         AS client_raw,
          UPPER(TRIM(IFNULL(PARENT_CLIENT_NAME, '')))  AS client_up,
          UPPER(TRIM(IFNULL(MSP_NAME, '')))            AS msp_up,
          TRIM(IFNULL(CLIENT_STATE, ''))               AS state_raw,
          UPPER(TRIM(IFNULL(CLIENT_STATE, '')))        AS state_key,
          UPPER(TRIM(IFNULL(OFFERING, '')))            AS offering_up,
          UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) IN ('EXTENSION', 'EXT') AS is_ext,
          DATE(SUBMISSION_DATE) AS sub,
          START_DATE            AS st,
          -- The report's START_DATE (ch_run_rate): the original assignment's start, which an
          -- extension keeps. The deal sheet's own START_DATE on an extension is the extension's, so
          -- it is never used in place of a blank INITIAL_START_DATE.
          INITIAL_START_DATE    AS ost,
          DATE(EXTENSION_DATE)  AS ext,
          ROW_NUMBER() OVER (
            PARTITION BY DEAL_SHEET_ID
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST
          ) AS rn
        FROM ${dealFqn}
        WHERE DEAL_SHEET_ID IS NOT NULL
      )
      WHERE rn = 1
    ),
    apc_states AS (
      SELECT * FROM UNNEST([
        ${stateRegionStructs}
      ])
    ),
    b2 AS (
      SELECT
        b.*,
        STRPOS(b.offering_up, 'ALLIED') > 0 AS is_allied,
        -- Client cluster lookup date: submission, then (extension) the extension date, then start.
        COALESCE(b.sub, IF(b.is_ext, b.ext, NULL), b.st) AS client_lookup_date,
        -- isPostJune2026Extension: an extension dated past the cutover on a contract started before
        -- it. A contract started in the Regional era keeps its extensions on the Region rules.
        b.is_ext AND NOT IFNULL(b.ost >= ${cut}, FALSE) AND IFNULL(b.ext >= ${cut}, FALSE) AS post_june_ext,
        NOT (b.rec_email LIKE '%cynetsystems.com%' OR b.rec_email LIKE '%cynetlocums.com%') AS is_health,
        ${namePartsSql("s.region")} AS placement_region_parts
      FROM base b
      LEFT JOIN apc_states s ON s.state = TRIM(SPLIT(b.state_key, '/')[SAFE_OFFSET(0)])
    ),
    ncm_rows AS (
      SELECT
        x.*,
        ARRAY_LENGTH(x.name_parts) > 0
          AND (SELECT LOGICAL_AND(part IN (${sqlList(REGION_NAME_PARTS)})) FROM UNNEST(x.name_parts) part)
          AS is_region_row,
        STARTS_WITH(x.code_up, 'APC') AS is_apc,
        STRPOS(UPPER(IFNULL(x.ctype, '')), 'GOV') > 0 AS is_gov_type,
        IF(x.state_up = '' OR x.state_up = 'ALL', 0, ARRAY_LENGTH(x.state_list)) AS width
      FROM (
        SELECT
          UPPER(TRIM(IFNULL(Client_Name, ''))) AS client_up,
          UPPER(TRIM(IFNULL(MSP_Name, '')))    AS msp_up,
          UPPER(TRIM(IFNULL(State, '')))       AS state_up,
          ${stateListSql("State")} AS state_list,
          NULLIF(TRIM(IFNULL(Cluster_Code, '')), '') AS code,
          UPPER(TRIM(IFNULL(Cluster_Code, '')))      AS code_up,
          NULLIF(TRIM(IFNULL(Cluster_Type, '')), '') AS ctype,
          Date AS d,
          ${namePartsSql("Client_Name")} AS name_parts
        FROM ${ncmFqn}
        WHERE Date IS NOT NULL
      ) x
    ),
    ncm_bounds AS (
      SELECT MIN(d) AS table_first, MAX(d) AS table_last FROM ncm_rows
    ),
    ncm_clients AS (
      SELECT client_up, MIN(d) AS client_first, MAX(d) AS client_last FROM ncm_rows GROUP BY client_up
    ),
    -- findOutlierCodes: only a lone "Gov School" row among a client's other codes is a slip.
    ncm_outliers AS (
      SELECT client_up, code_up FROM (
        SELECT
          client_up, code_up, COUNT(*) AS n,
          SUM(COUNT(*)) OVER (PARTITION BY client_up) AS total,
          COUNT(*) OVER (PARTITION BY client_up) AS n_codes
        FROM ncm_rows
        WHERE code_up != ''
        GROUP BY client_up, code_up
      )
      WHERE n = 1 AND code_up = 'GOV SCHOOL' AND total >= 3 AND n_codes >= 2
    ),
    -- buildRecruiterRegionHistoryMap: Recruiter Region Logs, one row per client, as a change log.
    -- A blank / "NA" region is "NA" (on no region from that date).
    rrl_rows AS (
      SELECT
        LOWER(TRIM(RECRUITER_EMAIL_ID)) AS rec_email,
        SAFE_CAST(EFFECTIVE_DATE AS DATE) AS eff,
        SAFE_CAST(END_DATE AS DATE) AS end_d,
        IF(UPPER(TRIM(IFNULL(NEW_REGION_CODE, ''))) IN ('', '${REGION_LOG_NA}'), '${REGION_LOG_NA}', TRIM(NEW_REGION_CODE))
          AS new_code
      FROM ${rrlFqn}
      WHERE IFNULL(IS_DELETED, FALSE) = FALSE
        AND TRIM(IFNULL(RECRUITER_EMAIL_ID, '')) != ''
        AND SAFE_CAST(EFFECTIVE_DATE AS DATE) IS NOT NULL
    ),
    -- An End Date with nothing covering the next day is a removal ("NA") from that day, but only
    -- from ${REGION_LOG_REMOVALS_FROM} on; an earlier one left the region carrying on, as before.
    rrl_removals AS (
      SELECT DISTINCT r.rec_email, DATE_ADD(r.end_d, INTERVAL 1 DAY) AS eff, '${REGION_LOG_NA}' AS new_code
      FROM rrl_rows r
      WHERE r.new_code != '${REGION_LOG_NA}'
        AND r.end_d IS NOT NULL
        AND DATE_ADD(r.end_d, INTERVAL 1 DAY) >= DATE '${REGION_LOG_REMOVALS_FROM}'
        AND NOT EXISTS (
          SELECT 1 FROM rrl_rows o
          WHERE o.rec_email = r.rec_email
            AND o.eff <= DATE_ADD(r.end_d, INTERVAL 1 DAY)
            AND IF(o.new_code = '${REGION_LOG_NA}',
                   o.eff = DATE_ADD(r.end_d, INTERVAL 1 DAY),
                   o.end_d IS NULL OR o.end_d >= DATE_ADD(r.end_d, INTERVAL 1 DAY))
        )
    ),
    rrl_log AS (
      SELECT DISTINCT rec_email, eff, new_code FROM rrl_rows
      UNION DISTINCT
      SELECT rec_email, eff, new_code FROM rrl_removals
    ),
    rec_log AS (
      SELECT rec_email, eff, new_code FROM rrl_log
      UNION ALL
      -- Fallback while Recruiter Region Logs is empty: the old history table, where a blank
      -- NEW_CLUSTER is KEPT as a removal.
      SELECT
        LOWER(TRIM(EMAIL_ID)) AS rec_email,
        EFFECTIVE_DATE AS eff,
        TRIM(IFNULL(NEW_CLUSTER, '')) AS new_code
      FROM ${recFqn}
      WHERE EMAIL_ID IS NOT NULL AND TRIM(EMAIL_ID) != '' AND EFFECTIVE_DATE IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM rrl_rows)
    ),
    rec_snapshot AS (
      SELECT LOWER(TRIM(RECRUITER_EMAIL_ID)) AS rec_email, MIN(TRIM(CLUSTER_CODE)) AS code
      FROM ${recSnapFqn}
      WHERE TRIM(IFNULL(RECRUITER_EMAIL_ID, '')) != '' AND TRIM(IFNULL(CLUSTER_CODE, '')) != ''
      GROUP BY 1
    ),
    -- Pass A: the client's cluster without APC rows, only to learn whether it is Government.
    req_a AS (
      SELECT
        DEAL_SHEET_ID, client_up, msp_up AS req_msp, state_key,
        client_lookup_date AS L, FALSE AS apc_ok, '' AS rec_code_up
      FROM b2
    ),
    ${clientClusterPassSql("ca", "req_a")},
    rec_req AS (
      SELECT
        b.DEAL_SHEET_ID,
        b.rec_email,
        ${govTypeSql("ca.ctype")} OR ${govCodeSql("ca.code")} AS client_gov_a,
        -- resolveAlignmentAsOfDate
        CASE
          WHEN (${govTypeSql("ca.ctype")} OR ${govCodeSql("ca.code")}) AND b.sub IS NOT NULL THEN b.sub
          WHEN b.is_ext AND b.post_june_ext THEN COALESCE(b.sub, b.ost, b.st)
          -- A contract started in the Regional era keeps the region it started on for every extension.
          WHEN b.is_ext AND b.ost >= ${cut} THEN b.ost
          WHEN b.is_ext THEN
            CASE
              WHEN COALESCE(b.ext, b.ost, b.st) >= ${cut} THEN COALESCE(b.ext, b.ost, b.st)
              WHEN b.sub IS NOT NULL THEN b.sub
              ELSE COALESCE(b.ext, b.ost, b.st)
            END
          WHEN b.st >= ${cut} THEN b.st
          WHEN b.sub IS NOT NULL THEN b.sub
          ELSE b.st
        END AS as_of_date
      FROM b2 b
      LEFT JOIN ca_out ca ON ca.DEAL_SHEET_ID = b.DEAL_SHEET_ID
    ),
    ${recruiterLogPassSql("rl", "rec_req")},
    rec_resolved AS (
      SELECT
        q.DEAL_SHEET_ID,
        q.as_of_date,
        q.client_gov_a,
        NULLIF(IF(q.rec_email IN ('', 'na') OR q.as_of_date IS NULL, NULL, IF(rl.found, rl.log_code, NULL)), '')
          AS log_code,
        CASE
          WHEN q.rec_email IN ('', 'na') THEN '${RECRUITER_CODE_SOURCE.NO_RECRUITER}'
          WHEN q.as_of_date IS NOT NULL AND rl.found AND rl.log_code = '' THEN '${RECRUITER_CODE_SOURCE.REMOVED}'
          WHEN q.as_of_date IS NOT NULL AND rl.found AND rl.via_pre_ref THEN '${RECRUITER_CODE_SOURCE.PRE_LOG_REFERENCE}'
          WHEN q.as_of_date IS NOT NULL AND rl.found THEN '${RECRUITER_CODE_SOURCE.LOG}'
          WHEN q.as_of_date IS NOT NULL AND rl.has_log THEN '${RECRUITER_CODE_SOURCE.BEFORE_LOG}'
          WHEN rs.code IS NOT NULL THEN '${RECRUITER_CODE_SOURCE.SNAPSHOT}'
          ELSE '${RECRUITER_CODE_SOURCE.NOT_FOUND}'
        END AS recruiter_code_source,
        rs.code AS snapshot_code
      FROM rec_req q
      LEFT JOIN rl_out rl ON rl.DEAL_SHEET_ID = q.DEAL_SHEET_ID
      LEFT JOIN rec_snapshot rs ON rs.rec_email = q.rec_email
    ),
    rec_final AS (
      SELECT
        r.*,
        -- The cluster the cluster rules read: the log, else rec_cluster when the log says nothing.
        CASE
          WHEN r.recruiter_code_source IN ('${RECRUITER_CODE_SOURCE.LOG}', '${RECRUITER_CODE_SOURCE.PRE_LOG_REFERENCE}')
            THEN r.log_code
          WHEN r.recruiter_code_source = '${RECRUITER_CODE_SOURCE.SNAPSHOT}' THEN r.snapshot_code
        END AS recruiter_cluster
      FROM rec_resolved r
    ),
    -- Pass B: the client's cluster with the recruiter known (APC rows for APC recruiters' Allied work).
    req_b AS (
      SELECT
        b.DEAL_SHEET_ID, b.client_up, b.msp_up AS req_msp, b.state_key,
        b.client_lookup_date AS L,
        b.is_allied AND (r.recruiter_cluster IS NULL OR STARTS_WITH(UPPER(r.recruiter_cluster), 'APC')) AS apc_ok,
        UPPER(TRIM(IFNULL(r.recruiter_cluster, ''))) AS rec_code_up
      FROM b2 b
      JOIN rec_final r ON r.DEAL_SHEET_ID = b.DEAL_SHEET_ID
    ),
    ${clientClusterPassSql("cb", "req_b")},
    -- Allied override: an APC recruiter's Allied placement reads the APC region row for its state.
    allied_pool AS (
      SELECT b.DEAL_SHEET_ID, b.client_lookup_date AS L, n.code, n.ctype, n.code_up, n.d
      FROM b2 b
      JOIN rec_final r ON r.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      JOIN ncm_rows n ON n.is_apc AND n.is_region_row
      WHERE EXISTS (SELECT 1 FROM UNNEST(n.name_parts) np JOIN UNNEST(b.placement_region_parts) pp ON np = pp)
        AND STARTS_WITH(UPPER(IFNULL(r.recruiter_cluster, '')), 'APC')
        AND b.is_allied
        AND b.client_lookup_date IS NOT NULL
        AND b.client_lookup_date < ${cut}
    ),
    allied_pick AS (
      SELECT DEAL_SHEET_ID, code, ctype
      FROM (
        SELECT
          a.*,
          COUNTIF(a.d <= a.L) OVER (PARTITION BY a.DEAL_SHEET_ID) AS n_in_force
        FROM allied_pool a
      )
      WHERE IF(n_in_force > 0, d <= L, TRUE)
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY DEAL_SHEET_ID
        ORDER BY IF(n_in_force > 0, d, NULL) DESC, IF(n_in_force > 0, NULL, d) ASC, code_up
      ) = 1
    ),
    -- health_system_cluster, for Jan-May 2025 submissions only. Exact client name and state.
    hsc_pick AS (
      SELECT b.DEAL_SHEET_ID, TRIM(h.Cluster_Code) AS code
      FROM b2 b
      JOIN ${hscFqn} h
        ON TRIM(h.Client_Name) = CASE UPPER(b.client_raw) ${aliasCases} ELSE b.client_raw END
       AND (TRIM(h.State) = b.state_raw OR UPPER(TRIM(h.State)) = 'ALL')
      WHERE b.sub BETWEEN DATE '${HEALTH_SYSTEM_CLUSTER_WINDOW.from}' AND DATE '${HEALTH_SYSTEM_CLUSTER_WINDOW.to}'
        AND b.client_raw != '' AND b.state_raw != ''
        AND UPPER(TRIM(h.Client_Name)) != 'THERAPY'
        AND TRIM(IFNULL(h.Cluster_Code, '')) != ''
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY b.DEAL_SHEET_ID
        ORDER BY IF(TRIM(h.State) = b.state_raw, 0, 1), TRIM(h.Cluster_Code)
      ) = 1
    ),
    client_cluster AS (
      SELECT
        b.DEAL_SHEET_ID,
        CASE
          WHEN ap.DEAL_SHEET_ID IS NOT NULL THEN ap.code
          WHEN hp.DEAL_SHEET_ID IS NOT NULL THEN hp.code
          ELSE cb.code
        END AS client_cluster,
        IF(ap.DEAL_SHEET_ID IS NOT NULL, ap.ctype, cb.ctype) AS client_cluster_type,
        CASE
          WHEN ap.DEAL_SHEET_ID IS NOT NULL THEN '${CLIENT_CODE_SOURCE.ALLIED_REGION}'
          WHEN hp.DEAL_SHEET_ID IS NOT NULL THEN '${CLIENT_CODE_SOURCE.HEALTH_SYSTEM_CLUSTER}'
          WHEN cb.code IS NOT NULL THEN CONCAT('${CLIENT_CODE_SOURCE.NEW_CLUSTER_MODEL} (', cb.matched_on, ')')
          ELSE '${CLIENT_CODE_SOURCE.NO_MATCH}'
        END AS client_cluster_source,
        cb.matched_on AS client_matched_on
      FROM b2 b
      LEFT JOIN cb_out cb ON cb.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN allied_pick ap ON ap.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN hsc_pick hp ON hp.DEAL_SHEET_ID = b.DEAL_SHEET_ID
    ),
    ca_rows AS (
      SELECT
        UPPER(TRIM(CLIENT_NAME)) AS client_up,
        ${stateListSql("STATE")} AS state_list,
        UPPER(TRIM(IFNULL(DIVISION, ''))) AS division_up,
        TRIM(REGION_CODE) AS region_code
      FROM ${caFqn}
      WHERE TRIM(IFNULL(CLIENT_NAME, '')) != '' AND TRIM(IFNULL(REGION_CODE, '')) != ''
    ),
    region_own AS (
      SELECT b.DEAL_SHEET_ID, MIN(c.region_code) AS code
      FROM b2 b
      JOIN ca_rows c
        ON c.client_up = b.client_up AND b.state_key IN UNNEST(c.state_list) AND c.division_up = b.offering_up
      WHERE b.client_up != '' AND b.state_key != '' AND b.offering_up != ''
      GROUP BY 1
    ),
    -- regionByStateAndDivision: every client in a state + speciality shares the region.
    region_by_state AS (
      SELECT b.DEAL_SHEET_ID, MIN(c.region_code) AS code
      FROM b2 b
      JOIN ca_rows c ON b.state_key IN UNNEST(c.state_list) AND c.division_up = b.offering_up
      WHERE b.state_key != '' AND b.offering_up != ''
      GROUP BY 1
    ),
    client_log AS (
      SELECT UPPER(TRIM(CLIENT_NAME)) AS client_up, EFFECTIVE_DATE AS eff, TRIM(IFNULL(NEW_CLUSTER, '')) AS new_code
      FROM ${clogFqn}
      WHERE TRIM(IFNULL(CLIENT_NAME, '')) != '' AND EFFECTIVE_DATE IS NOT NULL
    ),
    -- resolveClientRegionAsOf: deal -> submission, extension -> extension date; then start.
    client_log_req AS (
      SELECT
        DEAL_SHEET_ID, client_up,
        IF(is_ext, COALESCE(ext, st), COALESCE(sub, st)) AS as_of_date
      FROM b2
    ),
    client_log_pick AS (
      SELECT DEAL_SHEET_ID, new_code FROM (
        SELECT q.DEAL_SHEET_ID, l.new_code, l.eff, 0 AS pass
        FROM client_log_req q JOIN client_log l ON l.client_up = q.client_up
        WHERE q.as_of_date IS NOT NULL AND l.eff <= q.as_of_date
        UNION ALL
        SELECT q.DEAL_SHEET_ID, l.new_code, l.eff, 1 AS pass
        FROM client_log_req q JOIN client_log l ON l.client_up = q.client_up
        WHERE q.as_of_date < DATE '${LOG_ERA_START_DATE}' AND l.eff <= DATE '${PRE_LOG_REFERENCE_DATE}'
      )
      WHERE TRUE
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY pass, eff DESC, new_code) = 1
    ),
    spot_clients AS (
      SELECT DISTINCT LOWER(TRIM(EMAIL)) AS rec_email, UPPER(TRIM(CLIENT_NAME)) AS client_up
      FROM ${raFqn}
      WHERE TRIM(IFNULL(EMAIL, '')) != '' AND TRIM(IFNULL(CLIENT_NAME, '')) != ''
    ),
    resolved AS (
      SELECT
        b.DEAL_SHEET_ID,
        b.PLACEMENT_ID,
        b.existing_recruiter_region,
        b.existing_client_region,
        b.existing_cluster_type,
        b.rec_email,
        b.client_up,
        b.client_lookup_date,
        b.post_june_ext,
        r.as_of_date,
        CASE
          WHEN r.as_of_date IS NULL THEN NULL
          WHEN r.as_of_date = b.sub THEN '${AS_OF_DATE_SOURCE.SUBMISSION_DATE}'
          WHEN r.as_of_date = b.ext THEN '${AS_OF_DATE_SOURCE.EXTENSION_DATE}'
          ELSE '${AS_OF_DATE_SOURCE.START_DATE}'
        END AS as_of_date_source,
        r.recruiter_cluster,
        r.recruiter_code_source,
        r.log_code AS recruiter_region,
        cc.client_cluster,
        cc.client_cluster_type AS client_cluster_model_type,
        cc.client_cluster_source,
        cc.client_matched_on,
        ${govTypeSql("cc.client_cluster_type")} OR ${govCodeSql("cc.client_cluster")} AS client_gov,
        ${compactCodeSql("r.log_code")} IN (${sqlList(SPOT_PROJECT_CODES)}) AS recruiter_on_spot,
        sc.rec_email IS NOT NULL AS spot_client_matched,
        COALESCE(ro.code, rbs.code) AS client_region_alignment,
        IF(ro.code IS NOT NULL, '${CLIENT_CODE_SOURCE.CLIENT_ALIGNMENT}',
           IF(rbs.code IS NOT NULL, '${CLIENT_CODE_SOURCE.REGION_BY_STATE}', NULL)) AS client_region_alignment_source,
        NULLIF(clp.new_code, '') AS client_log_code,
        b.is_health
      FROM b2 b
      JOIN rec_final r ON r.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      JOIN client_cluster cc ON cc.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN region_own ro ON ro.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN region_by_state rbs ON rbs.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN client_log_pick clp ON clp.DEAL_SHEET_ID = b.DEAL_SHEET_ID
      LEFT JOIN spot_clients sc ON sc.rec_email = b.rec_email AND sc.client_up = b.client_up
    ),
    programmed AS (
      SELECT
        x.*,
        -- isRegionalProgramRow
        x.is_health
          AND NOT x.client_gov
          AND NOT x.post_june_ext
          AND (x.as_of_date >= ${cut} OR x.recruiter_on_spot) AS is_regional
      FROM resolved x
    )
    SELECT
      p.DEAL_SHEET_ID,
      p.PLACEMENT_ID,
      p.existing_recruiter_region,
      p.existing_client_region,
      p.existing_cluster_type,
      p.as_of_date,
      p.as_of_date_source,
      p.client_lookup_date,
      IF(p.is_regional, p.recruiter_region, ${displayCodeSql("p.recruiter_cluster")}) AS recruiter_code,
      IF(p.is_regional AND p.recruiter_region IS NULL, 'no log code for Regional row', p.recruiter_code_source)
        AS recruiter_code_source,
      CASE
        WHEN NOT p.is_regional THEN
          ${displayCodeSql("p.client_cluster")}
        WHEN p.recruiter_on_spot AND p.spot_client_matched THEN p.recruiter_region
        ELSE COALESCE(p.client_log_code, p.client_region_alignment)
      END AS client_code,
      CASE
        WHEN NOT p.is_regional THEN p.client_cluster_source
        WHEN p.recruiter_on_spot AND p.spot_client_matched THEN '${CLIENT_CODE_SOURCE.SPOT_PROJECT}'
        WHEN p.client_log_code IS NOT NULL THEN '${CLIENT_CODE_SOURCE.CLIENT_LOG}'
        WHEN p.client_region_alignment IS NOT NULL THEN p.client_region_alignment_source
        ELSE '${CLIENT_CODE_SOURCE.NO_MATCH}'
      END AS client_code_source,
      IF(p.is_regional, '${PROGRAMME.REGIONAL}', p.client_cluster_model_type) AS client_cluster_type,
      p.recruiter_cluster AS recruiter_cluster_raw,
      p.client_cluster AS client_cluster_raw,
      CASE
        WHEN p.is_regional THEN '${PROGRAMME.REGIONAL}'
        WHEN p.client_gov THEN '${PROGRAMME.GOVERNMENT}'
        ELSE '${PROGRAMME.CLUSTER}'
      END AS programme,
      -- WHY_BLANK: one line naming every side that came back blank, so a gap is actionable.
      NULLIF(
        ARRAY_TO_STRING(
          ARRAY(
            SELECT w FROM UNNEST([
              IF(p.as_of_date IS NULL, '${WHY_BLANK.NO_AS_OF_DATE}', NULL),
              IF(IF(p.is_regional, p.recruiter_region, p.recruiter_cluster) IS NULL,
                CASE p.recruiter_code_source
                  WHEN '${RECRUITER_CODE_SOURCE.NO_RECRUITER}' THEN '${WHY_BLANK.NO_RECRUITER}'
                  WHEN '${RECRUITER_CODE_SOURCE.REMOVED}' THEN '${WHY_BLANK.RECRUITER_REMOVED}'
                  WHEN '${RECRUITER_CODE_SOURCE.BEFORE_LOG}' THEN '${WHY_BLANK.RECRUITER_BEFORE_LOG}'
                  ELSE '${WHY_BLANK.RECRUITER_NOT_FOUND}'
                END, NULL),
              IF(NOT p.is_regional AND p.client_cluster IS NULL,
                CASE
                  WHEN p.client_up NOT IN (SELECT client_up FROM ncm_clients) THEN '${WHY_BLANK.CLIENT_ABSENT}'
                  WHEN p.client_matched_on = 'client_data_ended' THEN '${WHY_BLANK.CLIENT_DATA_ENDED}'
                  WHEN p.client_matched_on = 'client_added_later' THEN '${WHY_BLANK.CLIENT_ADDED_LATER}'
                  WHEN p.client_matched_on = 'superseded' THEN '${WHY_BLANK.CLIENT_SUPERSEDED}'
                  ELSE '${WHY_BLANK.CLIENT_NO_ROW}'
                END, NULL),
              IF(p.is_regional
                 AND NOT (p.recruiter_on_spot AND p.spot_client_matched)
                 AND p.client_log_code IS NULL AND p.client_region_alignment IS NULL,
                '${WHY_BLANK.REGION_NOT_ALIGNED}', NULL)
            ]) AS w
            WHERE w IS NOT NULL
          ),
          '; '
        ),
        ''
      ) AS why_blank
    FROM programmed p`;
}

/**
 * Multi-statement SQL filling the three deal sheet columns on the cynet health table, and reporting
 * how many rows each UPDATE touched. Idempotent: a settled table updates 0.
 *
 * Default FILL-IF-EMPTY. overwrite: true replaces any value that differs from the resolved one; a
 * column that resolved to nothing is still left alone.
 * @param {object} [options] - { projectId, datasetId, tableIds, overwrite }
 * @returns {{sql: string, tableIds: string[]}}
 */
function buildClusterRegionFillSql(options = {}) {
  const tableIds =
    Array.isArray(options.tableIds) && options.tableIds.length > 0
      ? [...new Set(options.tableIds.map((t) => String(t).trim()).filter(Boolean))]
      : [...CLUSTER_REGION_TABLE_IDS];
  const overwrite = options.overwrite === true;

  const blank = (col) => `NULLIF(TRIM(IFNULL(d.${col}, '')), '') IS NULL`;
  const differs = (col, src) => `IFNULL(TRIM(d.${col}), '') != s.${src}`;
  const needs = (col, src) =>
    overwrite
      ? `(s.${src} IS NOT NULL AND ${differs(col, src)})`
      : `(${blank(col)} AND s.${src} IS NOT NULL)`;
  const value = (col, src) =>
    overwrite
      ? `IFNULL(s.${src}, d.${col})`
      : `IFNULL(NULLIF(TRIM(IFNULL(d.${col}, '')), ''), s.${src})`;

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
    ${needs("RECRUITER_CLUSTER_REGION", "recruiter_code")}
    OR ${needs("CLIENT_CLUSTER_REGION", "client_code")}
    OR ${needs("CLUSTER_TYPE", "client_cluster_type")}`;

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
  RECRUITER_CLUSTER_REGION = ${value("RECRUITER_CLUSTER_REGION", "recruiter_code")},
  CLIENT_CLUSTER_REGION = ${value("CLIENT_CLUSTER_REGION", "client_code")},
  CLUSTER_TYPE = ${value("CLUSTER_TYPE", "client_cluster_type")}
FROM ${src} s
WHERE d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  -- Only touch rows where at least one of the three would change.
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
 * SQL rebuilding the trace table from scratch (CREATE OR REPLACE) with one row per deal sheet row.
 * Full reasoning lives here rather than on the deal sheet.
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
  client_lookup_date    AS CLIENT_LOOKUP_DATE,
  recruiter_code        AS RECRUITER_CODE,
  recruiter_code_source AS RECRUITER_CODE_SOURCE,
  recruiter_cluster_raw AS RECRUITER_CLUSTER_CODE,
  CASE
    WHEN recruiter_code IS NULL OR UPPER(recruiter_code) = 'NA' THEN NULL
    WHEN STARTS_WITH(UPPER(recruiter_code), 'APC') THEN 'Allied'
    WHEN REGEXP_CONTAINS(UPPER(recruiter_code), r'^(LOC|ENT|EXC|SPC|GOV|SLED)') THEN NULL
    WHEN UPPER(recruiter_code) LIKE '%N' THEN 'Nursing'
    WHEN UPPER(recruiter_code) LIKE '%A' THEN 'Allied'
  END AS RECRUITER_SPECIALTY,
  client_code           AS CLIENT_CODE,
  client_code_source    AS CLIENT_CODE_SOURCE,
  client_cluster_raw    AS CLIENT_CLUSTER_CODE,
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
 * @param {object} [options] - { projectId, datasetId, tableIds, skipTrace, overwrite }
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
  LOG_ERA_START_DATE,
  PRE_LOG_REFERENCE_DATE,
  SPOT_PROJECT_CODES,
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
