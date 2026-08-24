-- Delete the Cynet Health Canada test rows and every log row they produced.
--
-- Scope: ONLY placements that live in cynet_health_canada_deal_sheet. Cynet health and locums rows
-- are never touched — every statement below is keyed on PLACEMENT_IDs read out of the Canada table.
--
-- Run STEP 1 first and read the counts. Run STEP 3 (the deletes) only once those look right, and
-- run the Canada deal sheet delete LAST — the log deletes read their key list from it.
--
-- Log tables written during a Canada sync run:
--   ch_additional_cost_logs      per row, from the enrich pipeline
--   ch_termination_reason_logs   per row, from the enrich pipeline
--   ownership_change_logs        recruiter-handover + hierarchy moves (PLACEMENT_ID is STRING here)
--   inorganic_hierarchy_logs     table-wide audit scan
--   ch_rate_change_logs          has NO PLACEMENT_ID — keyed on CONTRACT_ID (see STEP 2)


-- ---------------------------------------------------------------------------
-- STEP 1 — what is about to be deleted. Read these counts before deleting anything.
-- ---------------------------------------------------------------------------
WITH canada_keys AS (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
)
SELECT 'cynet_health_canada_deal_sheet' AS table_name, COUNT(*) AS rows_to_delete
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
UNION ALL
SELECT 'ch_additional_cost_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_keys)
UNION ALL
SELECT 'ch_termination_reason_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_keys)
UNION ALL
SELECT 'ownership_change_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
-- PLACEMENT_ID is STRING on this table, so cast the key side to match.
WHERE PLACEMENT_ID IN (SELECT CAST(PLACEMENT_ID AS STRING) FROM canada_keys)
UNION ALL
SELECT 'inorganic_hierarchy_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_keys)
ORDER BY table_name;


-- ---------------------------------------------------------------------------
-- STEP 2 — ch_rate_change_logs has no PLACEMENT_ID, only CONTRACT_ID.
--
-- A CONTRACT_ID can be shared with a cynet health row, so deleting by contract alone could remove a
-- health log. This picks only contracts that exist in Canada AND nowhere else. Run it and check the
-- count; if it is 0 (likely, since rate-change logs need a rate change to occur) skip the delete.
-- ---------------------------------------------------------------------------
WITH canada_contracts AS (
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
),
other_contracts AS (
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL
  UNION DISTINCT
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL
)
SELECT COUNT(*) AS rate_change_rows_to_delete
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (
  SELECT CONTRACT_ID FROM canada_contracts
  EXCEPT DISTINCT
  SELECT CONTRACT_ID FROM other_contracts
);


-- ---------------------------------------------------------------------------
-- STEP 3 — the deletes.
--
-- ORDER MATTERS: the log deletes read their key list from the Canada deal sheet, so that table must
-- be emptied LAST. Running its DELETE first would leave every log row orphaned and undeletable.
-- ---------------------------------------------------------------------------

-- 3a. Additional cost logs
DELETE FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 3b. Termination reason logs
DELETE FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 3c. Ownership change logs (PLACEMENT_ID is STRING here)
DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT CAST(PLACEMENT_ID AS STRING)
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 3d. Inorganic hierarchy logs
DELETE FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 3e. Rate change logs — ONLY if STEP 2 returned a non-zero count.
-- DELETE FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
-- WHERE CONTRACT_ID IN (
--   SELECT DISTINCT CONTRACT_ID
--   FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
--   WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
--   EXCEPT DISTINCT
--   SELECT DISTINCT CONTRACT_ID
--   FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
--   WHERE CONTRACT_ID IS NOT NULL
--   EXCEPT DISTINCT
--   SELECT DISTINCT CONTRACT_ID
--   FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
--   WHERE CONTRACT_ID IS NOT NULL
-- );

-- 3f. LAST: the Canada deal sheet itself.
DELETE FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
WHERE TRUE;


-- ---------------------------------------------------------------------------
-- STEP 4 — Firestore, not BigQuery.
--
-- The CONTRACT_ID counter lives outside BigQuery and survives these deletes. Its stored nextValue
-- always wins over config.startValue, so unless the doc is deleted the next run carries on from the
-- old number instead of restarting at CAC1000.
--
-- Delete this document in the Firebase console (project runrate-505913):
--   workspaces/run-rate-tool/contractIdSequences/cynet_health_canada_deal_sheet
--
-- NOTE: it currently reads nextValue 23270, which is a CHC (cynet health) range number, not CAC.
-- Delete it so the next Canada run starts at CAC1000.
--
-- Also clear this domain's sync checkpoints so the next run rescans from page 1:
--   workspaces/run-rate-tool/dealSheetSyncCheckpoints/active-records-canada
--   workspaces/run-rate-tool/dealSheetSyncCheckpoints/active-deal-sheet-update-cursor-canada
--   workspaces/run-rate-tool/dealSheetSyncCheckpoints/active-deal-sheet-insert-page-cursor-canada
--
-- Do NOT touch the -health or -locums documents, or cynet_health_deal_sheet's counter.


-- ---------------------------------------------------------------------------
-- STEP 5 — verify everything is gone (expect 0 across the board).
-- ---------------------------------------------------------------------------
-- SELECT 'canada_deal_sheet' AS t, COUNT(*) c
-- FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
-- UNION ALL SELECT 'health_deal_sheet_UNCHANGED', COUNT(*)
-- FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`;
