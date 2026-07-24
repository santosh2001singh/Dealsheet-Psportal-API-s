-- STEP 2 of 2 — BACKFILL TYPE_OF_CLIENT from CLIENT_TYPE on ALL deal-sheet tables (run AFTER the
-- rename in STEP 1). Overwrites every row's TYPE_OF_CLIENT with the derived bucket. Mirrors the code
-- mapClientTypeToTypeOfClient(): keyword match, order school -> federal -> state/local -> else.
--   %school%             -> 'School'
--   %federal%            -> 'Federal'
--   %state% / %local% / %goverment% / %government% -> 'Goverment'   (business-reference spelling)
--   any other non-blank  -> 'Commercial'   (VMS / Direct / Practice / …)
--   blank / null         -> NULL
--
-- Run: bq query --use_legacy_sql=false --project_id=cynetdatabase < this_file.sql

-- Reusable expression note: BigQuery has no shared function here, so the CASE is repeated per table.

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;

UPDATE `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;

UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;

UPDATE `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet` SET TYPE_OF_CLIENT = CASE
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%school%'  THEN 'School'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%federal%' THEN 'Federal'
    WHEN LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%state%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%local%'
      OR LOWER(TRIM(CAST(CLIENT_TYPE AS STRING))) LIKE '%gover%'   THEN 'Goverment'
    WHEN TRIM(IFNULL(CAST(CLIENT_TYPE AS STRING), '')) != ''       THEN 'Commercial'
    ELSE NULL END
WHERE TRUE;
