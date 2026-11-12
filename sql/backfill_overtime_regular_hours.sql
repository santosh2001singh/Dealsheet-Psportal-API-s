-- Cynet Health billing overtime -> regular-hours formula (Nov 2026). cynet_health_deal_sheet only:
-- the ended table, canada and locums are not touched.
--
-- Rule (w2PayRateNew.usesRegularHoursOtSplit): a submittal with ANY `overtime` id
-- (/api/billing-overtimes/) uses REGULAR_HOURS_1/2 for the NEW-rate OT split, exactly like CA / AK.
--
-- Run it through: node functions/scripts/backfillOvertimeRegularHours.js [--placement <id>] --apply
-- which first loads
-- rr_project_data.tmp_overtime_regular_hours (one row per deal sheet whose submittal has an overtime
-- id, with that deal sheet's regular / scheduled hours from Nexus). Only staged deal sheets change,
-- so a --placement run touches that placement alone.
--
-- Run with the sync schedulers PAUSED (dealSheetSyncTrigger, dealSheetSyncUpdateTrigger,
-- rateChangeLogSyncTrigger) and deploy the code before resuming them. Rows are updated in place:
-- no new versions, no rate-change logs.
--
-- A row takes the API regular hours only when its own SCHEDULE_HOURS_1/2 equal the deal sheet's
-- current scheduled hours; an older version with different schedule hours is left as it was.
--
-- The NEW-rate family is recomputed from each row's own columns with the same chain and rounding as
-- computeNewRateFamily (unrounded through the chain, JS Math.round half-up at the end). Check it
-- afterwards with: node functions/scripts/backfillOvertimeRegularHours.js --verify

-- 1. Columns.
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS OVERTIME_ID INT64,
  ADD COLUMN IF NOT EXISTS OVERTIME STRING;
-- 2. Backup (every row of a staged deal sheet). Additive, so a one-placement test run and the full
-- run later both land here; a deal sheet already backed up is not copied again.
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.bkp_20261111_overtime_regular_hours`
LIKE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`;
INSERT INTO `cynetdatabase.rr_project_data.bkp_20261111_overtime_regular_hours`
SELECT d.*
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
WHERE d.DEAL_SHEET_ID IN (SELECT DEAL_SHEET_ID FROM `cynetdatabase.rr_project_data.tmp_overtime_regular_hours`)
  AND d.DEAL_SHEET_ID NOT IN (
    SELECT DEAL_SHEET_ID FROM `cynetdatabase.rr_project_data.bkp_20261111_overtime_regular_hours`
    WHERE DEAL_SHEET_ID IS NOT NULL);

-- 3. Overtime + regular hours.
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET
  OVERTIME_ID = s.OVERTIME_ID,
  OVERTIME = s.OVERTIME,
  REGULAR_HOURS_1 = IFNULL(s.API_REGULAR_HRS_1, 0),
  REGULAR_HOURS_2 = IFNULL(s.API_REGULAR_HRS_2, 0)
FROM `cynetdatabase.rr_project_data.tmp_overtime_regular_hours` s
WHERE d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  AND d.PLACEMENT_ID = s.PLACEMENT_ID
  AND IFNULL(d.SCHEDULE_HOURS_1, 0) = IFNULL(s.API_SCHEDULED_HRS_1, 0)
  AND IFNULL(d.SCHEDULE_HOURS_2, 0) = IFNULL(s.API_SCHEDULED_HRS_2, 0);

-- 4. Recompute the NEW-rate family (regular-hours branch) for every row that now has an overtime id.
-- JS round2: Math.round((v + Number.EPSILON) * 100) / 100, Math.round = FLOOR(x + 0.5).
CREATE TEMP FUNCTION js_round2(v FLOAT64) AS (
  FLOOR((v + 2.220446049250313e-16) * 100 + 0.5) / 100
);
CREATE TEMP FUNCTION w2_new(pt STRING, sh1 FLOAT64, sh2 FLOAT64, rh1 FLOAT64, rh2 FLOAT64,
  fwh FLOAT64, swh FLOAT64, pay FLOAT64, ot FLOAT64, tax FLOAT64, nontax FLOAT64,
  po FLOAT64, orient FLOAT64) AS (
  CASE
    WHEN TRIM(IFNULL(pt, '')) = '' THEN NULL
    WHEN UPPER(TRIM(pt)) IN ('FT', 'INTERNAL') THEN 0
    WHEN po - orient = 0 THEN NULL
    ELSE (1.23 * (rh1 * fwh * pay + (sh1 - rh1) * ot * fwh + rh2 * swh * pay + (sh2 - rh2) * ot * swh)
          + (1.23 * tax + nontax)) / (po - orient)
  END
);
CREATE TEMP FUNCTION final_pay_new(w2 FLOAT64, per_diem FLOAT64, fwh FLOAT64, swh FLOAT64,
  po FLOAT64, orient FLOAT64) AS (
  CASE
    WHEN w2 = 0 THEN 0
    WHEN w2 IS NULL OR po - orient = 0 THEN NULL
    ELSE (per_diem * (fwh + swh) * 1.09) / (po - orient) + w2
  END
);
CREATE TEMP FUNCTION final_cost_new(fp FLOAT64, po FLOAT64, orient FLOAT64) AS (
  IF(fp IS NULL OR po - orient = 0, NULL, fp + po / (po - orient))
);
CREATE TEMP FUNCTION final_bill_new(br FLOAT64, cot FLOAT64, fee FLOAT64, sh1 FLOAT64, sh2 FLOAT64,
  rh1 FLOAT64, rh2 FLOAT64, fwh FLOAT64, swh FLOAT64, po FLOAT64, orient FLOAT64) AS (
  IF(po - orient = 0, NULL,
    (rh1 * fwh * br + (sh1 - rh1) * cot * fwh + rh2 * swh * br + (sh2 - rh2) * cot * swh - orient * br)
      * (1 - fee) / (po - orient))
);
-- BILLABLE_ORIENTATION "70.00%" -> 0.70; blank / 0% leaves the orientation hours out.
CREATE TEMP FUNCTION margin_new(fbr FLOAT64, fc FLOAT64, po FLOAT64, bo STRING, bo_hrs FLOAT64) AS (
  IF(fbr IS NULL OR fc IS NULL OR po = 0, NULL,
    fbr
    - fbr * IF(IFNULL(SAFE_CAST(REPLACE(TRIM(bo), '%', '') AS FLOAT64), 0) = 0, 0, bo_hrs)
          * (1 - IFNULL(SAFE_CAST(REPLACE(TRIM(bo), '%', '') AS FLOAT64), 0) / 100) / po
    - fc)
);

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET
  W2_PAY_RATE_NEW = js_round2(x.w2),
  FINAL_PAY_RATE_NEW = js_round2(x.fp),
  FINAL_COST_NEW = js_round2(x.fc),
  FINAL_BILL_RATE_NEW = js_round2(x.fbr),
  CALCULATED_MARGIN = js_round2(margin_new(x.fbr, x.fc, x.po, d.BILLABLE_ORIENTATION, x.bo_hrs))
FROM (
  SELECT k, w2, fp, final_cost_new(fp, po, orient) AS fc, fbr, po, bo_hrs
  FROM (
    SELECT k, w2, final_pay_new(w2, per_diem, fwh, swh, po, orient) AS fp, fbr, po, orient, bo_hrs
    FROM (
      SELECT
        FORMAT('%t|%t|%t', DEAL_SHEET_ID, PLACEMENT_ID, LAST_UPDATED) AS k,
        w2_new(PLACEMENT_TYPE, IFNULL(SCHEDULE_HOURS_1, 0), IFNULL(SCHEDULE_HOURS_2, 0),
          IFNULL(REGULAR_HOURS_1, 0), IFNULL(REGULAR_HOURS_2, 0), IFNULL(FIRST_WEEK_HOURS, 0),
          IFNULL(SECOND_WEEK_HOURS, 0), IFNULL(PAY_RATE, 0), IFNULL(OT_RATE, 0),
          IFNULL(TOTAL_BONUS_TAXABLE, 0), IFNULL(TOTAL_BONUS_NON_TAXABLE, 0),
          IFNULL(PO_HOURS, 0), IFNULL(NBO_HOURS, 0)) AS w2,
        final_bill_new(IFNULL(BILL_RATE, 0), IFNULL(CLIENT_OT_RATE, 0), IFNULL(CLIENT_MSP_FEE, 0),
          IFNULL(SCHEDULE_HOURS_1, 0), IFNULL(SCHEDULE_HOURS_2, 0), IFNULL(REGULAR_HOURS_1, 0),
          IFNULL(REGULAR_HOURS_2, 0), IFNULL(FIRST_WEEK_HOURS, 0), IFNULL(SECOND_WEEK_HOURS, 0),
          IFNULL(PO_HOURS, 0), IFNULL(NBO_HOURS, 0)) AS fbr,
        IFNULL(WEEKLY_PER_DIEM_NON_TAXED, 0) AS per_diem,
        IFNULL(FIRST_WEEK_HOURS, 0) AS fwh, IFNULL(SECOND_WEEK_HOURS, 0) AS swh,
        IFNULL(PO_HOURS, 0) AS po, IFNULL(NBO_HOURS, 0) AS orient,
        IFNULL(BILLABLE_ORIENTATION_HRS, 0) AS bo_hrs
      FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
      WHERE OVERTIME_ID IS NOT NULL
    )
  )
) x
WHERE d.OVERTIME_ID IS NOT NULL
  AND FORMAT('%t|%t|%t', d.DEAL_SHEET_ID, d.PLACEMENT_ID, d.LAST_UPDATED) = x.k;

-- 5. After --verify passes, deploy the functions, resume the schedulers, then:
-- DROP TABLE `cynetdatabase.rr_project_data.tmp_overtime_regular_hours`;
