-- Cynet Locums: EVERY margin mismatch, one row per placement, with the reason in the last column.
--
-- Deal sheet: cynetdatabase.rr_project_data.cynet_locums_deal_sheet
-- Run-rate:   cynetdatabase.cynet_locum.lo_run_rate
--
-- Active candidates only: placements whose LATEST deal sheet version is BOOKED or STARTED.
--
-- Match is on SKU_NUMBER. lo_run_rate has no PLACEMENT_ID and one SKU can carry several rows
-- (extensions, re-bookings, even a different candidate on the same SKU), so among the run-rate rows
-- of that SKU the pick is: same candidate (CND_NEXUS_ID = CANDIDATE_ID) first, then the closest
-- START_DATE, then the closest PAY_RATE / BILL_RATE. rr_rows_for_sku says how many rows competed,
-- so an ambiguous pick is visible.
--
-- Column map (lo_run_rate -> deal sheet), same as load_all_locums_runrate_from_lo_run_rate.sql:
--   NET_MARGIN -> CALCULATED_MARGIN, GROSS_MARGIN -> GROSS_MARGIN, TYPE -> PAYMENT_TYPE,
--   GUARANTEED_HOURS -> SCHEDULE_HOURS_1, INITIAL_PROJ_IN_WK -> PROJECT_DURATION,
--   ORIENTATION_HOURS -> NBO_HOURS, WEEKLY_PER_DIEM -> WEEKLY_PER_DIEM_NON_TAXED.
--
-- Our formula (locumsDerivedPlacementFields.js):
--   FINAL_BILL_RATE   = BILL_RATE x (1 - MSP fee)
--   W2_PAY_RATE       = pay + (per diem + wallet) / hours + bonus / (hours x weeks)
--                       + orientation hrs x pay / (hours x weeks)      (blank type: x1.14 burden)
--   FINAL_PAY_RATE    = W2 x (1 + LOADING_COST_EXCEPTION) if set, else blank type x1.08,
--                       start < 2024-05-01 x1.00, else x1.09
--   FINAL_COST        = FINAL_PAY_RATE
--   CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_COST   (FT = 0)
--
-- reason: every input that differs, or, when all inputs agree, the formula step that differs
-- (W2_PAY_RATE / FINAL_PAY_RATE loading / FINAL_COST / FINAL_BILL_RATE).

