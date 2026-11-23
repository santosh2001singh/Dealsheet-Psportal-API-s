-- Contract id re-mint cleanup (2026-11-23), Cynet Health. See memory dna-contract-id-remint-2026-11.
--
-- Bug: revalidateDealContractIdAgainstRunrate judged a DEAL against a window built from its OWN
-- approved run-rate row, so every time the placement's start moved (DNA job re-dated, pushback,
-- typo fix) a new CHC id was minted, the deal sheet was rewritten to it, and the next RR approve
-- added a second all_CH_data_runrate row. Code fix: own rows excluded from the window.
--
-- Rules (user, 2026-11-23):
--   * keep the FIRST approved id = CONTRACT_ID of the placement's earliest run-rate row
--     (placements with one run-rate row: that row's id);
--   * all_CH_data_runrate keeps ONE row per placement: the latest approved row, put on the kept id;
--     manual columns empty on it are filled from the latest older row of the SAME PLACEMENT_STATUS;
--     the older rows are deleted;
--   * cynet_health_deal_sheet, all_CH_Deal_sheet_data, ownership_change_logs, ch_rate_change_logs,
--     ch_termination_reason_logs: CONTRACT_ID old -> kept, same PLACEMENT_ID only.
-- Out of scope: 1465062 (legacy-looking BOOKED row with NEW_ID, needs review), 1467199 (EXTENSION,
-- different cause), all_CH_data_runrate_merged (not ours), aita_webhook_outbox (sent history),
-- run-rate rows with no PLACEMENT_ID (data team).
--
-- Deploy the code fix BEFORE step 3, or the next update run re-mints the fixed rows.

-- ============================================================================================
-- 0) MAP + BACKUPS (run once; CREATE fails if the table exists)
-- ============================================================================================
CREATE TABLE `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` AS
WITH rr AS (
  SELECT CAST(PLACEMENT_ID AS STRING) pid, CONTRACT_ID, LAST_UPDATED
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE PLACEMENT_ID IS NOT NULL),
rrp AS (SELECT pid, ARRAY_AGG(CONTRACT_ID ORDER BY LAST_UPDATED LIMIT 1)[OFFSET(0)] keep_id,
  ARRAY_AGG(DISTINCT CONTRACT_ID) rr_ids FROM rr GROUP BY pid),
