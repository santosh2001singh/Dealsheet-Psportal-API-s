-- Migrate CONTRACT_ID from INT64 to STRING for prefixed per-table ids (CHC1000, CAC1000, LOC1000).
-- Run in BigQuery BEFORE deploying updated Firebase functions.
--
-- Runtime allocation: functions/src/contractIdResolver.js + contractIdSequence.js
-- Per-table Firestore docs: workspaces/run-rate-tool/contractIdSequences/{table_id} starting at seq 1000.
--
-- WARNING: DROP COLUMN removes existing CONTRACT_ID values (numeric legacy ids).

-- =============================================================================
-- Active deal sheet tables
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

-- =============================================================================
-- Ended deal sheet tables
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

-- =============================================================================
-- Log tables
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;

ALTER TABLE `cynetdatabase.rr_project_data.ch_termination_reason_logs`
  DROP COLUMN IF EXISTS CONTRACT_ID;
ALTER TABLE `cynetdatabase.rr_project_data.ch_termination_reason_logs`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING;
