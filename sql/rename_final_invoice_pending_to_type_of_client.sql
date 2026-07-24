-- STEP 1 of 2 — RENAME column FINAL_INVOICE_PENDING -> TYPE_OF_CLIENT on ALL deal-sheet tables.
-- Run this BEFORE deploying the code (the enrich pipeline now writes TYPE_OF_CLIENT; if the column
-- is still named FINAL_INVOICE_PENDING the streaming insert fails with "unknown field").
-- Rename is metadata-only (instant, keeps existing values). Then run the backfill (STEP 2).
--
-- Run: bq query --use_legacy_sql=false --project_id=cynetdatabase < this_file.sql

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`         RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`  RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`         RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`        RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
ALTER TABLE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`        RENAME COLUMN FINAL_INVOICE_PENDING TO TYPE_OF_CLIENT;
