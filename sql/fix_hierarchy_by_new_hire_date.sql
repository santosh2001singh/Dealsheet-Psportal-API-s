-- STEP 1: build the check table (read-only on deal sheet)
CREATE OR REPLACE TABLE `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd` AS
WITH syn AS (
  SELECT col, s FROM UNNEST([
    STRUCT('ATL' AS col, ['atl','associate team lead'] AS arr),
    ('SECONDARY_RECRUITER', ['secondary recruiter','secondary rm','secondary recruitment manager']),
    ('TEAM_LEAD', ['tl','team lead','senior team lead','senior teamlead','senior tl','sr team lead','sr. team lead']),
    ('RM', ['rm','recruitement manager','recruitment manager','associate recruitment manager','associate recruitement manager','associate recruiterment manager']),
    ('SECONDARY_AM', ['secondary am','secondary account manager','secondary delivery manager']),
    ('ASSOCIATE_AM', ['associate delivery manager','associate account manager']),
    ('ACCOUNT_MANAGER', ['delivery manager','sr. delivery manager','sr delivery manager','senior delivery manager','account manager','sr. account manager','sr account manager','senior account manager']),
    ('DELIVERY_DIRECTOR', ['delivery director','director - delivery','director delivery']),
    ('ASSOCIATE_DELIVERY_DIRECTOR', ['director','associate director','assoc director','associate group director','associate group directeor','associate director - delivery','associate director delivery','director - business operations','director delivery for public sector']),
    ('VP', ['vice president','vp','sr vp','sr. vp','svp','srvp','vp srvp','vp/srvp','sr vice president','sr. vice president','senior vice president','sr vice president (svp)','sr. vice president (svp)','senior vice president (svp)','sr vp (svp)','sr. vp (svp)']),
    ('AVP', ['avp','associate vice president','associate vice president - delivery','associate vice president delivery'])
  ]), UNNEST(arr) s
),
-- Latest version of each DEAL placement (health, non-locums) with a NEW_HIRE_DATE
deals AS (
  SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE DEAL_TYPE = 'DEAL' AND NEW_HIRE_DATE IS NOT NULL
    AND IFNULL(UPPER(TRIM(OFFERING)),'') != 'LOCUMS'
    AND ASSIGNMENT_RECRUITER_EMAIL IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) = 1
),
tgt AS (
  SELECT d.PLACEMENT_ID, d.NEW_HIRE_DATE, UPPER(TRIM(d.RECRUITER_EMP_NO)) AS rec_emp, e.external_id
  FROM deals d
  JOIN `cynetdatabase.MISC.directory_employees` e
    ON LOWER(TRIM(e.email)) = LOWER(TRIM(d.ASSIGNMENT_RECRUITER_EMAIL))
),
-- Same per-level ranking as fetchHierarchyLevelChainsByKey: mode 'HIRE' = anchored on NEW_HIRE_DATE, 'NULL' = what a null anchor gave (earliest snapshot)
ranked AS (
  SELECT t.PLACEMENT_ID, t.rec_emp, m.mode, h.hierarchy_level, h.manager_name, h.manager_employee_id, h.manager_title,
    ROW_NUMBER() OVER (PARTITION BY t.PLACEMENT_ID, m.mode, h.hierarchy_level ORDER BY
      CASE WHEN m.mode='HIRE' AND h.synced_at <= t.NEW_HIRE_DATE THEN 0 ELSE 1 END,
      CASE WHEN m.mode='HIRE' AND h.synced_at <= t.NEW_HIRE_DATE THEN h.synced_at END DESC,
      h.synced_at ASC) AS rn
  FROM tgt t
  CROSS JOIN UNNEST(['HIRE','NULL']) AS mode WITH OFFSET
  JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h ON h.employee_external_id = t.external_id
  , UNNEST([STRUCT(mode AS mode)]) m
  -- HIRE: skip snapshot rows with a blank title (2026-03-13/14 syncs lost titles), else a real VP/AM would read as empty
  WHERE m.mode = 'NULL' OR NULLIF(TRIM(h.manager_title), '') IS NOT NULL
),
titled AS (
  SELECT r.*,
    LOWER(TRIM(REGEXP_REPLACE(IFNULL(manager_title,''), r'\s+', ' '))) AS nt
  FROM ranked r WHERE rn = 1
),
mapped AS (
  SELECT t.*, COALESCE(s1.col, s2.col) AS col
  FROM titled t
  LEFT JOIN syn s1 ON s1.s = t.nt
  LEFT JOIN syn s2 ON s2.s = TRIM(REGEXP_REPLACE(t.nt, r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$', ''))
),
-- First (lowest) level wins per column; manager = recruiter himself -> 'NA'
chain AS (
  SELECT PLACEMENT_ID, mode, col,
    IF(UPPER(TRIM(manager_employee_id)) = rec_emp, 'NA', manager_name) AS name,
    IF(UPPER(TRIM(manager_employee_id)) = rec_emp, 'NA', manager_employee_id) AS emp
  FROM mapped WHERE col IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID, mode, col ORDER BY SAFE_CAST(hierarchy_level AS INT64)) = 1
),
stored AS (
  SELECT PLACEMENT_ID, ID, NEW_HIRE_DATE, ASSIGNMENT_RECRUITER, col, name, emp
  FROM deals, UNNEST([
    STRUCT('ATL' AS col, ATL AS name, ATL_EMP_NO AS emp),
    ('SECONDARY_RECRUITER', SECONDARY_RECRUITER, SECONDARY_RECRUITER_EMP_NO),
    ('TEAM_LEAD', TEAM_LEAD, TEAM_LEAD_EMP_NO),
    ('RM', RM, RM_EMP_NO),
    ('SECONDARY_AM', SECONDARY_AM, SECONDARY_AM_EMP_NO),
    ('ASSOCIATE_AM', ASSOCIATE_AM, ASSOCIATE_AM_EMP_NO),
    ('ACCOUNT_MANAGER', ACCOUNT_MANAGER, ACCOUNT_MANAGER_EMP_NO),
    ('DELIVERY_DIRECTOR', DELIVERY_DIRECTOR, DELIVERY_DIRECTOR_EMP_NO),
    ('ASSOCIATE_DELIVERY_DIRECTOR', ASSOCIATE_DELIVERY_DIRECTOR, ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO),
    ('AVP', AVP, AVP_EMP_NO),
    ('VP', VP, VP_EMP_NO)
  ])
  WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM tgt)
),
cmp AS (
  SELECT s.PLACEMENT_ID, s.ID, s.ASSIGNMENT_RECRUITER, s.NEW_HIRE_DATE, s.col AS column_name,
    s.name AS stored_name, s.emp AS stored_emp,
    h.name AS expected_name, h.emp AS expected_emp,
    n.name AS null_anchor_name, n.emp AS null_anchor_emp,
    CASE
      WHEN IFNULL(UPPER(TRIM(s.emp)),'') = IFNULL(UPPER(TRIM(h.emp)),'') THEN 'OK'
      WHEN IFNULL(UPPER(TRIM(s.emp)),'') = IFNULL(UPPER(TRIM(n.emp)),'') THEN 'NULL_ANCHOR_BUG'
      ELSE 'OTHER_MISMATCH'
    END AS verdict
  FROM stored s
  LEFT JOIN chain h ON h.PLACEMENT_ID = s.PLACEMENT_ID AND h.mode = 'HIRE' AND h.col = s.col
  LEFT JOIN chain n ON n.PLACEMENT_ID = s.PLACEMENT_ID AND n.mode = 'NULL' AND n.col = s.col
),
cmp2 AS (
  SELECT *,
    NULLIF(NULLIF(UPPER(TRIM(stored_emp)),''),'NA') AS s_e,
    NULLIF(NULLIF(UPPER(TRIM(expected_emp)),''),'NA') AS h_e,
    NULLIF(NULLIF(UPPER(TRIM(null_anchor_emp)),''),'NA') AS n_e
  FROM cmp
)
SELECT c.* EXCEPT (s_e, h_e, n_e, ID),
  CASE
    WHEN LOGICAL_AND(s_e IS NOT DISTINCT FROM h_e) OVER w THEN 'OK'
    WHEN LOGICAL_AND(s_e IS NOT DISTINCT FROM n_e) OVER w THEN 'OLD_SNAPSHOT_FIXABLE'
    ELSE 'OTHER_MANUAL_REVIEW'
  END AS category,
  s_e IS DISTINCT FROM h_e AS is_wrong
