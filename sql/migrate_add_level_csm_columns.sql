-- Add LEVEL_2_CSM, LEVEL_3_CSM, LEVEL_4_CSM STRING columns to all active + ended domain-routed deal sheet tables.
-- Manual BigQuery-edited columns; carried forward on update-append by the sync pipeline.
-- Run this migration in BigQuery before relying on the new columns.

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS LEVEL_2_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_3_CSM STRING,
  ADD COLUMN IF NOT EXISTS LEVEL_4_CSM STRING;
