-- START_DATE swap for the LOG tables (2026-11-19), same rule as start_date_swap_20261119.sql:
--   START_DATE           <- the placement's original start (INITIAL_START_DATE)
--   EXTENSION_START_DATE <- the log row's own start (old START_DATE) on extensions / re-booked DEALs
-- Tables: ownership_change_logs (system rows only; data team rows untouched), ch_rate_change_logs,
-- ch_additional_cost_logs. EXTENSION_START_DATE column added first (ALTER ... ADD COLUMN IF NOT EXISTS).
-- Original start / deal type come from the placement's latest deal-sheet row (Health: the pre-swap backup;
-- ended tables call it ORIGINAL_START_DATE). Rerun-safe: every value is computed from the backups.

-- 0) BACKUPS (run once)
-- CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ownership_change_logs` AS SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs`;
-- CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_rate_change_logs` AS SELECT * FROM `cynetdatabase.rr_project_data.ch_rate_change_logs`;
-- CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_additional_cost_logs` AS SELECT * FROM `cynetdatabase.rr_project_data.ch_additional_cost_logs`;

-- 1) NEW COLUMN
-- ALTER TABLE `cynetdatabase.rr_project_data.ownership_change_logs` ADD COLUMN IF NOT EXISTS EXTENSION_START_DATE DATE;
-- ALTER TABLE `cynetdatabase.rr_project_data.ch_rate_change_logs` ADD COLUMN IF NOT EXISTS EXTENSION_START_DATE DATE;
-- ALTER TABLE `cynetdatabase.rr_project_data.ch_additional_cost_logs` ADD COLUMN IF NOT EXISTS EXTENSION_START_DATE DATE;

-- 2) BACKFILL
CREATE TEMP TABLE pl AS
SELECT CAST(PLACEMENT_ID AS STRING) AS pid, init, dt
FROM (
  SELECT PLACEMENT_ID, INITIAL_START_DATE AS init, DEAL_TYPE AS dt, LAST_UPDATED FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_deal_sheet`
  UNION ALL SELECT PLACEMENT_ID, ORIGINAL_START_DATE, DEAL_TYPE, LAST_UPDATED FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
  UNION ALL SELECT PLACEMENT_ID, INITIAL_START_DATE, DEAL_TYPE, LAST_UPDATED FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
  UNION ALL SELECT PLACEMENT_ID, INITIAL_START_DATE, DEAL_TYPE, LAST_UPDATED FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
  UNION ALL SELECT PLACEMENT_ID, INITIAL_START_DATE, DEAL_TYPE, LAST_UPDATED FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
  UNION ALL SELECT PLACEMENT_ID, ORIGINAL_START_DATE, DEAL_TYPE, LAST_UPDATED FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
)
WHERE PLACEMENT_ID IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY CAST(PLACEMENT_ID AS STRING) ORDER BY LAST_UPDATED DESC NULLS LAST) = 1;

CREATE TEMP TABLE log_new AS
WITH src AS (
  SELECT 'ownership' AS t, CAST(b.ID AS STRING) AS id, b.START_DATE AS own,
         COALESCE(b.INITIAL_START_DATE, p.init) AS init, p.dt
  FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ownership_change_logs` b
  LEFT JOIN pl p ON p.pid = CAST(b.PLACEMENT_ID AS STRING)
  WHERE b.PLACEMENT_ID IS NOT NULL AND b.EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'
  UNION ALL
  SELECT 'rate', CAST(b.ID AS STRING), b.START_DATE, p.init, p.dt
  FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_rate_change_logs` b
  LEFT JOIN pl p ON p.pid = CAST(b.PLACEMENT_ID AS STRING)
  WHERE b.PLACEMENT_ID IS NOT NULL
  UNION ALL
  SELECT 'addcost', CAST(b.ID AS STRING), b.START_DATE, p.init, p.dt
  FROM `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ch_additional_cost_logs` b
  LEFT JOIN pl p ON p.pid = CAST(b.PLACEMENT_ID AS STRING)
  WHERE b.PLACEMENT_ID IS NOT NULL
)
SELECT t, id, own,
  IF(init IS NOT NULL AND own IS NOT NULL AND init <= own, init, own) AS new_start,
  IF(own IS NOT NULL AND (STRPOS(UPPER(IFNULL(dt, '')), 'EXTENSION') > 0 OR (init IS NOT NULL AND init < own)),
     own, CAST(NULL AS DATE)) AS new_ext
FROM src;

BEGIN TRANSACTION;

UPDATE `cynetdatabase.rr_project_data.ownership_change_logs` x
SET START_DATE = s.new_start, EXTENSION_START_DATE = s.new_ext
FROM (SELECT * FROM log_new WHERE t = 'ownership') s
WHERE CAST(x.ID AS STRING) = s.id AND x.EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC';

UPDATE `cynetdatabase.rr_project_data.ch_rate_change_logs` x
SET START_DATE = s.new_start, EXTENSION_START_DATE = s.new_ext
FROM (SELECT * FROM log_new WHERE t = 'rate') s
WHERE CAST(x.ID AS STRING) = s.id;

UPDATE `cynetdatabase.rr_project_data.ch_additional_cost_logs` x
SET START_DATE = s.new_start, EXTENSION_START_DATE = s.new_ext
FROM (SELECT * FROM log_new WHERE t = 'addcost') s
WHERE CAST(x.ID AS STRING) = s.id;

COMMIT TRANSACTION;

-- 3) VERIFY (run separately). Every number must be 0.
-- SELECT 'ownership' t,
--   COUNTIF(COALESCE(n.EXTENSION_START_DATE, n.START_DATE) IS DISTINCT FROM b.START_DATE) own_start_broken,
--   COUNTIF(b.EDITED_BY = 'DATA_TEAM_SYNC' AND (n.START_DATE IS DISTINCT FROM b.START_DATE OR n.EXTENSION_START_DATE IS NOT NULL)) data_team_touched,
--   COUNTIF(n.ID IS NULL OR b.ID IS NULL) row_mismatch
-- FROM `cynetdatabase.rr_project_data.ownership_change_logs` n
-- FULL JOIN `cynetdatabase.rr_project_data.bkp_20261119_start_swap_ownership_change_logs` b USING (ID)
-- (same shape for ch_rate_change_logs / ch_additional_cost_logs)

-- ROLLBACK: UPDATE <log table> x SET START_DATE = b.START_DATE, EXTENSION_START_DATE = NULL
--           FROM <backup> b WHERE x.ID = b.ID;
