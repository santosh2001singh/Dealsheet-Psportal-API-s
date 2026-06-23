-- Add ONSITE_AM_EMAIL STRING column to all active + ended domain-routed deal sheet tables.
-- Populated from Nexus Users API email on the sales rep user (same source as ONSITE_AM).
-- Run this migration in BigQuery before relying on the new column.

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;

ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING;
