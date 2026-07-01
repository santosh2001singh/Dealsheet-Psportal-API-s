-- One-time backfill: EXTENSION_DATE and EXTENSION_START_DATE on all 6 domain deal sheet tables.
-- Run AFTER migrate_extension_date_to_timestamp.sql (DROP + re-add as TIMESTAMP).
-- If EXTENSION_DATE is still DATE, run migrate_extension_date_to_timestamp.sql first.
--
-- EXTENSION_DATE  = MIN(DATE_AND_TIME) per DEAL_SHEET_ID + PLACEMENT_ID (TIMESTAMP)
-- EXTENSION_START_DATE = START_DATE when DEAL_TYPE = EXTENSION, else NULL
--
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush (~90 min).

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` AS t
SET EXTENSION_DATE = e.earliest_ts
FROM (
  SELECT DEAL_SHEET_ID, PLACEMENT_ID, MIN(DATE_AND_TIME) AS earliest_ts
  FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS e
WHERE t.DEAL_SHEET_ID = e.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = e.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION';

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
SET EXTENSION_START_DATE = IF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION', START_DATE, NULL);

-- =============================================================================
-- Verification (extension rows with null dates should be 0 where DATE_AND_TIME exists)
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
