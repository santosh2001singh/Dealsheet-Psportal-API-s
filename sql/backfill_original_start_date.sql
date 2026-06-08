-- One-time backfill for ORIGINAL_START_DATE on all 6 deal sheet tables.
--
-- Definition:
--   Lineage key = CANDIDATE_NEXUS_ID | LOWER(EMAIL) | PHONE | CLIENT_ID
--   (same as buildContractMatchKey in functions/src/contractIdResolver.js)
--   ORIGINAL_START_DATE = START_DATE of the earliest-created DEAL row
--     (MIN DATE_AND_TIME) in that lineage, applied to every row (DEAL + EXTENSION).
--
-- Per domain, the original date is computed from the UNION of active + ended tables,
-- then both tables are updated. Safe to re-run (idempotent overwrite for keyed rows).
--
-- Rows with null CANDIDATE_NEXUS_ID or CLIENT_ID are skipped (cannot be keyed).
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush.

-- =============================================================================
-- cynet_health (active + ended)
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

-- =============================================================================
-- cynet_health_canada (active + ended)
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

-- =============================================================================
-- cynet_locums (active + ended)
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  WITH lineage AS (
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
    UNION ALL
    SELECT
      CANDIDATE_NEXUS_ID,
      CLIENT_ID,
      CANDIDATE_EMAIL,
      PHONE_NUMBER,
      DEAL_TYPE,
      START_DATE,
      DATE_AND_TIME
    FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ),
  keyed AS (
    SELECT
      CONCAT(
        CAST(CANDIDATE_NEXUS_ID AS STRING),
        '|',
        LOWER(TRIM(IFNULL(CANDIDATE_EMAIL, ''))),
        '|',
        TRIM(IFNULL(PHONE_NUMBER, '')),
        '|',
        CAST(CLIENT_ID AS STRING)
      ) AS match_key,
      START_DATE,
      DATE_AND_TIME
    FROM lineage
    WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
      AND CANDIDATE_NEXUS_ID IS NOT NULL
      AND CLIENT_ID IS NOT NULL
  )
  SELECT
    match_key,
    ARRAY_AGG(START_DATE IGNORE NULLS ORDER BY DATE_AND_TIME ASC LIMIT 1)[
      SAFE_OFFSET(0)
    ] AS original_start_date
  FROM keyed
  GROUP BY match_key
) AS orig
WHERE t.CANDIDATE_NEXUS_ID IS NOT NULL
  AND t.CLIENT_ID IS NOT NULL
  AND CONCAT(
    CAST(t.CANDIDATE_NEXUS_ID AS STRING),
    '|',
    LOWER(TRIM(IFNULL(t.CANDIDATE_EMAIL, ''))),
    '|',
    TRIM(IFNULL(t.PHONE_NUMBER, '')),
    '|',
    CAST(t.CLIENT_ID AS STRING)
  ) = orig.match_key;

-- =============================================================================
-- Verification (run after UPDATEs; keyed_still_null should be 0 per table)
-- =============================================================================

-- health
SELECT
  'cynet_health_deal_sheet' AS table_name,
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ) AS keyed_still_null,
  COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
UNION ALL
SELECT
  'cynet_health_ended_deal_sheet',
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ),
  COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`;

-- canada
SELECT
  'cynet_health_canada_deal_sheet' AS table_name,
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ) AS keyed_still_null,
  COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
UNION ALL
SELECT
  'cynet_health_canada_ended_deal_sheet',
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ),
  COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`;

-- locums
SELECT
  'cynet_locums_deal_sheet' AS table_name,
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ) AS keyed_still_null,
  COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
UNION ALL
SELECT
  'cynet_locums_ended_deal_sheet',
  COUNTIF(
    ORIGINAL_START_DATE IS NULL
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
  ),
  COUNT(*)
FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`;
