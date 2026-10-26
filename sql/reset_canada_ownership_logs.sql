-- Reset Cynet Health Canada's ownership_change_logs (and any inorganic_hierarchy_logs) so the Canada
-- trigger rebuilds them from the first deal-sheet version (Sep 2026).
--
-- Why: Canada's ownership log is now ON and also records recruiter-hierarchy seats (Canada has no
-- inorganic hierarchy). The Canada rows already in the table were written by the health move scan
-- before the audit scans were domain-scoped, so they follow health's rules, not Canada's. Deleting
-- them before the first Canada run lets the full-history scan write the whole log afresh — and stops
-- the old rows from blocking new ones through the (placement, role, new, previous) dedupe.
--
-- Keyed ONLY on PLACEMENT_IDs read from the Canada deal sheet; health and locums rows are untouched.
-- Run STEP 1, check the counts, then STEP 2. Do it BEFORE the first Canada trigger run on the new code.


-- STEP 1 — counts
WITH canada_placements AS (
  SELECT DISTINCT CAST(PLACEMENT_ID AS STRING) AS pid
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
)
SELECT 'ownership_change_logs' AS table_name, COUNT(*) AS canada_rows
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE PLACEMENT_ID IN (SELECT pid FROM canada_placements)
UNION ALL
SELECT 'inorganic_hierarchy_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE CAST(PLACEMENT_ID AS STRING) IN (SELECT pid FROM canada_placements);


-- STEP 2 — deletes
DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT CAST(PLACEMENT_ID AS STRING)
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

DELETE FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE CAST(PLACEMENT_ID AS STRING) IN (
  SELECT DISTINCT CAST(PLACEMENT_ID AS STRING)
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);
