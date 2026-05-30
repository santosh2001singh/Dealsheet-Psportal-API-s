-- Drop CA_GM and CA_NM from all domain-routed active and ended deal sheet tables.
--
-- CA_GM was previously populated only for CLIENT_STATE = CA (copy of GROSS_MARGIN);
-- the enrichment pipeline no longer writes it.
-- CA_NM was never written by the sync pipeline.
-- GROSS_MARGIN continues to receive Nexus hourly_revenue for every state (CA or not).
--
-- Run this migration in BigQuery before the next sync after deploying the code change.

-- =============================================================================
-- cynet_health_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;

-- =============================================================================
-- cynet_health_canada_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;

-- =============================================================================
-- cynet_locums_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;

-- =============================================================================
-- cynet_health_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;

-- =============================================================================
-- cynet_health_canada_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;

-- =============================================================================
-- cynet_locums_ended_deal_sheet
-- =============================================================================
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  DROP COLUMN IF EXISTS CA_GM,
  DROP COLUMN IF EXISTS CA_NM;
