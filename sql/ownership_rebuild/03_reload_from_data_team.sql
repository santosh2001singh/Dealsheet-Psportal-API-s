-- STEP 3 of the ownership_change_logs rebuild: delete EVERYTHING, then load the data team's table.
--
-- Prerequisites:
--   * 01_backup.sql and 02_add_columns.sql have run.
--   * The ownership-log switch is OFF in the deployed code, and nothing has streamed into the table
--     for ~90 minutes. BigQuery refuses DELETE on rows still in the streaming buffer
--     ("would affect rows in the streaming buffer"); if that error appears, wait and re-run.
--
-- Every row of Cluster_Data.ownership_data is loaded as-is (no DISTINCT, as agreed). Data team rows are
-- marked EDITED_BY = 'DATA_TEAM_SYNC' / EFFECTIVE_DATE_SOURCE = 'DATA_TEAM' and are never rewritten by
-- the triggers. They carry no PLACEMENT_ID / CONTRACT_ID (the data team does not have them).
--
-- Role names are converted to the system's names (TL and Team Lead -> TEAM_LEAD, Onsite Owner ->
-- LEVEL_2_CSM, ...). A role with no system equivalent (Mentor, Recruitment Mentor, ...) is upper-cased
-- with underscores so it still reads the same way.

BEGIN TRANSACTION;

DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE TRUE;

INSERT INTO `cynetdatabase.rr_project_data.ownership_change_logs` (
  ID, LAST_UPDATED, SKU_NO, PLACEMENT_ID, CANDIDATE_NAME, CANDIDATE_EMAIL,
  START_DATE, INITIAL_START_DATE, OWNERSHIP_EFFECTIVE_DATE, END_DATE_PREVIOUS_OWNER,
  OWNERSHIP_ROLE, NEW_OWNER_NAME, NEW_OWNER_EMP_NO, PREVIOUS_OWNER_NAME, PREVIOUS_OWNER_EMP_NO,
  CHANGE_REASON_NOTES, STATUS_REMARKS, EDITED_BY, CONTRACT_ID, IS_DELETED, DELETED_BY,
  EFFECTIVE_DATE_SOURCE, EFFECTIVE_DATE_PLACEMENT_ID
)
SELECT
  GENERATE_UUID()                                   AS ID,
  CURRENT_TIMESTAMP()                               AS LAST_UPDATED,
  o.SKU_NO,
  CAST(NULL AS STRING)                              AS PLACEMENT_ID,
  o.CANDIDATE_NAME,
  CAST(NULL AS STRING)                              AS CANDIDATE_EMAIL,
  o.START_DATE,
  o.START_DATE                                      AS INITIAL_START_DATE,
  o.EFFECTIVE_DATE                                  AS OWNERSHIP_EFFECTIVE_DATE,
  DATE_SUB(o.EFFECTIVE_DATE, INTERVAL 1 DAY)        AS END_DATE_PREVIOUS_OWNER,
  CASE UPPER(TRIM(o.OWNERSHIP_UPDATE))
    WHEN 'RECRUITER'                           THEN 'RECRUITER'
    WHEN 'SECONDARY RECRUITER'                 THEN 'SECONDARY_RECRUITER'
    WHEN 'ONSITE AM'                           THEN 'ONSITE_AM'
    WHEN 'ONSITE OWNER'                        THEN 'LEVEL_2_CSM'
    WHEN 'ATL'                                 THEN 'ATL'
    WHEN 'TL'                                  THEN 'TEAM_LEAD'
    WHEN 'TEAM LEAD'                           THEN 'TEAM_LEAD'
    WHEN 'RM'                                  THEN 'RM'
    WHEN 'ASSOCIATE AM'                        THEN 'ASSOCIATE_AM'
    WHEN 'SECONDARY AM'                        THEN 'SECONDARY_AM'
    WHEN 'ACCOUNT MANAGER'                     THEN 'ACCOUNT_MANAGER'
    WHEN 'GROUP DIRECTOR'                      THEN 'ASSOCIATE_DELIVERY_DIRECTOR'
    WHEN 'GROUP DIRECTOR / ASSOCIATE DIRECTOR' THEN 'ASSOCIATE_DELIVERY_DIRECTOR'
    WHEN 'AVP'                                 THEN 'AVP'
    WHEN 'VP / SR. VP'                         THEN 'VP'
    ELSE REGEXP_REPLACE(UPPER(TRIM(o.OWNERSHIP_UPDATE)), r'[^A-Z0-9]+', '_')
  END                                               AS OWNERSHIP_ROLE,
  o.NEW_UPDATE                                      AS NEW_OWNER_NAME,
  o.NEW_EMP_CODE                                    AS NEW_OWNER_EMP_NO,
  o.OLD_ONE                                         AS PREVIOUS_OWNER_NAME,
  o.OLD_EMP_CODE                                    AS PREVIOUS_OWNER_EMP_NO,
  -- "Upcoming Extension | SHOULD_BE_UPDATED_AFTER=2026-10-17"; NULL parts are dropped, both NULL -> NULL.
  NULLIF(ARRAY_TO_STRING([
    NULLIF(TRIM(o.COMMENT), ''),
    IF(o.EFFECTIVE_DATE_SHOULD_BE_UPDATE_AFTER IS NULL, NULL,
       CONCAT('SHOULD_BE_UPDATED_AFTER=', CAST(o.EFFECTIVE_DATE_SHOULD_BE_UPDATE_AFTER AS STRING)))
  ], ' | '), '')                                    AS CHANGE_REASON_NOTES,
  o.REMARKS                                         AS STATUS_REMARKS,
  'DATA_TEAM_SYNC'                                  AS EDITED_BY,
  CAST(NULL AS STRING)                              AS CONTRACT_ID,
  CAST(NULL AS BOOL)                                AS IS_DELETED,
  CAST(NULL AS STRING)                              AS DELETED_BY,
  'DATA_TEAM'                                       AS EFFECTIVE_DATE_SOURCE,
  CAST(NULL AS STRING)                              AS EFFECTIVE_DATE_PLACEMENT_ID
FROM `cynetdatabase.Cluster_Data.ownership_data` o;

COMMIT TRANSACTION;
