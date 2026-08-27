-- Repair the 34 CONTRACT_ID collisions in CHC23000..CHC23033.
--
-- WHAT HAPPENED: the Firestore sequence counter was created with startValue 23000 and the first ~34
-- mints went out TWICE — once around 07-27..08-17, once around 08-06..08-26 — so each of
-- CHC23000..CHC23033 sits on two unrelated candidates. The counter has since advanced normally
-- (max in table = 23269), so this is a bounded, historical block, NOT an ongoing leak.
--
-- STRATEGY: the earliest deal sheet per id keeps it (claim_rank = 1); the later one is re-issued a
-- fresh id above everything ever used. Re-issuing the LATER row is the safer half: it has had less
-- time to accumulate downstream references.
--
-- ORDER OF OPERATIONS — do not skip step 0.
--   0. Freeze the counter above the repair range (below) so a concurrent sync cannot hand out an id
--      this script is about to assign.
--   1. Run section 1 and SAVE the output. It is the mapping you are about to apply.
--   2. Run section 2 (deal sheet UPDATE).
--   3. Run section 3 for EACH log table.
--   4. Run section 4 to verify zero collisions remain.
--
-- STEP 0 (Firestore, manual — do this FIRST):
--   workspaces/run-rate-tool/contractIdSequences/cynet_health_deal_sheet
--   set nextValue = 23400   (comfortably above max 23269 + the 34 ids issued below)
--   The code change in contractIdSequence.js now also floors the counter at the table's own max, so
--   this is belt-and-braces rather than the only defence.

-- ---------------------------------------------------------------------------------------------
-- SECTION 1 — Build and INSPECT the remap. Save this output before changing anything.
--   New ids start at 23300, leaving 23270..23299 as a gap so an in-flight sync cannot land on them.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE TABLE `cynetdatabase.rr_project_data.contract_id_collision_remap` AS
WITH latest AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
      ORDER BY LAST_UPDATED DESC NULLS LAST
    ) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ) WHERE rn = 1
),
colliding AS (
  SELECT CONTRACT_ID
  FROM latest
  WHERE CONTRACT_ID IS NOT NULL
  GROUP BY CONTRACT_ID
  HAVING COUNT(DISTINCT CAST(CANDIDATE_ID AS STRING)) > 1
),
-- Aggregate to one row per (id, candidate) FIRST. Ranking in the same SELECT as the GROUP BY made
-- the window ORDER BY reference an ungrouped column, which BigQuery rejects.
per_candidate AS (
  SELECT
    l.CONTRACT_ID AS old_contract_id,
    CAST(l.CANDIDATE_ID AS STRING) AS candidate_id,
    ANY_VALUE(l.CANDIDATE_NAME) AS candidate_name,
    MIN(l.DEAL_SHEET_CREATED_DATE) AS first_created
  FROM latest l
  JOIN colliding c USING (CONTRACT_ID)
  GROUP BY l.CONTRACT_ID, CAST(l.CANDIDATE_ID AS STRING)
),
-- Then rank: claim_rank 1 keeps the id, 2+ gets re-issued.
claims AS (
  SELECT
    old_contract_id,
    candidate_id,
    candidate_name,
    first_created,
    ROW_NUMBER() OVER (
      PARTITION BY old_contract_id
      ORDER BY first_created ASC, candidate_id ASC
    ) AS claim_rank
  FROM per_candidate
)
SELECT
  old_contract_id,
  candidate_id,
  candidate_name,
  first_created,
  claim_rank,
  CONCAT('CHC', CAST(23300 + ROW_NUMBER() OVER (ORDER BY old_contract_id, claim_rank) - 1 AS STRING))
    AS new_contract_id
FROM claims
WHERE claim_rank > 1;

-- Inspect before proceeding. Expect 34 rows, new ids CHC23300..CHC23333, no duplicates.
SELECT * FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`
ORDER BY old_contract_id;

SELECT
  COUNT(*) AS remap_rows,
  COUNT(DISTINCT new_contract_id) AS distinct_new_ids,   -- must equal remap_rows
  MIN(new_contract_id) AS first_new,
  MAX(new_contract_id) AS last_new
FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`;

