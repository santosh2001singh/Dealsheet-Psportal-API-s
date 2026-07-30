-- Fetch a recruiter's DEAL delivery hierarchy (RM / ATL / TEAM_LEAD / ACCOUNT_MANAGER / SECONDARY_AM /
-- ASSOCIATE_AM / GRP_DIR_ASSOC_GRP_DIR / DELIVERY_DIRECTOR / AVP / VP_SRVP / SECONDARY_RECRUITER +
-- their *_EMP_NO) from the recruiter's Google-Workspace manager chain — exactly what the deal-sheet
-- pipeline (fetchDealRecruiterHierarchyByPlacementId) writes for a DEAL row.
--
-- USE FROM FRONTEND: when an ownership log is deleted (wrong recruiter was assigned), re-run this for
-- the CURRENT recruiter to get the correct hierarchy, then overwrite the deal-sheet row.
--
-- Parameters (replace the two DECLARE defaults):
--   recruiter_email : the recruiter to resolve (e.g. 'brian.k@cynethealth.com')
--   anchor_date     : the placement's NEW_HIRE_DATE (TIMESTAMP). Snapshot picked = LATEST snapshot
--                     on/before this date (org chart as it stood at hire). Pass CURRENT_TIMESTAMP()
--                     for the latest available chain. Fallback if none on/before: earliest snapshot.
--
-- Snapshot rule mirrors code: per hierarchy_level INDEPENDENTLY, nearest snapshot to the anchor
-- (direction on_or_before, else earliest). Title -> role via the same synonym map (a trailing
-- department qualifier like " - Delivery" / " - REC" / " - Recruitment" / " - Staffing" is stripped
-- before matching).

DECLARE recruiter_email STRING DEFAULT 'brian.k@cynethealth.com';
DECLARE anchor_date TIMESTAMP DEFAULT TIMESTAMP('2026-06-08');  -- e.g. the row's NEW_HIRE_DATE

