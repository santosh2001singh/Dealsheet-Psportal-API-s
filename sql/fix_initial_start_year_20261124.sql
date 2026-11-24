-- 2026-11-24: INITIAL_START_DATE was 2026-12-25 (later than the placement's own start) on two Health
-- extensions, created Sep 2026. ENDED vs ENDED<30 = END_DATE - INITIAL_START_DATE, so 1470519
-- (Kim Reasons, ended 2026-11-08 after 42 days) became ENDED<30.
--   1470519 Kim Reasons  CHC23713 -> 2025-12-15 (contract continuous since CHC20863, same as 1474420); ENDED<30 -> ENDED
--   1469503 Toya Piper   CHC20880 -> 2025-12-25 (the chain's real start; year was off by one)
-- Only rows still holding 2026-12-25 are touched.

-- 1) Backups
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261124_isd_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` WHERE PLACEMENT_ID IN (1470519, 1469503);
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261124_isd_runrate` AS
SELECT * FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE PLACEMENT_ID IN (1470519, 1469503);
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261124_isd_all_ch_deal_sheet_data` AS
SELECT * FROM `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data` WHERE PLACEMENT_ID IN (1470519, 1469503);
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261124_isd_ownership_change_logs` AS
SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE CAST(PLACEMENT_ID AS STRING) IN ('1470519', '1469503');

-- 2) Fix
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET INITIAL_START_DATE = CASE PLACEMENT_ID WHEN 1470519 THEN DATE '2025-12-15' ELSE DATE '2025-12-25' END,
    PLACEMENT_STATUS = IF(PLACEMENT_ID = 1470519 AND PLACEMENT_STATUS = 'ENDED<30', 'ENDED', PLACEMENT_STATUS)
WHERE PLACEMENT_ID IN (1470519, 1469503) AND INITIAL_START_DATE = DATE '2026-12-25';

UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate`
SET INITIAL_START_DATE = CASE PLACEMENT_ID WHEN 1470519 THEN DATE '2025-12-15' ELSE DATE '2025-12-25' END
WHERE PLACEMENT_ID IN (1470519, 1469503) AND INITIAL_START_DATE = DATE '2026-12-25';

UPDATE `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data`
SET INITIAL_START_DATE = CASE PLACEMENT_ID WHEN 1470519 THEN DATE '2025-12-15' ELSE DATE '2025-12-25' END,
    PLACEMENT_STATUS = IF(PLACEMENT_ID = 1470519 AND PLACEMENT_STATUS = 'ENDED<30', 'ENDED', PLACEMENT_STATUS)
WHERE PLACEMENT_ID IN (1470519, 1469503) AND INITIAL_START_DATE = DATE '2026-12-25';

UPDATE `cynetdatabase.rr_project_data.ownership_change_logs`
SET INITIAL_START_DATE = CASE CAST(PLACEMENT_ID AS STRING) WHEN '1470519' THEN DATE '2025-12-15' ELSE DATE '2025-12-25' END
WHERE CAST(PLACEMENT_ID AS STRING) IN ('1470519', '1469503') AND INITIAL_START_DATE = DATE '2026-12-25';

-- 3) Verify (expect 0 everywhere)
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` WHERE PLACEMENT_ID IN (1470519, 1469503) AND (INITIAL_START_DATE = DATE '2026-12-25' OR PLACEMENT_STATUS = 'ENDED<30')) AS deal_sheet_left,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE PLACEMENT_ID IN (1470519, 1469503) AND INITIAL_START_DATE = DATE '2026-12-25') AS runrate_left,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data` WHERE PLACEMENT_ID IN (1470519, 1469503) AND (INITIAL_START_DATE = DATE '2026-12-25' OR PLACEMENT_STATUS = 'ENDED<30')) AS all_ch_data_left,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE CAST(PLACEMENT_ID AS STRING) IN ('1470519', '1469503') AND INITIAL_START_DATE = DATE '2026-12-25') AS own_log_left;

-- Rollback (by table; restores the two placements' rows from the backups):
-- DELETE FROM cynet_health_deal_sheet WHERE PLACEMENT_ID IN (1470519, 1469503); INSERT INTO cynet_health_deal_sheet SELECT * FROM bkp_20261124_isd_deal_sheet;
-- (same pattern for all_CH_data_runrate, all_CH_Deal_sheet_data, ownership_change_logs)
