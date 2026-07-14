-- One-time backfill: fill PREVIOUS_RECRUITER (NAME / EMP_NO / EMAIL) on the LATEST row of each
-- EXTENSION placement in cynet_health_deal_sheet, from the legacy manual ownership tracker
-- (Cluster_Data.ownership_data). In-place UPDATE (append-only NOT touched — no new rows).
--
-- Match: SKU_NUMBER = SKU_NO, OWNERSHIP_UPDATE = 'Recruiter'.
-- Pick:  the recruiter-change whose NEW_EMP_CODE = the row's current RECRUITER_EMP_NO (the change
--        that installed the current recruiter); else the latest EFFECTIVE_DATE change.
-- Values: PREVIOUS_RECRUITER_NAME = OLD_ONE, PREVIOUS_RECRUITER_EMP_NO = OLD_EMP_CODE,
--         PREVIOUS_RECRUITER_EMAIL = MISC.directory_employees email (by employee_id).
-- Safe/idempotent: only touches latest EXTENSION rows whose PREVIOUS_RECRUITER is currently empty
-- and that have a matching legacy recruiter change (valid, non-'NA' OLD_EMP_CODE). Re-runs = 0 rows.
--
-- Run:  bq query --use_legacy_sql=false --project_id=cynetdatabase < this_file.sql
-- (For canada/locums, copy this and swap the target + latest_ext table name — the CH tracker only
--  holds H-SKUs, so those would match nothing unless legacy data is added there.)

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET
  d.PREVIOUS_RECRUITER_NAME = src.old_name,
  d.PREVIOUS_RECRUITER_EMP_NO = src.old_emp,
  d.PREVIOUS_RECRUITER_EMAIL = src.old_email
FROM (
  WITH latest_ext AS (
    SELECT id, sku, cur_emp FROM (
      SELECT
        ID AS id,
        TRIM(CAST(SKU_NUMBER AS STRING)) AS sku,
        TRIM(IFNULL(CAST(RECRUITER_EMP_NO AS STRING), '')) AS cur_emp,
        TRIM(IFNULL(CAST(PREVIOUS_RECRUITER_NAME AS STRING), '')) AS prev_name,
        TRIM(IFNULL(CAST(PREVIOUS_RECRUITER_EMAIL AS STRING), '')) AS prev_email,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(DEAL_SHEET_ID AS STRING), CAST(PLACEMENT_ID AS STRING)
          ORDER BY DATE_AND_TIME DESC NULLS LAST
        ) AS rn
      FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
      WHERE UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) = 'EXTENSION'
    )
    WHERE rn = 1
      AND sku != ''
      AND prev_name = ''
      AND prev_email = ''
  ),
  rec AS (
    SELECT
      TRIM(CAST(SKU_NO AS STRING)) AS sku,
      TRIM(IFNULL(CAST(NEW_EMP_CODE AS STRING), '')) AS new_emp,
      OLD_ONE AS old_name,
      TRIM(CAST(OLD_EMP_CODE AS STRING)) AS old_emp,
      CAST(EFFECTIVE_DATE AS STRING) AS eff
    FROM `cynetdatabase.Cluster_Data.ownership_data`
    WHERE UPPER(TRIM(CAST(OWNERSHIP_UPDATE AS STRING))) = 'RECRUITER'
      AND OLD_EMP_CODE IS NOT NULL
      AND UPPER(TRIM(CAST(OLD_EMP_CODE AS STRING))) NOT IN ('', 'NA')
  ),
  dir AS (
    SELECT TRIM(CAST(employee_id AS STRING)) AS emp, email
    FROM `cynetdatabase.MISC.directory_employees`
    WHERE email IS NOT NULL AND TRIM(email) != ''
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY TRIM(CAST(employee_id AS STRING))
      ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
    ) = 1
  ),
  picked AS (
    SELECT
      le.id,
      r.old_name,
      r.old_emp,
      ROW_NUMBER() OVER (
        PARTITION BY le.id
        ORDER BY (r.new_emp = le.cur_emp) DESC, r.eff DESC
      ) AS rn
    FROM latest_ext le
    JOIN rec r ON r.sku = le.sku
  )
  SELECT p.id, p.old_name, p.old_emp, dir.email AS old_email
  FROM picked p
  LEFT JOIN dir ON dir.emp = p.old_emp
  WHERE p.rn = 1
) src
WHERE d.ID = src.id;