-- Safety: none of the new ids may already exist anywhere. Must return 0 rows.
SELECT r.new_contract_id
FROM `cynetdatabase.rr_project_data.contract_id_collision_remap` r
WHERE r.new_contract_id IN (
  SELECT CONTRACT_ID FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
);

-- ---------------------------------------------------------------------------------------------
-- SECTION 2 — Apply to the deal sheet.
--   Matched on (CONTRACT_ID, CANDIDATE_ID) so ALL of the losing candidate's append-history rows move
--   together and the winning candidate's rows are untouched.
-- ---------------------------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET CONTRACT_ID = r.new_contract_id
FROM `cynetdatabase.rr_project_data.contract_id_collision_remap` r
WHERE d.CONTRACT_ID = r.old_contract_id
  AND CAST(d.CANDIDATE_ID AS STRING) = r.candidate_id;

-- ---------------------------------------------------------------------------------------------
-- SECTION 3 — Log tables, keyed on CONTRACT_ID.
--   ch_rate_change_logs returned "no data" for the colliding ids, so it needs nothing. Run the
--   SELECT for each table below FIRST; only run the UPDATE where the SELECT returns rows.
--   Note: a log table without CANDIDATE_ID cannot be split automatically — inspect those by hand.
-- ---------------------------------------------------------------------------------------------
-- 3a. Which log tables are actually affected?
SELECT 'ch_rate_change_logs' AS tbl, COUNT(*) AS rows_affected
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (SELECT old_contract_id FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`)
UNION ALL
SELECT 'ownership_change_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE CONTRACT_ID IN (SELECT old_contract_id FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`)
UNION ALL
SELECT 'ch_termination_reason_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_termination_reason_logs`
WHERE CONTRACT_ID IN (SELECT old_contract_id FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`)
UNION ALL
SELECT 'ch_additional_cost_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`
WHERE CONTRACT_ID IN (SELECT old_contract_id FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`)
UNION ALL
SELECT 'inorganic_hierarchy_logs', COUNT(*)
FROM `cynetdatabase.rr_project_data.inorganic_hierarchy_logs`
WHERE CONTRACT_ID IN (SELECT old_contract_id FROM `cynetdatabase.rr_project_data.contract_id_collision_remap`);

-- 3b. Template — run per affected table that carries CANDIDATE_ID.
-- UPDATE `cynetdatabase.rr_project_data.ownership_change_logs` t
-- SET CONTRACT_ID = r.new_contract_id
-- FROM `cynetdatabase.rr_project_data.contract_id_collision_remap` r
-- WHERE t.CONTRACT_ID = r.old_contract_id
--   AND CAST(t.CANDIDATE_ID AS STRING) = r.candidate_id;

-- ---------------------------------------------------------------------------------------------
-- SECTION 4 — Verify. Both queries must return zero rows.
-- ---------------------------------------------------------------------------------------------
WITH latest AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
      ORDER BY LAST_UPDATED DESC NULLS LAST
    ) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ) WHERE rn = 1
)
SELECT CONTRACT_ID, COUNT(DISTINCT CAST(CANDIDATE_ID AS STRING)) AS candidates
FROM latest
WHERE CONTRACT_ID IS NOT NULL
GROUP BY CONTRACT_ID
HAVING candidates > 1;

-- No candidate should hold two ids for what is one contract (same client + same start).
WITH latest AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
      ORDER BY LAST_UPDATED DESC NULLS LAST
    ) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ) WHERE rn = 1
)
SELECT CAST(CANDIDATE_ID AS STRING) AS candidate_id, CLIENT_ID, START_DATE,
       COUNT(DISTINCT CONTRACT_ID) AS ids
FROM latest
WHERE CONTRACT_ID IS NOT NULL
GROUP BY candidate_id, CLIENT_ID, START_DATE
HAVING ids > 1;
