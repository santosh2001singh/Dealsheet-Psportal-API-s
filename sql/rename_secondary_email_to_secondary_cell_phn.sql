-- Rename SECONDARY_EMAIL -> SECONDARY_CELL_PHN across all deal sheet tables (Aug 2026).
--
-- The column was a manual, user-edited email field. It now holds the candidate's secondary cell
-- number, sourced from Nexus candidate_contact_info[].leap_phone, and is API-owned: the enrichment
-- pipeline overwrites it on every sync (see API_OWNED_COLUMNS in functions/src/columnMappings.js).
--
-- Because the old contents are email addresses, they are cleared after the rename so no email ever
-- surfaces in a phone column. Run this ONCE, before deploying the code change.
--
-- BigQuery's RENAME COLUMN has no IF EXISTS guard, so re-running a statement that already succeeded
-- errors with "Column not found: SECONDARY_EMAIL". That is safe to ignore on a partial re-run --
-- verify with the final query at the bottom instead.

-- ---------------------------------------------------------------------------
-- 1. Rename -- active tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

-- ---------------------------------------------------------------------------
-- 2. Rename -- ended tables
-- ---------------------------------------------------------------------------
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  RENAME COLUMN SECONDARY_EMAIL TO SECONDARY_CELL_PHN;

-- ---------------------------------------------------------------------------
-- 3. Clear the carried-over email values
-- ---------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  SET SECONDARY_CELL_PHN = NULL WHERE SECONDARY_CELL_PHN IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Verify -- expect 6 rows, all with column_name = SECONDARY_CELL_PHN and no
--    SECONDARY_EMAIL left anywhere.
-- ---------------------------------------------------------------------------
SELECT table_name, column_name, data_type
FROM `cynetdatabase.rr_project_data.INFORMATION_SCHEMA.COLUMNS`
WHERE column_name IN ('SECONDARY_EMAIL', 'SECONDARY_CELL_PHN')
ORDER BY table_name;
