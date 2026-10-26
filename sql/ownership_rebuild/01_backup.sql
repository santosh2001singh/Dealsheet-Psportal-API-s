-- STEP 1 of the ownership_change_logs rebuild: full backup before anything is deleted.
--
-- Run this first. It copies every row of ownership_change_logs (system + legacy + Canada + Locums)
-- into a dated backup table. To roll back later:
--   DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE TRUE;
--   INSERT INTO `cynetdatabase.rr_project_data.ownership_change_logs`
--     SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs_backup_20261002`;
-- (run the rollback before 02_add_columns.sql, or list the columns explicitly after it).

CREATE TABLE `cynetdatabase.rr_project_data.ownership_change_logs_backup_20261002`
COPY `cynetdatabase.rr_project_data.ownership_change_logs`;

-- Check: the two counts must be equal.
-- SELECT
--   (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ownership_change_logs`)                 AS live_rows,
--   (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ownership_change_logs_backup_20261002`) AS backup_rows;
