-- Cynet Health Canada — put the $70 NL weekly per diem on rows synced before the default existed.
--
-- WHY
-- Nexus's lodging_amount / meal_amount read 0 for Newfoundland, so every NL row was stored with
-- WEEKLY_PER_DIEM_NON_TAXED = 0 and its T4_PAY_RATE was short by 70 / 11.25 = 6.22/hr. The sync now
-- defaults NL to 70 (applyCanadaNlDefaultPerDiem in functions/src/canadaDerivedPlacementFields.js).
--
-- WHY THIS MUST RUN BEFORE THE NEXT CANADA SYNC
-- When Nexus sends no per diem, the sync keeps the STORED value, so a figure a user edits on the
-- RR-Dashboard is not overwritten (applyCanadaNlPerDiemCarryForward). The old 0s look exactly like a
-- typed 0 to it, so they would be kept forever. This script turns them into 70 once; after that
-- a 0 in the table can only be a deliberate edit.
--
-- SCOPE
--   ONLY CLIENT_STATE = 'NL' rows whose per diem is 0 or NULL. Health, locums, every other province
--   and any NL row already carrying a non-zero per diem are untouched.
--   Run it on cynet_health_canada_deal_sheet, then again with the table name swapped to
--   cynet_health_canada_ended_deal_sheet (same schema).
--
-- WHAT CHANGES (per row whose rate family is computable)
--   WEEKLY_PER_DIEM_NON_TAXED      0 -> 70
--   T4_PAY_RATE, FINAL_PAY_RATE    +6.22
--   FINAL_COST                     +6.41  (T4 * 1.03)
--   CALCULATED_MARGIN, GROSS_MARGIN go down by the same amounts
--   FINAL_BILL_RATE, MARGIN        unchanged
-- A row whose rate family cannot be computed (no pay rate, no hours/duration, FT / INTERNAL,
-- unrecognised payment type) only gets the per diem; its derived fields are left as they are.
--
-- The arithmetic is the SQL twin of computeCanadaT4PayRate / computeCanadaDerivedPlacementFields.
-- Keep the two in step. Each row is recomputed from its OWN columns, so every version of a placement
-- stays internally consistent.


-- ---------------------------------------------------------------------------
-- STEP 1 — preview. Sanity-check a few rows by hand (SKU CH1423 should land on 76.26).
-- ---------------------------------------------------------------------------
WITH nl AS (
  SELECT
    *,
    CASE REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '')
      WHEN '' THEN 1.04 * 1.1672
      WHEN 'T4' THEN 1.04 * 1.1672
      WHEN 'T4A' THEN 1.0254
      WHEN 'INC' THEN 1.0254
      WHEN 'T4A/INC' THEN 1.0254
      WHEN 'T4AINC' THEN 1.0254
    END AS burden
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE CLIENT_STATE = 'NL'
    AND IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) = 0
)
SELECT
  PLACEMENT_ID, SKU_NUMBER, CANDIDATE_NAME, PAYMENT_TYPE, PAY_RATE,
  WEEKLY_PER_DIEM_NON_TAXED AS old_per_diem,
  T4_PAY_RATE AS old_t4_pay_rate,
  ROUND((PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * burden
        + 70 / 11.25, 2) AS new_t4_pay_rate,
  CALCULATED_MARGIN AS old_calculated_margin
FROM nl
WHERE burden IS NOT NULL
  AND UPPER(TRIM(IFNULL(PLACEMENT_TYPE, ''))) NOT IN ('FT', 'INTERNAL', '')
  AND PAY_RATE IS NOT NULL
  AND IFNULL(SCHEDULE_HOURS_1, 0) != 0
  AND IFNULL(PROJECT_DURATION, 0) != 0
ORDER BY PLACEMENT_ID;


-- ---------------------------------------------------------------------------
-- STEP 2 — recompute the rate family for the computable rows, with 70 in the per diem term.
-- Runs BEFORE step 3 because its WHERE clause selects on the old 0 per diem.
-- ---------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET
  T4_PAY_RATE       = ROUND((PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
                        * IF(REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '') IN ('', 'T4'),
                             1.04 * 1.1672, 1.0254)
                        + 70 / 11.25, 2),
  FINAL_PAY_RATE    = ROUND((PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
                        * IF(REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '') IN ('', 'T4'),
                             1.04 * 1.1672, 1.0254)
                        + 70 / 11.25, 2),
  FINAL_COST        = ROUND(ROUND((PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
                        * IF(REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '') IN ('', 'T4'),
                             1.04 * 1.1672, 1.0254)
                        + 70 / 11.25, 2) * 1.03, 2),
  CALCULATED_MARGIN = IF(FINAL_BILL_RATE IS NULL, NULL, ROUND(FINAL_BILL_RATE - ROUND(ROUND(
                        (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
                        * IF(REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '') IN ('', 'T4'),
                             1.04 * 1.1672, 1.0254)
                        + 70 / 11.25, 2) * 1.03, 2), 2)),
  GROSS_MARGIN      = IF(FINAL_BILL_RATE IS NULL, NULL, ROUND(FINAL_BILL_RATE - ROUND(
                        (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
                        * IF(REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '') IN ('', 'T4'),
                             1.04 * 1.1672, 1.0254)
                        + 70 / 11.25, 2), 2))
WHERE CLIENT_STATE = 'NL'
  AND IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) = 0
  AND REGEXP_REPLACE(UPPER(TRIM(IFNULL(PAYMENT_TYPE, ''))), r'[\s_]', '')
        IN ('', 'T4', 'T4A', 'INC', 'T4A/INC', 'T4AINC')
  AND UPPER(TRIM(IFNULL(PLACEMENT_TYPE, ''))) NOT IN ('FT', 'INTERNAL', '')
  AND PAY_RATE IS NOT NULL
  AND IFNULL(SCHEDULE_HOURS_1, 0) != 0
  AND IFNULL(PROJECT_DURATION, 0) != 0;


-- ---------------------------------------------------------------------------
-- STEP 3 — the per diem itself, on every NL row still at 0 / NULL.
-- ---------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET WEEKLY_PER_DIEM_NON_TAXED = 70
WHERE CLIENT_STATE = 'NL'
  AND IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) = 0;


-- ---------------------------------------------------------------------------
-- STEP 4 — verify. Both counts should be 0.
-- ---------------------------------------------------------------------------
-- SELECT
--   COUNTIF(IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) = 0) AS nl_still_zero,
--   COUNTIF(T4_PAY_RATE IS NOT NULL AND UPPER(TRIM(PAYMENT_TYPE)) = 'T4'
--           AND ABS(T4_PAY_RATE - ROUND(
--             (PAY_RATE + IFNULL(ADDITIONAL_BONUS,0)/(SCHEDULE_HOURS_1*PROJECT_DURATION)) * (1.04*1.1672)
--             + WEEKLY_PER_DIEM_NON_TAXED/11.25, 2)) > 0.01) AS t4_off
-- FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
-- WHERE CLIENT_STATE = 'NL';
