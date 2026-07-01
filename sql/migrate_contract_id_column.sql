-- Reset CONTRACT_ID in all domain-routed active and ended deal sheet tables.
--
-- Prefixed STRING ids are assigned at runtime by functions/src/contractIdResolver.js:
--   cynet_health_deal_sheet        -> CHC1000, CHC1001, ...
--   cynet_health_canada_deal_sheet -> CAC1000, CAC1001, ...
--   cynet_locums_deal_sheet        -> LOC1000, LOC1001, ...
--
-- For INT64 -> STRING type change, run sql/migrate_contract_id_to_string.sql first.
-- This script only clears values on an existing STRING CONTRACT_ID column.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET CONTRACT_ID = NULL
WHERE CONTRACT_ID IS NOT NULL;