WITH
deal AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
    WHERE PLACEMENT_ID IS NOT NULL
  ) WHERE rn = 1
    -- Active placements only, on the LATEST version.
    AND UPPER(TRIM(IFNULL(PLACEMENT_STATUS, ''))) IN ('BOOKED', 'STARTED')
    AND TRIM(IFNULL(SKU_NUMBER, '')) != ''
),
rr AS (
  SELECT *, COUNT(*) OVER (PARTITION BY TRIM(SKU_NUMBER)) AS rr_rows_for_sku
  FROM `cynetdatabase.cynet_locum.lo_run_rate`
  WHERE TRIM(IFNULL(SKU_NUMBER, '')) != ''
),
matched AS (
  SELECT * EXCEPT(pick) FROM (
    SELECT
      d.PLACEMENT_ID, d.DEAL_SHEET_ID, d.CANDIDATE_NAME, d.DEAL_TYPE, d.PLACEMENT_STATUS,
      r.ID AS rr_id, r.rr_rows_for_sku,
      CAST(d.CANDIDATE_ID AS STRING) = TRIM(r.CND_NEXUS_ID) AS same_candidate,
      r.CANDIDATE_NAME AS rr_candidate_name,
      d.SKU_NUMBER AS sku,
      d.START_DATE AS deal_start, r.START_DATE AS rr_start,
      d.PLACEMENT_TYPE AS deal_placement_type, r.PLACEMENT_TYPE AS rr_placement_type,
      d.PARENT_CLIENT_NAME AS deal_parent, r.PARENT_CLIENT_NAME AS rr_parent,
      UPPER(TRIM(IFNULL(d.PAYMENT_TYPE, ''))) AS deal_pay_type,
      UPPER(TRIM(IFNULL(r.TYPE, ''))) AS rr_pay_type,
      ROUND(d.PAY_RATE, 2) AS deal_pay, ROUND(r.PAY_RATE, 2) AS rr_pay,
      ROUND(d.BILL_RATE, 2) AS deal_bill, ROUND(r.BILL_RATE, 2) AS rr_bill,
      -- MSP fee is a fraction; guard the odd row that holds a percentage.
      ROUND(IF(d.CLIENT_MSP_FEE >= 1, d.CLIENT_MSP_FEE / 100, IFNULL(d.CLIENT_MSP_FEE, 0)), 4) AS deal_fee,
      ROUND(IF(r.CLIENT_MSP_FEE >= 1, r.CLIENT_MSP_FEE / 100, IFNULL(r.CLIENT_MSP_FEE, 0)), 4) AS rr_fee,
      ROUND(IFNULL(d.ADDITIONAL_BONUS, 0), 2) AS deal_bonus, ROUND(IFNULL(r.ADDITIONAL_BONUS, 0), 2) AS rr_bonus,
      ROUND(IFNULL(d.WEEKLY_PER_DIEM_NON_TAXED, 0), 2) AS deal_per_diem, ROUND(IFNULL(r.WEEKLY_PER_DIEM, 0), 2) AS rr_per_diem,
      ROUND(IFNULL(d.WEEKLY_WALLET_MONEY, 0), 2) AS deal_wallet, ROUND(IFNULL(r.WEEKLY_WALLET_MONEY, 0), 2) AS rr_wallet,
      ROUND(IFNULL(d.NBO_HOURS, 0), 2) AS deal_orient, ROUND(IFNULL(r.ORIENTATION_HOURS, 0), 2) AS rr_orient,
      d.SCHEDULE_HOURS_1 AS deal_hours, r.GUARANTEED_HOURS AS rr_hours,
      d.PROJECT_DURATION AS deal_weeks, CAST(r.INITIAL_PROJ_IN_WK AS FLOAT64) AS rr_weeks,
      d.LOADING_COST_EXCEPTION AS deal_loading_exc, r.LOADING_COST_EXCEPTION AS rr_loading_exc,
      ROUND(d.W2_PAY_RATE, 2) AS deal_w2, ROUND(r.W2_PAY_RATE, 2) AS rr_w2,
      ROUND(d.FINAL_PAY_RATE, 2) AS deal_final_pay, ROUND(r.FINAL_PAY_RATE, 2) AS rr_final_pay,
      ROUND(d.FINAL_COST, 2) AS deal_cost, ROUND(r.FINAL_COST, 2) AS rr_cost,
      ROUND(d.FINAL_BILL_RATE, 2) AS deal_final_bill, ROUND(r.FINAL_BILL_RATE, 2) AS rr_final_bill,
      ROUND(d.CALCULATED_MARGIN, 2) AS deal_margin, ROUND(r.NET_MARGIN, 2) AS rr_margin,
      ROUND(d.GROSS_MARGIN, 2) AS deal_gross, ROUND(r.GROSS_MARGIN, 2) AS rr_gross,
      ROW_NUMBER() OVER (
        PARTITION BY d.PLACEMENT_ID
        ORDER BY
          IF(CAST(d.CANDIDATE_ID AS STRING) = TRIM(r.CND_NEXUS_ID), 0, 1),
          ABS(IFNULL(DATE_DIFF(d.START_DATE, r.START_DATE, DAY), 99999)),
          ABS(IFNULL(d.PAY_RATE, 0) - IFNULL(r.PAY_RATE, 0)) + ABS(IFNULL(d.BILL_RATE, 0) - IFNULL(r.BILL_RATE, 0)),
          r.LAST_UPDATED DESC
      ) AS pick
    FROM deal d
    JOIN rr r ON TRIM(r.SKU_NUMBER) = TRIM(d.SKU_NUMBER)
  ) WHERE pick = 1
),
flags AS (
  SELECT
    *,
    -- "a and b differ": beyond a cent, or one side null and the other not.
    (ABS(IFNULL(deal_margin, 0) - IFNULL(rr_margin, 0)) > 0.01 OR (deal_margin IS NULL) != (rr_margin IS NULL)) AS margin_differs,
    (ABS(IFNULL(deal_gross, 0) - IFNULL(rr_gross, 0)) > 0.01 OR (deal_gross IS NULL) != (rr_gross IS NULL)) AS gross_differs,
    deal_pay_type != rr_pay_type AS type_differs,
    UPPER(TRIM(IFNULL(deal_placement_type, ''))) != UPPER(TRIM(IFNULL(rr_placement_type, ''))) AS ptype_differs,
    ABS(IFNULL(deal_pay, 0) - IFNULL(rr_pay, 0)) > 0.01 OR (deal_pay IS NULL) != (rr_pay IS NULL) AS pay_differs,
    ABS(IFNULL(deal_bill, 0) - IFNULL(rr_bill, 0)) > 0.01 OR (deal_bill IS NULL) != (rr_bill IS NULL) AS bill_differs,
    ABS(deal_fee - rr_fee) > 0.0001 AS fee_differs,
    ABS(deal_bonus - rr_bonus) > 0.01 AS bonus_differs,
    ABS(deal_per_diem - rr_per_diem) > 0.01 AS per_diem_differs,
    ABS(deal_wallet - rr_wallet) > 0.01 AS wallet_differs,
    ABS(deal_orient - rr_orient) > 0.01 AS orient_differs,
    -- Hours divide per diem / wallet / bonus / orientation; weeks divide bonus / orientation.
    -- They move the margin only when one of those is non-zero.
    (deal_per_diem + rr_per_diem + deal_wallet + rr_wallet + deal_bonus + rr_bonus + deal_orient + rr_orient) != 0
      AND IFNULL(deal_hours, 0) != IFNULL(rr_hours, 0) AS hours_differs,
    (deal_bonus + rr_bonus + deal_orient + rr_orient) != 0
      AND IFNULL(deal_weeks, 0) != IFNULL(rr_weeks, 0) AS weeks_differs,
    ABS(IFNULL(deal_loading_exc, -1) - IFNULL(rr_loading_exc, -1)) > 0.0001 AS loading_exc_differs,
    -- Start date only matters across the 2024-05-01 loading cut-over.
    (deal_start < DATE '2024-05-01') != (rr_start < DATE '2024-05-01') AS start_cutover_differs
  FROM matched
),
explained AS (
  SELECT
    *,
    ARRAY_TO_STRING(ARRAY(
      SELECT x FROM UNNEST([
        IF(NOT same_candidate, CONCAT('MATCH: run-rate row is a different candidate (', IFNULL(rr_candidate_name, 'null'), ')'), NULL),
        -- Why OUR margin is empty, when it is.
        IF(deal_margin IS NULL AND rr_margin IS NOT NULL,
          CONCAT('OUR MARGIN IS NULL: ',
            CASE
              WHEN deal_pay IS NULL OR deal_pay = 0 THEN 'no PAY_RATE (null / 0)'
              WHEN deal_bill IS NULL OR deal_bill = 0 THEN 'no BILL_RATE'
              WHEN deal_w2 IS NULL THEN 'W2_PAY_RATE not computed'
              WHEN deal_final_pay IS NULL THEN 'FINAL_PAY_RATE not computed'
              ELSE 'rate chain not computed (check the row)'
            END), NULL),
        IF(rr_margin IS NULL AND deal_margin IS NOT NULL, 'RUN-RATE MARGIN IS NULL', NULL),
        IF(type_differs, CONCAT('PAYMENT_TYPE: ours "', deal_pay_type, '" vs run-rate "', rr_pay_type, '"'), NULL),
        IF(ptype_differs, CONCAT('PLACEMENT_TYPE: ours ', IFNULL(deal_placement_type, 'null'), ' vs run-rate ', IFNULL(rr_placement_type, 'null')), NULL),
        IF(pay_differs, CONCAT('PAY_RATE: ours ', IFNULL(CAST(deal_pay AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_pay AS STRING), 'null')), NULL),
        IF(bill_differs, CONCAT('BILL_RATE: ours ', IFNULL(CAST(deal_bill AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_bill AS STRING), 'null')), NULL),
        IF(fee_differs, CONCAT('CLIENT_MSP_FEE: ours ', CAST(deal_fee AS STRING), ' vs run-rate ', CAST(rr_fee AS STRING)), NULL),
        IF(bonus_differs, CONCAT('ADDITIONAL_BONUS: ours ', CAST(deal_bonus AS STRING), ' vs run-rate ', CAST(rr_bonus AS STRING)), NULL),
        IF(per_diem_differs, CONCAT('WEEKLY_PER_DIEM: ours ', CAST(deal_per_diem AS STRING), ' vs run-rate ', CAST(rr_per_diem AS STRING)), NULL),
        IF(wallet_differs, CONCAT('WEEKLY_WALLET_MONEY: ours ', CAST(deal_wallet AS STRING), ' vs run-rate ', CAST(rr_wallet AS STRING)), NULL),
        IF(orient_differs, CONCAT('ORIENTATION_HOURS: ours ', CAST(deal_orient AS STRING), ' vs run-rate ', CAST(rr_orient AS STRING)), NULL),
        IF(hours_differs, CONCAT('GUARANTEED_HOURS: ours ', IFNULL(CAST(deal_hours AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_hours AS STRING), 'null')), NULL),
        IF(weeks_differs, CONCAT('PROJECT_DURATION: ours ', IFNULL(CAST(deal_weeks AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_weeks AS STRING), 'null')), NULL),
        IF(loading_exc_differs, CONCAT('LOADING_COST_EXCEPTION: ours ', IFNULL(CAST(deal_loading_exc AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_loading_exc AS STRING), 'null')), NULL),
        IF(start_cutover_differs, CONCAT('START_DATE across May-2024 loading cut-over: ours ', CAST(deal_start AS STRING), ' vs run-rate ', CAST(rr_start AS STRING)), NULL),
        -- Every input agrees -> the formula differs. Name the step.
        IF(NOT (type_differs OR ptype_differs OR pay_differs OR bill_differs OR fee_differs OR bonus_differs
                OR per_diem_differs OR wallet_differs OR orient_differs OR hours_differs OR weeks_differs
                OR loading_exc_differs OR start_cutover_differs)
           AND margin_differs AND deal_margin IS NOT NULL AND rr_margin IS NOT NULL,
          CONCAT('SAME INPUTS, FORMULA DIFFERS at ',
            CASE
              WHEN ABS(IFNULL(deal_w2, 0) - IFNULL(rr_w2, 0)) > 0.01
                THEN CONCAT('W2_PAY_RATE: ours ', IFNULL(CAST(deal_w2 AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_w2 AS STRING), 'null'))
              WHEN ABS(IFNULL(deal_final_pay, 0) - IFNULL(rr_final_pay, 0)) > 0.01
                THEN CONCAT('the loading: ours ', IFNULL(CAST(ROUND(SAFE_DIVIDE(deal_final_pay, deal_w2), 4) AS STRING), 'null'),
                            ' vs run-rate ', IFNULL(CAST(ROUND(SAFE_DIVIDE(rr_final_pay, rr_w2), 4) AS STRING), 'null'), ' (final pay / W2)')
              WHEN ABS(IFNULL(deal_cost, 0) - IFNULL(rr_cost, 0)) > 0.01
                THEN CONCAT('FINAL_COST: ours ', IFNULL(CAST(deal_cost AS STRING), 'null'), ' vs run-rate ', IFNULL(CAST(rr_cost AS STRING), 'null'),
                            ' (ours = final pay)')
              WHEN ABS(IFNULL(deal_final_bill, 0) - IFNULL(rr_final_bill, 0)) > 0.01
                THEN CONCAT('FINAL_BILL_RATE: ours ', IFNULL(CAST(deal_final_bill AS STRING), 'null'), ' vs run-rate ',
                            IFNULL(CAST(rr_final_bill AS STRING), 'null'), ' (ours = bill x (1 - fee))')
              ELSE 'the margin itself (inputs and rates agree)'
            END), NULL),
        IF(gross_differs AND NOT margin_differs, 'GROSS_MARGIN only (ours = Nexus hourly_revenue)', NULL)
      ]) AS x WHERE x IS NOT NULL
    ), ' | ') AS reason
  FROM flags
)
SELECT
  PLACEMENT_ID,
  DEAL_SHEET_ID,
  CANDIDATE_NAME,
  DEAL_TYPE,
  PLACEMENT_STATUS,
  sku,
  rr_id,
  rr_rows_for_sku,
  same_candidate,
  deal_start        AS start_date_dealsheet,
  rr_start          AS start_date_runrate,

  deal_margin       AS margin_dealsheet,
  rr_margin         AS margin_runrate,
  ROUND(deal_margin - rr_margin, 2) AS margin_gap,
  deal_gross        AS gross_margin_dealsheet,
  rr_gross          AS gross_margin_runrate,
  ROUND(deal_gross - rr_gross, 2)   AS gross_margin_gap,

  deal_pay_type     AS payment_type_dealsheet,
  rr_pay_type       AS payment_type_runrate,
  deal_placement_type AS placement_type_dealsheet,
  rr_placement_type AS placement_type_runrate,
  deal_pay          AS pay_rate_dealsheet,
  rr_pay            AS pay_rate_runrate,
  deal_bill         AS bill_rate_dealsheet,
  rr_bill           AS bill_rate_runrate,
  deal_fee          AS msp_fee_dealsheet,
  rr_fee            AS msp_fee_runrate,
  deal_bonus        AS additional_bonus_dealsheet,
  rr_bonus          AS additional_bonus_runrate,
  deal_per_diem     AS weekly_per_diem_dealsheet,
  rr_per_diem       AS weekly_per_diem_runrate,
  deal_wallet       AS weekly_wallet_dealsheet,
  rr_wallet         AS weekly_wallet_runrate,
  deal_orient       AS orientation_hours_dealsheet,
  rr_orient         AS orientation_hours_runrate,
  deal_hours        AS guaranteed_hours_dealsheet,
  rr_hours          AS guaranteed_hours_runrate,
  deal_weeks        AS project_weeks_dealsheet,
  rr_weeks          AS project_weeks_runrate,
  deal_loading_exc  AS loading_cost_exception_dealsheet,
  rr_loading_exc    AS loading_cost_exception_runrate,

  deal_w2           AS w2_pay_rate_dealsheet,
  rr_w2             AS w2_pay_rate_runrate,
  ROUND(SAFE_DIVIDE(deal_final_pay, deal_w2), 4) AS loading_dealsheet,
  ROUND(SAFE_DIVIDE(rr_final_pay, rr_w2), 4)     AS loading_runrate,
  deal_final_pay    AS final_pay_rate_dealsheet,
  rr_final_pay      AS final_pay_rate_runrate,
  deal_cost         AS final_cost_dealsheet,
  rr_cost           AS final_cost_runrate,
  deal_final_bill   AS final_bill_rate_dealsheet,
  rr_final_bill     AS final_bill_rate_runrate,

  reason
FROM explained
WHERE margin_differs OR gross_differs OR pay_differs OR bill_differs
ORDER BY ABS(IFNULL(deal_margin, 0) - IFNULL(rr_margin, 0)) DESC;
