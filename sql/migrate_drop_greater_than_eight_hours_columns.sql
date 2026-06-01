-- Drop GREATER_THAN_EIGHT_HOURS_1/2 from all domain-routed active and ended deal sheet tables.
--
-- These columns were pass-through mappings from Nexus deal-sheet-hours-details
-- (greater_than_eight_hrs_1/2). The enrichment pipeline no longer writes them.
-- REGULAR_HOURS_1/2 remain unchanged.
--
-- Run this migration in BigQuery BEFORE deploying the updated Firebase functions.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_1,
  DROP COLUMN IF EXISTS GREATER_THAN_EIGHT_HOURS_2;
