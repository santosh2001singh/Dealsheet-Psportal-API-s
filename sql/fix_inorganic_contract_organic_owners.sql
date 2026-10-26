-- inorganic_hierarchy_logs: people wrongly logged INORGANIC who already owned the contract organically.
--
-- Rule (contract-based): anyone who held ANY role (recruiter or any hierarchy role / delivery POC) on
-- ANY placement of the placement's CONTRACT_ID, in the active deal sheet or in the run-rate, is an
-- organic owner of that contract. A promotion (e.g. recruiter -> Director) is not an inorganic join.
-- The sync now applies this rule before inserting (applyContractOrganicOwnerFilterToInorganicRows);
-- this file cleans up the rows written before that.


-- =====================================================================================
-- STEP 1 - the reported case: Tobin Jacob, PLACEMENT_ID 1465523, CHC22164.
-- Anup Bhel was the contract's recruiter (run-rate) and was promoted to Director. Demi Sharma stays.
-- =====================================================================================

-- 1a. Preview.
SELECT ID, LAST_UPDATED, PLACEMENT_ID,
       INORGANIC_ACCOUNT_MANAGER, INORGANIC_ASSOCIATE_GROUP_DIRECTOR, INORGANIC_DELIVERY_POC
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE ID = '0572750f-1e64-4c98-833b-ba25439a8ceb';

