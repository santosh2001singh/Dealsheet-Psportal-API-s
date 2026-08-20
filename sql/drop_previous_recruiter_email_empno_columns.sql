-- Drop PREVIOUS_RECRUITER_EMAIL + PREVIOUS_RECRUITER_EMP_NO from all deal sheet tables (Aug 2026).
--
-- The sync no longer writes PREVIOUS_RECRUITER_* to the deal sheet at all -- the frontend derives the
-- previous recruiter itself. PREVIOUS_RECRUITER_NAME is KEPT (it still holds values written before
-- this change) but is never populated on new rows; the EMAIL and EMP_NO columns are dropped.
--
-- Ownership logging is unaffected: the RECRUITER ownership_change_logs row now comes from the
-- latest-vs-previous pair scan and from the in-memory __PREV_RECRUITER_* fields captured on a
-- recruiter change, not from these columns.
--
-- Run this ONCE in BigQuery AFTER deploying the functions change (the deployed code must have stopped
-- writing/selecting the columns first, or streaming inserts and the ownership scans will fail).

-- ---------------------------------------------------------------------------
-- 1. Drop columns -- active tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

-- ---------------------------------------------------------------------------
-- 2. Drop columns -- ended tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMAIL,
  DROP COLUMN IF EXISTS PREVIOUS_RECRUITER_EMP_NO;

-- ---------------------------------------------------------------------------
-- 3. Verify -- expect 0 rows
-- ---------------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
WHERE column_name IN ('PREVIOUS_RECRUITER_EMAIL', 'PREVIOUS_RECRUITER_EMP_NO')
  AND table_name IN (
    'cynet_health_deal_sheet',
    'cynet_health_canada_deal_sheet',
    'cynet_locums_deal_sheet',
    'cynet_health_ended_deal_sheet',
    'cynet_health_canada_ended_deal_sheet',
    'cynet_locums_ended_deal_sheet'
  )
ORDER BY table_name, column_name;
