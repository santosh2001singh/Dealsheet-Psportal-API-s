-- CONTRACT_ID collisions: one id shared by two or more DIFFERENT candidates.
--
-- Root cause (Aug 2026): the Firestore sequence counter
-- workspaces/run-rate-tool/contractIdSequences/cynet_health_deal_sheet never advanced past its
-- configured startValue (23000), so consecutive runs re-minted the SAME block CHC23000..CHC23033.
-- Symptom is a CONTIGUOUS run of ids starting exactly at startValue, each on exactly 2 candidates.
--
-- Run 1 and 2 BEFORE repairing anything: 1 tells you the blast radius, 2 tells you whether the
-- counter is still stuck (if it is, a repair now just gets re-collided on the next sync).

-- 1. Every colliding id, with the candidates and the runs that minted them.
WITH latest AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
      ORDER BY LAST_UPDATED DESC NULLS LAST
    ) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  ) WHERE rn = 1
)
SELECT
  CONTRACT_ID,
  COUNT(DISTINCT CAST(CANDIDATE_ID AS STRING))            AS distinct_candidates,
  COUNT(*)                                                AS placement_rows,
  STRING_AGG(DISTINCT CANDIDATE_NAME, ' | ')              AS candidates,
  STRING_AGG(DISTINCT CAST(DEAL_SHEET_ID AS STRING), ',') AS deal_sheet_ids,
  MIN(DEAL_SHEET_CREATED_DATE)                            AS first_created,
  MAX(DEAL_SHEET_CREATED_DATE)                            AS last_created
FROM latest
WHERE CONTRACT_ID IS NOT NULL
GROUP BY CONTRACT_ID
HAVING distinct_candidates > 1
ORDER BY CONTRACT_ID;

-- 2. Is the counter still stuck? Highest id actually in the table.
--    Compare against Firestore workspaces/run-rate-tool/contractIdSequences/cynet_health_deal_sheet.
--    A nextValue at/below this max means the NEXT sync will collide again.
SELECT
  MAX(CAST(REGEXP_EXTRACT(CONTRACT_ID, r'^CHC(\d+)$') AS INT64)) AS max_seq_in_table,
  COUNT(DISTINCT CONTRACT_ID)                                    AS distinct_ids
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE REGEXP_CONTAINS(CONTRACT_ID, r'^CHC\d+$');

-- 3. Which candidate should KEEP the id, and which needs a new one.
--    Rule: earliest DEAL_SHEET_CREATED_DATE keeps it (it minted first); later ones get re-issued.
--    Review this list by hand before running any UPDATE.
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
)
SELECT
  l.CONTRACT_ID,
  l.CANDIDATE_ID,
  l.CANDIDATE_NAME,
  l.DEAL_SHEET_ID,
  l.PLACEMENT_ID,
  l.FACILITY_NAME,
  l.START_DATE,
  l.DEAL_SHEET_CREATED_DATE,
  ROW_NUMBER() OVER (
    PARTITION BY l.CONTRACT_ID
    ORDER BY l.DEAL_SHEET_CREATED_DATE ASC, CAST(l.CANDIDATE_ID AS STRING) ASC
  ) AS claim_rank   -- 1 = keeps the id, >1 = needs a fresh id
FROM latest l
JOIN colliding c USING (CONTRACT_ID)
ORDER BY l.CONTRACT_ID, claim_rank;

-- 4. Downstream contamination: the log tables are all keyed on CONTRACT_ID, so every colliding id
--    has mixed two candidates' history together. Check each before repairing.
--    (Swap in ch_rate_change_logs / ownership_change_logs / ch_termination_reason_logs.)
SELECT CONTRACT_ID, COUNT(*) AS log_rows
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
WHERE CONTRACT_ID IN (
  SELECT CONTRACT_ID FROM (
    SELECT CONTRACT_ID
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    WHERE CONTRACT_ID IS NOT NULL
    GROUP BY CONTRACT_ID
    HAVING COUNT(DISTINCT CAST(CANDIDATE_ID AS STRING)) > 1
  )
)
GROUP BY CONTRACT_ID
ORDER BY CONTRACT_ID;
