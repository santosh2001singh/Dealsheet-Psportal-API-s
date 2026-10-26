-- Rename every ch_rate_change_logs column that mirrors a deal-sheet column to the deal sheet's own
-- name (Oct 2026), so the log reads the same as the deal sheet.
--
--   RECRUITER                            -> ASSIGNMENT_RECRUITER
--   RECRUITER_EMAIL_ID                   -> ASSIGNMENT_RECRUITER_EMAIL
--   MSP                                  -> MSP_NAME
--   ONSITE_MANAGER                       -> ONSITE_AM
--   *_INITIAL_PROJECT_DURATION_IN_WEEKS  -> *_PROJECT_DURATION
--   *_ORIENTATION_HOURS                  -> *_NBO_HOURS
--   *_WEEKLY_PER_DIEM                    -> *_WEEKLY_PER_DIEM_NON_TAXED
--   *_GUARANTEED_HOURS                   -> *_SCHEDULE_HOURS_1  (guaranteed weekly hours on the deal sheet)
--
-- Metadata-only: no row is rewritten and the data in each column stays where it is. Queries,
-- reports or dashboards reading the OLD names must be updated. Run in BigQuery BEFORE deploying the
-- functions that write the new names; until then the insert drops those keys silently.

ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  RENAME COLUMN RECRUITER TO ASSIGNMENT_RECRUITER,
  RENAME COLUMN RECRUITER_EMAIL_ID TO ASSIGNMENT_RECRUITER_EMAIL,
  RENAME COLUMN MSP TO MSP_NAME,
  RENAME COLUMN ONSITE_MANAGER TO ONSITE_AM,
  RENAME COLUMN OLD_INITIAL_PROJECT_DURATION_IN_WEEKS TO OLD_PROJECT_DURATION,
  RENAME COLUMN NEW_INITIAL_PROJECT_DURATION_IN_WEEKS TO NEW_PROJECT_DURATION,
  RENAME COLUMN OLD_ORIENTATION_HOURS TO OLD_NBO_HOURS,
  RENAME COLUMN NEW_ORIENTATION_HOURS TO NEW_NBO_HOURS,
  RENAME COLUMN OLD_WEEKLY_PER_DIEM TO OLD_WEEKLY_PER_DIEM_NON_TAXED,
  RENAME COLUMN NEW_WEEKLY_PER_DIEM TO NEW_WEEKLY_PER_DIEM_NON_TAXED,
  RENAME COLUMN OLD_GUARANTEED_HOURS TO OLD_SCHEDULE_HOURS_1,
  RENAME COLUMN NEW_GUARANTEED_HOURS TO NEW_SCHEDULE_HOURS_1;
