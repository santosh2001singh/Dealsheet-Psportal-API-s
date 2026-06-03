-- One-time backfill for NEW_HIRE_DATE and EXTENSION_DATE on existing deal sheet rows.
-- Only fills NULL targets using the earliest DATE_AND_TIME per DEAL_SHEET_ID + PLACEMENT_ID.
-- EXTENSION_DATE uses the US Eastern calendar date (America/New_York).
-- Run each UPDATE block per table; safe to re-run (NULL-only guards).

-- =============================================================================
-- Active deal sheet tables
-- =============================================================================

-- cynet_health_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;

-- cynet_health_canada_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;

-- cynet_locums_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;

-- =============================================================================
-- Ended deal sheet tables
-- =============================================================================

-- cynet_health_ended_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;

-- cynet_health_canada_ended_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;

-- cynet_locums_ended_deal_sheet
UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` AS t
SET NEW_HIRE_DATE = stamp.creation_ts
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    MIN(DATE_AND_TIME) AS creation_ts
  FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'DEAL'
  AND t.NEW_HIRE_DATE IS NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` AS t
SET EXTENSION_DATE = stamp.extension_date
FROM (
  SELECT
    DEAL_SHEET_ID,
    PLACEMENT_ID,
    DATE(MIN(DATE_AND_TIME), 'America/New_York') AS extension_date
  FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND UPPER(TRIM(PLACEMENT_STATUS)) = 'BOOKED'
  GROUP BY DEAL_SHEET_ID, PLACEMENT_ID
) AS stamp
WHERE t.DEAL_SHEET_ID = stamp.DEAL_SHEET_ID
  AND t.PLACEMENT_ID = stamp.PLACEMENT_ID
  AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
  AND t.EXTENSION_DATE IS NULL;
