-- Cynet Health Canada: margin mismatches between our deal sheet and the run-rate table, WITH the reason.
--
-- Active candidates only: placements whose LATEST deal sheet version is BOOKED or STARTED.
--
-- One row per placement (its LATEST deal sheet version), matched to ONE run-rate row, the same way
-- the sync matches it:
--   CANDIDATE_ID + FACILITY_NAME + PARENT_CLIENT_NAME
--   + any one of the deal row's START / END / TENTATIVE_END dates inside the run-rate window
--     (START_DATE .. COALESCE(END_DATE, TENTATIVE_END_DATE))
-- When more than one run-rate row qualifies, the one whose START_DATE is closest wins.
--
-- Compared (the sheet's own names in brackets):
--   CALCULATED_MARGIN [MARGIN]       = FINAL_BILL_RATE - FINAL_COST
--   GROSS_MARGIN      [GROSS MARGIN] = FINAL_BILL_RATE - FINAL_PAY_RATE
-- MARGIN is NOT compared: ours is Nexus hourly_revenue, the run-rate side is empty.
--
-- `reason` lists every INPUT that differs, in the order it moves the margin:
--   PAYMENT_TYPE (T4 vs T4A = a different loading), CLIENT_STATE (a different province loading),
--   PAY_RATE, BILL_RATE, CLIENT_MSP_FEE, ADDITIONAL_BONUS, then GUARANTEED_HOURS / WEEKS (these only
--   matter when there is a bonus to spread) and the NL weekly per diem.
-- When every input agrees and the margin still differs, the difference is in the FORMULA, and
-- `reason` says which step: the loading (T4 / pay rate), FINAL_COST (x 1.03) or FINAL_BILL_RATE.
-- A null margin on our side names why we could not compute one.
--
-- Tolerance: 0.01 (cents), so float noise is not reported.


-- ---------------------------------------------------------------------------
-- STEP 1 — summary: how many mismatch, and the main reason for each.
-- ---------------------------------------------------------------------------
WITH
deal AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
    WHERE PLACEMENT_ID IS NOT NULL
  ) WHERE rn = 1
    -- Active placements only. Filtered on the LATEST version, so a placement that has since ended
    -- drops out even though older versions of it were STARTED.
    AND UPPER(TRIM(IFNULL(PLACEMENT_STATUS, ''))) IN ('BOOKED', 'STARTED')
),
matched AS (
  SELECT * EXCEPT(pick) FROM (
    SELECT
      d.PLACEMENT_ID, d.DEAL_SHEET_ID, d.CANDIDATE_NAME, d.DEAL_TYPE, d.PLACEMENT_STATUS,
      d.SKU_NUMBER AS deal_sku, r.SKU_NUMBER AS rr_sku,
      d.START_DATE AS deal_start, r.START_DATE AS rr_start,
      d.CLIENT_STATE AS deal_state, r.CLIENT_STATE AS rr_state,
      REGEXP_REPLACE(UPPER(TRIM(IFNULL(d.PAYMENT_TYPE, ''))), r'[\s_]', '') AS deal_pay_type,
      REGEXP_REPLACE(UPPER(TRIM(IFNULL(r.PAYMENT_TYPE, ''))), r'[\s_]', '') AS rr_pay_type,
      d.PLACEMENT_TYPE AS deal_placement_type,
      ROUND(d.PAY_RATE, 2) AS deal_pay, ROUND(r.PAY_RATE, 2) AS rr_pay,
      ROUND(d.BILL_RATE, 2) AS deal_bill, ROUND(r.BILL_RATE, 2) AS rr_bill,
      -- MSP fee is a fraction; guard the odd row that holds a percentage.
      ROUND(IF(d.CLIENT_MSP_FEE > 1, d.CLIENT_MSP_FEE / 100, IFNULL(d.CLIENT_MSP_FEE, 0)), 4) AS deal_fee,
      ROUND(IF(r.CLIENT_MSP_FEE > 1, r.CLIENT_MSP_FEE / 100, IFNULL(r.CLIENT_MSP_FEE, 0)), 4) AS rr_fee,
      ROUND(IFNULL(d.ADDITIONAL_BONUS, 0), 2) AS deal_bonus, ROUND(IFNULL(r.ADDITIONAL_BONUS, 0), 2) AS rr_bonus,
      d.SCHEDULE_HOURS_1 AS deal_hours, r.SCHEDULE_HOURS_1 AS rr_hours,
      d.PROJECT_DURATION AS deal_weeks, r.PROJECT_DURATION AS rr_weeks,
      ROUND(IFNULL(d.WEEKLY_PER_DIEM_NON_TAXED, 0), 2) AS deal_per_diem,
      ROUND(IFNULL(r.WEEKLY_PER_DIEM_NON_TAXED, 0), 2) AS rr_per_diem,
      ROUND(d.T4_PAY_RATE, 2) AS deal_t4, ROUND(r.T4_PAY_RATE, 2) AS rr_t4,
      ROUND(d.FINAL_PAY_RATE, 2) AS deal_final_pay, ROUND(r.FINAL_PAY_RATE, 2) AS rr_final_pay,
      ROUND(d.FINAL_COST, 2) AS deal_cost, ROUND(r.FINAL_COST, 2) AS rr_cost,
      ROUND(d.FINAL_BILL_RATE, 2) AS deal_final_bill, ROUND(r.FINAL_BILL_RATE, 2) AS rr_final_bill,
      ROUND(d.CALCULATED_MARGIN, 2) AS deal_margin, ROUND(r.CALCULATED_MARGIN, 2) AS rr_margin,
      ROUND(d.GROSS_MARGIN, 2) AS deal_gross, ROUND(r.GROSS_MARGIN, 2) AS rr_gross,
      ROW_NUMBER() OVER (
        PARTITION BY d.PLACEMENT_ID
        ORDER BY ABS(DATE_DIFF(d.START_DATE, r.START_DATE, DAY)), r.SKU_NUMBER
      ) AS pick
    FROM deal d
    JOIN `cynetdatabase.rr_project_data.all_Health_Canada_data_Runrate` r
      ON  CAST(d.CANDIDATE_ID AS STRING)    = CAST(r.CANDIDATE_ID AS STRING)
      AND LOWER(TRIM(d.FACILITY_NAME))      = LOWER(TRIM(r.FACILITY_NAME))
      AND LOWER(TRIM(d.PARENT_CLIENT_NAME)) = LOWER(TRIM(r.PARENT_CLIENT_NAME))
      AND (
           d.START_DATE         BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
        OR d.END_DATE           BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
        OR d.TENTATIVE_END_DATE BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
      )
  ) WHERE pick = 1
),
flags AS (
  SELECT
    *,
    -- "a and b differ": beyond a cent, or one side null and the other not.
    (ABS(IFNULL(deal_margin, 0) - IFNULL(rr_margin, 0)) > 0.01 OR (deal_margin IS NULL) != (rr_margin IS NULL)) AS margin_differs,
    (ABS(IFNULL(deal_gross, 0) - IFNULL(rr_gross, 0)) > 0.01 OR (deal_gross IS NULL) != (rr_gross IS NULL)) AS gross_differs,
    -- Canada collapses T4A / INC / T4A-INC to one loading, so compare them as one type.
    IF(deal_pay_type IN ('T4A', 'INC', 'T4A/INC', 'T4AINC'), 'T4A', IF(deal_pay_type = '', 'T4', deal_pay_type))
      != IF(rr_pay_type IN ('T4A', 'INC', 'T4A/INC', 'T4AINC'), 'T4A', IF(rr_pay_type = '', 'T4', rr_pay_type)) AS type_differs,
    UPPER(TRIM(IFNULL(deal_state, ''))) != UPPER(TRIM(IFNULL(rr_state, ''))) AS state_differs,
    ABS(IFNULL(deal_pay, 0) - IFNULL(rr_pay, 0)) > 0.01 AS pay_differs,
    ABS(IFNULL(deal_bill, 0) - IFNULL(rr_bill, 0)) > 0.01 AS bill_differs,
    ABS(deal_fee - rr_fee) > 0.0001 AS fee_differs,
    ABS(deal_bonus - rr_bonus) > 0.01 AS bonus_differs,
    -- Hours / weeks only spread the bonus, so they move the margin only when a bonus exists.
    (deal_bonus != 0 OR rr_bonus != 0) AND IFNULL(deal_hours, -1) != IFNULL(rr_hours, -1) AS hours_differs,
    (deal_bonus != 0 OR rr_bonus != 0) AND IFNULL(deal_weeks, -1) != IFNULL(rr_weeks, -1) AS weeks_differs,
    -- Per diem only enters the NL loading.
    UPPER(TRIM(IFNULL(deal_state, ''))) = 'NL' AND ABS(deal_per_diem - rr_per_diem) > 0.01 AS per_diem_differs
  FROM matched
),
explained AS (
  SELECT
    *,
    ARRAY_TO_STRING(ARRAY(
      SELECT x FROM UNNEST([
        -- Why OUR margin is empty, when it is.
        IF(deal_margin IS NULL AND rr_margin IS NOT NULL,
          CONCAT('OUR MARGIN IS NULL: ',
            CASE
              WHEN deal_pay IS NULL THEN 'no PAY_RATE'
              WHEN deal_bill IS NULL OR deal_bill = 0 THEN 'no BILL_RATE'
              WHEN deal_hours IS NULL OR deal_hours = 0 THEN 'no GUARANTEED_HOURS'
              WHEN deal_weeks IS NULL OR deal_weeks = 0 THEN 'no PROJECT_DURATION'
              WHEN deal_pay_type NOT IN ('', 'T4', 'T4A', 'INC', 'T4A/INC', 'T4AINC')
                THEN CONCAT('PAYMENT_TYPE "', deal_pay_type, '" is not T4/T4A')
              WHEN deal_pay_type IN ('T4A', 'INC', 'T4A/INC', 'T4AINC')
                   AND UPPER(TRIM(deal_state)) IN ('AB', 'MB', 'SK', 'QC', 'NB')
                THEN CONCAT('T4A is "No business" in ', deal_state)
              ELSE 'rate chain not computed (check the row)'
            END), NULL),
        IF(rr_margin IS NULL AND deal_margin IS NOT NULL, 'RUN-RATE MARGIN IS NULL', NULL),
        IF(type_differs, CONCAT('PAYMENT_TYPE: ours ', deal_pay_type, ' vs run-rate ', rr_pay_type), NULL),
        IF(state_differs, CONCAT('CLIENT_STATE: ours ', IFNULL(deal_state, 'null'), ' vs run-rate ', IFNULL(rr_state, 'null')), NULL),
        IF(pay_differs, CONCAT('PAY_RATE: ours ', IFNULL(CAST(deal_pay AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_pay AS STRING), 'null')), NULL),
        IF(bill_differs, CONCAT('BILL_RATE: ours ', IFNULL(CAST(deal_bill AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_bill AS STRING), 'null')), NULL),
        IF(fee_differs, CONCAT('CLIENT_MSP_FEE: ours ', IFNULL(CAST(deal_fee AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_fee AS STRING), 'null')), NULL),
        IF(bonus_differs, CONCAT('ADDITIONAL_BONUS: ours ', IFNULL(CAST(deal_bonus AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_bonus AS STRING), 'null')), NULL),
        IF(hours_differs, CONCAT('GUARANTEED_HOURS: ours ', IFNULL(CAST(deal_hours AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_hours AS STRING), 'null')), NULL),
        IF(weeks_differs, CONCAT('PROJECT_DURATION: ours ', IFNULL(CAST(deal_weeks AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_weeks AS STRING), 'null')), NULL),
        IF(per_diem_differs, CONCAT('WEEKLY_PER_DIEM (NL): ours ', IFNULL(CAST(deal_per_diem AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_per_diem AS STRING), 'null')), NULL),
        -- Every input agrees -> the formula differs. Name the step.
        IF(NOT (type_differs OR state_differs OR pay_differs OR bill_differs OR fee_differs OR bonus_differs
                OR hours_differs OR weeks_differs OR per_diem_differs)
           AND deal_margin IS NOT NULL AND rr_margin IS NOT NULL,
          CONCAT('SAME INPUTS, FORMULA DIFFERS at ',
            CASE
              WHEN ABS(IFNULL(deal_t4, 0) - IFNULL(rr_t4, 0)) > 0.01
                THEN CONCAT('the loading: ours ', CAST(ROUND(SAFE_DIVIDE(deal_t4, deal_pay), 4) AS STRING),
                            ' vs run-rate ', CAST(ROUND(SAFE_DIVIDE(rr_t4, rr_pay), 4) AS STRING), ' (T4 / pay rate)')
              WHEN ABS(IFNULL(deal_cost, 0) - IFNULL(rr_cost, 0)) > 0.01
                THEN CONCAT('FINAL_COST: ours ', IFNULL(CAST(deal_cost AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_cost AS STRING), 'null'),
                            ' (ours = final pay x 1.03)')
              WHEN ABS(IFNULL(deal_final_bill, 0) - IFNULL(rr_final_bill, 0)) > 0.01
                THEN CONCAT('FINAL_BILL_RATE: ours ', IFNULL(CAST(deal_final_bill AS STRING), 'null'), ' vs run-rate ',
                            IFNULL(CAST(rr_final_bill AS STRING), 'null'), ' (ours = bill x (1 - fee); BC 4% uplift?)')
              ELSE 'the margin itself (inputs and rates agree)'
            END), NULL)
      ]) AS x WHERE x IS NOT NULL
    ), ' | ') AS reason
  FROM flags
)
SELECT
  -- The first reason listed is the biggest driver; bucket on it.
  SPLIT(reason, ':')[SAFE_OFFSET(0)] AS main_reason,
  COUNT(*) AS rows_mismatched,
  ROUND(AVG(ABS(IFNULL(deal_margin, 0) - IFNULL(rr_margin, 0))), 2) AS avg_abs_margin_gap
