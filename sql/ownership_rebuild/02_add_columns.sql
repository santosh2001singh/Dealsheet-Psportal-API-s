-- STEP 2 of the ownership_change_logs rebuild: three new columns. Existing columns are untouched.
--
--   INITIAL_START_DATE          the contract's first start date.
--                               data team rows: their START_DATE.
--                               system rows:    the deal sheet's INITIAL_START_DATE.
--   EFFECTIVE_DATE_SOURCE       where OWNERSHIP_EFFECTIVE_DATE came from:
--                               DATA_TEAM        loaded from Cluster_Data.ownership_data, never rewritten
--                               END_PLUS_1       system row, the placement's END_DATE + 1 (provisional)
--                               TENTATIVE_PLUS_1 system row, no END_DATE, TENTATIVE_END_DATE + 1 (provisional)
--                               EXTENSION_START  system row, overwritten with the next extension's START_DATE (final)
--   EFFECTIVE_DATE_PLACEMENT_ID the placement whose date was used (the anchor placement for *_PLUS_1,
--                               the next extension for EXTENSION_START). NULL for data team rows.

ALTER TABLE `cynetdatabase.rr_project_data.ownership_change_logs`
  ADD COLUMN IF NOT EXISTS INITIAL_START_DATE DATE,
  ADD COLUMN IF NOT EXISTS EFFECTIVE_DATE_SOURCE STRING,
  ADD COLUMN IF NOT EXISTS EFFECTIVE_DATE_PLACEMENT_ID STRING;