-- 1b. Fix. Nobody from Associate Group Director up remains, so the POC clears too
--     (the sync's own rule: the inorganic POC is ADD -> DD -> AVP -> VP only).
UPDATE `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
SET INORGANIC_ASSOCIATE_GROUP_DIRECTOR        = NULL,
    INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO = NULL,
    INORGANIC_DELIVERY_POC                    = NULL,
    INORGANIC_DELIVERY_POC_EMP_NO             = NULL,
    INORGANIC_DELIVERY_POC_EMAIL              = NULL
WHERE ID = '0572750f-1e64-4c98-833b-ba25439a8ceb'
  AND INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO = 'CY5277';


-- =====================================================================================
-- STEP 2 - every other row with the same problem (read-only preview).
-- One output row per wrongly-logged person: which log row, which slot, which contract.
-- =====================================================================================
WITH placement_contract AS (
  SELECT CAST(DEAL_SHEET_ID AS STRING) AS ds, CAST(PLACEMENT_ID AS STRING) AS pid,
         ANY_VALUE(TRIM(CONTRACT_ID)) AS contract_id
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  GROUP BY ds, pid
),
owner_source AS (
  SELECT TRIM(CONTRACT_ID) AS contract_id, [
    STRUCT(CAST(ASSIGNMENT_RECRUITER AS STRING) AS n, CAST(RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT(CAST(ATL AS STRING), CAST(ATL_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_RECRUITER AS STRING), CAST(SECONDARY_RECRUITER_EMP_NO AS STRING)),
    STRUCT(CAST(TEAM_LEAD AS STRING), CAST(TEAM_LEAD_EMP_NO AS STRING)),
    STRUCT(CAST(RM AS STRING), CAST(RM_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_AM AS STRING), CAST(SECONDARY_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_AM AS STRING), CAST(ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ACCOUNT_MANAGER AS STRING), CAST(ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_DIRECTOR AS STRING), CAST(DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_DELIVERY_DIRECTOR AS STRING), CAST(ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(AVP AS STRING), CAST(AVP_EMP_NO AS STRING)),
    STRUCT(CAST(VP AS STRING), CAST(VP_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_POC AS STRING), CAST(DELIVERY_POC_EMP_NO AS STRING))
  ] AS people
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  UNION ALL
  SELECT TRIM(CONTRACT_ID), [
    STRUCT(CAST(ASSIGNMENT_RECRUITER AS STRING) AS n, CAST(RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT(CAST(ATL AS STRING), CAST(ATL_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_RECRUITER AS STRING), CAST(SECONDARY_RECRUITER_EMP_NO AS STRING)),
    STRUCT(CAST(TEAM_LEAD AS STRING), CAST(TEAM_LEAD_EMP_NO AS STRING)),
    STRUCT(CAST(RM AS STRING), CAST(RM_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_AM AS STRING), CAST(SECONDARY_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_AM AS STRING), CAST(ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ACCOUNT_MANAGER AS STRING), CAST(ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_DIRECTOR AS STRING), CAST(DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_DELIVERY_DIRECTOR AS STRING), CAST(ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(AVP AS STRING), CAST(AVP_EMP_NO AS STRING)),
    STRUCT(CAST(VP AS STRING), CAST(VP_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_POC AS STRING), CAST(DELIVERY_POC_EMP_NO AS STRING))
  ]
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
),
-- Same keys as the code: cluster suffix "(GOV)" off, whitespace collapsed, case-folded, NA = nobody.
owners AS (
  SELECT DISTINCT contract_id,
    NULLIF(LOWER(REGEXP_REPLACE(TRIM(REGEXP_REPLACE(IFNULL(p.n, ''), r'\s*\([^)]*\)\s*$', '')), r'\s+', ' ')), 'na') AS name_key,
    NULLIF(UPPER(TRIM(IFNULL(p.e, ''))), 'NA') AS emp_key
  FROM owner_source, UNNEST(people) AS p
),
log_slots AS (
  SELECT l.ID, l.LAST_UPDATED, l.DEAL_SHEET_ID, l.PLACEMENT_ID, l.CANDIDATE_NAME, c.contract_id,
         s.slot, s.n AS person, s.e AS person_emp_no,
         NULLIF(LOWER(REGEXP_REPLACE(TRIM(IFNULL(s.n, '')), r'\s+', ' ')), 'na') AS name_key,
         NULLIF(UPPER(TRIM(IFNULL(s.e, ''))), 'NA') AS emp_key
  FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
  JOIN placement_contract c
    ON c.ds = CAST(l.DEAL_SHEET_ID AS STRING) AND c.pid = CAST(l.PLACEMENT_ID AS STRING)
  CROSS JOIN UNNEST([
    STRUCT('INORGANIC_RECRUITER' AS slot, CAST(l.INORGANIC_RECRUITER AS STRING) AS n, CAST(l.INORGANIC_RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT('INORGANIC_ACCOUNT_MANAGER', CAST(l.INORGANIC_ACCOUNT_MANAGER AS STRING), CAST(l.INORGANIC_ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ASSOCIATE_AM', CAST(l.INORGANIC_ASSOCIATE_AM AS STRING), CAST(l.INORGANIC_ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT('INORGANIC_RM', CAST(l.INORGANIC_RM AS STRING), CAST(l.INORGANIC_RM_EMP_NO AS STRING)),
    STRUCT('INORGANIC_TL', CAST(l.INORGANIC_TL AS STRING), CAST(l.INORGANIC_TL_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ATL', CAST(l.INORGANIC_ATL AS STRING), CAST(l.INORGANIC_ATL_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ASSOCIATE_GROUP_DIRECTOR', CAST(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR AS STRING), CAST(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO AS STRING)),
    STRUCT('INORGANIC_DELIVERY_DIRECTOR', CAST(l.INORGANIC_DELIVERY_DIRECTOR AS STRING), CAST(l.INORGANIC_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT('INORGANIC_AVP', CAST(l.INORGANIC_AVP AS STRING), CAST(l.INORGANIC_AVP_EMP_NO AS STRING)),
    STRUCT('INORGANIC_VP_SR_VP', CAST(l.INORGANIC_VP_SR_VP AS STRING), CAST(l.INORGANIC_VP_SR_VP_EMP_NO AS STRING))
  ]) AS s
  WHERE s.n IS NOT NULL OR s.e IS NOT NULL
)
SELECT ls.ID, ls.LAST_UPDATED, ls.DEAL_SHEET_ID, ls.PLACEMENT_ID, ls.CANDIDATE_NAME, ls.contract_id,
       ls.slot, ls.person, ls.person_emp_no
FROM log_slots ls
WHERE EXISTS (
  SELECT 1 FROM owners o
  WHERE o.contract_id = ls.contract_id
    AND ( (ls.emp_key IS NOT NULL AND o.emp_key = ls.emp_key)
       OR (ls.name_key IS NOT NULL AND o.name_key = ls.name_key) )
)
ORDER BY ls.contract_id, ls.PLACEMENT_ID, ls.slot;


-- =====================================================================================
-- STEP 3 - bulk fix for every row STEP 2 lists. Run it as ONE script (BigQuery "Run" on the whole
-- block), and run it together with the code deploy: the fixed sync builds the cleaned row, and if
-- the old wrong row is still there its dedupe key differs, so the sync would insert the clean row
-- NEXT TO the wrong one instead of recognising it.
-- Rows written in the last ~30 minutes sit in the streaming buffer and cannot be UPDATEd yet.
-- =====================================================================================
CREATE TEMP TABLE bad_slots AS
WITH placement_contract AS (
  SELECT CAST(DEAL_SHEET_ID AS STRING) AS ds, CAST(PLACEMENT_ID AS STRING) AS pid,
         ANY_VALUE(TRIM(CONTRACT_ID)) AS contract_id
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  GROUP BY ds, pid
),
owner_source AS (
  SELECT TRIM(CONTRACT_ID) AS contract_id, [
    STRUCT(CAST(ASSIGNMENT_RECRUITER AS STRING) AS n, CAST(RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT(CAST(ATL AS STRING), CAST(ATL_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_RECRUITER AS STRING), CAST(SECONDARY_RECRUITER_EMP_NO AS STRING)),
    STRUCT(CAST(TEAM_LEAD AS STRING), CAST(TEAM_LEAD_EMP_NO AS STRING)),
    STRUCT(CAST(RM AS STRING), CAST(RM_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_AM AS STRING), CAST(SECONDARY_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_AM AS STRING), CAST(ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ACCOUNT_MANAGER AS STRING), CAST(ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_DIRECTOR AS STRING), CAST(DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_DELIVERY_DIRECTOR AS STRING), CAST(ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(AVP AS STRING), CAST(AVP_EMP_NO AS STRING)),
    STRUCT(CAST(VP AS STRING), CAST(VP_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_POC AS STRING), CAST(DELIVERY_POC_EMP_NO AS STRING))
  ] AS people
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  UNION ALL
  SELECT TRIM(CONTRACT_ID), [
    STRUCT(CAST(ASSIGNMENT_RECRUITER AS STRING) AS n, CAST(RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT(CAST(ATL AS STRING), CAST(ATL_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_RECRUITER AS STRING), CAST(SECONDARY_RECRUITER_EMP_NO AS STRING)),
    STRUCT(CAST(TEAM_LEAD AS STRING), CAST(TEAM_LEAD_EMP_NO AS STRING)),
    STRUCT(CAST(RM AS STRING), CAST(RM_EMP_NO AS STRING)),
    STRUCT(CAST(SECONDARY_AM AS STRING), CAST(SECONDARY_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_AM AS STRING), CAST(ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT(CAST(ACCOUNT_MANAGER AS STRING), CAST(ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_DIRECTOR AS STRING), CAST(DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(ASSOCIATE_DELIVERY_DIRECTOR AS STRING), CAST(ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT(CAST(AVP AS STRING), CAST(AVP_EMP_NO AS STRING)),
    STRUCT(CAST(VP AS STRING), CAST(VP_EMP_NO AS STRING)),
    STRUCT(CAST(DELIVERY_POC AS STRING), CAST(DELIVERY_POC_EMP_NO AS STRING))
  ]
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
),
-- Same keys as the code: cluster suffix "(GOV)" off, whitespace collapsed, case-folded, NA = nobody.
owners AS (
  SELECT DISTINCT contract_id,
    NULLIF(LOWER(REGEXP_REPLACE(TRIM(REGEXP_REPLACE(IFNULL(p.n, ''), r'\s*\([^)]*\)\s*$', '')), r'\s+', ' ')), 'na') AS name_key,
    NULLIF(UPPER(TRIM(IFNULL(p.e, ''))), 'NA') AS emp_key
  FROM owner_source, UNNEST(people) AS p
),
log_slots AS (
  SELECT l.ID, l.LAST_UPDATED, l.DEAL_SHEET_ID, l.PLACEMENT_ID, l.CANDIDATE_NAME, c.contract_id,
         s.slot, s.n AS person, s.e AS person_emp_no,
         NULLIF(LOWER(REGEXP_REPLACE(TRIM(IFNULL(s.n, '')), r'\s+', ' ')), 'na') AS name_key,
         NULLIF(UPPER(TRIM(IFNULL(s.e, ''))), 'NA') AS emp_key
  FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
  JOIN placement_contract c
    ON c.ds = CAST(l.DEAL_SHEET_ID AS STRING) AND c.pid = CAST(l.PLACEMENT_ID AS STRING)
  CROSS JOIN UNNEST([
    STRUCT('INORGANIC_RECRUITER' AS slot, CAST(l.INORGANIC_RECRUITER AS STRING) AS n, CAST(l.INORGANIC_RECRUITER_EMP_NO AS STRING) AS e),
    STRUCT('INORGANIC_ACCOUNT_MANAGER', CAST(l.INORGANIC_ACCOUNT_MANAGER AS STRING), CAST(l.INORGANIC_ACCOUNT_MANAGER_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ASSOCIATE_AM', CAST(l.INORGANIC_ASSOCIATE_AM AS STRING), CAST(l.INORGANIC_ASSOCIATE_AM_EMP_NO AS STRING)),
    STRUCT('INORGANIC_RM', CAST(l.INORGANIC_RM AS STRING), CAST(l.INORGANIC_RM_EMP_NO AS STRING)),
    STRUCT('INORGANIC_TL', CAST(l.INORGANIC_TL AS STRING), CAST(l.INORGANIC_TL_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ATL', CAST(l.INORGANIC_ATL AS STRING), CAST(l.INORGANIC_ATL_EMP_NO AS STRING)),
    STRUCT('INORGANIC_ASSOCIATE_GROUP_DIRECTOR', CAST(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR AS STRING), CAST(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO AS STRING)),
    STRUCT('INORGANIC_DELIVERY_DIRECTOR', CAST(l.INORGANIC_DELIVERY_DIRECTOR AS STRING), CAST(l.INORGANIC_DELIVERY_DIRECTOR_EMP_NO AS STRING)),
    STRUCT('INORGANIC_AVP', CAST(l.INORGANIC_AVP AS STRING), CAST(l.INORGANIC_AVP_EMP_NO AS STRING)),
    STRUCT('INORGANIC_VP_SR_VP', CAST(l.INORGANIC_VP_SR_VP AS STRING), CAST(l.INORGANIC_VP_SR_VP_EMP_NO AS STRING)),
    STRUCT('INORGANIC_DELIVERY_POC', CAST(l.INORGANIC_DELIVERY_POC AS STRING), CAST(l.INORGANIC_DELIVERY_POC_EMP_NO AS STRING))
  ]) AS s
  WHERE s.n IS NOT NULL OR s.e IS NOT NULL
)
SELECT DISTINCT ls.ID, ls.slot
FROM log_slots ls
WHERE EXISTS (
  SELECT 1 FROM owners o
  WHERE o.contract_id = ls.contract_id
    AND ( (ls.emp_key IS NOT NULL AND o.emp_key = ls.emp_key)
       OR (ls.name_key IS NOT NULL AND o.name_key = ls.name_key) )
);

-- 3a. Clear each person slot held by a contract owner.
UPDATE `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
SET INORGANIC_RECRUITER = IF(b.inorganic_recruiter, NULL, l.INORGANIC_RECRUITER),
    INORGANIC_RECRUITER_EMP_NO = IF(b.inorganic_recruiter, NULL, l.INORGANIC_RECRUITER_EMP_NO),
    INORGANIC_ACCOUNT_MANAGER = IF(b.inorganic_account_manager, NULL, l.INORGANIC_ACCOUNT_MANAGER),
    INORGANIC_ACCOUNT_MANAGER_EMP_NO = IF(b.inorganic_account_manager, NULL, l.INORGANIC_ACCOUNT_MANAGER_EMP_NO),
    INORGANIC_ASSOCIATE_AM = IF(b.inorganic_associate_am, NULL, l.INORGANIC_ASSOCIATE_AM),
    INORGANIC_ASSOCIATE_AM_EMP_NO = IF(b.inorganic_associate_am, NULL, l.INORGANIC_ASSOCIATE_AM_EMP_NO),
    INORGANIC_RM = IF(b.inorganic_rm, NULL, l.INORGANIC_RM),
    INORGANIC_RM_EMP_NO = IF(b.inorganic_rm, NULL, l.INORGANIC_RM_EMP_NO),
    INORGANIC_TL = IF(b.inorganic_tl, NULL, l.INORGANIC_TL),
    INORGANIC_TL_EMP_NO = IF(b.inorganic_tl, NULL, l.INORGANIC_TL_EMP_NO),
    INORGANIC_ATL = IF(b.inorganic_atl, NULL, l.INORGANIC_ATL),
    INORGANIC_ATL_EMP_NO = IF(b.inorganic_atl, NULL, l.INORGANIC_ATL_EMP_NO),
    INORGANIC_ASSOCIATE_GROUP_DIRECTOR = IF(b.inorganic_associate_group_director, NULL, l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR),
    INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO = IF(b.inorganic_associate_group_director, NULL, l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO),
    INORGANIC_DELIVERY_DIRECTOR = IF(b.inorganic_delivery_director, NULL, l.INORGANIC_DELIVERY_DIRECTOR),
    INORGANIC_DELIVERY_DIRECTOR_EMP_NO = IF(b.inorganic_delivery_director, NULL, l.INORGANIC_DELIVERY_DIRECTOR_EMP_NO),
    INORGANIC_AVP = IF(b.inorganic_avp, NULL, l.INORGANIC_AVP),
    INORGANIC_AVP_EMP_NO = IF(b.inorganic_avp, NULL, l.INORGANIC_AVP_EMP_NO),
    INORGANIC_VP_SR_VP = IF(b.inorganic_vp_sr_vp, NULL, l.INORGANIC_VP_SR_VP),
    INORGANIC_VP_SR_VP_EMP_NO = IF(b.inorganic_vp_sr_vp, NULL, l.INORGANIC_VP_SR_VP_EMP_NO)
FROM (
  SELECT ID,
         LOGICAL_OR(slot = 'INORGANIC_RECRUITER') AS inorganic_recruiter,
         LOGICAL_OR(slot = 'INORGANIC_ACCOUNT_MANAGER') AS inorganic_account_manager,
         LOGICAL_OR(slot = 'INORGANIC_ASSOCIATE_AM') AS inorganic_associate_am,
         LOGICAL_OR(slot = 'INORGANIC_RM') AS inorganic_rm,
         LOGICAL_OR(slot = 'INORGANIC_TL') AS inorganic_tl,
         LOGICAL_OR(slot = 'INORGANIC_ATL') AS inorganic_atl,
         LOGICAL_OR(slot = 'INORGANIC_ASSOCIATE_GROUP_DIRECTOR') AS inorganic_associate_group_director,
         LOGICAL_OR(slot = 'INORGANIC_DELIVERY_DIRECTOR') AS inorganic_delivery_director,
         LOGICAL_OR(slot = 'INORGANIC_AVP') AS inorganic_avp,
         LOGICAL_OR(slot = 'INORGANIC_VP_SR_VP') AS inorganic_vp_sr_vp
  FROM bad_slots
  GROUP BY ID
) b
WHERE l.ID = b.ID;

-- 3b. The POC was a contract owner -> re-pick it as the sync does: first of ADD -> DD -> AVP -> VP
--     still present, email from the directory (ACTIVE first, latest first); nobody left -> NULL.
UPDATE `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` t
SET INORGANIC_DELIVERY_POC = p.poc_name,
    INORGANIC_DELIVERY_POC_EMP_NO = p.poc_emp,
    INORGANIC_DELIVERY_POC_EMAIL = p.poc_email
FROM (
  SELECT x.ID, x.poc_name, x.poc_emp, (
           SELECT e.email FROM `cynetdatabase.MISC.directory_employees` e
           WHERE x.poc_emp IS NOT NULL AND CAST(e.employee_id AS STRING) = x.poc_emp
             AND e.email IS NOT NULL AND TRIM(e.email) != ''
           ORDER BY (e.status = 'ACTIVE') DESC, e.updated_at DESC
           LIMIT 1
         ) AS poc_email
  FROM (
    SELECT l.ID,
           CASE
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, '')) != '' THEN l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_DELIVERY_DIRECTOR, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_DELIVERY_DIRECTOR, '')) != '' THEN l.INORGANIC_DELIVERY_DIRECTOR
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_AVP, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_AVP, '')) != '' THEN l.INORGANIC_AVP
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_VP_SR_VP, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_VP_SR_VP, '')) != '' THEN l.INORGANIC_VP_SR_VP
           END AS poc_name,
           CASE
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, '')) != '' THEN CAST(l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO AS STRING)
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_DELIVERY_DIRECTOR, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_DELIVERY_DIRECTOR, '')) != '' THEN CAST(l.INORGANIC_DELIVERY_DIRECTOR_EMP_NO AS STRING)
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_AVP, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_AVP, '')) != '' THEN CAST(l.INORGANIC_AVP_EMP_NO AS STRING)
             WHEN NULLIF(UPPER(TRIM(IFNULL(l.INORGANIC_VP_SR_VP, ''))), 'NA') IS NOT NULL AND TRIM(IFNULL(l.INORGANIC_VP_SR_VP, '')) != '' THEN CAST(l.INORGANIC_VP_SR_VP_EMP_NO AS STRING)
           END AS poc_emp
    FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
    WHERE l.ID IN (SELECT ID FROM bad_slots WHERE slot = 'INORGANIC_DELIVERY_POC')
  ) x
) p
WHERE t.ID = p.ID;

