-- Migrate GUARANTEED_HOURS / NEW_GUARANTEED_HOURS -> SCHEDULE_HOURS_1 / SCHEDULE_HOURS_2
-- Run in BigQuery BEFORE deploying updated Firebase functions.
--
-- SCHEDULE_HOURS_1 = former GUARANTEED_HOURS (scheduled_hrs_1).
-- SCHEDULE_HOURS_2 backfilled from ratio suffix in NEW_GUARANTEED_HOURS when present (e.g. "40/36" -> 36).
-- When NEW_GUARANTEED_HOURS had no slash, treat whole value as hrs2 if SCHEDULE_HOURS_2 still null.
--
-- Applies to all domain-routed active and ended deal sheet tables.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  RENAME COLUMN IF EXISTS GUARANTEED_HOURS TO SCHEDULE_HOURS_1;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SCHEDULE_HOURS_2 FLOAT64;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(SPLIT(NEW_GUARANTEED_HOURS, '/')[SAFE_OFFSET(1)] AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') > 0
  AND SCHEDULE_HOURS_2 IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET SCHEDULE_HOURS_2 = SAFE_CAST(NEW_GUARANTEED_HOURS AS FLOAT64)
WHERE NEW_GUARANTEED_HOURS IS NOT NULL
  AND STRPOS(NEW_GUARANTEED_HOURS, '/') = 0
  AND SCHEDULE_HOURS_2 IS NULL;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS NEW_GUARANTEED_HOURS;
