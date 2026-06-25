-- Drop US-only rate / hours / bonus columns from Canada deal sheet tables.
-- Canada uses T4_PAY_RATE / FINAL_PAY_RATE / FINAL_COST / NET_MARGIN and SCHEDULE_HOURS_1 only.
--
-- Run in BigQuery before deploying the sync code hardening.

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS W2_PAY_RATE_NEW,
  DROP COLUMN IF EXISTS FINAL_PAY_RATE_NEW,
  DROP COLUMN IF EXISTS FINAL_COST_NEW,
  DROP COLUMN IF EXISTS NEW_MARGIN,
  DROP COLUMN IF EXISTS FINAL_BILL_RATE_NEW,
  DROP COLUMN IF EXISTS FIRST_WEEK_HOURS,
  DROP COLUMN IF EXISTS SECOND_WEEK_HOURS,
  DROP COLUMN IF EXISTS TOTAL_BONUS_TAXABLE,
  DROP COLUMN IF EXISTS TOTAL_BONUS_NON_TAXABLE,
  DROP COLUMN IF EXISTS REGULAR_HOURS_1,
  DROP COLUMN IF EXISTS REGULAR_HOURS_2,
  DROP COLUMN IF EXISTS SCHEDULE_HOURS_2;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS W2_PAY_RATE_NEW,
  DROP COLUMN IF EXISTS FINAL_PAY_RATE_NEW,
  DROP COLUMN IF EXISTS FINAL_COST_NEW,
  DROP COLUMN IF EXISTS NEW_MARGIN,
  DROP COLUMN IF EXISTS FINAL_BILL_RATE_NEW,
  DROP COLUMN IF EXISTS FIRST_WEEK_HOURS,
  DROP COLUMN IF EXISTS SECOND_WEEK_HOURS,
  DROP COLUMN IF EXISTS TOTAL_BONUS_TAXABLE,
  DROP COLUMN IF EXISTS TOTAL_BONUS_NON_TAXABLE,
  DROP COLUMN IF EXISTS REGULAR_HOURS_1,
  DROP COLUMN IF EXISTS REGULAR_HOURS_2,
  DROP COLUMN IF EXISTS SCHEDULE_HOURS_2;
