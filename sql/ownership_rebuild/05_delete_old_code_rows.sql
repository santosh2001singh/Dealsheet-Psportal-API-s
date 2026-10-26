-- STEP 5 of the ownership_change_logs rebuild: remove every row the OLD trigger code wrote after the reload.
--
-- The reload (03) ran while the old code was still deployed; the next trigger runs started writing
-- old-style rows again (same-placement scan + contract chain, old dates). Data team rows are tagged
-- EDITED_BY = 'DATA_TEAM_SYNC', so everything else is old-code output and can go.
--
-- Run this AFTER the new code is deployed with ownership writes OFF, and ~90 minutes after the last
-- trigger run (rows still in the streaming buffer cannot be deleted). Run it again right before turning
-- the switch ON if any trigger wrote in between. Re-running is safe: it never touches data team rows.

-- Preview first: what will be deleted.
SELECT LEFT(IFNULL(CONTRACT_ID, 'none'), 3) AS domain, COUNT(*) AS rows_to_delete,
       MIN(LAST_UPDATED) AS first_written, MAX(LAST_UPDATED) AS last_written
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'
GROUP BY 1;

DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC';

-- Check: only data team rows remain (expected 8151 = Cluster_Data.ownership_data row count).
-- SELECT COUNTIF(EDITED_BY = 'DATA_TEAM_SYNC') AS data_team_rows, COUNTIF(EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC') AS other_rows
-- FROM `cynetdatabase.rr_project_data.ownership_change_logs`;
