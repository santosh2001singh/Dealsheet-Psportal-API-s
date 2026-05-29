-- Reset CONTRACT_ID values in all domain-routed active and ended deal sheet tables.
--
-- The earlier backfill (CONTRACT_ID = PLACEMENT_ID) is no longer the desired
-- semantic. The new runtime resolver in functions/src/contractIdResolver.js
-- assigns Firestore-sequenced ids (starting at 100000) for DEAL rows and
-- reuses the matching DEAL's CONTRACT_ID for EXTENSION rows.
--
-- This migration only clears the column contents. The CONTRACT_ID INT64 column
-- itself is intentionally kept; the runtime resolver writes to it on every
-- insert/update.
--
-- ADD COLUMN IF NOT EXISTS is left in place so this script remains the single
-- entry point for setting up the CONTRACT_ID column on any new domain table.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID INT64;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;
