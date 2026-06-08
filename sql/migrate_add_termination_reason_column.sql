-- Add TERMINATION_REASON STRING column to all active + ended domain-routed deal sheet tables.
-- Run this migration in BigQuery before relying on the new column.

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS TERMINATION_REASON STRING;
