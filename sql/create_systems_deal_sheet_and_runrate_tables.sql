-- Cynet Systems runrate from CEIPAL: the two tables that mirror Health's
--   all_CH_data_runrate      -> all_CS_data_runrate       history, copied from CS_TABLE_RUNRATE
--   cynet_health_deal_sheet  -> cynet_systems_deal_sheet  written by the CEIPAL sync (systemsDealSheetSync.js)
--
-- Both tables keep CS_TABLE_RUNRATE's 97 column names and types unchanged, so the dashboard can read
-- them the way it reads CS_TABLE_RUNRATE today, plus the columns the CEIPAL sync adds.
-- CREATE TABLE (not OR REPLACE) on purpose: re-running this never wipes a table that already exists.
--
-- The CEIPAL sync writes every placement of the report, with ENTITY = SYSTEMS / HEALTH / CANADA.
--
-- MARGIN convention (same as Health): MARGIN = CEIPAL's own margin (Bill - Pay) for synced rows;
-- CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_COST (the sheet's "MARGIN" formula). The historical
-- MARGIN in CS_TABLE_RUNRATE is that sheet formula, so the copy puts it in CALCULATED_MARGIN too and
-- leaves MARGIN as it was.

-- 1) History: copy of CS_TABLE_RUNRATE + the new columns.
CREATE TABLE `cynetdatabase.rr_project_data.all_CS_data_runrate` AS
SELECT
  src.*,
  CAST(NULL AS STRING)   AS PLACEMENT_ID,  -- CEIPAL Placement Code, e.g. PLC-13831
  CAST(NULL AS INT64)    AS CEIPAL_APPLICANT_ID,
  CAST(NULL AS STRING)   AS CEIPAL_PLACEMENT_STATUS,
  CAST(NULL AS STRING)   AS CEIPAL_PROFILE_STATUS,
  CAST(NULL AS DATE)     AS TENTATIVE_START_DATE,
  CAST(NULL AS DATE)     AS EFFECTIVE_DATE,
  CAST(NULL AS DATETIME) AS SUBMISSION_DATE,
  CAST(NULL AS DATETIME) AS CEIPAL_MODIFIED_ON,
  CAST(NULL AS STRING)   AS PAYLOCITY_ID,
  CAST(NULL AS STRING)   AS JOB_CODE,
  CAST(NULL AS STRING)   AS CLIENT_JOB_ID,
  CAST(NULL AS STRING)   AS PAY_TYPE,
  CAST(NULL AS STRING)   AS RECRUITER_EMP_NO,
  CAST(NULL AS STRING)   AS CEIPAL_RECRUITER_EMP_NO,
  src.MARGIN             AS CALCULATED_MARGIN,
  CAST(NULL AS FLOAT64)  AS GP_PERCENTAGE,
  -- Google Workspace recruiter hierarchy companions (same set as the Health deal sheet).
  CAST(NULL AS STRING)   AS ATL_EMP_NO,
  CAST(NULL AS STRING)   AS SECONDARY_RECRUITER,
  CAST(NULL AS STRING)   AS SECONDARY_RECRUITER_EMP_NO,
  CAST(NULL AS STRING)   AS TEAM_LEAD_EMP_NO,
  CAST(NULL AS STRING)   AS RM_EMP_NO,
  CAST(NULL AS STRING)   AS SECONDARY_AM_EMP_NO,
  CAST(NULL AS STRING)   AS ASSOCIATE_AM_EMP_NO,
  CAST(NULL AS STRING)   AS ACCOUNT_MANAGER_EMP_NO,
  CAST(NULL AS STRING)   AS DELIVERY_DIRECTOR,
  CAST(NULL AS STRING)   AS DELIVERY_DIRECTOR_EMP_NO,
  CAST(NULL AS STRING)   AS ASSOCIATE_DELIVERY_DIRECTOR,
  CAST(NULL AS STRING)   AS ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO,
  CAST(NULL AS STRING)   AS AVP,
  CAST(NULL AS STRING)   AS AVP_EMP_NO,
  CAST(NULL AS STRING)   AS VP,
  CAST(NULL AS STRING)   AS VP_EMP_NO,
  CAST(NULL AS STRING)   AS CONTRACT_ID,  -- CSC1000+, minted by the CEIPAL sync (Firestore sequence); NULL on history rows
  CAST(NULL AS STRING)   AS CURRENCY,  -- USD / CAD; CEIPAL rows set it (Canada rates are CAD)
  'CS_TABLE_RUNRATE'     AS DATA_SOURCE
FROM `cynetdatabase.cynet_Data.CS_TABLE_RUNRATE` AS src;

-- 2) Deal sheet: identical schema, empty. The first CEIPAL insert run fills it.
CREATE TABLE `cynetdatabase.rr_project_data.cynet_systems_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.all_CS_data_runrate` WHERE FALSE;

-- 3) Checks
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.cynet_Data.CS_TABLE_RUNRATE`)          AS source_rows,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CS_data_runrate`)   AS copied_rows,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_systems_deal_sheet`) AS deal_sheet_rows;
