-- Recompute EXT_OR_REHIRE_BY_RMG for every deal sheet row (idempotent; see extensionRehire.js).
CREATE TEMP TABLE ds_rows AS
  SELECT * FROM (
      SELECT
        'cynet_health_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
      UNION ALL
      SELECT
        'cynet_health_canada_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
      UNION ALL
      SELECT
        'cynet_locums_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
      UNION ALL
      SELECT
        'cynet_health_ended_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
      UNION ALL
      SELECT
        'cynet_health_canada_ended_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
      UNION ALL
      SELECT
        'cynet_locums_ended_deal_sheet' AS table_id,
        CASE
        WHEN DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(DEAL_SHEET_ID AS STRING))
        WHEN PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(PLACEMENT_ID AS STRING))
      END AS unit_key,
        UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) AS deal_type,
        UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS status_started,
        CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(TRIM(CAST(VMS_JOB_ID AS STRING)), '') AS vms_job_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_END_DATE) AS start_key,
        LAST_UPDATED AS date_and_time,
        EXT_OR_REHIRE_BY_RMG AS current_value
      FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
  )
  WHERE unit_key IS NOT NULL;

CREATE TEMP TABLE ext_rehire_values AS
  WITH units AS (
    -- One row per deal/extension event. Identity + dates come from the unit's LATEST appended row;
    -- ever_started is sticky across its whole history.
    SELECT
      unit_key,
      IFNULL(LOGICAL_OR(status_started), FALSE) AS ever_started,
      ARRAY_AGG(
        STRUCT(deal_type, candidate_key, client_key, vms_job_key, parent_client_key, start_key)
        ORDER BY date_and_time DESC NULLS LAST, table_id ASC
        LIMIT 1
      )[SAFE_OFFSET(0)] AS latest
    FROM ds_rows
    GROUP BY unit_key
  ),
  units_flat AS (
    SELECT
      unit_key,
      ever_started,
      latest.deal_type AS deal_type,
      latest.candidate_key AS candidate_key,
      latest.parent_client_key AS parent_client_key,
      latest.start_key AS start_key,
      -- Chain = candidate + client + VMS job: which extensions belong to which deal. The VMS job
      -- segment is dropped when the row has none, so those rows still chain on candidate+client.
      IF(
        latest.candidate_key IS NULL OR latest.client_key IS NULL,
        NULL,
        CONCAT(
          latest.candidate_key, '|', latest.client_key,
          IF(latest.vms_job_key IS NULL, '', CONCAT('|vms:', latest.vms_job_key))
        )
      ) AS chain_key
    FROM units
  ),
  candidate_history AS (
    -- Prior placements for the candidate ANYWHERE. No parent-client filter: the repeat-deal rule
    -- is client-agnostic, so a row with no parent client still counts as history.
    SELECT candidate_key, parent_client_key, start_key AS hist_start
    FROM units_flat
    WHERE candidate_key IS NOT NULL
  UNION ALL
  SELECT
    CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
    NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
    START_DATE AS hist_start
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  ),
  repeat_deals AS (
    -- A DEAL is a REPEAT when the candidate has ANY strictly earlier placement — same client or a
    -- different one (deliberately client-agnostic, unlike the old rehire rule) — from the deal
    -- sheet or the legacy run-rate tables.
    SELECT u.unit_key, TRUE AS is_repeat_deal
    FROM units_flat u
    JOIN candidate_history h
      ON h.candidate_key = u.candidate_key
     AND h.hist_start IS NOT NULL
     AND u.start_key IS NOT NULL
     AND h.hist_start < u.start_key
    WHERE u.deal_type = 'DEAL'
      AND u.candidate_key IS NOT NULL
    GROUP BY u.unit_key
  ),
  deals_in_chain AS (
    -- Every DEAL of a chain, tagged with whether it is a repeat, so extensions can inherit it.
    SELECT
      u.unit_key AS deal_unit_key,
      u.chain_key,
      u.start_key AS deal_start,
      IFNULL(rd.is_repeat_deal, FALSE) AS is_repeat_deal
    FROM units_flat u
    LEFT JOIN repeat_deals rd USING (unit_key)
    WHERE u.chain_key IS NOT NULL AND u.deal_type = 'DEAL'
  ),
  extension_parents AS (
    -- Attach each EXTENSION to the newest DEAL of its chain starting at or before it. An extension
    -- with no such DEAL here (the deal lives only in run-rate) gets no row and falls through to
    -- FALSE below -> plain EXTENSION.
    SELECT
      e.unit_key,
      ARRAY_AGG(d.is_repeat_deal ORDER BY d.deal_start DESC NULLS LAST, d.deal_unit_key DESC LIMIT 1)[
        SAFE_OFFSET(0)
      ] AS parent_is_repeat_deal
    FROM units_flat e
    JOIN deals_in_chain d
      ON d.chain_key = e.chain_key
     AND (
       e.start_key IS NULL
       OR d.deal_start IS NULL
       OR d.deal_start <= e.start_key
     )
    WHERE e.deal_type = 'EXTENSION' AND e.chain_key IS NOT NULL
    GROUP BY e.unit_key
  ),
  ranked AS (
    SELECT
      u.unit_key,
      u.ever_started,
      u.deal_type,
      IFNULL(rd.is_repeat_deal, FALSE) AS is_repeat_deal,
      IFNULL(ep.parent_is_repeat_deal, FALSE) AS parent_is_repeat_deal
    FROM units_flat u
    LEFT JOIN repeat_deals rd USING (unit_key)
    LEFT JOIN extension_parents ep USING (unit_key)
  )
  SELECT
    unit_key,
    CASE
      WHEN deal_type = 'EXTENSION' AND parent_is_repeat_deal THEN 'REBOOKED / EXTENSION'
      WHEN deal_type = 'EXTENSION' THEN 'EXTENSION'
      WHEN deal_type = 'DEAL' AND is_repeat_deal AND ever_started THEN 'REBOOKED'
      WHEN deal_type = 'DEAL' AND is_repeat_deal THEN 'REOFFERED'
    END AS value
  FROM ranked;

-- Counted BEFORE the updates below, and always one row per table (0 when nothing changed) so an
-- empty job result means "counts unavailable", never "nothing changed".
CREATE TEMP TABLE ext_rehire_pending AS
  WITH changed AS (
    SELECT r.table_id, COUNT(*) AS changed_rows
    FROM ds_rows r
    JOIN ext_rehire_values v USING (unit_key)
    WHERE r.current_value IS DISTINCT FROM v.value
    GROUP BY r.table_id
  )
  SELECT t AS table_id, IFNULL(c.changed_rows, 0) AS changed_rows
  FROM UNNEST(['cynet_health_deal_sheet', 'cynet_health_canada_deal_sheet', 'cynet_locums_deal_sheet', 'cynet_health_ended_deal_sheet', 'cynet_health_canada_ended_deal_sheet', 'cynet_locums_ended_deal_sheet']) AS t
  LEFT JOIN changed c ON c.table_id = t;

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` t
SET EXT_OR_REHIRE_BY_RMG = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXT_OR_REHIRE_BY_RMG IS DISTINCT FROM v.value;

SELECT table_id, changed_rows FROM ext_rehire_pending ORDER BY table_id;