FROM explained
WHERE margin_differs OR gross_differs
GROUP BY main_reason
UNION ALL
SELECT '== TOTAL matched placements', COUNT(*), NULL FROM explained
UNION ALL
SELECT '== TOTAL margin mismatches', COUNTIF(margin_differs OR gross_differs), NULL FROM explained
ORDER BY rows_mismatched DESC;


-- ---------------------------------------------------------------------------
-- STEP 2 — the row list. Same CTEs as STEP 1 (deal, matched, flags, explained); paste them above
-- this SELECT, or replace STEP 1's final SELECT with this one.
-- ---------------------------------------------------------------------------
-- SELECT
--   reason,
--   PLACEMENT_ID, CANDIDATE_NAME, deal_sku, rr_sku, DEAL_TYPE, PLACEMENT_STATUS, deal_state,
--   deal_margin, rr_margin, ROUND(deal_margin - rr_margin, 2) AS margin_gap,
--   deal_gross, rr_gross, ROUND(deal_gross - rr_gross, 2) AS gross_gap,
--   deal_pay_type, rr_pay_type, deal_pay, rr_pay, deal_bill, rr_bill, deal_fee, rr_fee,
--   deal_bonus, rr_bonus, deal_hours, rr_hours, deal_weeks, rr_weeks, deal_per_diem, rr_per_diem,
--   deal_t4, rr_t4, deal_cost, rr_cost, deal_final_bill, rr_final_bill
-- FROM explained
-- WHERE margin_differs OR gross_differs
-- ORDER BY ABS(IFNULL(deal_margin, 0) - IFNULL(rr_margin, 0)) DESC;
