-- Migrate SCHEDULED_HOURS_1 / SCHEDULED_HOURS_2 -> GUARANTEED_HOURS / NEW_GUARANTEED_HOURS
-- Run in BigQuery BEFORE deploying updated Firebase functions.
--
-- NEW_GUARANTEED_HOURS stores ratio text like "38/40" (scheduled_hrs_1 / scheduled_hrs_2).
-- GUARANTEED_HOURS keeps the numeric value from scheduled_hrs_1.
--
-- Applies to all domain-routed active and ended deal sheet tables.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;

-- If NEW_GUARANTEED_HOURS was created as FLOAT64, fix type (run only if needed):
-- ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
--   ALTER COLUMN NEW_GUARANTEED_HOURS SET DATA TYPE STRING;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  RENAME COLUMN IF EXISTS SCHEDULED_HOURS_1 TO GUARANTEED_HOURS;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS NEW_GUARANTEED_HOURS STRING;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET NEW_GUARANTEED_HOURS = CONCAT(CAST(GUARANTEED_HOURS AS STRING), '/', CAST(SCHEDULED_HOURS_2 AS STRING))
WHERE GUARANTEED_HOURS IS NOT NULL
  AND SCHEDULED_HOURS_2 IS NOT NULL
  AND SCHEDULED_HOURS_2 != 0
  AND NEW_GUARANTEED_HOURS IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS SCHEDULED_HOURS_2;
