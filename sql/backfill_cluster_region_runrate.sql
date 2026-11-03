-- Cluster / region backfill — RUN-RATE. Run AFTER backfill_cluster_region.sql (deal sheet).
--
-- Table: cynetdatabase.rr_project_data.all_CH_data_runrate
-- Copies RECRUITER_CLUSTER_REGION, CLIENT_CLUSTER_REGION, CLUSTER_TYPE from the cynet health deal sheet
-- onto the run-rate rows that came from an approved deal sheet:
--   - the run-rate row carries a DEAL_SHEET_ID
--   - some version of that deal sheet has MOVE_RUNRATE = TRUE
-- The value is the deal sheet's newest version for that DEAL_SHEET_ID. A blank deal sheet value never
-- blanks the run-rate; only a value that differs is written.
--
-- Step 1 backs up the three columns for every run-rate row. Rollback:
--   UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` r
--   SET RECRUITER_CLUSTER_REGION = b.RECRUITER_CLUSTER_REGION,
--       CLIENT_CLUSTER_REGION = b.CLIENT_CLUSTER_REGION,
--       CLUSTER_TYPE = b.CLUSTER_TYPE
--   FROM `cynetdatabase.rr_project_data.bkp_20261028_cluster_region_runrate` b
--   WHERE r.ID = b.ID;
--
-- The last statement returns how many rows the UPDATE touched.

DECLARE changed_rows INT64 DEFAULT 0;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261028_cluster_region_runrate` AS
SELECT ID, DEAL_SHEET_ID, PLACEMENT_ID, RECRUITER_CLUSTER_REGION, CLIENT_CLUSTER_REGION, CLUSTER_TYPE,
       CURRENT_TIMESTAMP() AS BACKED_UP_AT
FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`;

CREATE TEMP TABLE src AS
SELECT
  DEAL_SHEET_ID,
  ARRAY_AGG(NULLIF(TRIM(IFNULL(RECRUITER_CLUSTER_REGION, '')), '')
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST LIMIT 1)[OFFSET(0)] AS rec,
  ARRAY_AGG(NULLIF(TRIM(IFNULL(CLIENT_CLUSTER_REGION, '')), '')
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST LIMIT 1)[OFFSET(0)] AS cli,
  ARRAY_AGG(NULLIF(TRIM(IFNULL(CLUSTER_TYPE, '')), '')
            ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST LIMIT 1)[OFFSET(0)] AS typ
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE DEAL_SHEET_ID IS NOT NULL
GROUP BY DEAL_SHEET_ID
HAVING LOGICAL_OR(UPPER(TRIM(IFNULL(MOVE_RUNRATE, ''))) = 'TRUE');

SET changed_rows = (
  SELECT COUNT(*)
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r
  JOIN src s ON r.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  WHERE (s.rec IS NOT NULL AND IFNULL(TRIM(r.RECRUITER_CLUSTER_REGION), '') != s.rec)
     OR (s.cli IS NOT NULL AND IFNULL(TRIM(r.CLIENT_CLUSTER_REGION), '') != s.cli)
     OR (s.typ IS NOT NULL AND IFNULL(TRIM(r.CLUSTER_TYPE), '') != s.typ)
);

UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` r
SET
  RECRUITER_CLUSTER_REGION = IFNULL(s.rec, r.RECRUITER_CLUSTER_REGION),
  CLIENT_CLUSTER_REGION = IFNULL(s.cli, r.CLIENT_CLUSTER_REGION),
  CLUSTER_TYPE = IFNULL(s.typ, r.CLUSTER_TYPE)
FROM src s
WHERE r.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  AND ((s.rec IS NOT NULL AND IFNULL(TRIM(r.RECRUITER_CLUSTER_REGION), '') != s.rec)
    OR (s.cli IS NOT NULL AND IFNULL(TRIM(r.CLIENT_CLUSTER_REGION), '') != s.cli)
    OR (s.typ IS NOT NULL AND IFNULL(TRIM(r.CLUSTER_TYPE), '') != s.typ));

SELECT 'all_CH_data_runrate' AS table_id, changed_rows;
