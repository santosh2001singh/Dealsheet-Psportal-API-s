-- START_DATE swap (Plan A), Cynet Health deal sheet + Health run-rate. See functions/src/startDateSwap.js.
--
--   START_DATE           <- INITIAL_START_DATE (contract's original start)
--   EXTENSION_START_DATE <- the placement's own start (old START_DATE) on extensions and re-booked DEALs,
--                           blank on fresh DEALs
--   INITIAL_START_DATE, EXTENSION_DATE: untouched
--   Rows whose INITIAL_START_DATE is blank or later than START_DATE keep START_DATE (bad data, listed
--   by the preview below); their EXTENSION_START_DATE still gets the own start on extensions.
--
-- Scope: every row of cynet_health_deal_sheet; all_CH_data_runrate only where PLACEMENT_ID IS NOT NULL
-- (PLACEMENT_ID NULL = data-team rows, never touched). Ended / Canada / Locums tables: not touched.
--
-- Run ONLY while the sync triggers are off, and deploy the new code before they turn back on.
--
-- Rerun-safe: the UPDATEs compute every value from the BACKUP (old format), never from the live
-- table, so running them twice writes the same values. The backup CREATE fails if the table exists,
-- so a second run can never overwrite the backup with already-swapped data.

-- ============================================================================================
-- 0) BACKUP (run once)
-- ============================================================================================
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate` AS
SELECT * FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`;

-- ============================================================================================
-- 1) PREVIEW (read-only). Expected on 2026-11-19: deal sheet 5,368 START changes,
--    runrate 565 START changes, placement_start_broken = 0 on both.
-- ============================================================================================
WITH src AS (
  SELECT 'deal_sheet' AS t, ID, PLACEMENT_ID, DEAL_TYPE, START_DATE, INITIAL_START_DATE, EXTENSION_START_DATE
  FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet`
  UNION ALL
  SELECT 'runrate', ID, PLACEMENT_ID, DEAL_TYPE, START_DATE, INITIAL_START_DATE, EXTENSION_START_DATE
  FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate`
  WHERE PLACEMENT_ID IS NOT NULL
),
calc AS (
  SELECT *,
    (INITIAL_START_DATE IS NOT NULL AND START_DATE IS NOT NULL AND INITIAL_START_DATE <= START_DATE) AS ok,
    STRPOS(UPPER(IFNULL(DEAL_TYPE, '')), 'EXTENSION') > 0 AS is_ext
  FROM src
),
swapped AS (
  SELECT *,
    IF(ok, INITIAL_START_DATE, START_DATE) AS new_start,
    IF(START_DATE IS NULL, EXTENSION_START_DATE,
       IF(is_ext OR (ok AND INITIAL_START_DATE < START_DATE), START_DATE, NULL)) AS new_ext
  FROM calc
)
SELECT t,
  COUNT(*) AS rows_in_scope,
  COUNTIF(new_start IS DISTINCT FROM START_DATE) AS start_changes,
  COUNTIF(new_ext IS DISTINCT FROM EXTENSION_START_DATE) AS ext_changes,
  COUNTIF(NOT ok) AS kept_bad_or_missing_initial,
  COUNTIF(COALESCE(new_ext, new_start) IS DISTINCT FROM START_DATE) AS placement_start_broken
FROM swapped
GROUP BY t;

-- ============================================================================================
-- 2) SWAP, both tables in one transaction
-- ============================================================================================
BEGIN TRANSACTION;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
SET
  START_DATE = IF(b.INITIAL_START_DATE IS NOT NULL AND b.INITIAL_START_DATE <= b.START_DATE,
                  b.INITIAL_START_DATE, b.START_DATE),
  EXTENSION_START_DATE = IF(
    STRPOS(UPPER(IFNULL(b.DEAL_TYPE, '')), 'EXTENSION') > 0
      OR (b.INITIAL_START_DATE IS NOT NULL AND b.INITIAL_START_DATE < b.START_DATE),
    b.START_DATE, CAST(NULL AS DATE))
FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet` b
WHERE t.ID = b.ID
  AND b.START_DATE IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` t
