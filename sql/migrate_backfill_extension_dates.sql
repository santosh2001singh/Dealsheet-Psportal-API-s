-- One-time backfill: EXTENSION_START_DATE on all 6 domain deal sheet tables.
--
-- EXTENSION_DATE is NOT backfilled here — it comes from job-submittal created_date
-- during Nexus enrich/sync. Re-run sync or bulkBackfillByPlacementId for extension
-- placements after code deploy.
--
-- EXTENSION_START_DATE = START_DATE when DEAL_TYPE = EXTENSION, else NULL
--
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush (~90 min).

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- Verification
-- =============================================================================

SELECT 'cynet_health_deal_sheet' AS tbl,
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL) AS ext_null_extension_date,
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL) AS ext_null_start_date,
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION') AS extension_rows
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
UNION ALL
SELECT 'cynet_health_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
UNION ALL
SELECT 'cynet_locums_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
UNION ALL
SELECT 'cynet_locums_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_DATE IS NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND EXTENSION_START_DATE IS NULL AND START_DATE IS NOT NULL),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
ORDER BY tbl;