dsp AS (SELECT CAST(PLACEMENT_ID AS STRING) pid, ARRAY_AGG(DISTINCT CONTRACT_ID IGNORE NULLS) ds_ids,
  ARRAY_AGG(DEAL_TYPE ORDER BY LAST_UPDATED DESC LIMIT 1)[OFFSET(0)] dt
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` GROUP BY pid),
aff AS (SELECT rrp.pid, keep_id, ARRAY_CONCAT(rr_ids, ds_ids) all_ids FROM rrp JOIN dsp USING(pid)
  WHERE dt = 'DEAL' AND rrp.pid != '1465062'
    AND ((SELECT COUNT(*) FROM UNNEST(ds_ids) d WHERE d NOT IN UNNEST(rr_ids)) > 0 OR ARRAY_LENGTH(rr_ids) > 1))
SELECT DISTINCT pid, keep_id, old_id FROM aff, UNNEST(all_ids) old_id WHERE old_id != keep_id;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate` AS
SELECT * FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
WHERE CAST(PLACEMENT_ID AS STRING) IN (SELECT pid FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`);

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_deal_sheet` AS
SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE CAST(PLACEMENT_ID AS STRING) IN (SELECT pid FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`);

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_all_ch_deal_sheet_data` AS
SELECT x.* FROM `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data` x
JOIN `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m ON x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ownership_change_logs` AS
SELECT x.* FROM `cynetdatabase.rr_project_data.ownership_change_logs` x
JOIN `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m ON x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ch_rate_change_logs` AS
SELECT x.* FROM `cynetdatabase.rr_project_data.ch_rate_change_logs` x
JOIN `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m ON x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ch_termination_reason_logs` AS
SELECT x.* FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs` x
JOIN `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m ON x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

-- ============================================================================================
-- 1) PREVIEW (read-only)
-- ============================================================================================
SELECT 'map placements' AS what, COUNT(DISTINCT pid) AS n FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`
UNION ALL SELECT 'map old ids', COUNT(*) FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`
UNION ALL SELECT 'runrate rows (backup)', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate`
UNION ALL SELECT 'runrate rows to delete', COUNT(*) - COUNT(DISTINCT PLACEMENT_ID) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate`
UNION ALL SELECT 'deal sheet rows to re-id', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_deal_sheet` d
  JOIN `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m ON d.CONTRACT_ID = m.old_id AND CAST(d.PLACEMENT_ID AS STRING) = m.pid
UNION ALL SELECT 'all_CH_Deal_sheet_data rows to re-id', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_all_ch_deal_sheet_data`
UNION ALL SELECT 'ownership_change_logs rows to re-id', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ownership_change_logs`
UNION ALL SELECT 'ch_rate_change_logs rows to re-id', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ch_rate_change_logs`
UNION ALL SELECT 'ch_termination_reason_logs rows to re-id', COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_ch_termination_reason_logs`;

-- ============================================================================================
-- 2) APPLY, one transaction. Every value comes from the backups, so a rerun writes the same thing.
-- ============================================================================================
BEGIN TRANSACTION;

-- 2a) Kept run-rate row: latest row of the placement, put on the kept id, manual blanks filled.
UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` t
SET
  CONTRACT_ID = f.keep_id,
  CLIENT_NAME_IN_CONREP = IF(IF(TRIM(t.CLIENT_NAME_IN_CONREP) = '', NULL, t.CLIENT_NAME_IN_CONREP) IS NULL, f.CLIENT_NAME_IN_CONREP, t.CLIENT_NAME_IN_CONREP),
  WEEKLY_WALLET_MONEY = IF(t.WEEKLY_WALLET_MONEY IS NULL, f.WEEKLY_WALLET_MONEY, t.WEEKLY_WALLET_MONEY),
  ONB_CAND_DOB = IF(t.ONB_CAND_DOB IS NULL, f.ONB_CAND_DOB, t.ONB_CAND_DOB),
  ONB_I9_RECIEVED = IF(IF(TRIM(t.ONB_I9_RECIEVED) = '', NULL, t.ONB_I9_RECIEVED) IS NULL, f.ONB_I9_RECIEVED, t.ONB_I9_RECIEVED),
  ONB_SUPP_DOC1 = IF(IF(TRIM(t.ONB_SUPP_DOC1) = '', NULL, t.ONB_SUPP_DOC1) IS NULL, f.ONB_SUPP_DOC1, t.ONB_SUPP_DOC1),
  ONB_SUPP_DOC1_EXP_DT = IF(t.ONB_SUPP_DOC1_EXP_DT IS NULL, f.ONB_SUPP_DOC1_EXP_DT, t.ONB_SUPP_DOC1_EXP_DT),
  ONB_SUPP_DOC2 = IF(IF(TRIM(t.ONB_SUPP_DOC2) = '', NULL, t.ONB_SUPP_DOC2) IS NULL, f.ONB_SUPP_DOC2, t.ONB_SUPP_DOC2),
  ONB_SUPP_DOC2_EXP_DT = IF(t.ONB_SUPP_DOC2_EXP_DT IS NULL, f.ONB_SUPP_DOC2_EXP_DT, t.ONB_SUPP_DOC2_EXP_DT),
  ONB_E_VERIFY = IF(IF(TRIM(t.ONB_E_VERIFY) = '', NULL, t.ONB_E_VERIFY) IS NULL, f.ONB_E_VERIFY, t.ONB_E_VERIFY),
  BGC_CATEGORY1 = IF(IF(TRIM(t.BGC_CATEGORY1) = '', NULL, t.BGC_CATEGORY1) IS NULL, f.BGC_CATEGORY1, t.BGC_CATEGORY1),
  BGC_AMOUNT1 = IF(t.BGC_AMOUNT1 IS NULL, f.BGC_AMOUNT1, t.BGC_AMOUNT1),
  BGC_CATEGORY2 = IF(IF(TRIM(t.BGC_CATEGORY2) = '', NULL, t.BGC_CATEGORY2) IS NULL, f.BGC_CATEGORY2, t.BGC_CATEGORY2),
  BGC_AMOUNT2 = IF(t.BGC_AMOUNT2 IS NULL, f.BGC_AMOUNT2, t.BGC_AMOUNT2),
  BGC_CATEGORY3 = IF(IF(TRIM(t.BGC_CATEGORY3) = '', NULL, t.BGC_CATEGORY3) IS NULL, f.BGC_CATEGORY3, t.BGC_CATEGORY3),
  BGC_AMOUNT3 = IF(t.BGC_AMOUNT3 IS NULL, f.BGC_AMOUNT3, t.BGC_AMOUNT3),
  BGC_TOTAL_BGV_COST = IF(t.BGC_TOTAL_BGV_COST IS NULL, f.BGC_TOTAL_BGV_COST, t.BGC_TOTAL_BGV_COST),
  BGC_AGENCY_NAME = IF(IF(TRIM(t.BGC_AGENCY_NAME) = '', NULL, t.BGC_AGENCY_NAME) IS NULL, f.BGC_AGENCY_NAME, t.BGC_AGENCY_NAME),
  DIVERSITY_STATUS = IF(IF(TRIM(t.DIVERSITY_STATUS) = '', NULL, t.DIVERSITY_STATUS) IS NULL, f.DIVERSITY_STATUS, t.DIVERSITY_STATUS),
  BACKOUT_OR_TERMINATION = IF(IF(TRIM(t.BACKOUT_OR_TERMINATION) = '', NULL, t.BACKOUT_OR_TERMINATION) IS NULL, f.BACKOUT_OR_TERMINATION, t.BACKOUT_OR_TERMINATION),
  CLIENT_RECRUITER = IF(IF(TRIM(t.CLIENT_RECRUITER) = '', NULL, t.CLIENT_RECRUITER) IS NULL, f.CLIENT_RECRUITER, t.CLIENT_RECRUITER),
  CLIENT_PAYMENT_TERMS = IF(IF(TRIM(t.CLIENT_PAYMENT_TERMS) = '', NULL, t.CLIENT_PAYMENT_TERMS) IS NULL, f.CLIENT_PAYMENT_TERMS, t.CLIENT_PAYMENT_TERMS),
  INVOICE_CYCLE_TO_CLIENT = IF(IF(TRIM(t.INVOICE_CYCLE_TO_CLIENT) = '', NULL, t.INVOICE_CYCLE_TO_CLIENT) IS NULL, f.INVOICE_CYCLE_TO_CLIENT, t.INVOICE_CYCLE_TO_CLIENT),
  CANDIDATE_PAYMENT_TERMS = IF(IF(TRIM(t.CANDIDATE_PAYMENT_TERMS) = '', NULL, t.CANDIDATE_PAYMENT_TERMS) IS NULL, f.CANDIDATE_PAYMENT_TERMS, t.CANDIDATE_PAYMENT_TERMS),
  PO_RECEIVED = IF(IF(TRIM(t.PO_RECEIVED) = '', NULL, t.PO_RECEIVED) IS NULL, f.PO_RECEIVED, t.PO_RECEIVED),
  PAYLOCITY_ID = IF(IF(TRIM(t.PAYLOCITY_ID) = '', NULL, t.PAYLOCITY_ID) IS NULL, f.PAYLOCITY_ID, t.PAYLOCITY_ID),
  COMMENTS = IF(IF(TRIM(t.COMMENTS) = '', NULL, t.COMMENTS) IS NULL, f.COMMENTS, t.COMMENTS),
  ENTITY = IF(IF(TRIM(t.ENTITY) = '', NULL, t.ENTITY) IS NULL, f.ENTITY, t.ENTITY),
  FIFTYTWO_TENURE_RTO_LASTDATE = IF(t.FIFTYTWO_TENURE_RTO_LASTDATE IS NULL, f.FIFTYTWO_TENURE_RTO_LASTDATE, t.FIFTYTWO_TENURE_RTO_LASTDATE),
  FIFTYTWO_TENURE_CANDIDATE_STATUS = IF(IF(TRIM(t.FIFTYTWO_TENURE_CANDIDATE_STATUS) = '', NULL, t.FIFTYTWO_TENURE_CANDIDATE_STATUS) IS NULL, f.FIFTYTWO_TENURE_CANDIDATE_STATUS, t.FIFTYTWO_TENURE_CANDIDATE_STATUS),
  RECRUITMENT_MENTOR = IF(IF(TRIM(t.RECRUITMENT_MENTOR) = '', NULL, t.RECRUITMENT_MENTOR) IS NULL, f.RECRUITMENT_MENTOR, t.RECRUITMENT_MENTOR),
  TYPE_OF_CLIENT = IF(IF(TRIM(t.TYPE_OF_CLIENT) = '', NULL, t.TYPE_OF_CLIENT) IS NULL, f.TYPE_OF_CLIENT, t.TYPE_OF_CLIENT),
  ST_DT_PUSHBACK_REASON = IF(IF(TRIM(t.ST_DT_PUSHBACK_REASON) = '', NULL, t.ST_DT_PUSHBACK_REASON) IS NULL, f.ST_DT_PUSHBACK_REASON, t.ST_DT_PUSHBACK_REASON),
  PRIMARY_SALES_PERSON = IF(IF(TRIM(t.PRIMARY_SALES_PERSON) = '', NULL, t.PRIMARY_SALES_PERSON) IS NULL, f.PRIMARY_SALES_PERSON, t.PRIMARY_SALES_PERSON),
  SECONDARY_SALES_PERSON = IF(IF(TRIM(t.SECONDARY_SALES_PERSON) = '', NULL, t.SECONDARY_SALES_PERSON) IS NULL, f.SECONDARY_SALES_PERSON, t.SECONDARY_SALES_PERSON),
  CREDENTIALING_SPECIALIST = IF(IF(TRIM(t.CREDENTIALING_SPECIALIST) = '', NULL, t.CREDENTIALING_SPECIALIST) IS NULL, f.CREDENTIALING_SPECIALIST, t.CREDENTIALING_SPECIALIST),
  CREDENTIALING_LEAD = IF(IF(TRIM(t.CREDENTIALING_LEAD) = '', NULL, t.CREDENTIALING_LEAD) IS NULL, f.CREDENTIALING_LEAD, t.CREDENTIALING_LEAD),
  SECONDARY_RECRUITER = IF(IF(TRIM(t.SECONDARY_RECRUITER) = '', NULL, t.SECONDARY_RECRUITER) IS NULL, f.SECONDARY_RECRUITER, t.SECONDARY_RECRUITER),
  SECONDARY_RECRUITER_EMP_NO = IF(IF(TRIM(t.SECONDARY_RECRUITER_EMP_NO) = '', NULL, t.SECONDARY_RECRUITER_EMP_NO) IS NULL, f.SECONDARY_RECRUITER_EMP_NO, t.SECONDARY_RECRUITER_EMP_NO)
FROM (
  SELECT k.pid, k.keep_id, k.kept_row_id,
    ARRAY_AGG(IF(TRIM(o.CLIENT_NAME_IN_CONREP) = '', NULL, o.CLIENT_NAME_IN_CONREP) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CLIENT_NAME_IN_CONREP,
    ARRAY_AGG(o.WEEKLY_WALLET_MONEY IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS WEEKLY_WALLET_MONEY,
    ARRAY_AGG(o.ONB_CAND_DOB IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_CAND_DOB,
    ARRAY_AGG(IF(TRIM(o.ONB_I9_RECIEVED) = '', NULL, o.ONB_I9_RECIEVED) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_I9_RECIEVED,
    ARRAY_AGG(IF(TRIM(o.ONB_SUPP_DOC1) = '', NULL, o.ONB_SUPP_DOC1) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_SUPP_DOC1,
    ARRAY_AGG(o.ONB_SUPP_DOC1_EXP_DT IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_SUPP_DOC1_EXP_DT,
    ARRAY_AGG(IF(TRIM(o.ONB_SUPP_DOC2) = '', NULL, o.ONB_SUPP_DOC2) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_SUPP_DOC2,
    ARRAY_AGG(o.ONB_SUPP_DOC2_EXP_DT IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_SUPP_DOC2_EXP_DT,
    ARRAY_AGG(IF(TRIM(o.ONB_E_VERIFY) = '', NULL, o.ONB_E_VERIFY) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ONB_E_VERIFY,
    ARRAY_AGG(IF(TRIM(o.BGC_CATEGORY1) = '', NULL, o.BGC_CATEGORY1) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_CATEGORY1,
    ARRAY_AGG(o.BGC_AMOUNT1 IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_AMOUNT1,
    ARRAY_AGG(IF(TRIM(o.BGC_CATEGORY2) = '', NULL, o.BGC_CATEGORY2) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_CATEGORY2,
    ARRAY_AGG(o.BGC_AMOUNT2 IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_AMOUNT2,
    ARRAY_AGG(IF(TRIM(o.BGC_CATEGORY3) = '', NULL, o.BGC_CATEGORY3) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_CATEGORY3,
    ARRAY_AGG(o.BGC_AMOUNT3 IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_AMOUNT3,
    ARRAY_AGG(o.BGC_TOTAL_BGV_COST IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_TOTAL_BGV_COST,
    ARRAY_AGG(IF(TRIM(o.BGC_AGENCY_NAME) = '', NULL, o.BGC_AGENCY_NAME) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BGC_AGENCY_NAME,
    ARRAY_AGG(IF(TRIM(o.DIVERSITY_STATUS) = '', NULL, o.DIVERSITY_STATUS) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS DIVERSITY_STATUS,
    ARRAY_AGG(IF(TRIM(o.BACKOUT_OR_TERMINATION) = '', NULL, o.BACKOUT_OR_TERMINATION) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS BACKOUT_OR_TERMINATION,
    ARRAY_AGG(IF(TRIM(o.CLIENT_RECRUITER) = '', NULL, o.CLIENT_RECRUITER) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CLIENT_RECRUITER,
    ARRAY_AGG(IF(TRIM(o.CLIENT_PAYMENT_TERMS) = '', NULL, o.CLIENT_PAYMENT_TERMS) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CLIENT_PAYMENT_TERMS,
    ARRAY_AGG(IF(TRIM(o.INVOICE_CYCLE_TO_CLIENT) = '', NULL, o.INVOICE_CYCLE_TO_CLIENT) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS INVOICE_CYCLE_TO_CLIENT,
    ARRAY_AGG(IF(TRIM(o.CANDIDATE_PAYMENT_TERMS) = '', NULL, o.CANDIDATE_PAYMENT_TERMS) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CANDIDATE_PAYMENT_TERMS,
    ARRAY_AGG(IF(TRIM(o.PO_RECEIVED) = '', NULL, o.PO_RECEIVED) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS PO_RECEIVED,
    ARRAY_AGG(IF(TRIM(o.PAYLOCITY_ID) = '', NULL, o.PAYLOCITY_ID) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS PAYLOCITY_ID,
    ARRAY_AGG(IF(TRIM(o.COMMENTS) = '', NULL, o.COMMENTS) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS COMMENTS,
    ARRAY_AGG(IF(TRIM(o.ENTITY) = '', NULL, o.ENTITY) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ENTITY,
    ARRAY_AGG(o.FIFTYTWO_TENURE_RTO_LASTDATE IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS FIFTYTWO_TENURE_RTO_LASTDATE,
    ARRAY_AGG(IF(TRIM(o.FIFTYTWO_TENURE_CANDIDATE_STATUS) = '', NULL, o.FIFTYTWO_TENURE_CANDIDATE_STATUS) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS FIFTYTWO_TENURE_CANDIDATE_STATUS,
    ARRAY_AGG(IF(TRIM(o.RECRUITMENT_MENTOR) = '', NULL, o.RECRUITMENT_MENTOR) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS RECRUITMENT_MENTOR,
    ARRAY_AGG(IF(TRIM(o.TYPE_OF_CLIENT) = '', NULL, o.TYPE_OF_CLIENT) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS TYPE_OF_CLIENT,
    ARRAY_AGG(IF(TRIM(o.ST_DT_PUSHBACK_REASON) = '', NULL, o.ST_DT_PUSHBACK_REASON) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS ST_DT_PUSHBACK_REASON,
    ARRAY_AGG(IF(TRIM(o.PRIMARY_SALES_PERSON) = '', NULL, o.PRIMARY_SALES_PERSON) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS PRIMARY_SALES_PERSON,
    ARRAY_AGG(IF(TRIM(o.SECONDARY_SALES_PERSON) = '', NULL, o.SECONDARY_SALES_PERSON) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS SECONDARY_SALES_PERSON,
    ARRAY_AGG(IF(TRIM(o.CREDENTIALING_SPECIALIST) = '', NULL, o.CREDENTIALING_SPECIALIST) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CREDENTIALING_SPECIALIST,
    ARRAY_AGG(IF(TRIM(o.CREDENTIALING_LEAD) = '', NULL, o.CREDENTIALING_LEAD) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS CREDENTIALING_LEAD,
    ARRAY_AGG(IF(TRIM(o.SECONDARY_RECRUITER) = '', NULL, o.SECONDARY_RECRUITER) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS SECONDARY_RECRUITER,
    ARRAY_AGG(IF(TRIM(o.SECONDARY_RECRUITER_EMP_NO) = '', NULL, o.SECONDARY_RECRUITER_EMP_NO) IGNORE NULLS ORDER BY o.LAST_UPDATED DESC LIMIT 1)[SAFE_OFFSET(0)] AS SECONDARY_RECRUITER_EMP_NO
  FROM (
    SELECT DISTINCT CAST(b.PLACEMENT_ID AS STRING) pid, m.keep_id,
      FIRST_VALUE(b.ID) OVER (PARTITION BY b.PLACEMENT_ID ORDER BY b.LAST_UPDATED DESC) kept_row_id,
      FIRST_VALUE(b.PLACEMENT_STATUS) OVER (PARTITION BY b.PLACEMENT_ID ORDER BY b.LAST_UPDATED DESC) kept_status
    FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate` b
    JOIN (SELECT DISTINCT pid, keep_id FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`) m
      ON CAST(b.PLACEMENT_ID AS STRING) = m.pid
  ) k
  LEFT JOIN `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate` o
    ON CAST(o.PLACEMENT_ID AS STRING) = k.pid AND o.ID != k.kept_row_id
   AND IFNULL(o.PLACEMENT_STATUS, '') = IFNULL(k.kept_status, '')
  GROUP BY k.pid, k.keep_id, k.kept_row_id
) f
WHERE t.ID = f.kept_row_id;

-- 2b) Older run-rate rows of those placements: removed (they are in the backup).
DELETE FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` t
WHERE CAST(t.PLACEMENT_ID AS STRING) IN (SELECT pid FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`)
  AND t.ID NOT IN (
    SELECT ARRAY_AGG(b.ID ORDER BY b.LAST_UPDATED DESC LIMIT 1)[OFFSET(0)]
    FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate` b GROUP BY b.PLACEMENT_ID);

-- 2c) Deal sheet + logs: old id -> kept id, same placement only.
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` x SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m
WHERE x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

UPDATE `cynetdatabase.rr_project_data.all_CH_Deal_sheet_data` x SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m
WHERE x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

UPDATE `cynetdatabase.rr_project_data.ownership_change_logs` x SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m
WHERE x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

UPDATE `cynetdatabase.rr_project_data.ch_rate_change_logs` x SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m
WHERE x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

UPDATE `cynetdatabase.rr_project_data.ch_termination_reason_logs` x SET CONTRACT_ID = m.keep_id
FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map` m
WHERE x.CONTRACT_ID = m.old_id AND CAST(x.PLACEMENT_ID AS STRING) = m.pid;

