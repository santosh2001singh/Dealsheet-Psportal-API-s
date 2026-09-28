-- Count, then delete, ONLY the Cynet Health Canada rows in the five log tables.
--
-- Unlike sql/cleanup_canada_test_rows.sql, this does NOT touch
-- cynet_health_canada_deal_sheet itself — only the log rows keyed off its placements/contracts.
-- Health and locums rows in these same log tables are never touched: every DELETE below is keyed on
-- PLACEMENT_ID / CONTRACT_ID values read out of the Canada deal sheet table, and the rate-change
-- delete explicitly excludes any contract id that also appears in health or locums.
--
-- Run STEP 1 first and read the counts. Run STEP 2 (the deletes) only once those look right.


-- ---------------------------------------------------------------------------
-- STEP 1 — counts. Read these before deleting anything.
-- ---------------------------------------------------------------------------
WITH canada_placement_keys AS (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
),
canada_contracts AS (
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
SELECT 'ch_additional_cost_logs' AS table_name, COUNT(*) AS canada_rows
FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_placement_keys)

UNION ALL
SELECT 'ch_termination_reason_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_placement_keys)

UNION ALL
-- PLACEMENT_ID is STRING on this table, so the key side is cast to match.
SELECT 'ownership_change_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE PLACEMENT_ID IN (SELECT CAST(PLACEMENT_ID AS STRING) FROM canada_placement_keys)

UNION ALL
SELECT 'inorganic_hierarchy_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM canada_placement_keys)

UNION ALL
-- ch_rate_change_logs has NO PLACEMENT_ID, only CONTRACT_ID — and a CONTRACT_ID can in principle be
-- shared with a health/locums row, so only contracts that exist in Canada AND NOWHERE ELSE count.
SELECT 'ch_rate_change_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (
  SELECT CONTRACT_ID FROM canada_contracts
  EXCEPT DISTINCT
  SELECT CONTRACT_ID FROM other_contracts
)
ORDER BY table_name;


-- ---------------------------------------------------------------------------
-- STEP 2 — the deletes. Run only after checking STEP 1's counts.
-- No ordering constraint between these five: none of them read from each other, only from the
-- (untouched) Canada deal sheet table.
-- ---------------------------------------------------------------------------

-- 2a. Additional cost logs
DELETE FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 2b. Termination reason logs
DELETE FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 2c. Ownership change logs (PLACEMENT_ID is STRING here)
DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT CAST(PLACEMENT_ID AS STRING)
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 2d. Inorganic hierarchy logs
DELETE FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE PLACEMENT_ID IN (
  SELECT DISTINCT PLACEMENT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE PLACEMENT_ID IS NOT NULL
);

-- 2e. Rate change logs — contract ids that belong ONLY to Canada.
DELETE FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  EXCEPT DISTINCT
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL
  EXCEPT DISTINCT
  SELECT DISTINCT CONTRACT_ID
  FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  WHERE CONTRACT_ID IS NOT NULL
);


-- ---------------------------------------------------------------------------
-- STEP 3 — verify. All five should read 0; re-run STEP 1's query, or:
-- ---------------------------------------------------------------------------
-- SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
-- WHERE PLACEMENT_ID IN (SELECT PLACEMENT_ID FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` WHERE PLACEMENT_ID IS NOT NULL);
