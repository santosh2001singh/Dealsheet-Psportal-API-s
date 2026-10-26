-- STEP 4 of the ownership_change_logs rebuild: checks to run right after 03_reload_from_data_team.sql.
-- Read-only. Every check should match the expected value in its comment.

-- (a) Row counts: data_team_rows = log_rows = data_team_tagged, system_rows = 0.
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.Cluster_Data.ownership_data`)                               AS data_team_rows,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ownership_change_logs`)                     AS log_rows,
  (SELECT COUNTIF(EDITED_BY = 'DATA_TEAM_SYNC' AND EFFECTIVE_DATE_SOURCE = 'DATA_TEAM')
     FROM `cynetdatabase.rr_project_data.ownership_change_logs`)                                   AS data_team_tagged,
  (SELECT COUNTIF(PLACEMENT_ID IS NOT NULL OR CONTRACT_ID IS NOT NULL)
     FROM `cynetdatabase.rr_project_data.ownership_change_logs`)                                   AS system_rows;

-- (b) Role mapping: rows per system role among the data team rows. TEAM_LEAD = TL + Team Lead (417),
--     LEVEL_2_CSM = Onsite Owner (1574), ASSOCIATE_DELIVERY_DIRECTOR = both Group Director spellings (366).
--     No row may have a NULL role.
SELECT OWNERSHIP_ROLE, COUNT(*) AS rows_
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE EDITED_BY = 'DATA_TEAM_SYNC'
GROUP BY 1
ORDER BY 2 DESC;

-- (c) Notes: rows with COMMENT or SHOULD_BE_UPDATE_AFTER in the source must have CHANGE_REASON_NOTES.
--     Expected: source_with_notes = log_with_notes.
SELECT
  (SELECT COUNTIF(NULLIF(TRIM(COMMENT), '') IS NOT NULL OR EFFECTIVE_DATE_SHOULD_BE_UPDATE_AFTER IS NOT NULL)
     FROM `cynetdatabase.Cluster_Data.ownership_data`)                                             AS source_with_notes,
  (SELECT COUNTIF(CHANGE_REASON_NOTES IS NOT NULL)
     FROM `cynetdatabase.rr_project_data.ownership_change_logs`)                                   AS log_with_notes;

-- (d) Spot check, Elaine Simon (H14312): 1 Done row (2026-04-05) + 3 Upcoming Extension rows (2026-10-17).
SELECT OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME, START_DATE, INITIAL_START_DATE,
       OWNERSHIP_EFFECTIVE_DATE, END_DATE_PREVIOUS_OWNER, CHANGE_REASON_NOTES, STATUS_REMARKS
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE SKU_NO = 'H14312'
ORDER BY OWNERSHIP_EFFECTIVE_DATE, OWNERSHIP_ROLE;