WITH emp AS (            -- email -> external_id (prefer ACTIVE, then latest)
  SELECT external_id
  FROM `cynetdatabase.MISC.directory_employees`
  WHERE LOWER(TRIM(email)) = LOWER(TRIM(recruiter_email))
  QUALIFY ROW_NUMBER() OVER (ORDER BY (status = 'ACTIVE') DESC, updated_at DESC) = 1
),
levels AS (             -- per level: nearest snapshot on/before anchor, else earliest
  SELECT hierarchy_level, manager_name, manager_employee_id, manager_title
  FROM (
    SELECT
      h.hierarchy_level, h.manager_name, h.manager_employee_id, h.manager_title,
      ROW_NUMBER() OVER (
        PARTITION BY h.hierarchy_level
        ORDER BY
          CASE WHEN h.synced_at <= anchor_date THEN 0 ELSE 1 END,
          CASE WHEN h.synced_at <= anchor_date THEN h.synced_at END DESC,
          h.synced_at ASC
      ) AS rn
    FROM `cynetdatabase.MISC.directory_employee_hierarchy` h
    JOIN emp ON emp.external_id = h.employee_external_id
  )
  WHERE rn = 1
),
mapped AS (             -- manager_title -> role (strip trailing dept qualifier, then match synonym)
  SELECT
    manager_name, manager_employee_id,
    CASE (
      TRIM(REGEXP_REPLACE(
        REGEXP_REPLACE(LOWER(TRIM(manager_title)), r'\s+', ' '),
        r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$', ''
      ))
    )
      WHEN 'atl' THEN 'ATL' WHEN 'associate team lead' THEN 'ATL'
      WHEN 'secondary recruiter' THEN 'SECONDARY_RECRUITER' WHEN 'secondary rm' THEN 'SECONDARY_RECRUITER' WHEN 'secondary recruitment manager' THEN 'SECONDARY_RECRUITER'
      WHEN 'tl' THEN 'TEAM_LEAD' WHEN 'team lead' THEN 'TEAM_LEAD' WHEN 'senior team lead' THEN 'TEAM_LEAD' WHEN 'senior teamlead' THEN 'TEAM_LEAD' WHEN 'senior tl' THEN 'TEAM_LEAD' WHEN 'sr team lead' THEN 'TEAM_LEAD' WHEN 'sr. team lead' THEN 'TEAM_LEAD'
      WHEN 'rm' THEN 'RM' WHEN 'recruitement manager' THEN 'RM' WHEN 'recruitment manager' THEN 'RM' WHEN 'associate recruitment manager' THEN 'RM' WHEN 'associate recruitement manager' THEN 'RM' WHEN 'associate recruiterment manager' THEN 'RM'
      WHEN 'secondary am' THEN 'SECONDARY_AM' WHEN 'secondary account manager' THEN 'SECONDARY_AM' WHEN 'secondary delivery manager' THEN 'SECONDARY_AM'
      WHEN 'associate delivery manager' THEN 'ASSOCIATE_AM'
      WHEN 'delivery manager' THEN 'ACCOUNT_MANAGER' WHEN 'sr. delivery manager' THEN 'ACCOUNT_MANAGER' WHEN 'sr delivery manager' THEN 'ACCOUNT_MANAGER' WHEN 'senior delivery manager' THEN 'ACCOUNT_MANAGER'
      WHEN 'delivery director' THEN 'DELIVERY_DIRECTOR'
      WHEN 'director' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'associate director' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'assoc director' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'associate group director' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'associate group directeor' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR' WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'avp' THEN 'AVP' WHEN 'associate vice president' THEN 'AVP' WHEN 'associate vice president delivery' THEN 'AVP'
      WHEN 'vice president' THEN 'VP_SRVP' WHEN 'vp' THEN 'VP_SRVP' WHEN 'sr vp' THEN 'VP_SRVP' WHEN 'sr. vp' THEN 'VP_SRVP' WHEN 'svp' THEN 'VP_SRVP' WHEN 'srvp' THEN 'VP_SRVP' WHEN 'vp srvp' THEN 'VP_SRVP' WHEN 'vp/srvp' THEN 'VP_SRVP'
      ELSE NULL
    END AS role,
    SAFE_CAST(hierarchy_level AS INT64) AS lvl
  FROM levels
),
picked AS (             -- closest level wins per role (same as code: first match by ascending level)
  SELECT role, manager_name, manager_employee_id
  FROM mapped
  WHERE role IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY role ORDER BY lvl ASC) = 1
)
SELECT
  MAX(IF(role='RM', manager_name, NULL)) AS RM,                                       MAX(IF(role='RM', manager_employee_id, NULL)) AS RM_EMP_NO,
  MAX(IF(role='ATL', manager_name, NULL)) AS ATL,                                     MAX(IF(role='ATL', manager_employee_id, NULL)) AS ATL_EMP_NO,
  MAX(IF(role='TEAM_LEAD', manager_name, NULL)) AS TEAM_LEAD,                         MAX(IF(role='TEAM_LEAD', manager_employee_id, NULL)) AS TEAM_LEAD_EMP_NO,
  MAX(IF(role='ACCOUNT_MANAGER', manager_name, NULL)) AS ACCOUNT_MANAGER,             MAX(IF(role='ACCOUNT_MANAGER', manager_employee_id, NULL)) AS ACCOUNT_MANAGER_EMP_NO,
  MAX(IF(role='SECONDARY_AM', manager_name, NULL)) AS SECONDARY_AM,                   MAX(IF(role='SECONDARY_AM', manager_employee_id, NULL)) AS SECONDARY_AM_EMP_NO,
  MAX(IF(role='ASSOCIATE_AM', manager_name, NULL)) AS ASSOCIATE_AM,                   MAX(IF(role='ASSOCIATE_AM', manager_employee_id, NULL)) AS ASSOCIATE_AM_EMP_NO,
  MAX(IF(role='GRP_DIR_ASSOC_GRP_DIR', manager_name, NULL)) AS GRP_DIR_ASSOC_GRP_DIR, MAX(IF(role='GRP_DIR_ASSOC_GRP_DIR', manager_employee_id, NULL)) AS GRP_DIR_ASSOC_GRP_DIR_EMP_NO,
  MAX(IF(role='DELIVERY_DIRECTOR', manager_name, NULL)) AS DELIVERY_DIRECTOR,         MAX(IF(role='DELIVERY_DIRECTOR', manager_employee_id, NULL)) AS DELIVERY_DIRECTOR_EMP_NO,
  MAX(IF(role='AVP', manager_name, NULL)) AS AVP,                                     MAX(IF(role='AVP', manager_employee_id, NULL)) AS AVP_EMP_NO,
  MAX(IF(role='VP_SRVP', manager_name, NULL)) AS VP_SRVP,                             MAX(IF(role='VP_SRVP', manager_employee_id, NULL)) AS VP_SRVP_EMP_NO,
  MAX(IF(role='SECONDARY_RECRUITER', manager_name, NULL)) AS SECONDARY_RECRUITER,     MAX(IF(role='SECONDARY_RECRUITER', manager_employee_id, NULL)) AS SECONDARY_RECRUITER_EMP_NO
FROM picked;
