-- Add billable orientation fields for Health US NEW_MARGIN (Nexus deal-sheets API).
-- Run in BigQuery BEFORE deploying updated Firebase functions.
--
-- BILLABLE_ORIENTATION_HRS  <- billable_orientation_hrs (FLOAT64; null -> 0 in sync)
-- BILLABLE_ORIENTATION      <- billable_orientation as percent string e.g. "70.00%"
--
-- Health US only (@cynethealth.com). Dropped from Canada and Locums domain tables.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS BILLABLE_ORIENTATION_HRS FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS BILLABLE_ORIENTATION STRING;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS BILLABLE_ORIENTATION_HRS FLOAT64;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS BILLABLE_ORIENTATION STRING;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION_HRS;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION_HRS;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION_HRS;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION_HRS;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS BILLABLE_ORIENTATION;
