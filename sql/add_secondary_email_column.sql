-- Re-add SECONDARY_EMAIL as an API-owned column on all deal sheet tables (Aug 2026).
--
-- SECONDARY_CELL_PHN (renamed from the old manual SECONDARY_EMAIL in an earlier migration) now holds
-- the candidate's secondary phone. SECONDARY_EMAIL is a separate column again, sourced from Nexus
-- candidate_contact_info[].secondary_email with leap_email as fallback.
--
-- Run this ONCE in BigQuery before deploying the functions change that maps the field.

-- ---------------------------------------------------------------------------
-- 1. Add column -- active tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

-- ---------------------------------------------------------------------------
-- 2. Add column -- ended tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS SECONDARY_EMAIL STRING;

-- ---------------------------------------------------------------------------
-- 3. Verify -- expect 6 rows with column_name = SECONDARY_EMAIL
-- ---------------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
WHERE column_name = 'SECONDARY_EMAIL'
  AND table_name IN (
    'cynet_health_deal_sheet',
    'cynet_health_canada_deal_sheet',
    'cynet_locums_deal_sheet',
    'cynet_health_ended_deal_sheet',
    'cynet_health_canada_ended_deal_sheet',
    'cynet_locums_ended_deal_sheet'
  )
ORDER BY table_name;
