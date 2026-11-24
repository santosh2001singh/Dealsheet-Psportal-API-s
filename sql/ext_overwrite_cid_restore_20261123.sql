-- 2026-11-23: restore the original CONTRACT_ID on 21 ENDED Health DEALs.
--
-- What happened: the DEAL's run-rate row was overwritten by its EXTENSION (same contract id, RR
-- overwrites by contract id), so all_CH_data_runrate now carries the extension's PLACEMENT_ID.
-- A refresh revalidation then judged the DEAL's dates against that row, found them outside,
-- and minted a fresh id that exists nowhere in run-rate (e.g. 1451239 CHC21832 -> CHC24281,
-- rejected in RR as "INCORRECT CONTRACT ID").
--
-- Checked with the deployed window function (2026-11-23): every DEAL below falls inside the
-- window of its original id, so it will not be re-minted after the restore.
-- Left for review: 1464352 (CHC22742 sits on another DEAL 1468626), 1474886 (BOOKED rebook,
-- old window ended 2026-11-03).
--
-- Scope: cynet_health_deal_sheet (same PLACEMENT_ID only), ownership_change_logs and
-- ch_rate_change_logs (same PLACEMENT_ID, plus extension 1473509 of 1458886, whose deal sheet
-- and run-rate already hold CHC22004). Run-rate is NOT touched: it already holds the original ids.
-- aita_webhook_outbox is history and is left alone.

-- Step 0: map + backups
-- (map table fix_20261123_ext_overwrite_cid_map: pid, keep_id, old_id; 21 rows)
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.bkp_20261123_extow_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE CAST(PLACEMENT_ID AS STRING) IN (SELECT pid FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`);

CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.bkp_20261123_extow_ownership_change_logs` AS
SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE CONTRACT_ID IN (SELECT old_id FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`);

CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.bkp_20261123_extow_ch_rate_change_logs` AS
SELECT * FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (SELECT old_id FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`);

-- Step 1: apply
BEGIN TRANSACTION;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map` m
WHERE CAST(t.PLACEMENT_ID AS STRING) = m.pid AND t.CONTRACT_ID = m.old_id;

UPDATE `cynetdatabase.rr_project_data.ownership_change_logs` t
SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map` m
WHERE t.CONTRACT_ID = m.old_id
  AND (CAST(t.PLACEMENT_ID AS STRING) = m.pid OR (m.pid = '1458886' AND CAST(t.PLACEMENT_ID AS STRING) = '1473509'));

UPDATE `cynetdatabase.rr_project_data.ch_rate_change_logs` t
SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map` m
WHERE t.CONTRACT_ID = m.old_id
  AND (CAST(t.PLACEMENT_ID AS STRING) = m.pid OR (m.pid = '1458886' AND CAST(t.PLACEMENT_ID AS STRING) = '1473509'));

COMMIT TRANSACTION;

-- Step 2: verify (all should be 0)
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    WHERE CONTRACT_ID IN (SELECT old_id FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`)) AS deal_sheet_old_id,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ownership_change_logs`
    WHERE CONTRACT_ID IN (SELECT old_id FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`)) AS ownership_old_id,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
    WHERE CONTRACT_ID IN (SELECT old_id FROM `cynetdatabase.rr_project_data.fix_20261123_ext_overwrite_cid_map`)) AS rate_old_id;

-- Rollback (if ever needed):
-- UPDATE cynet_health_deal_sheet t SET CONTRACT_ID = b.CONTRACT_ID FROM bkp_20261123_extow_deal_sheet b WHERE t.ID = b.ID;
-- (log tables: restore CONTRACT_ID from the matching bkp_20261123_extow_* rows by their row key)
