-- Fix NEW_HIRE_DATE on DEAL placements that started 2026-04-01 but are really continuations
-- (Nexus created a new DEAL instead of an EXTENSION). Their NEW_HIRE_DATE came from the new
-- placement's own BOOKED note (late March 2026) instead of the original hire.
-- Scope: cynet_health_deal_sheet only. Code is unchanged; NEW_HIRE_DATE freeze keeps the fixed value.
--
-- Source of the correct value, per Apr-1 DEAL (same CANDIDATE_ID + CLIENT_ID always required;
-- DID NOT START / ENDED<30 DEALs are never used as a source):
--   SAME_CONTRACT : earliest earlier DEAL on the same CONTRACT_ID
--   CROSS_CONTRACT: earlier DEAL on another CONTRACT_ID that ended 2026-03-25..2026-03-31,
--                   then the earliest DEAL on that contract
--   CONTRACT_HIST : no earlier DEAL; earliest NEW_HIRE_DATE on the same contract's other rows
--                   (active extensions + run-rate) that is before the Apr-1 DEAL's date
-- Downstream EXTENSION rows that copied the wrong Apr-1 value are fixed too.

-- 1) Map
CREATE OR REPLACE TABLE `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_map` AS
WITH p AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    WHERE PLACEMENT_ID IS NOT NULL
  ) WHERE rn = 1
),
valid_deal AS (
  SELECT * FROM p
  WHERE DEAL_TYPE = 'DEAL'
    AND UPPER(IFNULL(PLACEMENT_STATUS, '')) NOT IN ('DID NOT START', 'ENDED<30')
    AND NEW_HIRE_DATE IS NOT NULL
),
apr AS (
  SELECT * FROM p WHERE DEAL_TYPE = 'DEAL' AND START_DATE = DATE '2026-04-01'
),
same_contract AS (
  SELECT a.PLACEMENT_ID,
    ARRAY_AGG(STRUCT(v.PLACEMENT_ID AS src_pid, v.CONTRACT_ID AS src_contract, v.NEW_HIRE_DATE AS nhd)
              ORDER BY v.START_DATE, v.NEW_HIRE_DATE LIMIT 1)[OFFSET(0)] s
  FROM apr a JOIN valid_deal v
    ON v.CONTRACT_ID = a.CONTRACT_ID AND v.START_DATE < DATE '2026-04-01'
   AND v.CANDIDATE_ID = a.CANDIDATE_ID AND v.CLIENT_ID = a.CLIENT_ID
  GROUP BY 1
),
cross_prev AS (
  SELECT a.PLACEMENT_ID,
    ARRAY_AGG(v.CONTRACT_ID ORDER BY v.END_DATE DESC LIMIT 1)[OFFSET(0)] prev_contract
  FROM apr a JOIN valid_deal v
    ON v.CONTRACT_ID != a.CONTRACT_ID AND v.START_DATE < DATE '2026-04-01'
   AND v.END_DATE BETWEEN DATE '2026-03-25' AND DATE '2026-03-31'
   AND v.CANDIDATE_ID = a.CANDIDATE_ID AND v.CLIENT_ID = a.CLIENT_ID
  WHERE a.PLACEMENT_ID NOT IN (SELECT PLACEMENT_ID FROM same_contract)
  GROUP BY 1
),
cross_contract AS (
  SELECT c.PLACEMENT_ID,
    ARRAY_AGG(STRUCT(v.PLACEMENT_ID AS src_pid, v.CONTRACT_ID AS src_contract, v.NEW_HIRE_DATE AS nhd)
              ORDER BY v.START_DATE, v.NEW_HIRE_DATE LIMIT 1)[OFFSET(0)] s
  FROM cross_prev c JOIN apr a USING (PLACEMENT_ID)
  JOIN valid_deal v
    ON v.CONTRACT_ID = c.prev_contract AND v.START_DATE < DATE '2026-04-01'
   AND v.CANDIDATE_ID = a.CANDIDATE_ID AND v.CLIENT_ID = a.CLIENT_ID
  GROUP BY 1
),
hist_rows AS (
  SELECT CONTRACT_ID, CAST(PLACEMENT_ID AS STRING) pid, NEW_HIRE_DATE
  FROM p WHERE DEAL_TYPE = 'EXTENSION' AND NEW_HIRE_DATE IS NOT NULL
  UNION ALL
  SELECT CAST(CONTRACT_ID AS STRING), CAST(PLACEMENT_ID AS STRING), SAFE_CAST(NEW_HIRE_DATE AS TIMESTAMP)
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` WHERE NEW_HIRE_DATE IS NOT NULL
),
contract_hist AS (
  SELECT a.PLACEMENT_ID,
    STRUCT(CAST(NULL AS INT64) AS src_pid, a.CONTRACT_ID AS src_contract, MIN(h.NEW_HIRE_DATE) AS nhd) s
  FROM apr a JOIN hist_rows h
    ON h.CONTRACT_ID = a.CONTRACT_ID AND DATE(h.NEW_HIRE_DATE) < DATE(a.NEW_HIRE_DATE)
  WHERE a.PLACEMENT_ID NOT IN (SELECT PLACEMENT_ID FROM same_contract)
    AND a.PLACEMENT_ID NOT IN (SELECT PLACEMENT_ID FROM cross_contract)
  GROUP BY a.PLACEMENT_ID, a.CONTRACT_ID
),
resolved AS (
  SELECT PLACEMENT_ID, 'SAME_CONTRACT' grp, s FROM same_contract
  UNION ALL SELECT PLACEMENT_ID, 'CROSS_CONTRACT', s FROM cross_contract
  UNION ALL SELECT PLACEMENT_ID, 'CONTRACT_HIST', s FROM contract_hist
)
SELECT a.PLACEMENT_ID, a.CONTRACT_ID, a.CANDIDATE_NAME, a.CANDIDATE_ID, a.CLIENT_ID,
  r.grp, r.s.src_pid, r.s.src_contract,
  a.NEW_HIRE_DATE AS old_nhd, r.s.nhd AS new_nhd
FROM apr a JOIN resolved r USING (PLACEMENT_ID)
WHERE r.s.nhd IS NOT NULL AND r.s.nhd != a.NEW_HIRE_DATE;

-- 1b) Where the source DEAL itself came right after an EXTENSION on its contract, that source DEAL is
-- also a mistaken rebook: use the source contract's earliest NEW_HIRE_DATE (active + run-rate) instead.
UPDATE `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_map` m
SET new_nhd = h.older, grp = CONCAT(m.grp, '_EXT_CHAIN')
FROM (
  SELECT CONTRACT_ID, MIN(nhd) older FROM (
    SELECT CONTRACT_ID, NEW_HIRE_DATE nhd FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    UNION ALL
    SELECT CAST(CONTRACT_ID AS STRING), SAFE_CAST(NEW_HIRE_DATE AS TIMESTAMP) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  ) WHERE nhd IS NOT NULL GROUP BY 1
) h
WHERE h.CONTRACT_ID = m.src_contract
  AND EXISTS (
    SELECT 1 FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` e
    JOIN `cynetdatabase.rr_project_data.cynet_health_deal_sheet` s ON s.PLACEMENT_ID = m.src_pid
    WHERE e.CONTRACT_ID = m.src_contract AND e.DEAL_TYPE = 'EXTENSION' AND e.START_DATE <= s.START_DATE
  );