FROM cmp2 c
WINDOW w AS (PARTITION BY PLACEMENT_ID);

-- STEP 2: PREVIEW
-- a) summary
SELECT category, COUNT(DISTINCT PLACEMENT_ID) AS placements, COUNTIF(is_wrong) AS wrong_columns
FROM `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd`
GROUP BY category ORDER BY category;

-- b) detail (sirf galat columns)
SELECT category, PLACEMENT_ID, ASSIGNMENT_RECRUITER, DATE(NEW_HIRE_DATE) AS new_hire_date, column_name,
  stored_name, stored_emp, expected_name, expected_emp, null_anchor_name
FROM `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd`
WHERE category != 'OK' AND is_wrong
ORDER BY category, PLACEMENT_ID, column_name;

-- STEP 3: BACKUP (sirf jo rows update hongi)
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261021_hierarchy_nhd_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE DEAL_TYPE = 'DEAL'
  AND PLACEMENT_ID IN (SELECT DISTINCT PLACEMENT_ID FROM `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd`
                       WHERE category = 'OLD_SNAPSHOT_FIXABLE');

-- STEP 4: FIX (saare DEAL versions of that placement, sirf hierarchy columns)
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET
  ATL = IF(p.ATL_FIX, p.ATL, d.ATL), ATL_EMP_NO = IF(p.ATL_FIX, p.ATL_EMP_NO, d.ATL_EMP_NO),
  SECONDARY_RECRUITER = IF(p.SECONDARY_RECRUITER_FIX, p.SECONDARY_RECRUITER, d.SECONDARY_RECRUITER), SECONDARY_RECRUITER_EMP_NO = IF(p.SECONDARY_RECRUITER_FIX, p.SECONDARY_RECRUITER_EMP_NO, d.SECONDARY_RECRUITER_EMP_NO),
  TEAM_LEAD = IF(p.TEAM_LEAD_FIX, p.TEAM_LEAD, d.TEAM_LEAD), TEAM_LEAD_EMP_NO = IF(p.TEAM_LEAD_FIX, p.TEAM_LEAD_EMP_NO, d.TEAM_LEAD_EMP_NO),
  RM = IF(p.RM_FIX, p.RM, d.RM), RM_EMP_NO = IF(p.RM_FIX, p.RM_EMP_NO, d.RM_EMP_NO),
  SECONDARY_AM = IF(p.SECONDARY_AM_FIX, p.SECONDARY_AM, d.SECONDARY_AM), SECONDARY_AM_EMP_NO = IF(p.SECONDARY_AM_FIX, p.SECONDARY_AM_EMP_NO, d.SECONDARY_AM_EMP_NO),
  ASSOCIATE_AM = IF(p.ASSOCIATE_AM_FIX, p.ASSOCIATE_AM, d.ASSOCIATE_AM), ASSOCIATE_AM_EMP_NO = IF(p.ASSOCIATE_AM_FIX, p.ASSOCIATE_AM_EMP_NO, d.ASSOCIATE_AM_EMP_NO),
  ACCOUNT_MANAGER = IF(p.ACCOUNT_MANAGER_FIX, p.ACCOUNT_MANAGER, d.ACCOUNT_MANAGER), ACCOUNT_MANAGER_EMP_NO = IF(p.ACCOUNT_MANAGER_FIX, p.ACCOUNT_MANAGER_EMP_NO, d.ACCOUNT_MANAGER_EMP_NO),
  DELIVERY_DIRECTOR = IF(p.DELIVERY_DIRECTOR_FIX, p.DELIVERY_DIRECTOR, d.DELIVERY_DIRECTOR), DELIVERY_DIRECTOR_EMP_NO = IF(p.DELIVERY_DIRECTOR_FIX, p.DELIVERY_DIRECTOR_EMP_NO, d.DELIVERY_DIRECTOR_EMP_NO),
  ASSOCIATE_DELIVERY_DIRECTOR = IF(p.ASSOCIATE_DELIVERY_DIRECTOR_FIX, p.ASSOCIATE_DELIVERY_DIRECTOR, d.ASSOCIATE_DELIVERY_DIRECTOR), ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO = IF(p.ASSOCIATE_DELIVERY_DIRECTOR_FIX, p.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, d.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO),
  AVP = IF(p.AVP_FIX, p.AVP, d.AVP), AVP_EMP_NO = IF(p.AVP_FIX, p.AVP_EMP_NO, d.AVP_EMP_NO),
  VP = IF(p.VP_FIX, p.VP, d.VP), VP_EMP_NO = IF(p.VP_FIX, p.VP_EMP_NO, d.VP_EMP_NO)
