-- Generated from functions/src/extensionRehire.js (buildExtensionRehireSql). Do not hand-edit: change
-- the JS and regenerate. Rule (2026-10-13): see the header of extensionRehire.js.
--
-- WRITES only the ACTIVE tables: cynet_health_deal_sheet, cynet_health_canada_deal_sheet,
-- cynet_locums_deal_sheet and all_CH_data_runrate. The 3 ENDED deal sheet tables are only READ, so an
-- ended contract still counts as an earlier contract / earlier start.
-- all_CH_data_runrate: only rows with DEAL_TYPE = DEAL / EXTENSION (the ones from the deal sheet) are
-- written, and they get exactly the deal sheet value of the same DEAL_SHEET_ID / PLACEMENT_ID. Data-team
-- rows have no DEAL_TYPE and keep their value; they still count as history.
-- Run-rate history is read from all_CH_data_runrate, all_Health_Canada_data_Runrate and
-- all_locums_runrate.
--
-- PREVIEW ONLY: writes nothing. Shows table / old value / new value / rows for every row that would change.

-- Recompute EXT_OR_REHIRE_BY_RMG for every deal sheet row (idempotent; see extensionRehire.js).
CREATE TEMP TABLE ds_rows AS
  SELECT * FROM (
      SELECT
        'cynet_health_deal_sheet' AS table_id,
        FALSE AS is_runrate,
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
        FALSE AS is_runrate,
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
        FALSE AS is_runrate,
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
        FALSE AS is_runrate,
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
        FALSE AS is_runrate,
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
        FALSE AS is_runrate,
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
      UNION ALL
      SELECT
        'all_CH_data_runrate' AS table_id,
        TRUE AS is_runrate,
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
      FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
      WHERE UPPER(TRIM(CAST(DEAL_TYPE AS STRING))) IN ('DEAL', 'EXTENSION')
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
    -- Run-rate rows being written only receive their deal sheet unit's value; they never shape it.
    WHERE NOT is_runrate
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
    -- Contracts for the candidate ANYWHERE, with whether each one started. No parent-client filter:
    -- the rule is client-agnostic, so a row with no parent client still counts as history.
    SELECT candidate_key, parent_client_key, start_key AS hist_start, ever_started AS hist_started
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
    START_DATE AS hist_start,
    UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS hist_started
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  UNION ALL
  SELECT
    CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
    NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
    START_DATE AS hist_start,
    UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS hist_started
  FROM `cynetdatabase.rr_project_data.all_Health_Canada_data_Runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  UNION ALL
  SELECT
    CASE
        WHEN CANDIDATE_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
    NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
    START_DATE AS hist_start,
    UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'ACTIVE', 'ENDED', 'ENDED<30') AS hist_started
  FROM `cynetdatabase.rr_project_data.all_locums_runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  ),
  deal_history AS (
    -- What came before each DEAL: any strictly earlier contract (-> REOFFERED while not started), and
    -- whether one of them STARTED (-> REBOOKED once started). Same client or a different one
    -- (deliberately client-agnostic), from the deal sheet or the legacy run-rate tables.
    SELECT
      u.unit_key,
      TRUE AS has_earlier_contract,
      LOGICAL_OR(IFNULL(h.hist_started, FALSE)) AS has_earlier_start
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
    -- Every DEAL of a chain, tagged with whether it has an earlier start (REBOOKED), so extensions
    -- can inherit it.
    SELECT
      u.unit_key AS deal_unit_key,
      u.chain_key,
      u.start_key AS deal_start,
      IFNULL(dh.has_earlier_start, FALSE) AS has_earlier_start
    FROM units_flat u
    LEFT JOIN deal_history dh USING (unit_key)
    WHERE u.chain_key IS NOT NULL AND u.deal_type = 'DEAL'
  ),
  extension_parents AS (
    -- Attach each EXTENSION to the newest DEAL of its chain starting at or before it. An extension
    -- with no such DEAL here (the deal lives only in run-rate) gets no row and falls through to
    -- FALSE below -> plain EXTENSION.
    SELECT
      e.unit_key,
      ARRAY_AGG(d.has_earlier_start ORDER BY d.deal_start DESC NULLS LAST, d.deal_unit_key DESC LIMIT 1)[
        SAFE_OFFSET(0)
      ] AS parent_has_earlier_start
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
      IFNULL(dh.has_earlier_contract, FALSE) AS has_earlier_contract,
      IFNULL(dh.has_earlier_start, FALSE) AS has_earlier_start,
      IFNULL(ep.parent_has_earlier_start, FALSE) AS parent_has_earlier_start
    FROM units_flat u
    LEFT JOIN deal_history dh USING (unit_key)
    LEFT JOIN extension_parents ep USING (unit_key)
  )
  SELECT
    unit_key,
    CASE
      WHEN deal_type = 'EXTENSION' AND parent_has_earlier_start THEN 'REBOOKED / EXTENSION'
      WHEN deal_type = 'EXTENSION' THEN 'EXTENSION'
      WHEN deal_type = 'DEAL' AND ever_started AND has_earlier_start THEN 'REBOOKED'
      WHEN deal_type = 'DEAL' AND NOT ever_started AND has_earlier_contract THEN 'REOFFERED'
    END AS value
  FROM ranked;

-- Preview only: nothing is written. One row per table / old value / new value that would change.
SELECT
  r.table_id,
  IFNULL(r.current_value, '(blank)') AS old_value,
  IFNULL(v.value, '(blank)') AS new_value,
  COUNT(*) AS rows_changing
FROM ds_rows r
JOIN ext_rehire_values v USING (unit_key)
WHERE r.current_value IS DISTINCT FROM v.value
  AND r.table_id IN ('cynet_health_deal_sheet', 'cynet_health_canada_deal_sheet', 'cynet_locums_deal_sheet', 'all_CH_data_runrate')
GROUP BY 1, 2, 3
ORDER BY 1, 4 DESC;