-- 2) Downstream extensions (same contract as the Apr-1 DEAL, started after it) carrying the wrong value
CREATE OR REPLACE TABLE `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_ext_map` AS
SELECT DISTINCT e.PLACEMENT_ID, e.CONTRACT_ID, m.PLACEMENT_ID AS apr_pid, m.old_nhd, m.new_nhd
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` e
JOIN `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_map` m
  ON e.CONTRACT_ID = m.CONTRACT_ID AND e.CANDIDATE_ID = m.CANDIDATE_ID
WHERE e.DEAL_TYPE = 'EXTENSION' AND e.START_DATE > DATE '2026-04-01'
  AND e.NEW_HIRE_DATE = m.old_nhd;

-- 3) Backup (run before the updates)
-- CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261013_nhd_apr1_cynet_health_deal_sheet` AS
-- SELECT * FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`;

-- 4) Updates
-- UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
-- SET NEW_HIRE_DATE = m.new_nhd
-- FROM `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_map` m
-- WHERE t.PLACEMENT_ID = m.PLACEMENT_ID AND t.NEW_HIRE_DATE = m.old_nhd;
--
-- UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
-- SET NEW_HIRE_DATE = m.new_nhd
-- FROM `cynetdatabase.rr_project_data.tmp_20261013_nhd_apr1_fix_ext_map` m
-- WHERE t.PLACEMENT_ID = m.PLACEMENT_ID AND t.NEW_HIRE_DATE = m.old_nhd;
