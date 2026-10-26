-- PREVIEW ONLY (no writes). Single SELECT — run the whole file (or select all of it).
--
-- Rule (2026-10-23, applyPreviousRecruiterIntoNewRecruiterHierarchyForRows): when the recruiter
-- changes and the PREVIOUS recruiter sits in the NEW recruiter's chain at a managed designation,
-- the previous recruiter goes into that regular field (e.g. RM / RM_EMP_NO).
-- Chain snapshot = same as code: per level, latest snapshot on/before NEW_HIRE_DATE, else earliest.
-- Title -> designation map is generated from recruiterHierarchyDesignations.js (managed only;
-- SECONDARY_RECRUITER / SECONDARY_AM excluded), with the " - Delivery/REC/..." suffix strip and the
-- unambiguous-directory-title fallback for NULL titles.
--
-- Scope: Health deal sheet, each placement's LATEST recruiter change. Rows to fix = that change row
-- and every later row of the placement (they carried the hierarchy forward from it).
-- Example case: PLACEMENT_ID 1472372 (Alex Smith -> Kartik Gupta, RM).

WITH
title_map AS (
  SELECT * FROM UNNEST([
    STRUCT('atl' AS title, 'ATL' AS designation),
    STRUCT('associate team lead' AS title, 'ATL' AS designation),
    STRUCT('associate team lead - federal' AS title, 'ATL' AS designation),
    STRUCT('tl' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('team lead' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('senior team lead' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('senior teamlead' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('senior tl' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('sr team lead' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('sr. team lead' AS title, 'TEAM_LEAD' AS designation),
    STRUCT('rm' AS title, 'RM' AS designation),
    STRUCT('recruitement manager' AS title, 'RM' AS designation),
    STRUCT('recruitment manager' AS title, 'RM' AS designation),
    STRUCT('associate recruitment manager' AS title, 'RM' AS designation),
    STRUCT('associate recruitement manager' AS title, 'RM' AS designation),
    STRUCT('associate recruiterment manager' AS title, 'RM' AS designation),
    STRUCT('associate delivery manager' AS title, 'ASSOCIATE_AM' AS designation),
    STRUCT('associate account manager' AS title, 'ASSOCIATE_AM' AS designation),
    STRUCT('delivery manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('sr. delivery manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('sr delivery manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('senior delivery manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('account manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('sr. account manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('sr account manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('senior account manager' AS title, 'ACCOUNT_MANAGER' AS designation),
    STRUCT('delivery director' AS title, 'DELIVERY_DIRECTOR' AS designation),
    STRUCT('director - delivery' AS title, 'DELIVERY_DIRECTOR' AS designation),
    STRUCT('director delivery' AS title, 'DELIVERY_DIRECTOR' AS designation),
    STRUCT('director' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('associate director' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('assoc director' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('associate group director' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('associate group directeor' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('associate director - delivery' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('associate director delivery' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('director - business operations' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('director delivery for public sector' AS title, 'ASSOCIATE_DELIVERY_DIRECTOR' AS designation),
    STRUCT('vice president' AS title, 'VP' AS designation),
    STRUCT('vp' AS title, 'VP' AS designation),
    STRUCT('sr vp' AS title, 'VP' AS designation),
    STRUCT('sr. vp' AS title, 'VP' AS designation),
    STRUCT('svp' AS title, 'VP' AS designation),
    STRUCT('srvp' AS title, 'VP' AS designation),
    STRUCT('vp srvp' AS title, 'VP' AS designation),
    STRUCT('vp/srvp' AS title, 'VP' AS designation),
    STRUCT('sr vice president' AS title, 'VP' AS designation),
    STRUCT('sr. vice president' AS title, 'VP' AS designation),
    STRUCT('senior vice president' AS title, 'VP' AS designation),
    STRUCT('sr vice president (svp)' AS title, 'VP' AS designation),
    STRUCT('sr. vice president (svp)' AS title, 'VP' AS designation),
    STRUCT('senior vice president (svp)' AS title, 'VP' AS designation),
    STRUCT('sr vp (svp)' AS title, 'VP' AS designation),
    STRUCT('sr. vp (svp)' AS title, 'VP' AS designation),
    STRUCT('avp' AS title, 'AVP' AS designation),
    STRUCT('associate vice president' AS title, 'AVP' AS designation),
    STRUCT('associate vice president - delivery' AS title, 'AVP' AS designation),
    STRUCT('associate vice president delivery' AS title, 'AVP' AS designation)
  ])
),

-- Every deal-sheet version with the recruiter of the version before it.
versions AS (
  SELECT
    ds.*,
    LAG(LOWER(TRIM(ds.ASSIGNMENT_RECRUITER_EMAIL))) OVER w AS prev_email,
    LAG(ds.ASSIGNMENT_RECRUITER) OVER w AS prev_recruiter_name,
    LAG(ds.RECRUITER_EMP_NO) OVER w AS prev_recruiter_emp_no,
    ROW_NUMBER() OVER (PARTITION BY ds.DEAL_SHEET_ID, ds.PLACEMENT_ID ORDER BY ds.LAST_UPDATED DESC) AS rn_desc
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` ds
  WINDOW w AS (PARTITION BY ds.DEAL_SHEET_ID, ds.PLACEMENT_ID ORDER BY ds.LAST_UPDATED)
),

-- Latest recruiter change per placement.
last_change AS (
  SELECT *
  FROM versions
  WHERE prev_email IS NOT NULL AND prev_email != ''
    AND LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) != prev_email
    AND COALESCE(UPPER(TRIM(prev_recruiter_emp_no)), '') != COALESCE(UPPER(TRIM(RECRUITER_EMP_NO)), '')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID, PLACEMENT_ID ORDER BY LAST_UPDATED DESC) = 1
),

-- New recruiter -> directory external_id (same ranking as fetchEmployeeDirectoryByEmails).
new_recruiter_dir AS (
  SELECT LOWER(TRIM(email)) AS email_norm, external_id
  FROM `cynetdatabase.MISC.directory_employees`
  WHERE external_id IS NOT NULL OR employee_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY LOWER(TRIM(email))
    ORDER BY (status = 'ACTIVE') DESC, (external_id IS NOT NULL) DESC, updated_at DESC
  ) = 1
),

-- New recruiter's chain: per level, latest snapshot on/before NEW_HIRE_DATE, else earliest.
chain AS (
  SELECT
    c.DEAL_SHEET_ID, c.PLACEMENT_ID,
    h.hierarchy_level, h.manager_name, h.manager_employee_id, h.manager_title
  FROM last_change c
  JOIN new_recruiter_dir d ON d.email_norm = LOWER(TRIM(c.ASSIGNMENT_RECRUITER_EMAIL))
  JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h ON h.employee_external_id = d.external_id
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY c.DEAL_SHEET_ID, c.PLACEMENT_ID, h.hierarchy_level
    ORDER BY
      CASE WHEN h.synced_at <= c.NEW_HIRE_DATE THEN 0 ELSE 1 END,
      CASE WHEN h.synced_at <= c.NEW_HIRE_DATE THEN h.synced_at END DESC,
      h.synced_at ASC
  ) = 1
),

-- Unambiguous directory designation per emp-no (fallback when the snapshot title is NULL).
directory_titles AS (
  SELECT
    CAST(h.manager_employee_id AS STRING) AS emp_no,
    LOWER(TRIM(REGEXP_REPLACE(h.manager_title, r'\s+', ' '))) AS t
  FROM `cynetdatabase.MISC.directory_employee_hierarchy` h
  WHERE h.manager_title IS NOT NULL AND TRIM(h.manager_title) != ''
  GROUP BY 1, 2
),
directory_title_designation AS (
  SELECT emp_no, ANY_VALUE(d) AS designation
  FROM (
    SELECT DISTINCT dt.emp_no, COALESCE(m1.designation, m2.designation) AS d
    FROM directory_titles dt
    LEFT JOIN title_map m1 ON m1.title = dt.t
    LEFT JOIN title_map m2
      ON m2.title = TRIM(REGEXP_REPLACE(dt.t, r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$', ''))
    WHERE COALESCE(m1.designation, m2.designation) IS NOT NULL
  )
  GROUP BY emp_no
  HAVING COUNT(DISTINCT d) = 1
),

-- Previous recruiter found in the new chain (emp-no; name when either emp-no is blank). Lowest level wins.
prev_in_chain AS (
  SELECT
    c.DEAL_SHEET_ID, c.PLACEMENT_ID,
    ch.hierarchy_level, ch.manager_name, ch.manager_employee_id, ch.manager_title,
    COALESCE(m1.designation, m2.designation, dtd.designation) AS designation
  FROM last_change c
  JOIN chain ch USING (DEAL_SHEET_ID, PLACEMENT_ID)
  LEFT JOIN title_map m1
    ON m1.title = LOWER(TRIM(REGEXP_REPLACE(ch.manager_title, r'\s+', ' ')))
  LEFT JOIN title_map m2
    ON m2.title = TRIM(REGEXP_REPLACE(LOWER(TRIM(REGEXP_REPLACE(ch.manager_title, r'\s+', ' '))),
                                      r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$', ''))
  LEFT JOIN directory_title_designation dtd
    ON dtd.emp_no = UPPER(TRIM(CAST(ch.manager_employee_id AS STRING)))
  WHERE
    CASE
      WHEN COALESCE(TRIM(c.prev_recruiter_emp_no), '') != '' AND COALESCE(TRIM(CAST(ch.manager_employee_id AS STRING)), '') != ''
        THEN UPPER(TRIM(c.prev_recruiter_emp_no)) = UPPER(TRIM(CAST(ch.manager_employee_id AS STRING)))
      ELSE LOWER(TRIM(REGEXP_REPLACE(c.prev_recruiter_name, r'\s*\([^)]*\)\s*$', ''))) = LOWER(TRIM(ch.manager_name))
    END
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.DEAL_SHEET_ID, c.PLACEMENT_ID ORDER BY SAFE_CAST(ch.hierarchy_level AS INT64)) = 1
),

latest AS (SELECT * FROM versions WHERE rn_desc = 1),

preview AS (
SELECT
  c.PLACEMENT_ID,
  c.DEAL_SHEET_ID,
  c.CONTRACT_ID,
  c.DEAL_TYPE,
  l.PLACEMENT_STATUS AS latest_status,
  c.CANDIDATE_NAME,
  c.prev_recruiter_name,
  c.prev_recruiter_emp_no,
  c.ASSIGNMENT_RECRUITER AS new_recruiter,
  c.RECRUITER_EMP_NO AS new_recruiter_emp_no,
  c.LAST_UPDATED AS changed_at,
  c.NEW_HIRE_DATE,
  p.hierarchy_level,
  p.manager_title,
  p.designation AS target_field,
  p.manager_name AS fill_name,
  COALESCE(CAST(p.manager_employee_id AS STRING), c.prev_recruiter_emp_no) AS fill_emp_no,
  -- What the latest row holds in that field today.
  CASE p.designation
    WHEN 'ATL' THEN l.ATL WHEN 'TEAM_LEAD' THEN l.TEAM_LEAD WHEN 'RM' THEN l.RM
    WHEN 'ASSOCIATE_AM' THEN l.ASSOCIATE_AM WHEN 'ACCOUNT_MANAGER' THEN l.ACCOUNT_MANAGER
    WHEN 'ASSOCIATE_DELIVERY_DIRECTOR' THEN l.ASSOCIATE_DELIVERY_DIRECTOR
    WHEN 'DELIVERY_DIRECTOR' THEN l.DELIVERY_DIRECTOR WHEN 'AVP' THEN l.AVP WHEN 'VP' THEN l.VP
  END AS current_name,
  CASE p.designation
    WHEN 'ATL' THEN l.ATL_EMP_NO WHEN 'TEAM_LEAD' THEN l.TEAM_LEAD_EMP_NO WHEN 'RM' THEN l.RM_EMP_NO
    WHEN 'ASSOCIATE_AM' THEN l.ASSOCIATE_AM_EMP_NO WHEN 'ACCOUNT_MANAGER' THEN l.ACCOUNT_MANAGER_EMP_NO
    WHEN 'ASSOCIATE_DELIVERY_DIRECTOR' THEN l.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO
    WHEN 'DELIVERY_DIRECTOR' THEN l.DELIVERY_DIRECTOR_EMP_NO WHEN 'AVP' THEN l.AVP_EMP_NO WHEN 'VP' THEN l.VP_EMP_NO
  END AS current_emp_no,
  (SELECT COUNT(*) FROM versions v
   WHERE v.DEAL_SHEET_ID = c.DEAL_SHEET_ID AND v.PLACEMENT_ID = c.PLACEMENT_ID
     AND v.LAST_UPDATED >= c.LAST_UPDATED) AS rows_to_fix
FROM last_change c
JOIN prev_in_chain p USING (DEAL_SHEET_ID, PLACEMENT_ID)
JOIN latest l USING (DEAL_SHEET_ID, PLACEMENT_ID)
WHERE p.designation IN ('ATL','TEAM_LEAD','RM','ASSOCIATE_AM','ACCOUNT_MANAGER',
                        'ASSOCIATE_DELIVERY_DIRECTOR','DELIVERY_DIRECTOR','AVP','VP')
),

classified AS (
  SELECT
    CASE
      WHEN UPPER(TRIM(COALESCE(current_emp_no, ''))) = UPPER(TRIM(COALESCE(fill_emp_no, '')))
        AND COALESCE(TRIM(fill_emp_no), '') != '' THEN 'ALREADY_CORRECT'
      WHEN current_name IS NULL OR TRIM(current_name) = '' OR UPPER(TRIM(current_name)) = 'NA' THEN 'FILL_EMPTY'
      ELSE 'OVERWRITE_OTHER_PERSON'
    END AS outcome,
    *
  FROM preview
)

-- One result: every candidate placement + summary counts on each row.
-- Check 1472372 is here: RM, Alex Smith, CY3248, FILL_EMPTY.
SELECT
  outcome,
  COUNT(*) OVER (PARTITION BY outcome) AS placements_in_outcome,
  SUM(rows_to_fix) OVER (PARTITION BY outcome) AS rows_in_outcome,
  COUNT(*) OVER (PARTITION BY outcome, target_field) AS placements_in_outcome_field,
  COUNT(*) OVER (PARTITION BY outcome, latest_status) AS placements_in_outcome_status,
  * EXCEPT (outcome)
FROM classified
ORDER BY
  CASE outcome WHEN 'FILL_EMPTY' THEN 0 WHEN 'OVERWRITE_OTHER_PERSON' THEN 1 ELSE 2 END,
  target_field,
  changed_at DESC;
