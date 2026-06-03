-- Add REJECTION_REASON STRING column to all active domain-routed deal sheet tables.
-- Manual BigQuery edit column; the sync pipeline does not write it (treated as a
-- manual column, carried forward across append-on-change inserts).
--
-- Run this migration in BigQuery before relying on the new column.

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS REJECTION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS REJECTION_REASON STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS REJECTION_REASON STRING;
