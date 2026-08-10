-- Per-role ownership handover audit log. One row per role (RECRUITER / ONSITE_AM / LEVEL_2_CSM /
-- LEVEL_3_CSM / LEVEL_4_CSM, plus a "vacated" hierarchy role like RM when that person became the
-- recruiter) whose owner changed between a placement's latest deal-sheet row and the row before it.
-- Populated by syncOwnershipChangeLogsFromBigQuery at the end of dealSheetSyncUpdateTrigger.
-- The deal-sheet rows themselves are never modified by this scan.
--
-- OWNERSHIP_EFFECTIVE_DATE starts as the deal's TENTATIVE_END_DATE + 1 day (temporary). Once a real extension
-- exists for the same CONTRACT_ID, dealSheetSyncTrigger overwrites OWNERSHIP_EFFECTIVE_DATE with that
-- extension's START_DATE (see overwriteOwnershipChangeLogEffectiveDatesFromExtensions).
--
-- Table already exists in BigQuery; the ALTER below adds the CONTRACT_ID column this feature needs.

CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.ownership_change_logs` (
  ID STRING,
  LAST_UPDATED TIMESTAMP,
  SKU_NO STRING,
  PLACEMENT_ID STRING,
  CANDIDATE_NAME STRING,
  CANDIDATE_EMAIL STRING,
  START_DATE DATE,
  OWNERSHIP_EFFECTIVE_DATE DATE,
  END_DATE_PREVIOUS_OWNER DATE,
  OWNERSHIP_ROLE STRING,
  NEW_OWNER_NAME STRING,
  NEW_OWNER_EMP_NO STRING,
  PREVIOUS_OWNER_NAME STRING,
  PREVIOUS_OWNER_EMP_NO STRING,
  CHANGE_REASON_NOTES STRING,
  STATUS_REMARKS STRING,
  EDITED_BY STRING,
  CONTRACT_ID STRING
);

-- Idempotent column add for the pre-existing table.
ALTER TABLE `cynetdatabase.rr_project_data.ownership_change_logs`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;
