-- One-time backfill for ORIGINAL_START_DATE on all_CH_data.
--
-- Target: cynetdatabase.rr_project_data.all_CH_data
--
-- Definition:
--   Group key = SKU_NUMBER (non-null, non-blank)
--   ORIGINAL_START_DATE = MIN(START_DATE) across all rows sharing that SKU_NUMBER
--   Applied to every row in the SKU group (DEAL_TYPE not used; often null).
--
-- Example: SKU H13361_H13979 with START_DATE 2025-11-03 and 2026-04-01
--   -> both rows get ORIGINAL_START_DATE = 2025-11-03
--
-- Overwrites existing ORIGINAL_START_DATE for keyed SKU rows (idempotent re-run).
-- Rows with null/blank SKU_NUMBER are skipped.
--
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush (~90 min).

-- =============================================================================
-- Pre-check (optional — run before UPDATE)
-- =============================================================================

-- Summary counts
SELECT
  COUNTIF(
    SKU_NUMBER IS NOT NULL
    AND TRIM(SKU_NUMBER) != ''
    AND START_DATE IS NOT NULL
  ) AS sku_keyed_rows_with_start_date,
  COUNTIF(
    SKU_NUMBER IS NOT NULL
    AND TRIM(SKU_NUMBER) != ''
    AND START_DATE IS NOT NULL
    AND ORIGINAL_START_DATE IS NULL
  ) AS sku_keyed_rows_still_null,
  COUNTIF(
    SKU_NUMBER IS NULL OR TRIM(SKU_NUMBER) = ''
  ) AS rows_without_sku_skipped,
  COUNT(DISTINCT IF(
    SKU_NUMBER IS NOT NULL AND TRIM(SKU_NUMBER) != '',
    SKU_NUMBER,
    NULL
  )) AS distinct_sku_count,
  COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.all_CH_data`;

-- SKU groups with more than one distinct START_DATE (review before UPDATE)
SELECT
  SKU_NUMBER,
  COUNT(*) AS row_count,
  COUNT(DISTINCT START_DATE) AS distinct_start_dates,
  MIN(START_DATE) AS original_start_date_to_apply,
  ARRAY_AGG(DISTINCT START_DATE IGNORE NULLS ORDER BY START_DATE) AS all_start_dates
FROM `cynetdatabase.rr_project_data.all_CH_data`
WHERE SKU_NUMBER IS NOT NULL
  AND TRIM(SKU_NUMBER) != ''
  AND START_DATE IS NOT NULL
GROUP BY SKU_NUMBER
HAVING COUNT(DISTINCT START_DATE) > 1
ORDER BY row_count DESC, SKU_NUMBER;

-- =============================================================================
-- Backfill
-- =============================================================================

UPDATE `cynetdatabase.rr_project_data.all_CH_data` AS t
SET ORIGINAL_START_DATE = orig.original_start_date
FROM (
  SELECT
    SKU_NUMBER,
    MIN(START_DATE) AS original_start_date
  FROM `cynetdatabase.rr_project_data.all_CH_data`
  WHERE SKU_NUMBER IS NOT NULL
    AND TRIM(SKU_NUMBER) != ''
    AND START_DATE IS NOT NULL
  GROUP BY SKU_NUMBER
) AS orig
WHERE t.SKU_NUMBER IS NOT NULL
  AND TRIM(t.SKU_NUMBER) != ''
  AND t.SKU_NUMBER = orig.SKU_NUMBER;

-- =============================================================================
-- Verification (run after UPDATE)
-- =============================================================================

-- keyed_still_wrong should be 0
SELECT
  'all_CH_data' AS table_name,
  COUNTIF(
    t.SKU_NUMBER IS NOT NULL
    AND TRIM(t.SKU_NUMBER) != ''
    AND t.START_DATE IS NOT NULL
    AND (
      t.ORIGINAL_START_DATE IS NULL
      OR t.ORIGINAL_START_DATE != orig.original_start_date
    )
  ) AS keyed_still_wrong,
  COUNTIF(
    t.SKU_NUMBER IS NOT NULL
    AND TRIM(t.SKU_NUMBER) != ''
    AND t.START_DATE IS NOT NULL
    AND t.ORIGINAL_START_DATE IS NOT NULL
    AND t.ORIGINAL_START_DATE != t.START_DATE
  ) AS rows_where_original_differs_from_row_start_date,
  COUNT(*) AS total
FROM `cynetdatabase.rr_project_data.all_CH_data` AS t
LEFT JOIN (
  SELECT
    SKU_NUMBER,
    MIN(START_DATE) AS original_start_date
  FROM `cynetdatabase.rr_project_data.all_CH_data`
  WHERE SKU_NUMBER IS NOT NULL
    AND TRIM(SKU_NUMBER) != ''
    AND START_DATE IS NOT NULL
  GROUP BY SKU_NUMBER
) AS orig
  ON t.SKU_NUMBER = orig.SKU_NUMBER;

-- Spot-check example SKU
SELECT
  SKU_NUMBER,
  PLACEMENT_ID,
  DEAL_SHEET_ID,
  START_DATE,
  ORIGINAL_START_DATE,
  PLACEMENT_STATUS,
  DEAL_TYPE,
  DATE_AND_TIME
FROM `cynetdatabase.rr_project_data.all_CH_data`
WHERE SKU_NUMBER = 'H13361_H13979'
ORDER BY START_DATE, DATE_AND_TIME;
