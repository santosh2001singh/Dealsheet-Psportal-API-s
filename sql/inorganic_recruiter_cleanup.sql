-- inorganic_hierarchy_logs cleanup after the 2026-10-02 inorganic fix.
--
-- Rules now in code (bigQueryClient.js):
--   * INORGANIC_RECRUITER is never written. The recruiter is the assignment recruiter; a recruiter
--     change is recorded in ownership_change_logs. The run-rate's INORGANIC_RECRUITER is ignored too.
--   * On a recruiter change, the new recruiter's chain is read on the day the recruiter CHANGED, not
--     on NEW_HIRE_DATE / EXTENSION_DATE.
--   * A recruiter change that already has a row (even one the RR dashboard edited or cleared) is
--     never appended again.
--
-- The 35 rows with RECRUITER_EMAIL_ID were re-evaluated with those rules (2026-10-02):
--   1  delete            - 1455552 Miguel Ipina: re-added by the scan after the RR dashboard cleared it,
--                          and Vance Tyson is in the same team as the frozen hierarchy anyway
--   4  clear recruiter   - real hierarchy divergence, only INORGANIC_RECRUITER has to go
--   24 untouched         - cleared by hand in the RR dashboard
--   6  untouched         - no recruiter change in the deal sheet history (rows the RR dashboard wrote)
--
-- Run top to bottom. Every statement names rows by ID.

-- 1. Backup.
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.inorganic_hierarchy_logs_backup_20261002`
COPY `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`;

-- 2. Preview: the 5 rows this file changes.
SELECT ID, LAST_UPDATED, PLACEMENT_ID, CANDIDATE_NAME, RECRUITER_EMAIL_ID,
       INORGANIC_RECRUITER, INORGANIC_RECRUITER_EMP_NO,
       INORGANIC_RM, INORGANIC_TL, INORGANIC_ACCOUNT_MANAGER, INORGANIC_ASSOCIATE_AM,
       INORGANIC_ASSOCIATE_GROUP_DIRECTOR, INORGANIC_DELIVERY_POC
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE ID IN (
  'e8e6e128-309f-4eef-85d7-b12241e743a1',  -- 1455552 Miguel Ipina        (delete)
  'ccda1b67-6c07-4408-b221-6d88e70104d9',  -- 1468730 Archana Patel       (clear recruiter)
  'c415dbd6-58c4-4ec1-becf-eeb6a345199e',  -- 1468265 Emily Hollifield    (clear recruiter)
  '35f3f52b-b977-4ab2-aecc-97d08db6060b',  -- 1468057 Letta M. Jackson    (clear recruiter)
  '73e4194e-0100-4959-882a-ef7746100ffe'   -- 1463801 Oluwatosin Shokeye  (clear recruiter)
);

-- 3. 1455552: the RR dashboard cleared this placement's inorganic values on 2026-09-15 15:38; the
--    scan re-added RM Nitish Sharma + recruiter Vance Tyson at 16:17. The cleared row stays.
DELETE FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE ID = 'e8e6e128-309f-4eef-85d7-b12241e743a1';

-- 4. The recruiter is never inorganic. None of these four has the recruiter as INORGANIC_DELIVERY_POC,
--    so the POC is left as it is.
UPDATE `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
SET INORGANIC_RECRUITER = NULL,
    INORGANIC_RECRUITER_EMP_NO = NULL
WHERE ID IN (
  'ccda1b67-6c07-4408-b221-6d88e70104d9',
  'c415dbd6-58c4-4ec1-becf-eeb6a345199e',
  '35f3f52b-b977-4ab2-aecc-97d08db6060b',
  '73e4194e-0100-4959-882a-ef7746100ffe'
);

-- 5. Check: both counts must be 0.
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
     WHERE INORGANIC_RECRUITER IS NOT NULL OR INORGANIC_RECRUITER_EMP_NO IS NOT NULL) AS rows_with_inorganic_recruiter,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
     WHERE ID = 'e8e6e128-309f-4eef-85d7-b12241e743a1') AS miguel_readded_row;