COMMIT TRANSACTION;

-- ============================================================================================
-- 3) VERIFY (read-only). Every number must be 0 except kept_rows (= map placements).
-- ============================================================================================
WITH p AS (SELECT DISTINCT pid, keep_id FROM `cynetdatabase.rr_project_data.fix_20261123_contract_id_map`)
SELECT
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r JOIN p ON CAST(r.PLACEMENT_ID AS STRING) = p.pid) AS kept_rows,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r JOIN p ON CAST(r.PLACEMENT_ID AS STRING) = p.pid
     WHERE r.CONTRACT_ID != p.keep_id) AS runrate_wrong_id,
  (SELECT COUNT(*) - COUNT(DISTINCT PLACEMENT_ID) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r JOIN p ON CAST(r.PLACEMENT_ID AS STRING) = p.pid) AS runrate_dupes,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d JOIN p ON CAST(d.PLACEMENT_ID AS STRING) = p.pid
     WHERE d.CONTRACT_ID != p.keep_id) AS deal_sheet_wrong_id;

-- ============================================================================================
-- ROLLBACK (only if needed)
-- ============================================================================================
-- DELETE FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE ID IN (SELECT ID FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate`);
-- INSERT INTO `cynetdatabase.rr_project_data.all_CH_data_runrate` SELECT * FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_runrate`;
-- UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` x SET CONTRACT_ID = b.CONTRACT_ID
--   FROM `cynetdatabase.rr_project_data.bkp_20261123_cid_remint_deal_sheet` b WHERE x.ID = b.ID;
-- (logs: UPDATE ... SET CONTRACT_ID = m.old_id from the map, same PLACEMENT_ID, rows in the log backups)
