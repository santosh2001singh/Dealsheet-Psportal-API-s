-- Add PLACEMENT_ID to ch_rate_change_logs and fill it for the rows already there (2,558 on 2026-10-09).
--
-- New rows: the sync writes PLACEMENT_ID from the deal-sheet version the NEW snapshot was read from
-- (syncService.buildRateChangeLogRow). Old rows never stored it, so each is matched back to a
-- placement across every deal sheet table (active + ended, health / locums / canada):
--   - candidates: same CONTRACT_ID, or same candidate name;
--   - usable only if contract + (start or name) line up, or name + start line up;
--   - score: contract 4, start 2, name 2, SKU 1, status 1, end date 1, FINAL_BILL_RATE 2, FINAL_PAY_RATE 2
--     (best version of each placement);
--   - the single top-scoring placement wins; a tie stays NULL (listed by step 5).
-- 2026-10-09 dry run: 2,541 matched (all 2,478 one-placement CONTRACT_ID + START_DATE rows agree with
-- the score), 17 ties left NULL — mostly locums candidates with several shifts on the same start date.
--
-- Run BEFORE deploying the functions that write PLACEMENT_ID: until the column exists the insert
-- drops that key silently (ignoreUnknownValues).

-- 1. Backup.
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.ch_rate_change_logs_backup_20261009`
COPY `cynetdatabase.rr_project_data.ch_rate_change_logs`;

-- 2. Column (INT64, same as the deal sheets and the other log tables).
ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs`
  ADD COLUMN IF NOT EXISTS PLACEMENT_ID INT64;

-- 3. Fill. Expected ~2,541 rows.
UPDATE `cynetdatabase.rr_project_data.ch_rate_change_logs` t
SET PLACEMENT_ID = m.PLACEMENT_ID
FROM (
  WITH ds AS (
  SELECT SAFE_CAST(CAST(PLACEMENT_ID AS STRING) AS INT64) pid, UPPER(TRIM(CONTRACT_ID)) c, UPPER(TRIM(SKU_NUMBER)) s,
         LOWER(REGEXP_REPLACE(TRIM(CANDIDATE_NAME), r'\s+', ' ')) n, START_DATE sd, END_DATE ed,
         UPPER(TRIM(PLACEMENT_STATUS)) st, ROUND(SAFE_CAST(FINAL_BILL_RATE AS FLOAT64), 2) fbr, ROUND(SAFE_CAST(FINAL_PAY_RATE AS FLOAT64), 2) fpr
  FROM (
    SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  )
),
l AS (
  SELECT ID, UPPER(TRIM(CONTRACT_ID)) c, UPPER(TRIM(SKU_NUMBER)) s, LOWER(REGEXP_REPLACE(TRIM(CANDIDATE_NAME), r'\s+', ' ')) n,
         START_DATE sd, END_DATE ed, UPPER(TRIM(PLACEMENT_STATUS)) st,
         ROUND(SAFE_CAST(NEW_FINAL_BILL_RATE AS FLOAT64), 2) fbr, ROUND(SAFE_CAST(NEW_FINAL_PAY_RATE AS FLOAT64), 2) fpr
  FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
),
-- Each version of a candidate placement scored against the log row; a placement keeps its best version.
scored AS (
  SELECT l.ID, ds.pid,
         MAX(IF(ds.c = l.c, 1, 0)) c_ok, MAX(IF(ds.sd = l.sd, 1, 0)) sd_ok, MAX(IF(ds.n = l.n, 1, 0)) n_ok,
         MAX(  IF(ds.c = l.c, 4, 0) + IF(ds.sd = l.sd, 2, 0) + IF(ds.n = l.n, 2, 0) + IF(ds.s = l.s, 1, 0)
             + IF(ds.st = l.st, 1, 0) + IF(ds.ed IS NOT DISTINCT FROM l.ed, 1, 0)
             + IF(ds.fbr = l.fbr, 2, 0) + IF(ds.fpr = l.fpr, 2, 0)) score
  FROM l JOIN ds ON ds.c = l.c OR ds.n = l.n
  WHERE ds.pid IS NOT NULL
  GROUP BY 1, 2
),
-- Usable only when the contract or the start date lines up as well as the name / contract.
eligible AS (
  SELECT * FROM scored WHERE (c_ok = 1 AND (sd_ok = 1 OR n_ok = 1)) OR (n_ok = 1 AND sd_ok = 1)
),
ranked AS (
  SELECT ID, pid, score,
         RANK() OVER (PARTITION BY ID ORDER BY score DESC) rk,
         COUNT(*) OVER (PARTITION BY ID, score) same_score
  FROM eligible
),
pick AS (
  SELECT ID, pid AS PLACEMENT_ID FROM ranked WHERE rk = 1 AND same_score = 1
)
  SELECT ID, PLACEMENT_ID FROM pick
) m
WHERE t.ID = m.ID
  AND t.PLACEMENT_ID IS NULL;

