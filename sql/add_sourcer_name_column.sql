-- Add SOURCER_NAME to the Cynet Health deal sheet tables (Oct 2026).
--
-- SOURCER_NAME = Nexus /api/candidates/{id}/ referrer_name (the person who referred the candidate).
-- No referrer -> NULL; there is no fallback to referral_source.name.
--
-- Cynet Health ONLY. Canada and Locums tables do not get this column: the sync strips it from their
-- rows (CANADA_ / LOCUMS_EXCLUDED_API_OWNED_COLUMNS).
--
-- all_CH_data_runrate already has SOURCER_NAME (STRING, manually filled) and is NOT touched here.
-- all_CH_Deal_sheet_data is not loaded by this sync; only the column is added there.
--
-- No backfill: existing rows stay NULL and fill as the sync re-writes them.
--
-- Run this ONCE in BigQuery before deploying the functions change that maps the field.

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS SOURCER_NAME STRING;

ALTER TABLE `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data`
  ADD COLUMN IF NOT EXISTS SOURCER_NAME STRING;

-- Verify -- expect 3 rows, all STRING
SELECT table_name, column_name, data_type
FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
WHERE column_name = 'SOURCER_NAME'
  AND table_name IN ('cynet_health_deal_sheet', 'all_CH_Deal_sheet_data', 'all_CH_data_runrate')
ORDER BY table_name;
