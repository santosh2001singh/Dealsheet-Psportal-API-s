-- 2026-11-02: extensions read the recruiter region on the original start (INITIAL_START_DATE), as RR-Dashboard
-- does with ch_run_rate.START_DATE. Step 0: tmp_20261102_cluster_resolved = buildClusterRegionResolvedSql (dropped after).
-- Rollback: UPDATE the 3 columns FROM bkp_20261102_ext_start_region / bkp_20261102_ext_start_region_runrate ON ID.

CREATE OR REPLACE TABLE `cynetdatabase.rr_project_data.tmp_20261102_ext_scope` AS
WITH latest AS (
  SELECT DEAL_SHEET_ID, START_DATE, INITIAL_START_DATE, DATE(EXTENSION_DATE) AS ext,
         RECRUITER_CLUSTER_REGION cur_rec, CLIENT_CLUSTER_REGION cur_cli, CLUSTER_TYPE cur_t
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE DEAL_SHEET_ID IS NOT NULL AND UPPER(TRIM(IFNULL(DEAL_TYPE,''))) IN ('EXTENSION','EXT')
  QUALIFY ROW_NUMBER() OVER (PARTITION BY DEAL_SHEET_ID ORDER BY LAST_UPDATED DESC NULLS LAST, EDIT_DATE DESC NULLS LAST) = 1
)
SELECT l.*, s.recruiter_code, s.client_code, s.client_cluster_type, s.programme, s.as_of_date, s.as_of_date_source
FROM latest l
JOIN `cynetdatabase.rr_project_data.tmp_20261102_cluster_resolved` s USING (DEAL_SHEET_ID)
WHERE (l.INITIAL_START_DATE >= DATE '2026-06-01' OR l.START_DATE >= DATE '2026-06-01' OR l.ext >= DATE '2026-06-01')
  AND ((s.recruiter_code IS NOT NULL AND IFNULL(TRIM(l.cur_rec), '') != s.recruiter_code)
    OR (s.client_code IS NOT NULL AND IFNULL(TRIM(l.cur_cli), '') != s.client_code)
    OR (s.client_cluster_type IS NOT NULL AND IFNULL(TRIM(l.cur_t), '') != s.client_cluster_type));

DECLARE ds_rows INT64 DEFAULT 0;
DECLARE rr_rows INT64 DEFAULT 0;

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261102_ext_start_region` AS
SELECT d.ID, d.DEAL_SHEET_ID, d.PLACEMENT_ID, d.RECRUITER_CLUSTER_REGION, d.CLIENT_CLUSTER_REGION, d.CLUSTER_TYPE,
       CURRENT_TIMESTAMP() AS BACKED_UP_AT
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
WHERE d.DEAL_SHEET_ID IN (SELECT DEAL_SHEET_ID FROM `cynetdatabase.rr_project_data.tmp_20261102_ext_scope`);

CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261102_ext_start_region_runrate` AS
SELECT r.ID, r.DEAL_SHEET_ID, r.PLACEMENT_ID, r.RECRUITER_CLUSTER_REGION, r.CLIENT_CLUSTER_REGION, r.CLUSTER_TYPE,
       CURRENT_TIMESTAMP() AS BACKED_UP_AT
FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r
WHERE r.DEAL_SHEET_ID IN (SELECT DEAL_SHEET_ID FROM `cynetdatabase.rr_project_data.tmp_20261102_ext_scope`);

SET ds_rows = (
  SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
  JOIN `cynetdatabase.rr_project_data.tmp_20261102_ext_scope` s USING (DEAL_SHEET_ID)
  WHERE (s.recruiter_code IS NOT NULL AND IFNULL(TRIM(d.RECRUITER_CLUSTER_REGION), '') != s.recruiter_code)
     OR (s.client_code IS NOT NULL AND IFNULL(TRIM(d.CLIENT_CLUSTER_REGION), '') != s.client_code)
     OR (s.client_cluster_type IS NOT NULL AND IFNULL(TRIM(d.CLUSTER_TYPE), '') != s.client_cluster_type));

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET RECRUITER_CLUSTER_REGION = IFNULL(s.recruiter_code, d.RECRUITER_CLUSTER_REGION),
    CLIENT_CLUSTER_REGION = IFNULL(s.client_code, d.CLIENT_CLUSTER_REGION),
    CLUSTER_TYPE = IFNULL(s.client_cluster_type, d.CLUSTER_TYPE)
FROM `cynetdatabase.rr_project_data.tmp_20261102_ext_scope` s
WHERE d.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  AND ((s.recruiter_code IS NOT NULL AND IFNULL(TRIM(d.RECRUITER_CLUSTER_REGION), '') != s.recruiter_code)
    OR (s.client_code IS NOT NULL AND IFNULL(TRIM(d.CLIENT_CLUSTER_REGION), '') != s.client_code)
    OR (s.client_cluster_type IS NOT NULL AND IFNULL(TRIM(d.CLUSTER_TYPE), '') != s.client_cluster_type));

SET rr_rows = (
  SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r
  JOIN `cynetdatabase.rr_project_data.tmp_20261102_ext_scope` s USING (DEAL_SHEET_ID)
  WHERE (s.recruiter_code IS NOT NULL AND IFNULL(TRIM(r.RECRUITER_CLUSTER_REGION), '') != s.recruiter_code)
     OR (s.client_code IS NOT NULL AND IFNULL(TRIM(r.CLIENT_CLUSTER_REGION), '') != s.client_code)
     OR (s.client_cluster_type IS NOT NULL AND IFNULL(TRIM(r.CLUSTER_TYPE), '') != s.client_cluster_type));

UPDATE `cynetdatabase.rr_project_data.all_CH_data_runrate` r
SET RECRUITER_CLUSTER_REGION = IFNULL(s.recruiter_code, r.RECRUITER_CLUSTER_REGION),
    CLIENT_CLUSTER_REGION = IFNULL(s.client_code, r.CLIENT_CLUSTER_REGION),
    CLUSTER_TYPE = IFNULL(s.client_cluster_type, r.CLUSTER_TYPE)
FROM `cynetdatabase.rr_project_data.tmp_20261102_ext_scope` s
WHERE r.DEAL_SHEET_ID = s.DEAL_SHEET_ID
  AND ((s.recruiter_code IS NOT NULL AND IFNULL(TRIM(r.RECRUITER_CLUSTER_REGION), '') != s.recruiter_code)
    OR (s.client_code IS NOT NULL AND IFNULL(TRIM(r.CLIENT_CLUSTER_REGION), '') != s.client_code)
    OR (s.client_cluster_type IS NOT NULL AND IFNULL(TRIM(r.CLUSTER_TYPE), '') != s.client_cluster_type));

SELECT ds_rows AS deal_sheet_rows_updated, rr_rows AS runrate_rows_updated,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261102_ext_start_region`) AS ds_backup,
  (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261102_ext_start_region_runrate`) AS rr_backup;
