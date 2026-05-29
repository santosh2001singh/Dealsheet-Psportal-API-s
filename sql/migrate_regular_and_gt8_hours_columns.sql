-- Migrate GREATER_THAN_EIGHT_HOURS_WEEK_1/2 -> REGULAR_HOURS_1/2 + GREATER_THAN_EIGHT_HOURS_1/2
-- Run in BigQuery BEFORE deploying updated Firebase functions.
--
-- Drops legacy week columns (unused in JS). Adds four hours columns populated on next sync
-- from /api/deal-sheet-hours-details/ (regular_hrs_1/2, greater_than_eight_hrs_1/2).
--
-- Applies to all domain-routed active and ended deal sheet tables.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_1;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_WEEK_2;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS REGULAR_HOURS_2 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_1 FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS GREATER_THAN_EIGHT_HOURS_2 FLOAT64;
