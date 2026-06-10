-- One-time: clear ORIGINAL_START_DATE on all 6 domain deal sheet tables.
-- Does NOT touch all_CH_data.
--
-- ORIGINAL_START_DATE is a manual field (like SKU_NUMBER): sync must not auto-fill.
-- Run AFTER code deploy (auto-fill removed) — otherwise the next sync may repopulate.
--
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush (~90 min).

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET ORIGINAL_START_DATE = NULL
WHERE ORIGINAL_START_DATE IS NOT NULL;

-- =============================================================================
-- Verification (still_set should be 0 for each table)
-- =============================================================================

SELECT 'cynet_health_deal_sheet' AS tbl, COUNTIF(ORIGINAL_START_DATE IS NOT NULL) AS still_set, COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
UNION ALL
SELECT 'cynet_health_ended_deal_sheet', COUNTIF(ORIGINAL_START_DATE IS NOT NULL), COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_deal_sheet', COUNTIF(ORIGINAL_START_DATE IS NOT NULL), COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_ended_deal_sheet', COUNTIF(ORIGINAL_START_DATE IS NOT NULL), COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
UNION ALL
SELECT 'cynet_locums_deal_sheet', COUNTIF(ORIGINAL_START_DATE IS NOT NULL), COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
UNION ALL
SELECT 'cynet_locums_ended_deal_sheet', COUNTIF(ORIGINAL_START_DATE IS NOT NULL), COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
ORDER BY tbl;
