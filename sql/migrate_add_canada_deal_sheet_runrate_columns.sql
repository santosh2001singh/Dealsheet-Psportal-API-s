-- Canada deal sheet schema alignment (cynet_health_canada_deal_sheet ONLY).
-- No data push / INSERT — schema changes only. Existing row data is preserved on rename.
--
-- Column notes (no new column):
--   CANDIDATE_NO            -> PHONE_NUMBER (already on table)
--   RECRUITER_CHANGE_DATE   -> EFFECTIVE_DATE (already on table)
--   W2_PAY_RATE             -> T4_PAY_RATE (renamed below; data kept)

-- =============================================================================
-- Part 1 — Add new columns
-- =============================================================================

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  ADD COLUMN IF NOT EXISTS CONTRACT_ID STRING,
  ADD COLUMN IF NOT EXISTS DT_RATE FLOAT64,
  ADD COLUMN IF NOT EXISTS CLIENT_DT_RATE FLOAT64,
  ADD COLUMN IF NOT EXISTS BEFORE_EXTENSION_RECRUITER STRING,
  ADD COLUMN IF NOT EXISTS ONSITE_AM_EMAIL STRING,
  ADD COLUMN IF NOT EXISTS DELIVERYPOC_EMAIL STRING,
  ADD COLUMN IF NOT EXISTS EXTENSION_START_DATE DATE,
  ADD COLUMN IF NOT EXISTS SECONDARY_PHN STRING,
  ADD COLUMN IF NOT EXISTS CLIENT_AVERAGING_AGREEMENT STRING,
  ADD COLUMN IF NOT EXISTS CANDIDATE_AVERAGING_AGREEMENT STRING,
  ADD COLUMN IF NOT EXISTS TOTAL_EXT_RECD INT64;

-- =============================================================================
-- Part 2 — Rename W2_PAY_RATE -> T4_PAY_RATE (existing data preserved)
-- =============================================================================

ALTER TABLE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  RENAME COLUMN IF EXISTS W2_PAY_RATE TO T4_PAY_RATE;