FROM (
  SELECT PLACEMENT_ID,
    MAX(IF(column_name='ATL', expected_name, NULL)) AS ATL,
    MAX(IF(column_name='ATL', expected_emp, NULL)) AS ATL_EMP_NO,
    LOGICAL_OR(column_name='ATL' AND is_wrong) AS ATL_FIX,
    MAX(IF(column_name='SECONDARY_RECRUITER', expected_name, NULL)) AS SECONDARY_RECRUITER,
    MAX(IF(column_name='SECONDARY_RECRUITER', expected_emp, NULL)) AS SECONDARY_RECRUITER_EMP_NO,
    LOGICAL_OR(column_name='SECONDARY_RECRUITER' AND is_wrong) AS SECONDARY_RECRUITER_FIX,
    MAX(IF(column_name='TEAM_LEAD', expected_name, NULL)) AS TEAM_LEAD,
    MAX(IF(column_name='TEAM_LEAD', expected_emp, NULL)) AS TEAM_LEAD_EMP_NO,
    LOGICAL_OR(column_name='TEAM_LEAD' AND is_wrong) AS TEAM_LEAD_FIX,
    MAX(IF(column_name='RM', expected_name, NULL)) AS RM,
    MAX(IF(column_name='RM', expected_emp, NULL)) AS RM_EMP_NO,
    LOGICAL_OR(column_name='RM' AND is_wrong) AS RM_FIX,
    MAX(IF(column_name='SECONDARY_AM', expected_name, NULL)) AS SECONDARY_AM,
    MAX(IF(column_name='SECONDARY_AM', expected_emp, NULL)) AS SECONDARY_AM_EMP_NO,
    LOGICAL_OR(column_name='SECONDARY_AM' AND is_wrong) AS SECONDARY_AM_FIX,
    MAX(IF(column_name='ASSOCIATE_AM', expected_name, NULL)) AS ASSOCIATE_AM,
    MAX(IF(column_name='ASSOCIATE_AM', expected_emp, NULL)) AS ASSOCIATE_AM_EMP_NO,
    LOGICAL_OR(column_name='ASSOCIATE_AM' AND is_wrong) AS ASSOCIATE_AM_FIX,
    MAX(IF(column_name='ACCOUNT_MANAGER', expected_name, NULL)) AS ACCOUNT_MANAGER,
    MAX(IF(column_name='ACCOUNT_MANAGER', expected_emp, NULL)) AS ACCOUNT_MANAGER_EMP_NO,
    LOGICAL_OR(column_name='ACCOUNT_MANAGER' AND is_wrong) AS ACCOUNT_MANAGER_FIX,
    MAX(IF(column_name='DELIVERY_DIRECTOR', expected_name, NULL)) AS DELIVERY_DIRECTOR,
    MAX(IF(column_name='DELIVERY_DIRECTOR', expected_emp, NULL)) AS DELIVERY_DIRECTOR_EMP_NO,
    LOGICAL_OR(column_name='DELIVERY_DIRECTOR' AND is_wrong) AS DELIVERY_DIRECTOR_FIX,
    MAX(IF(column_name='ASSOCIATE_DELIVERY_DIRECTOR', expected_name, NULL)) AS ASSOCIATE_DELIVERY_DIRECTOR,
    MAX(IF(column_name='ASSOCIATE_DELIVERY_DIRECTOR', expected_emp, NULL)) AS ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO,
    LOGICAL_OR(column_name='ASSOCIATE_DELIVERY_DIRECTOR' AND is_wrong) AS ASSOCIATE_DELIVERY_DIRECTOR_FIX,
    MAX(IF(column_name='AVP', expected_name, NULL)) AS AVP,
    MAX(IF(column_name='AVP', expected_emp, NULL)) AS AVP_EMP_NO,
    LOGICAL_OR(column_name='AVP' AND is_wrong) AS AVP_FIX,
    MAX(IF(column_name='VP', expected_name, NULL)) AS VP,
    MAX(IF(column_name='VP', expected_emp, NULL)) AS VP_EMP_NO,
    LOGICAL_OR(column_name='VP' AND is_wrong) AS VP_FIX
  FROM `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd`
  WHERE category = 'OLD_SNAPSHOT_FIXABLE'
  GROUP BY PLACEMENT_ID
) p
WHERE d.PLACEMENT_ID = p.PLACEMENT_ID
  AND d.DEAL_TYPE = 'DEAL';