-- 4. Check: expected filled ~2,541, empty ~17.
SELECT COUNTIF(PLACEMENT_ID IS NOT NULL) AS filled, COUNTIF(PLACEMENT_ID IS NULL) AS empty
FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`;

-- 5. Rows left NULL (ties), with their candidate placements, for a manual look.
WITH ds AS (
  SELECT SAFE_CAST(CAST(PLACEMENT_ID AS STRING) AS INT64) pid, UPPER(TRIM(CONTRACT_ID)) c, UPPER(TRIM(SKU_NUMBER)) s,
         LOWER(REGEXP_REPLACE(TRIM(CANDIDATE_NAME), r'\s+', ' ')) n, START_DATE sd, END_DATE ed,
         UPPER(TRIM(PLACEMENT_STATUS)) st, ROUND(SAFE_CAST(FINAL_BILL_RATE AS FLOAT64), 2) fbr, ROUND(SAFE_CAST(FINAL_PAY_RATE AS FLOAT64), 2) fpr
  FROM (
    SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
    UNION ALL SELECT PLACEMENT_ID, CONTRACT_ID, SKU_NUMBER, CANDIDATE_NAME, START_DATE, END_DATE, PLACEMENT_STATUS, FINAL_BILL_RATE, FINAL_PAY_RATE FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  )
),
l AS (
  SELECT ID, UPPER(TRIM(CONTRACT_ID)) c, UPPER(TRIM(SKU_NUMBER)) s, LOWER(REGEXP_REPLACE(TRIM(CANDIDATE_NAME), r'\s+', ' ')) n,
         START_DATE sd, END_DATE ed, UPPER(TRIM(PLACEMENT_STATUS)) st,
         ROUND(SAFE_CAST(NEW_FINAL_BILL_RATE AS FLOAT64), 2) fbr, ROUND(SAFE_CAST(NEW_FINAL_PAY_RATE AS FLOAT64), 2) fpr
  FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`
),
-- Each version of a candidate placement scored against the log row; a placement keeps its best version.
scored AS (
  SELECT l.ID, ds.pid,
         MAX(IF(ds.c = l.c, 1, 0)) c_ok, MAX(IF(ds.sd = l.sd, 1, 0)) sd_ok, MAX(IF(ds.n = l.n, 1, 0)) n_ok,
         MAX(  IF(ds.c = l.c, 4, 0) + IF(ds.sd = l.sd, 2, 0) + IF(ds.n = l.n, 2, 0) + IF(ds.s = l.s, 1, 0)
             + IF(ds.st = l.st, 1, 0) + IF(ds.ed IS NOT DISTINCT FROM l.ed, 1, 0)
             + IF(ds.fbr = l.fbr, 2, 0) + IF(ds.fpr = l.fpr, 2, 0)) score
  FROM l JOIN ds ON ds.c = l.c OR ds.n = l.n
  WHERE ds.pid IS NOT NULL
  GROUP BY 1, 2
),
-- Usable only when the contract or the start date lines up as well as the name / contract.
eligible AS (
  SELECT * FROM scored WHERE (c_ok = 1 AND (sd_ok = 1 OR n_ok = 1)) OR (n_ok = 1 AND sd_ok = 1)
),
ranked AS (
  SELECT ID, pid, score,
         RANK() OVER (PARTITION BY ID ORDER BY score DESC) rk,
         COUNT(*) OVER (PARTITION BY ID, score) same_score
  FROM eligible
),
pick AS (
  SELECT ID, pid AS PLACEMENT_ID FROM ranked WHERE rk = 1 AND same_score = 1
)
SELECT r.ID, l.c AS CONTRACT_ID, l.n AS CANDIDATE_NAME, l.sd AS START_DATE, l.st AS PLACEMENT_STATUS,
       r.pid AS CANDIDATE_PLACEMENT_ID, r.score
FROM ranked r
JOIN l USING (ID)
WHERE r.rk = 1 AND r.same_score > 1
ORDER BY l.c, r.ID, r.pid;
