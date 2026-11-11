-- NL T4 loading: 1.04 x 1.1672 (1.213888, 21.39%) -> Finance's flat 20.72% (1.2072).
-- Business confirmed 2026-11-11. Recomputes the pay-rate chain exactly as
-- computeCanadaDerivedPlacementFields does, from each row's own stored inputs:
--   T4_PAY_RATE       = ROUND((PAY_RATE + BONUS / (HOURS * WEEKS)) * 1.2072 + PER_DIEM / 11.25, 2)
--   FINAL_PAY_RATE    = T4_PAY_RATE
--   FINAL_COST        = ROUND(FINAL_PAY_RATE * 1.03, 2)
--   CALCULATED_MARGIN = ROUND(FINAL_BILL_RATE - FINAL_COST, 2)
--   GROSS_MARGIN      = ROUND(FINAL_BILL_RATE - FINAL_PAY_RATE, 2)
-- At the time of writing: 165 rows / 116 deal sheets in cynet_health_canada_deal_sheet; the ended
-- table holds no NL rows. NL T4A (1.0254) is unchanged.

-- 1. Backup.
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261111_canada_nl_t4` AS
SELECT *
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
WHERE UPPER(TRIM(CLIENT_STATE)) = 'NL';

-- 2. Recompute, each row from its own columns (the table keeps several versions per deal sheet).
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
SET
  T4_PAY_RATE = ROUND(
    (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * 1.2072
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25, 2),
  FINAL_PAY_RATE = ROUND(
    (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * 1.2072
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25, 2),
  FINAL_COST = ROUND(ROUND(
    (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * 1.2072
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25, 2) * 1.03, 2),
  CALCULATED_MARGIN = ROUND(FINAL_BILL_RATE - ROUND(ROUND(
    (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * 1.2072
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25, 2) * 1.03, 2), 2),
  GROSS_MARGIN = ROUND(FINAL_BILL_RATE - ROUND(
    (PAY_RATE + IFNULL(ADDITIONAL_BONUS, 0) / (SCHEDULE_HOURS_1 * PROJECT_DURATION)) * 1.2072
      + IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) / 11.25, 2), 2)
WHERE UPPER(TRIM(CLIENT_STATE)) = 'NL'
  AND IFNULL(NULLIF(UPPER(TRIM(PAYMENT_TYPE)), ''), 'T4') = 'T4'
  AND UPPER(TRIM(PLACEMENT_TYPE)) NOT IN ('INTERNAL', 'FT')
  AND PAY_RATE IS NOT NULL
  AND IFNULL(SCHEDULE_HOURS_1, 0) <> 0
  AND IFNULL(PROJECT_DURATION, 0) <> 0;