-- STEP 5: VERIFY -> STEP 1 dobara chalao, phir:
SELECT category, COUNT(DISTINCT PLACEMENT_ID) FROM `cynetdatabase.rr_project_data.chk_20261021_hierarchy_nhd` GROUP BY 1;
-- OLD_SNAPSHOT_FIXABLE = 0 aana chahiye

-- ROLLBACK (agar zarurat pade):
-- MERGE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
-- USING `cynetdatabase.rr_project_data.bkp_20261021_hierarchy_nhd_deal_sheet` b ON d.ID = b.ID
-- WHEN MATCHED THEN UPDATE SET
--   ATL = b.ATL, ATL_EMP_NO = b.ATL_EMP_NO,
--   SECONDARY_RECRUITER = b.SECONDARY_RECRUITER, SECONDARY_RECRUITER_EMP_NO = b.SECONDARY_RECRUITER_EMP_NO,
--   TEAM_LEAD = b.TEAM_LEAD, TEAM_LEAD_EMP_NO = b.TEAM_LEAD_EMP_NO,
--   RM = b.RM, RM_EMP_NO = b.RM_EMP_NO,
--   SECONDARY_AM = b.SECONDARY_AM, SECONDARY_AM_EMP_NO = b.SECONDARY_AM_EMP_NO,
--   ASSOCIATE_AM = b.ASSOCIATE_AM, ASSOCIATE_AM_EMP_NO = b.ASSOCIATE_AM_EMP_NO,
--   ACCOUNT_MANAGER = b.ACCOUNT_MANAGER, ACCOUNT_MANAGER_EMP_NO = b.ACCOUNT_MANAGER_EMP_NO,
--   DELIVERY_DIRECTOR = b.DELIVERY_DIRECTOR, DELIVERY_DIRECTOR_EMP_NO = b.DELIVERY_DIRECTOR_EMP_NO,
--   ASSOCIATE_DELIVERY_DIRECTOR = b.ASSOCIATE_DELIVERY_DIRECTOR, ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO = b.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO,
--   AVP = b.AVP, AVP_EMP_NO = b.AVP_EMP_NO,
--   VP = b.VP, VP_EMP_NO = b.VP_EMP_NO;
