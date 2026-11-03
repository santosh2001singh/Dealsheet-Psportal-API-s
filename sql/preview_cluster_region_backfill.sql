-- Cluster / region backfill — PREVIEW (read-only). Run this first, then backfill_cluster_region.sql.
--
-- Table: cynetdatabase.rr_project_data.cynet_health_deal_sheet
-- Columns: RECRUITER_CLUSTER_REGION, CLIENT_CLUSTER_REGION, CLUSTER_TYPE
--
-- Rules = the RR-Dashboard incentive report (see functions/src/clusterRegionResolver.js).
-- GENERATED from buildClusterRegionResolvedSql — regenerate rather than hand-edit the resolver part.
--
-- One row per DEAL_SHEET_ID (newest version). The update writes every version of that id.
-- *_status: FILL = blank today, gets a value | CHANGE = value replaced | same | keep = nothing
-- resolved, current value stays (the update never blanks a column).
-- Only rows where at least one column is FILL or CHANGE are listed. Remove the final WHERE to see all.

WITH s AS (
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
          DATE(EXTENSION_DATE)  AS ext,
          ROW_NUMBER() OVER (
            PARTITION BY DEAL_SHEET_ID
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST
          ) AS rn
        FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
        WHERE DEAL_SHEET_ID IS NOT NULL
      )
      WHERE rn = 1
    ),
    apc_states AS (
      SELECT * FROM UNNEST([
        STRUCT('PA' AS state, 'North East' AS region),
        STRUCT('NY' AS state, 'North East' AS region),
        STRUCT('VT' AS state, 'North East' AS region),
        STRUCT('ME' AS state, 'North East' AS region),
        STRUCT('MA' AS state, 'North East' AS region),
        STRUCT('RI' AS state, 'North East' AS region),
        STRUCT('NJ' AS state, 'North East' AS region),
        STRUCT('NH' AS state, 'North East' AS region),
        STRUCT('CT' AS state, 'North East' AS region),
        STRUCT('ND' AS state, 'Midwest' AS region),
        STRUCT('SD' AS state, 'Midwest' AS region),
        STRUCT('NE' AS state, 'Midwest' AS region),
        STRUCT('KS' AS state, 'Midwest' AS region),
        STRUCT('MN' AS state, 'Midwest' AS region),
        STRUCT('IA' AS state, 'Midwest' AS region),
        STRUCT('MO' AS state, 'Midwest' AS region),
        STRUCT('WI' AS state, 'Midwest' AS region),
        STRUCT('IL' AS state, 'Midwest' AS region),
        STRUCT('IN' AS state, 'Midwest' AS region),
        STRUCT('MI' AS state, 'Midwest' AS region),
        STRUCT('OH' AS state, 'Midwest' AS region),
        STRUCT('AR' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('LA' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('MS' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('AL' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('GA' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('SC' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('NC' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('VA' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('WV' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('KY' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('TN' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('FL' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('DE' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('MD' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('DC' AS state, 'South East/ Mid Atlantic' AS region),
        STRUCT('WA' AS state, 'South West/ Pacific West' AS region),
        STRUCT('OR' AS state, 'South West/ Pacific West' AS region),
        STRUCT('ID' AS state, 'South West/ Pacific West' AS region),
        STRUCT('MT' AS state, 'South West/ Pacific West' AS region),
        STRUCT('WY' AS state, 'South West/ Pacific West' AS region),
        STRUCT('CA' AS state, 'South West/ Pacific West' AS region),
        STRUCT('NV' AS state, 'South West/ Pacific West' AS region),
        STRUCT('UT' AS state, 'South West/ Pacific West' AS region),
        STRUCT('CO' AS state, 'South West/ Pacific West' AS region),
        STRUCT('AZ' AS state, 'South West/ Pacific West' AS region),
        STRUCT('NM' AS state, 'South West/ Pacific West' AS region),
        STRUCT('OK' AS state, 'South West/ Pacific West' AS region),
        STRUCT('TX' AS state, 'South West/ Pacific West' AS region),
        STRUCT('AK' AS state, 'South West/ Pacific West' AS region),
        STRUCT('HI' AS state, 'South West/ Pacific West' AS region)
      ])
    ),
    b2 AS (
      SELECT
        b.*,
        STRPOS(b.offering_up, 'ALLIED') > 0 AS is_allied,
        -- Client cluster lookup date: submission, then (extension) the extension date, then start.
        COALESCE(b.sub, IF(b.is_ext, b.ext, NULL), b.st) AS client_lookup_date,
        -- isPostJune2026Extension: the later of start / extension date is past the cutover.
        b.is_ext AND (b.st >= DATE '2026-06-01' OR b.ext >= DATE '2026-06-01') AS post_june_ext,
        NOT (b.rec_email LIKE '%cynetsystems.com%' OR b.rec_email LIKE '%cynetlocums.com%') AS is_health,
        ARRAY(SELECT REGEXP_REPLACE(p, r'\s+', '') FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(s.region, ''))), '/')) p WHERE TRIM(p) != '') AS placement_region_parts
      FROM base b
      LEFT JOIN apc_states s ON s.state = TRIM(SPLIT(b.state_key, '/')[SAFE_OFFSET(0)])
    ),
    ncm_rows AS (
      SELECT
        x.*,
        ARRAY_LENGTH(x.name_parts) > 0
          AND (SELECT LOGICAL_AND(part IN ('NORTHEAST', 'MIDWEST', 'SOUTHEAST', 'MIDATLANTIC', 'SOUTHWEST', 'PACIFICWEST')) FROM UNNEST(x.name_parts) part)
          AS is_region_row,
        STARTS_WITH(x.code_up, 'APC') AS is_apc,
        STRPOS(UPPER(IFNULL(x.ctype, '')), 'GOV') > 0 AS is_gov_type,
        IF(x.state_up = '' OR x.state_up = 'ALL', 0, ARRAY_LENGTH(x.state_list)) AS width
      FROM (
        SELECT
          UPPER(TRIM(IFNULL(Client_Name, ''))) AS client_up,
          UPPER(TRIM(IFNULL(MSP_Name, '')))    AS msp_up,
          UPPER(TRIM(IFNULL(State, '')))       AS state_up,
          ARRAY(SELECT TRIM(s) FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(State, ''))), '/')) s WHERE TRIM(s) != '') AS state_list,
          NULLIF(TRIM(IFNULL(Cluster_Code, '')), '') AS code,
          UPPER(TRIM(IFNULL(Cluster_Code, '')))      AS code_up,
          NULLIF(TRIM(IFNULL(Cluster_Type, '')), '') AS ctype,
          Date AS d,
          ARRAY(SELECT REGEXP_REPLACE(p, r'\s+', '') FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(Client_Name, ''))), '/')) p WHERE TRIM(p) != '') AS name_parts
        FROM `cynetdatabase.Cluster_Data.new_cluster_model`
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
    rec_log AS (
      -- A blank NEW_CLUSTER is KEPT: it records the recruiter being taken off a cluster.
      SELECT
        LOWER(TRIM(EMAIL_ID)) AS rec_email,
        EFFECTIVE_DATE AS eff,
        TRIM(IFNULL(NEW_CLUSTER, '')) AS new_code
      FROM `cynetdatabase.Cluster_Data.rec_cluster_historical_data`
      WHERE EMAIL_ID IS NOT NULL AND TRIM(EMAIL_ID) != '' AND EFFECTIVE_DATE IS NOT NULL
    ),
    rec_snapshot AS (
      SELECT LOWER(TRIM(RECRUITER_EMAIL_ID)) AS rec_email, MIN(TRIM(CLUSTER_CODE)) AS code
      FROM `cynetdatabase.Cluster_Data.rec_cluster`
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
    
    ca_cand AS (
      SELECT
        r.DEAL_SHEET_ID, r.L, r.req_msp, r.rec_code_up, r.client_up,
        n.msp_up, n.code, n.code_up, n.ctype, n.d, n.width, n.is_gov_type,
        o.code_up IS NOT NULL AS is_outlier
      FROM req_a r
      JOIN ncm_rows n
        ON n.client_up = r.client_up
       AND NOT n.is_region_row
       AND (r.apc_ok OR NOT n.is_apc)
       AND (n.state_up = 'ALL' OR r.state_key IN UNNEST(n.state_list))
      LEFT JOIN ncm_outliers o ON o.client_up = n.client_up AND o.code_up = n.code_up
      WHERE r.client_up != '' AND r.state_key != '' AND r.L IS NOT NULL
    ),
    -- The lone "Gov School" slip is skipped, unless it is all the placement has.
    ca_pool AS (
      SELECT * EXCEPT(has_clean) FROM (
        SELECT c.*, COUNTIF(NOT c.is_outlier) OVER (PARTITION BY c.DEAL_SHEET_ID) > 0 AS has_clean
        FROM ca_cand c
      )
      WHERE NOT is_outlier OR NOT has_clean
    ),
    ca_flag AS (
      SELECT
        x.*,
        x.d <= x.L AS in_force,
        x.req_msp != '' AND x.msp_up = x.req_msp AS msp_hit,
        COUNTIF(x.d <= x.L) OVER w AS n_in_force,
        COUNTIF(x.d <= x.L AND x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_in_force_msp,
        COUNTIF(x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_msp
      FROM ca_pool x
      WINDOW w AS (PARTITION BY x.DEAL_SHEET_ID)
    ),
    -- Latest row in force; MSP narrows only when it matches something.
    ca_matched AS (
      SELECT * FROM ca_flag
      WHERE in_force AND (n_in_force_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d DESC, is_gov_type DESC, IF(width = 0, 9999, width), code_up) = 1
    ),
    -- Among rows tied on the winning date, the recruiter's own code wins.
    ca_tie AS (
      SELECT f.DEAL_SHEET_ID, f.code, f.ctype
      FROM ca_flag f
      JOIN ca_matched m ON m.DEAL_SHEET_ID = f.DEAL_SHEET_ID
      WHERE f.in_force AND (f.n_in_force_msp = 0 OR f.msp_hit)
        AND f.d = m.d AND f.rec_code_up != '' AND f.code_up = f.rec_code_up
      QUALIFY ROW_NUMBER() OVER (PARTITION BY f.DEAL_SHEET_ID ORDER BY f.code_up) = 1
    ),
    -- A newer row for the same MSP that no longer covers the state supersedes the match.
    ca_superseded AS (
      SELECT DISTINCT m.DEAL_SHEET_ID
      FROM ca_matched m
      JOIN ncm_rows n
        ON n.client_up = m.client_up AND n.msp_up = m.msp_up AND n.d > m.d AND n.d <= m.L
    ),
    ca_pre AS (
      SELECT * FROM ca_flag
      WHERE n_in_force = 0 AND L < DATE '2025-01-01'
        AND (n_msp = 0 OR msp_hit) AND d <= DATE '2025-10-31'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d DESC, is_gov_type DESC, IF(width = 0, 9999, width), code_up) = 1
    ),
    ca_earliest AS (
      SELECT * FROM ca_flag
      WHERE n_in_force = 0 AND (n_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d ASC, is_gov_type DESC, code_up) = 1
    ),
    ca_decided AS (
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
      FROM req_a r
      CROSS JOIN ncm_bounds nb
      LEFT JOIN ncm_clients cs ON cs.client_up = r.client_up
      LEFT JOIN ca_matched m ON m.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ca_tie t ON t.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ca_superseded sup ON sup.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ca_pre pre ON pre.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN ca_earliest e ON e.DEAL_SHEET_ID = r.DEAL_SHEET_ID
    ),
    ca_out AS (
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
      FROM ca_decided
    ),
    rec_req AS (
      SELECT
        b.DEAL_SHEET_ID,
        b.rec_email,
        (
  UPPER(TRIM(IFNULL(ca.ctype, ''))) NOT IN ('TARGET', 'TERRITORY', 'ENTERPRISE')
  AND STRPOS(UPPER(IFNULL(ca.ctype, '')), 'GOV') > 0) OR (
  NOT REGEXP_CONTAINS(UPPER(IFNULL(ca.code, '')), r'LOC|ENT|APC')
  AND REGEXP_CONTAINS(UPPER(IFNULL(ca.code, '')), r'GOV|SLED')) AS client_gov_a,
        -- resolveAlignmentAsOfDate
        CASE
          WHEN ((
  UPPER(TRIM(IFNULL(ca.ctype, ''))) NOT IN ('TARGET', 'TERRITORY', 'ENTERPRISE')
  AND STRPOS(UPPER(IFNULL(ca.ctype, '')), 'GOV') > 0) OR (
  NOT REGEXP_CONTAINS(UPPER(IFNULL(ca.code, '')), r'LOC|ENT|APC')
  AND REGEXP_CONTAINS(UPPER(IFNULL(ca.code, '')), r'GOV|SLED'))) AND b.sub IS NOT NULL THEN b.sub
          WHEN b.is_ext AND b.post_june_ext THEN COALESCE(b.sub, b.st)
          WHEN b.is_ext THEN
            CASE
              WHEN COALESCE(b.ext, b.st) >= DATE '2026-06-01' THEN COALESCE(b.ext, b.st)
              WHEN b.st >= DATE '2026-06-01' THEN b.st
              WHEN b.sub IS NOT NULL THEN b.sub
              ELSE COALESCE(b.ext, b.st)
            END
          WHEN b.st >= DATE '2026-06-01' THEN b.st
          WHEN b.sub IS NOT NULL THEN b.sub
          ELSE b.st
        END AS as_of_date
      FROM b2 b
      LEFT JOIN ca_out ca ON ca.DEAL_SHEET_ID = b.DEAL_SHEET_ID
    ),
    
    rl_on_before AS (
      SELECT r.DEAL_SHEET_ID, l.new_code
      FROM rec_req r
      JOIN rec_log l ON l.rec_email = r.rec_email
      WHERE r.as_of_date IS NOT NULL AND l.eff <= r.as_of_date
      QUALIFY ROW_NUMBER() OVER (PARTITION BY r.DEAL_SHEET_ID ORDER BY l.eff DESC, l.new_code) = 1
    ),
    -- Pre-2025 placements read the alignment in force on the reference date.
    rl_pre_ref AS (
      SELECT r.DEAL_SHEET_ID, l.new_code
      FROM rec_req r
      JOIN rec_log l ON l.rec_email = r.rec_email
      WHERE r.as_of_date < DATE '2025-01-01' AND l.eff <= DATE '2025-10-31'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY r.DEAL_SHEET_ID ORDER BY l.eff DESC, l.new_code) = 1
    ),
    rl_out AS (
      SELECT
        r.DEAL_SHEET_ID,
        ob.DEAL_SHEET_ID IS NOT NULL OR pr.DEAL_SHEET_ID IS NOT NULL AS found,
        COALESCE(ob.new_code, pr.new_code) AS log_code,
        ob.DEAL_SHEET_ID IS NULL AND pr.DEAL_SHEET_ID IS NOT NULL AS via_pre_ref,
        hl.rec_email IS NOT NULL AS has_log
      FROM rec_req r
      LEFT JOIN rl_on_before ob ON ob.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN rl_pre_ref pr ON pr.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN (SELECT DISTINCT rec_email FROM rec_log) hl ON hl.rec_email = r.rec_email
    ),
    rec_resolved AS (
      SELECT
        q.DEAL_SHEET_ID,
        q.as_of_date,
        q.client_gov_a,
        NULLIF(IF(q.rec_email IN ('', 'na') OR q.as_of_date IS NULL, NULL, IF(rl.found, rl.log_code, NULL)), '')
          AS log_code,
        CASE
          WHEN q.rec_email IN ('', 'na') THEN 'no recruiter email'
          WHEN q.as_of_date IS NOT NULL AND rl.found AND rl.log_code = '' THEN 'removed in log'
          WHEN q.as_of_date IS NOT NULL AND rl.found AND rl.via_pre_ref THEN 'log as of 2025-10-31 (pre-2025 placement)'
          WHEN q.as_of_date IS NOT NULL AND rl.found THEN 'rec_cluster_historical_data'
          WHEN q.as_of_date IS NOT NULL AND rl.has_log THEN 'log starts after placement'
          WHEN rs.code IS NOT NULL THEN 'rec_cluster (not in log)'
          ELSE 'not in log or rec_cluster'
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
          WHEN r.recruiter_code_source IN ('rec_cluster_historical_data', 'log as of 2025-10-31 (pre-2025 placement)')
            THEN r.log_code
          WHEN r.recruiter_code_source = 'rec_cluster (not in log)' THEN r.snapshot_code
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
    
    cb_cand AS (
      SELECT
        r.DEAL_SHEET_ID, r.L, r.req_msp, r.rec_code_up, r.client_up,
        n.msp_up, n.code, n.code_up, n.ctype, n.d, n.width, n.is_gov_type,
        o.code_up IS NOT NULL AS is_outlier
      FROM req_b r
      JOIN ncm_rows n
        ON n.client_up = r.client_up
       AND NOT n.is_region_row
       AND (r.apc_ok OR NOT n.is_apc)
       AND (n.state_up = 'ALL' OR r.state_key IN UNNEST(n.state_list))
      LEFT JOIN ncm_outliers o ON o.client_up = n.client_up AND o.code_up = n.code_up
      WHERE r.client_up != '' AND r.state_key != '' AND r.L IS NOT NULL
    ),
    -- The lone "Gov School" slip is skipped, unless it is all the placement has.
    cb_pool AS (
      SELECT * EXCEPT(has_clean) FROM (
        SELECT c.*, COUNTIF(NOT c.is_outlier) OVER (PARTITION BY c.DEAL_SHEET_ID) > 0 AS has_clean
        FROM cb_cand c
      )
      WHERE NOT is_outlier OR NOT has_clean
    ),
    cb_flag AS (
      SELECT
        x.*,
        x.d <= x.L AS in_force,
        x.req_msp != '' AND x.msp_up = x.req_msp AS msp_hit,
        COUNTIF(x.d <= x.L) OVER w AS n_in_force,
        COUNTIF(x.d <= x.L AND x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_in_force_msp,
        COUNTIF(x.req_msp != '' AND x.msp_up = x.req_msp) OVER w AS n_msp
      FROM cb_pool x
      WINDOW w AS (PARTITION BY x.DEAL_SHEET_ID)
    ),
    -- Latest row in force; MSP narrows only when it matches something.
    cb_matched AS (
      SELECT * FROM cb_flag
      WHERE in_force AND (n_in_force_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d DESC, is_gov_type DESC, IF(width = 0, 9999, width), code_up) = 1
    ),
    -- Among rows tied on the winning date, the recruiter's own code wins.
    cb_tie AS (
      SELECT f.DEAL_SHEET_ID, f.code, f.ctype
      FROM cb_flag f
      JOIN cb_matched m ON m.DEAL_SHEET_ID = f.DEAL_SHEET_ID
      WHERE f.in_force AND (f.n_in_force_msp = 0 OR f.msp_hit)
        AND f.d = m.d AND f.rec_code_up != '' AND f.code_up = f.rec_code_up
      QUALIFY ROW_NUMBER() OVER (PARTITION BY f.DEAL_SHEET_ID ORDER BY f.code_up) = 1
    ),
    -- A newer row for the same MSP that no longer covers the state supersedes the match.
    cb_superseded AS (
      SELECT DISTINCT m.DEAL_SHEET_ID
      FROM cb_matched m
      JOIN ncm_rows n
        ON n.client_up = m.client_up AND n.msp_up = m.msp_up AND n.d > m.d AND n.d <= m.L
    ),
    cb_pre AS (
      SELECT * FROM cb_flag
      WHERE n_in_force = 0 AND L < DATE '2025-01-01'
        AND (n_msp = 0 OR msp_hit) AND d <= DATE '2025-10-31'
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d DESC, is_gov_type DESC, IF(width = 0, 9999, width), code_up) = 1
    ),
    cb_earliest AS (
      SELECT * FROM cb_flag
      WHERE n_in_force = 0 AND (n_msp = 0 OR msp_hit)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY d ASC, is_gov_type DESC, code_up) = 1
    ),
    cb_decided AS (
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
      FROM req_b r
      CROSS JOIN ncm_bounds nb
      LEFT JOIN ncm_clients cs ON cs.client_up = r.client_up
      LEFT JOIN cb_matched m ON m.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN cb_tie t ON t.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN cb_superseded sup ON sup.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN cb_pre pre ON pre.DEAL_SHEET_ID = r.DEAL_SHEET_ID
      LEFT JOIN cb_earliest e ON e.DEAL_SHEET_ID = r.DEAL_SHEET_ID
    ),
    cb_out AS (
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
      FROM cb_decided
    ),
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
        AND b.client_lookup_date < DATE '2026-06-01'
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
      JOIN `cynetdatabase.Cluster_Data.health_system_cluster` h
        ON TRIM(h.Client_Name) = CASE UPPER(b.client_raw) WHEN 'NCDAC' THEN 'State of NC' WHEN 'NCDPS' THEN 'State of NC' ELSE b.client_raw END
       AND (TRIM(h.State) = b.state_raw OR UPPER(TRIM(h.State)) = 'ALL')
      WHERE b.sub BETWEEN DATE '2025-01-01' AND DATE '2025-05-31'
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
          WHEN ap.DEAL_SHEET_ID IS NOT NULL THEN 'new_cluster_model APC region row'
          WHEN hp.DEAL_SHEET_ID IS NOT NULL THEN 'health_system_cluster (Jan-May 2025 submission)'
          WHEN cb.code IS NOT NULL THEN CONCAT('new_cluster_model (', cb.matched_on, ')')
          ELSE 'no match'
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
        ARRAY(SELECT TRIM(s) FROM UNNEST(SPLIT(UPPER(TRIM(IFNULL(STATE, ''))), '/')) s WHERE TRIM(s) != '') AS state_list,
        UPPER(TRIM(IFNULL(DIVISION, ''))) AS division_up,
        TRIM(REGION_CODE) AS region_code
      FROM `cynetdatabase.Cluster_Data.client_alignment`
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
      FROM `cynetdatabase.Cluster_Data.client_logs_new`
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
        WHERE q.as_of_date < DATE '2025-01-01' AND l.eff <= DATE '2025-10-31'
      )
      WHERE TRUE
      QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY pass, eff DESC, new_code) = 1
    ),
    spot_clients AS (
      SELECT DISTINCT LOWER(TRIM(EMAIL)) AS rec_email, UPPER(TRIM(CLIENT_NAME)) AS client_up
      FROM `cynetdatabase.Cluster_Data.Region_alignment`
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
          WHEN r.as_of_date = b.sub THEN 'SUBMISSION_DATE'
          WHEN r.as_of_date = b.ext THEN 'EXTENSION_DATE'
          ELSE 'START_DATE'
        END AS as_of_date_source,
        r.recruiter_cluster,
        r.recruiter_code_source,
        r.log_code AS recruiter_region,
        cc.client_cluster,
        cc.client_cluster_type AS client_cluster_model_type,
        cc.client_cluster_source,
        cc.client_matched_on,
        (
  UPPER(TRIM(IFNULL(cc.client_cluster_type, ''))) NOT IN ('TARGET', 'TERRITORY', 'ENTERPRISE')
  AND STRPOS(UPPER(IFNULL(cc.client_cluster_type, '')), 'GOV') > 0) OR (
  NOT REGEXP_CONTAINS(UPPER(IFNULL(cc.client_cluster, '')), r'LOC|ENT|APC')
  AND REGEXP_CONTAINS(UPPER(IFNULL(cc.client_cluster, '')), r'GOV|SLED')) AS client_gov,
        UPPER(REGEXP_REPLACE(REGEXP_REPLACE(TRIM(IFNULL(r.log_code, '')), r'\s*-\s*', '-'), r'\s+', '')) IN ('SPOT-N', 'SPOT-A', 'SPURMC-N', 'SPURMC-A', 'SPUP-N', 'SPUP-A') AS recruiter_on_spot,
        sc.rec_email IS NOT NULL AS spot_client_matched,
        COALESCE(ro.code, rbs.code) AS client_region_alignment,
        IF(ro.code IS NOT NULL, 'client_alignment',
           IF(rbs.code IS NOT NULL, 'client_alignment state + speciality', NULL)) AS client_region_alignment_source,
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
          AND (x.as_of_date >= DATE '2026-06-01' OR x.recruiter_on_spot) AS is_regional
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
      IF(p.is_regional, p.recruiter_region, IF(
  REGEXP_CONTAINS(UPPER(TRIM(IFNULL(p.recruiter_cluster, ''))), r'^EXC-[0-9]+$'),
  CONCAT('Gov Region ', REGEXP_EXTRACT(UPPER(TRIM(p.recruiter_cluster)), r'^EXC-([0-9]+)$')),
  p.recruiter_cluster)) AS recruiter_code,
      IF(p.is_regional AND p.recruiter_region IS NULL, 'no log code for Regional row', p.recruiter_code_source)
        AS recruiter_code_source,
      CASE
        WHEN NOT p.is_regional THEN
          IF(
  REGEXP_CONTAINS(UPPER(TRIM(IFNULL(p.client_cluster, ''))), r'^EXC-[0-9]+$'),
  CONCAT('Gov Region ', REGEXP_EXTRACT(UPPER(TRIM(p.client_cluster)), r'^EXC-([0-9]+)$')),
  p.client_cluster)
        WHEN p.recruiter_on_spot AND p.spot_client_matched THEN p.recruiter_region
        ELSE COALESCE(p.client_log_code, p.client_region_alignment)
      END AS client_code,
      CASE
        WHEN NOT p.is_regional THEN p.client_cluster_source
        WHEN p.recruiter_on_spot AND p.spot_client_matched THEN 'special project client (recruiter code)'
        WHEN p.client_log_code IS NOT NULL THEN 'client_logs_new'
        WHEN p.client_region_alignment IS NOT NULL THEN p.client_region_alignment_source
        ELSE 'no match'
      END AS client_code_source,
      IF(p.is_regional, 'Regional', p.client_cluster_model_type) AS client_cluster_type,
      p.recruiter_cluster AS recruiter_cluster_raw,
      p.client_cluster AS client_cluster_raw,
      CASE
        WHEN p.is_regional THEN 'Regional'
        WHEN p.client_gov THEN 'Government'
        ELSE 'Cluster'
      END AS programme,
      -- WHY_BLANK: one line naming every side that came back blank, so a gap is actionable.
      NULLIF(
        ARRAY_TO_STRING(
          ARRAY(
            SELECT w FROM UNNEST([
              IF(p.as_of_date IS NULL, 'no resolvable placement date', NULL),
              IF(IF(p.is_regional, p.recruiter_region, p.recruiter_cluster) IS NULL,
                CASE p.recruiter_code_source
                  WHEN 'no recruiter email' THEN 'no recruiter email'
                  WHEN 'removed in log' THEN 'recruiter removed from cluster in log'
                  WHEN 'log starts after placement' THEN 'recruiter log starts after placement'
                  ELSE 'recruiter not in cluster history or rec_cluster'
                END, NULL),
              IF(NOT p.is_regional AND p.client_cluster IS NULL,
                CASE
                  WHEN p.client_up NOT IN (SELECT client_up FROM ncm_clients) THEN 'client absent from new_cluster_model'
                  WHEN p.client_matched_on = 'client_data_ended' THEN 'client data ended before placement'
                  WHEN p.client_matched_on = 'client_added_later' THEN 'client added to new_cluster_model after placement'
                  WHEN p.client_matched_on = 'superseded' THEN 'newer client row no longer covers the state'
                  ELSE 'no new_cluster_model row for client/state/date'
                END, NULL),
              IF(p.is_regional
                 AND NOT (p.recruiter_on_spot AND p.spot_client_matched)
                 AND p.client_log_code IS NULL AND p.client_region_alignment IS NULL,
                'no client_alignment block for state + speciality', NULL)
            ]) AS w
            WHERE w IS NOT NULL
          ),
          '; '
        ),
        ''
      ) AS why_blank
    FROM programmed p
),
d AS (
  SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE DEAL_SHEET_ID IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST) = 1
),
p AS (
  SELECT
    d.DEAL_SHEET_ID, d.PLACEMENT_ID, d.SKU_NUMBER, d.CANDIDATE_NAME, d.DEAL_TYPE, d.PLACEMENT_STATUS,
    DATE(d.SUBMISSION_DATE) AS submission_date, d.START_DATE AS start_date, DATE(d.EXTENSION_DATE) AS extension_date,
    d.ASSIGNMENT_RECRUITER_EMAIL, d.PARENT_CLIENT_NAME, d.MSP_NAME, d.CLIENT_STATE, d.OFFERING,
    s.programme,
    s.as_of_date AS recruiter_as_of_date, s.as_of_date_source AS recruiter_as_of_source,
    s.client_lookup_date,

    d.RECRUITER_CLUSTER_REGION AS recruiter_current,
    s.recruiter_code           AS recruiter_new,
    CASE
    WHEN s.recruiter_code IS NULL THEN IF(NULLIF(TRIM(IFNULL(d.RECRUITER_CLUSTER_REGION, '')), '') IS NULL, 'blank (nothing resolved)', 'keep (nothing resolved)')
    WHEN NULLIF(TRIM(IFNULL(d.RECRUITER_CLUSTER_REGION, '')), '') IS NULL THEN 'FILL'
    WHEN TRIM(d.RECRUITER_CLUSTER_REGION) = s.recruiter_code THEN 'same'
    ELSE 'CHANGE'
  END AS recruiter_status,
    s.recruiter_code_source    AS recruiter_source,

    d.CLIENT_CLUSTER_REGION AS client_current,
    s.client_code           AS client_new,
    CASE
    WHEN s.client_code IS NULL THEN IF(NULLIF(TRIM(IFNULL(d.CLIENT_CLUSTER_REGION, '')), '') IS NULL, 'blank (nothing resolved)', 'keep (nothing resolved)')
    WHEN NULLIF(TRIM(IFNULL(d.CLIENT_CLUSTER_REGION, '')), '') IS NULL THEN 'FILL'
    WHEN TRIM(d.CLIENT_CLUSTER_REGION) = s.client_code THEN 'same'
    ELSE 'CHANGE'
  END AS client_status,
    s.client_code_source    AS client_source,

    d.CLUSTER_TYPE         AS cluster_type_current,
    s.client_cluster_type  AS cluster_type_new,
    CASE
    WHEN s.client_cluster_type IS NULL THEN IF(NULLIF(TRIM(IFNULL(d.CLUSTER_TYPE, '')), '') IS NULL, 'blank (nothing resolved)', 'keep (nothing resolved)')
    WHEN NULLIF(TRIM(IFNULL(d.CLUSTER_TYPE, '')), '') IS NULL THEN 'FILL'
    WHEN TRIM(d.CLUSTER_TYPE) = s.client_cluster_type THEN 'same'
    ELSE 'CHANGE'
  END AS cluster_type_status,

    s.why_blank
  FROM d JOIN s USING (DEAL_SHEET_ID)
)
SELECT * FROM p
WHERE 'FILL' IN (recruiter_status, client_status, cluster_type_status)
   OR 'CHANGE' IN (recruiter_status, client_status, cluster_type_status)
ORDER BY programme, start_date DESC, DEAL_SHEET_ID;
