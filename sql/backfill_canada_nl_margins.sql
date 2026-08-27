-- Cynet Health Canada — recompute the NEWFOUNDLAND (NL) rate family after the burden change.
--
-- WHY
-- Finance's email states NL's loading two ways that do not agree:
--   table : "Final Loading Cost = 20.72%"             -> 1.2072
--   note  : "Pay Rate + 4% Vacation pay + 16.72%"     -> 1.04 * 1.1672 = 1.213888  (21.39%)
-- The code now follows the NOTE (1.213888), matching the legacy run-rate sheet. Rows synced before
-- that change carry the old 1.2072 figure, so they need recomputing.
--
-- SCOPE
--   ONLY cynet_health_canada_deal_sheet, and within it ONLY CLIENT_STATE = 'NL'.
--   Health, locums and every other province are untouched. NL T4A is untouched (its 1.0254 corp
--   cost did not change).
--
-- WHAT CHANGES  (111 rows at the time of writing; avg +0.50 on T4_PAY_RATE, max +0.64)
--   T4_PAY_RATE, FINAL_PAY_RATE   go up
--   FINAL_COST                     goes up   (T4 * 1.03)
--   CALCULATED_MARGIN              goes down (bill - cost)
--   GROSS_MARGIN                   goes down (bill - pay)
--   FINAL_BILL_RATE                unchanged (bill side does not depend on the burden)
--   MARGIN                         unchanged (Nexus hourly_revenue, never derived here)
--
-- The formula below is the SQL twin of computeCanadaT4PayRate / computeCanadaDerivedPlacementFields
-- in functions/src/canadaDerivedPlacementFields.js. Keep the two in step.


-- ---------------------------------------------------------------------------
-- STEP 1 — preview. Run this first and sanity-check a few rows by hand.
-- ---------------------------------------------------------------------------
WITH recalc AS (
  SELECT
    PLACEMENT_ID,
    CANDIDATE_NAME,
    PAYMENT_TYPE,
    PAY_RATE,
    SCHEDULE_HOURS_1,
    PROJECT_DURATION,
    WEEKLY_PER_DIEM_NON_TAXED,
    T4_PAY_RATE       AS old_t4_pay_rate,
    FINAL_COST        AS old_final_cost,
    CALCULATED_MARGIN AS old_calculated_margin,
    GROSS_MARGIN      AS old_gross_margin,
    -- (PAY_RATE + bonus / (hours * weeks)) * 1.213888  + per diem / 11.25
    ROUND(
      (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
        * (1.04 * 1.1672)
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25
    , 2) AS new_t4_pay_rate
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE CLIENT_STATE = 'NL'
    AND UPPER(TRIM(PAYMENT_TYPE)) = 'T4'
    AND PLACEMENT_TYPE NOT IN ('FT', 'INTERNAL')
    AND PAY_RATE IS NOT NULL
    AND SCHEDULE_HOURS_1 IS NOT NULL AND SCHEDULE_HOURS_1 != 0
    AND PROJECT_DURATION IS NOT NULL AND PROJECT_DURATION != 0
)
SELECT
  PLACEMENT_ID, CANDIDATE_NAME, PAY_RATE, WEEKLY_PER_DIEM_NON_TAXED,
  old_t4_pay_rate, new_t4_pay_rate,
  ROUND(new_t4_pay_rate - old_t4_pay_rate, 2)                      AS t4_delta,
  old_final_cost,        ROUND(new_t4_pay_rate * 1.03, 2)          AS new_final_cost,
  old_calculated_margin, old_gross_margin
FROM recalc
ORDER BY ABS(new_t4_pay_rate - old_t4_pay_rate) DESC;


-- ---------------------------------------------------------------------------
-- STEP 2 — the update.
--
-- Recomputes the whole chain from PAY_RATE so the row is internally consistent, rather than nudging
-- the stored numbers. FINAL_BILL_RATE is recomputed from BILL_RATE and the MSP fee too, so a row
-- whose bill side was already correct simply lands on the same value.
--
-- CALCULATED_MARGIN / GROSS_MARGIN are 0 for FT placements in the code; those rows are excluded by
-- the WHERE clause, so the arithmetic below always applies.
-- ---------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` d
SET
  T4_PAY_RATE       = c.new_t4,
  FINAL_PAY_RATE    = c.new_t4,
  FINAL_COST        = ROUND(c.new_t4 * 1.03, 2),
  FINAL_BILL_RATE   = c.new_bill,
  CALCULATED_MARGIN = ROUND(c.new_bill - ROUND(c.new_t4 * 1.03, 2), 2),
  GROSS_MARGIN      = ROUND(c.new_bill - c.new_t4, 2)
FROM (
  SELECT
    PLACEMENT_ID,
    ROUND(
      (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION))
        * (1.04 * 1.1672)
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25
    , 2) AS new_t4,
    -- MSP fee is stored as a fraction (0.018 = 1.8%); guard the odd row that holds a percentage.
    ROUND(BILL_RATE * (1 - LEAST(GREATEST(IFNULL(
      IF(CLIENT_MSP_FEE > 1, CLIENT_MSP_FEE / 100, CLIENT_MSP_FEE), 0), 0), 1)), 2) AS new_bill
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE CLIENT_STATE = 'NL'
    AND UPPER(TRIM(PAYMENT_TYPE)) = 'T4'
    AND PLACEMENT_TYPE NOT IN ('FT', 'INTERNAL')
    AND PAY_RATE IS NOT NULL
    AND BILL_RATE IS NOT NULL AND BILL_RATE != 0
    AND SCHEDULE_HOURS_1 IS NOT NULL AND SCHEDULE_HOURS_1 != 0
    AND PROJECT_DURATION IS NOT NULL AND PROJECT_DURATION != 0
) c
WHERE d.PLACEMENT_ID = c.PLACEMENT_ID
  AND d.CLIENT_STATE = 'NL';


-- ---------------------------------------------------------------------------
-- STEP 3 — verify. Every NL T4 row should now reproduce the 1.213888 loading.
-- ---------------------------------------------------------------------------
-- SELECT
--   COUNT(*) AS nl_t4_rows,
--   COUNTIF(ABS(T4_PAY_RATE - ROUND(
--     (PAY_RATE + IFNULL(ADDITIONAL_BONUS,0)/(SCHEDULE_HOURS_1*PROJECT_DURATION)) * (1.04*1.1672)
--     + IFNULL(WEEKLY_PER_DIEM_NON_TAXED,0)/11.25, 2)) > 0.01) AS still_wrong,
--   COUNTIF(ABS(CALCULATED_MARGIN - ROUND(FINAL_BILL_RATE - FINAL_COST, 2)) > 0.01) AS calc_margin_off,
--   COUNTIF(ABS(GROSS_MARGIN      - ROUND(FINAL_BILL_RATE - FINAL_PAY_RATE, 2)) > 0.01) AS gross_margin_off
-- FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
-- WHERE CLIENT_STATE = 'NL' AND UPPER(TRIM(PAYMENT_TYPE)) = 'T4'
--   AND PLACEMENT_TYPE NOT IN ('FT','INTERNAL');
--
-- Confirm nothing outside NL moved (row counts should be unchanged from before the run):
-- SELECT CLIENT_STATE, COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
-- GROUP BY 1 ORDER BY 1;