SET
  START_DATE = IF(b.INITIAL_START_DATE IS NOT NULL AND b.INITIAL_START_DATE <= b.START_DATE,
                  b.INITIAL_START_DATE, b.START_DATE),
  EXTENSION_START_DATE = IF(
    STRPOS(UPPER(IFNULL(b.DEAL_TYPE, '')), 'EXTENSION') > 0
      OR (b.INITIAL_START_DATE IS NOT NULL AND b.INITIAL_START_DATE < b.START_DATE),
    b.START_DATE, CAST(NULL AS DATE))
FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate` b
WHERE t.ID = b.ID
  AND b.PLACEMENT_ID IS NOT NULL
  AND b.START_DATE IS NOT NULL;

COMMIT TRANSACTION;

-- ============================================================================================
-- 3) VERIFY (read-only). Every number must be 0.
-- ============================================================================================
SELECT 'deal_sheet' AS t,
  COUNTIF(IF(n.PLACEMENT_ID IS NULL, n.START_DATE, COALESCE(n.EXTENSION_START_DATE, n.START_DATE))
          IS DISTINCT FROM b.START_DATE) AS placement_start_broken,
  COUNTIF(n.INITIAL_START_DATE IS DISTINCT FROM b.INITIAL_START_DATE) AS initial_changed,
  COUNTIF(n.EXTENSION_DATE IS DISTINCT FROM b.EXTENSION_DATE) AS extension_date_changed,
  COUNTIF(n.ID IS NULL) + COUNTIF(b.ID IS NULL) AS row_mismatch,
  COUNTIF(n.INITIAL_START_DATE IS NOT NULL AND n.INITIAL_START_DATE <= b.START_DATE
          AND n.START_DATE IS DISTINCT FROM n.INITIAL_START_DATE) AS start_not_initial
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` n
FULL JOIN `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet` b USING (ID)
UNION ALL
SELECT 'runrate (ours)',
  COUNTIF(IF(n.PLACEMENT_ID IS NULL, n.START_DATE, COALESCE(n.EXTENSION_START_DATE, n.START_DATE))
          IS DISTINCT FROM b.START_DATE),
  COUNTIF(n.INITIAL_START_DATE IS DISTINCT FROM b.INITIAL_START_DATE),
  COUNTIF(n.EXTENSION_DATE IS DISTINCT FROM b.EXTENSION_DATE),
  COUNTIF(n.ID IS NULL) + COUNTIF(b.ID IS NULL),
  COUNTIF(n.INITIAL_START_DATE IS NOT NULL AND n.INITIAL_START_DATE <= b.START_DATE
          AND n.START_DATE IS DISTINCT FROM n.INITIAL_START_DATE)
FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` n
FULL JOIN `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate` b USING (ID)
WHERE COALESCE(b.PLACEMENT_ID, n.PLACEMENT_ID) IS NOT NULL
UNION ALL
-- Data-team rows: START_DATE and EXTENSION_START_DATE byte-for-byte unchanged.
SELECT 'runrate (data team)',
  COUNTIF(n.START_DATE IS DISTINCT FROM b.START_DATE),
  COUNTIF(n.EXTENSION_START_DATE IS DISTINCT FROM b.EXTENSION_START_DATE),
  COUNTIF(n.INITIAL_START_DATE IS DISTINCT FROM b.INITIAL_START_DATE),
  COUNTIF(n.ID IS NULL) + COUNTIF(b.ID IS NULL),
  0
FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` n
FULL JOIN `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate` b USING (ID)
WHERE COALESCE(b.PLACEMENT_ID, n.PLACEMENT_ID) IS NULL;

-- ============================================================================================
-- ROLLBACK (only if needed): put the two date columns back from the backup.
-- ============================================================================================
-- UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
-- SET START_DATE = b.START_DATE, EXTENSION_START_DATE = b.EXTENSION_START_DATE
-- FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet` b WHERE t.ID = b.ID;
-- UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` t
-- SET START_DATE = b.START_DATE, EXTENSION_START_DATE = b.EXTENSION_START_DATE
-- FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_runrate` b WHERE t.ID = b.ID;
