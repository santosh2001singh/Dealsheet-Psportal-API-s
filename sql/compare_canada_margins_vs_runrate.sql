-- Cynet Health Canada: margin differences between our deal sheet and the legacy run-rate table.
--
-- Returns ONLY the rows where a margin disagrees, so the list is the review queue.
--
-- Match key (the same one the sync itself uses):
--   CANDIDATE_ID + FACILITY_NAME + PARENT_CLIENT_NAME
--   + any one of the deal row's START / END / TENTATIVE_END dates falling inside the run-rate row's
--     window (START_DATE .. COALESCE(END_DATE, TENTATIVE_END_DATE))
--
-- The date window is what separates one contract from the next: 58 candidate+facility pairs have
-- more than one run-rate contract with a different SKU, so matching on identity alone would compare
-- the wrong pair of rows. SKU_NUMBER is carried in the output for eyeballing, not used as the key.
--
-- MARGIN is deliberately NOT compared: it holds Nexus's hourly_revenue on our side and is empty on
-- the run-rate side (0 of 620 rows), so every row would show a false difference.
--
-- Compared:
--   CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_COST
--   GROSS_MARGIN      = FINAL_BILL_RATE - FINAL_PAY_RATE
-- with the inputs alongside, so a difference can be traced to the rate it came from.

WITH matched AS (
  SELECT
    d.PLACEMENT_ID,
    d.DEAL_SHEET_ID,
    d.CANDIDATE_ID,
    d.CANDIDATE_NAME,
    d.FACILITY_NAME,
    d.PARENT_CLIENT_NAME,
    d.CLIENT_STATE,
    d.PAYMENT_TYPE,
    d.PLACEMENT_TYPE,
    d.START_DATE            AS deal_start,
    d.TENTATIVE_END_DATE    AS deal_tentative_end,
    d.SKU_NUMBER            AS deal_sku,
    r.SKU_NUMBER            AS runrate_sku,

    -- Margins, rounded to 2dp so float noise is not reported as a difference.
    ROUND(d.CALCULATED_MARGIN, 2) AS deal_calculated_margin,
    ROUND(r.CALCULATED_MARGIN, 2) AS runrate_calculated_margin,
    ROUND(d.GROSS_MARGIN, 2)      AS deal_gross_margin,
    ROUND(r.GROSS_MARGIN, 2)      AS runrate_gross_margin,

    -- The inputs every margin is built from, so a difference can be traced to its source.
    ROUND(d.PAY_RATE, 2)          AS deal_pay_rate,
    ROUND(r.PAY_RATE, 2)          AS runrate_pay_rate,
    ROUND(d.BILL_RATE, 2)         AS deal_bill_rate,
    ROUND(r.BILL_RATE, 2)         AS runrate_bill_rate,
    ROUND(d.T4_PAY_RATE, 2)       AS deal_t4_pay_rate,
    ROUND(r.T4_PAY_RATE, 2)       AS runrate_t4_pay_rate,
    ROUND(d.FINAL_PAY_RATE, 2)    AS deal_final_pay_rate,
    ROUND(r.FINAL_PAY_RATE, 2)    AS runrate_final_pay_rate,
    ROUND(d.FINAL_BILL_RATE, 2)   AS deal_final_bill_rate,
    ROUND(r.FINAL_BILL_RATE, 2)   AS runrate_final_bill_rate,
    ROUND(d.FINAL_COST, 2)        AS deal_final_cost,
    ROUND(r.FINAL_COST, 2)        AS runrate_final_cost,
    ROUND(d.SCHEDULE_HOURS_1, 2)  AS deal_guaranteed_hours,
    ROUND(r.SCHEDULE_HOURS_1, 2)  AS runrate_guaranteed_hours,
    ROUND(d.PROJECT_DURATION, 2)  AS deal_weeks,
    ROUND(r.PROJECT_DURATION, 2)  AS runrate_weeks,
    ROUND(d.ADDITIONAL_BONUS, 2)  AS deal_bonus,
    ROUND(r.ADDITIONAL_BONUS, 2)  AS runrate_bonus,
    ROUND(d.CLIENT_MSP_FEE, 4)    AS deal_msp_fee,
    ROUND(r.CLIENT_MSP_FEE, 4)    AS runrate_msp_fee
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` d
  JOIN `cynetdatabase.rr_project_data.all_Health_Canada_data_Runrate` r
    ON  CAST(d.CANDIDATE_ID AS STRING)          = CAST(r.CANDIDATE_ID AS STRING)
    AND LOWER(TRIM(d.FACILITY_NAME))            = LOWER(TRIM(r.FACILITY_NAME))
    AND LOWER(TRIM(d.PARENT_CLIENT_NAME))       = LOWER(TRIM(r.PARENT_CLIENT_NAME))
    -- Any one of the deal row's dates inside the run-rate window pins the contract.
    AND (
         d.START_DATE          BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
      OR d.END_DATE            BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
      OR d.TENTATIVE_END_DATE  BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)
    )
)
SELECT
  -- What differs, so the list can be filtered or sorted by problem type.
  CONCAT(
    IF(deal_calculated_margin IS DISTINCT FROM runrate_calculated_margin, 'CALCULATED_MARGIN ', ''),
    IF(deal_gross_margin      IS DISTINCT FROM runrate_gross_margin,      'GROSS_MARGIN ',      '')
  ) AS differs_in,
  ROUND(deal_calculated_margin - runrate_calculated_margin, 2) AS calculated_margin_delta,
  ROUND(deal_gross_margin      - runrate_gross_margin, 2)      AS gross_margin_delta,
  *
FROM matched
-- IS DISTINCT FROM treats NULL as a value, so "we have a number / run-rate has none" is reported
-- rather than silently dropped.
WHERE deal_calculated_margin IS DISTINCT FROM runrate_calculated_margin
   OR deal_gross_margin      IS DISTINCT FROM runrate_gross_margin
ORDER BY
  ABS(IFNULL(deal_calculated_margin - runrate_calculated_margin, 0)) DESC,
  ABS(IFNULL(deal_gross_margin      - runrate_gross_margin, 0)) DESC;


-- ---------------------------------------------------------------------------
-- Summary first, if you want the size of the problem before the row list.
-- ---------------------------------------------------------------------------
-- WITH matched AS ( ...same CTE as above... )
-- SELECT
--   COUNT(*)                                                                    AS matched_rows,
--   COUNTIF(deal_calculated_margin IS DISTINCT FROM runrate_calculated_margin)  AS calculated_margin_diffs,
--   COUNTIF(deal_gross_margin      IS DISTINCT FROM runrate_gross_margin)       AS gross_margin_diffs,
--   COUNTIF(deal_final_pay_rate    IS DISTINCT FROM runrate_final_pay_rate)     AS final_pay_rate_diffs,
--   COUNTIF(deal_final_bill_rate   IS DISTINCT FROM runrate_final_bill_rate)    AS final_bill_rate_diffs,
--   COUNTIF(deal_final_cost        IS DISTINCT FROM runrate_final_cost)         AS final_cost_diffs
-- FROM matched;
