-- Add billable orientation snapshots to rate-change log table (Health NEW_MARGIN inputs).
-- Run in BigQuery BEFORE deploying updated Firebase functions.

ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS OLD_BILLABLE_ORIENTATION_HRS FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS OLD_BILLABLE_ORIENTATION STRING;
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS NEW_BILLABLE_ORIENTATION_HRS FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS NEW_BILLABLE_ORIENTATION STRING;
