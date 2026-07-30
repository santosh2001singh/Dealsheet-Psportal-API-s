-- One-time / on-demand EXTENSION_REHIRE ("Extension/Rehire") backfill for all 6 domain deal sheet
-- tables. Run sql/migrate_add_extension_rehire_column.sql FIRST.
--
-- Identical to what the post-sync maintenance pass runs on every sync
-- (functions/src/syncService.js -> backfillExtensionRehireForDealSheets). Paste this into the
-- BigQuery console to fill the column immediately instead of waiting for the next scheduled sync.
--
-- GENERATED — do not hand-edit. Regenerate after changing the rules:
--   cd functions && node -e "const{buildExtensionRehireSql}=require('./src/extensionRehire');console.log(buildExtensionRehireSql({projectId:'cynetdatabase',datasetId:'rr_project_data',runrateTableIds:['all_CH_data_runrate','all_Health_Canada_data_Runrate']}).sql)"
--
-- Idempotent: the value is a pure function of the current table contents, so a second run reports 0.
-- The final SELECT returns the number of rows CHANGED per table.
-- Recompute EXTENSION_REHIRE for every deal sheet row (idempotent; see extensionRehire.js).
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
        CASE
          WHEN CLIENT_ID IS NOT NULL THEN CONCAT('cid:', CAST(CLIENT_ID AS STRING))
          WHEN NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') IS NOT NULL THEN CONCAT('pc:', NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), ''))
        END AS client_key,
        NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
        COALESCE(START_DATE, TENTATIVE_DATE) AS start_key,
        DATE_AND_TIME AS date_and_time,
        EXTENSION_REHIRE AS current_value
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
        STRUCT(deal_type, candidate_key, client_key, parent_client_key, start_key)
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
      IF(
        latest.candidate_key IS NULL OR latest.client_key IS NULL,
        NULL,
        CONCAT(latest.candidate_key, '|', latest.client_key)
      ) AS chain_key
    FROM units
  ),
  candidate_history AS (
    SELECT candidate_key, parent_client_key, start_key AS hist_start
    FROM units_flat
    WHERE candidate_key IS NOT NULL AND parent_client_key IS NOT NULL
  UNION ALL
  SELECT
    CASE
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
    NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
    START_DATE AS hist_start
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  UNION ALL
  SELECT
    CASE
        WHEN CANDIDATE_NEXUS_ID IS NOT NULL THEN CONCAT('nx:', CAST(CANDIDATE_NEXUS_ID AS STRING))
        WHEN NULLIF(LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))), '') IS NOT NULL
          THEN CONCAT('em:', LOWER(TRIM(CAST(CANDIDATE_EMAIL AS STRING))))
      END AS candidate_key,
    NULLIF(LOWER(TRIM(CAST(PARENT_CLIENT_NAME AS STRING))), '') AS parent_client_key,
    START_DATE AS hist_start
  FROM `cynetdatabase.rr_project_data.all_Health_Canada_data_Runrate`
  WHERE UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
  ),
  rehire AS (
    -- DEAL units whose candidate has an EARLIER placement at a different parent client.
    SELECT u.unit_key, TRUE AS has_prior_other_client
    FROM units_flat u
    JOIN candidate_history h
      ON h.candidate_key = u.candidate_key
     AND h.parent_client_key IS NOT NULL
     AND h.parent_client_key != u.parent_client_key
     AND h.hist_start IS NOT NULL
     AND (u.start_key IS NULL OR h.hist_start < u.start_key)
    WHERE u.deal_type = 'DEAL'
      AND u.candidate_key IS NOT NULL
      AND u.parent_client_key IS NOT NULL
    GROUP BY u.unit_key
  ),
  generations AS (
    -- Each DEAL opens a generation; extensions inherit the generation of the DEAL they follow.
    -- Generation 0 = extensions of a placement whose DEAL is not in the deal sheet at all (run-rate
    -- only), so its first extension is still the 1st extension.
    SELECT
      unit_key,
      ever_started,
      deal_type,
      chain_key,
      start_key,
      COUNTIF(deal_type = 'DEAL') OVER (
        PARTITION BY chain_key
        ORDER BY start_key ASC NULLS FIRST, IF(deal_type = 'DEAL', 0, 1) ASC, unit_key ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS deal_generation
    FROM units_flat
    WHERE chain_key IS NOT NULL
  ),
  ranked AS (
    SELECT
      unit_key,
      ever_started,
      deal_type,
      ROW_NUMBER() OVER (
        PARTITION BY chain_key, deal_generation, deal_type
        ORDER BY start_key ASC NULLS FIRST, unit_key ASC
      ) AS extension_rank,
      COUNTIF(deal_type = 'EXTENSION') OVER (
        PARTITION BY chain_key, deal_generation
      ) AS generation_extension_count
    FROM generations
  )
  SELECT
    r.unit_key,
    CASE
      WHEN deal_type = 'EXTENSION' AND extension_rank >= 2 THEN 'REBOOKED/EXTENSION'
      WHEN deal_type = 'EXTENSION' AND ever_started THEN 'REBOOKED'
      WHEN deal_type = 'EXTENSION' THEN 'REOFFERED'
      WHEN deal_type = 'DEAL' AND generation_extension_count > 0 THEN 'EXTENSION'
      WHEN deal_type = 'DEAL' AND has_prior_other_client THEN 'REHIRED'
    END AS value
  FROM ranked r
  LEFT JOIN rehire h USING (unit_key);

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
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` t
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` t
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` t
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` t
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` t
SET EXTENSION_REHIRE = v.value
FROM ext_rehire_values v
WHERE v.unit_key = CASE
        WHEN t.DEAL_SHEET_ID IS NOT NULL THEN CONCAT('ds:', CAST(t.DEAL_SHEET_ID AS STRING))
        WHEN t.PLACEMENT_ID IS NOT NULL THEN CONCAT('pl:', CAST(t.PLACEMENT_ID AS STRING))
      END
  AND t.EXTENSION_REHIRE IS DISTINCT FROM v.value;

SELECT table_id, changed_rows FROM ext_rehire_pending ORDER BY table_id;
