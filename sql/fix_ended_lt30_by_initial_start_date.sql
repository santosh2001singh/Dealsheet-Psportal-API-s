-- ENDED vs ENDED<30 re-derived from INITIAL_START_DATE -> END_DATE (business rule, Oct 2026).
--
-- Rule: DATE_DIFF(END_DATE, COALESCE(INITIAL_START_DATE, START_DATE), DAY) < 30 -> 'ENDED<30',
-- otherwise 'ENDED'. The submittal's "Early Term" status no longer decides it (it used to:
-- Early Term + job start -> submittal end < 30). Code fixed in
-- columnMappings.applyEndedPlacementStatusByInitialStart; this repairs rows written before.
--
-- Only rows already ENDED / ENDED<30 with both dates present are touched. Every version of a
-- placement is recomputed from its own dates, so the history agrees with the rule.
-- Run STEP 1 first, check the counts, then STEP 2 per table.


-- STEP 1 - preview: rows whose status flips (all three active tables).
WITH all_rows AS (
  SELECT 'cynet_health_deal_sheet' AS tbl, DEAL_SHEET_ID, PLACEMENT_ID, CANDIDATE_NAME, DEAL_TYPE,
         CONTRACT_ID, START_DATE, INITIAL_START_DATE, END_DATE, PLACEMENT_STATUS, LAST_UPDATED
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  UNION ALL
  SELECT 'cynet_health_canada_deal_sheet', DEAL_SHEET_ID, PLACEMENT_ID, CANDIDATE_NAME, DEAL_TYPE,
         CONTRACT_ID, START_DATE, INITIAL_START_DATE, END_DATE, PLACEMENT_STATUS, LAST_UPDATED
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  UNION ALL
  SELECT 'cynet_locums_deal_sheet', DEAL_SHEET_ID, PLACEMENT_ID, CANDIDATE_NAME, DEAL_TYPE,
         CONTRACT_ID, START_DATE, INITIAL_START_DATE, END_DATE, PLACEMENT_STATUS, LAST_UPDATED
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
),
calc AS (
  SELECT *,
         DATE_DIFF(SAFE_CAST(END_DATE AS DATE),
                   SAFE_CAST(COALESCE(INITIAL_START_DATE, START_DATE) AS DATE), DAY) AS days_from_initial
  FROM all_rows
  WHERE UPPER(TRIM(PLACEMENT_STATUS)) IN ('ENDED', 'ENDED<30')
),
latest AS (
  SELECT *, IF(days_from_initial < 30, 'ENDED<30', 'ENDED') AS new_status
  FROM calc
  WHERE days_from_initial IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY tbl, DEAL_SHEET_ID, PLACEMENT_ID ORDER BY LAST_UPDATED DESC) = 1
)
SELECT tbl, CANDIDATE_NAME, DEAL_SHEET_ID, PLACEMENT_ID, DEAL_TYPE, CONTRACT_ID,
       INITIAL_START_DATE, START_DATE, END_DATE, days_from_initial,
       PLACEMENT_STATUS AS current_status, new_status
FROM latest
WHERE UPPER(TRIM(PLACEMENT_STATUS)) != new_status
ORDER BY tbl, current_status, days_from_initial;


-- STEP 2 - fix (run once per table: cynet_health_deal_sheet, cynet_health_canada_deal_sheet,
-- cynet_locums_deal_sheet; same for the *_ended_deal_sheet tables if they should follow too).
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET PLACEMENT_STATUS = IF(
  DATE_DIFF(SAFE_CAST(END_DATE AS DATE),
            SAFE_CAST(COALESCE(INITIAL_START_DATE, START_DATE) AS DATE), DAY) < 30,
  'ENDED<30', 'ENDED')
WHERE UPPER(TRIM(PLACEMENT_STATUS)) IN ('ENDED', 'ENDED<30')
  AND DATE_DIFF(SAFE_CAST(END_DATE AS DATE),
                SAFE_CAST(COALESCE(INITIAL_START_DATE, START_DATE) AS DATE), DAY) IS NOT NULL
  AND UPPER(TRIM(PLACEMENT_STATUS)) != IF(
    DATE_DIFF(SAFE_CAST(END_DATE AS DATE),
              SAFE_CAST(COALESCE(INITIAL_START_DATE, START_DATE) AS DATE), DAY) < 30,
    'ENDED<30', 'ENDED');