-- 3c. Rows left with nobody in any hierarchy slot (and no recruiter). The sync would no longer
--     write these at all. Review, then delete only if the business agrees.
SELECT l.ID, l.LAST_UPDATED, l.DEAL_SHEET_ID, l.PLACEMENT_ID, l.CANDIDATE_NAME
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
WHERE l.ID IN (SELECT ID FROM bad_slots)
  AND COALESCE(l.INORGANIC_RECRUITER, l.INORGANIC_ACCOUNT_MANAGER, l.INORGANIC_ASSOCIATE_AM, l.INORGANIC_RM, l.INORGANIC_TL, l.INORGANIC_ATL, l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, l.INORGANIC_DELIVERY_DIRECTOR, l.INORGANIC_AVP, l.INORGANIC_VP_SR_VP) IS NULL;
-- DELETE FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs` l
-- WHERE l.ID IN (SELECT ID FROM bad_slots)
--   AND COALESCE(l.INORGANIC_RECRUITER, l.INORGANIC_ACCOUNT_MANAGER, l.INORGANIC_ASSOCIATE_AM, l.INORGANIC_RM, l.INORGANIC_TL, l.INORGANIC_ATL, l.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, l.INORGANIC_DELIVERY_DIRECTOR, l.INORGANIC_AVP, l.INORGANIC_VP_SR_VP) IS NULL;
