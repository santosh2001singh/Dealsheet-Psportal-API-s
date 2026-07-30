-- One-time backfill: ORIGINAL_START_DATE, NEW_HIRE_DATE, non-recruiter hierarchy columns, and
-- (where possible) CONTRACT_ID on EXISTING EXTENSION rows that were inserted before the sync
-- code could fill these from the domain run-rate table (functions/src/bigQueryClient.js:
-- fetchExtensionRunrateBackfillByPlacementId / applyExtensionRunrateBackfillForInsertRows /
-- resolveContractIdsForRunrateMatchedExtensions).
--
-- Scope: DEAL_TYPE = EXTENSION AND CONTRACT_ID IS NULL (mirrors rowNeedsExtensionRunrateBackfill).
-- Only ever fills a column that is currently NULL — never overwrites a value already present
-- (manual edits or values already carried forward from a baseline are left untouched).
--
-- Domain run-rate tables (one per target table's domain):
--   cynet_health_*         -> all_CH_data_runrate
--   cynet_health_canada_*  -> all_Health_Canada_data_Runrate
--   cynet_locums_*         -> all_locums_runrate
--
-- Hierarchy columns intentionally EXCLUDE recruiter identity (ASSIGNMENT_RECRUITER*,
-- SECONDARY_RECRUITER, RECRUITER_ID/EMP_NO, PREVIOUS_RECRUITER_*) — the sync-assigned current
-- recruiter must win, never the historical one. Also excludes CLIENT_RECRUITER,
-- PRIMARY_SALES_PERSON, SECONDARY_SALES_PERSON, and RECRUITER_CLUSTER — these are manual
-- BigQuery-edited columns and must never be auto-filled from a fuzzy runrate match.
-- Every *_EMP_NO companion column (TEAM_LEAD_EMP_NO, ATL_EMP_NO, etc.) is excluded for a
-- different reason: the runrate tables never stored emp-no data, only names, so there is
-- nothing to select. Those EMP_NO fields can still get filled on a runrate-matched EXTENSION
-- row via the parent-DEAL-inherit path, or because new DEAL rows now auto-fill hierarchy
-- EMP_NOs at insert time from cynetdatabase.MISC.directory_employee_hierarchy.
--
-- CONTRACT_ID caveat: the run-rate table's own CONTRACT_ID column is always NULL, so it can
-- never be copied from there. This script can only REUSE a CONTRACT_ID already present on some
-- OTHER row (DEAL or EXTENSION) in the SAME target table for the same candidate+client identity
-- — a pure-SQL, same-table self-join. It CANNOT allocate a brand-new CHC/CAC/LOC id, because that
-- sequence is Firestore-backed and only reachable from the Node.js app layer
-- (resolveContractIdsForRunrateMatchedExtensions). Rows with no reusable CONTRACT_ID anywhere in
-- the table will keep CONTRACT_ID = NULL after this script — re-run the live sync/backfill
-- endpoint (bulkBackfillPlacementRecordsFromNexus / refreshPlacementRecordToBigQuery) for those,
-- which will mint a fresh id through the same code path new EXTENSION rows use.
--
-- Match tiers (highest to lowest priority), same as the live code:
--   1. EXACT_NEXUS_TENTATIVE   - same CANDIDATE_NEXUS_ID + same TENTATIVE_DATE
--   2. NEXUS_PARENT_FACILITY   - same NEXUS_ID + parent client + facility (substring match), before ext start
--   3. NEXUS_PARENT_CLIENT     - same NEXUS_ID + parent client, before ext start
--   4. EMAIL_VMS_JOB_ID        - same candidate email + VMS_JOB_ID
--   5. NEXUS_LATEST_BEFORE_EXT - same NEXUS_ID only, latest runrate row before ext start
--
-- Runrate source rows: only PLACEMENT_STATUS IN (STARTED, BOOKED, ENDED, ENDED<30). DID NOT START,
-- DID NOT ACCEPT, ACTIVE, and null/unknown statuses are excluded before tier ranking.
--
-- Streaming buffer: recently inserted rows may reject UPDATE; re-run after flush (~90 min).
-- Idempotent: safe to re-run (WHERE ... IS NULL guards mean already-filled rows are untouched).

DECLARE target_tables ARRAY<STRUCT<tbl STRING, runrate_tbl STRING>> DEFAULT [
  STRUCT('cynet_health_deal_sheet', 'all_CH_data_runrate'),
  STRUCT('cynet_health_ended_deal_sheet', 'all_CH_data_runrate'),
  STRUCT('cynet_health_canada_deal_sheet', 'all_Health_Canada_data_Runrate'),
  STRUCT('cynet_health_canada_ended_deal_sheet', 'all_Health_Canada_data_Runrate'),
  STRUCT('cynet_locums_deal_sheet', 'all_locums_runrate'),
  STRUCT('cynet_locums_ended_deal_sheet', 'all_locums_runrate')
];

FOR rec IN (SELECT tbl, runrate_tbl FROM UNNEST(target_tables))
DO
  EXECUTE IMMEDIATE FORMAT("""
    WITH extensions AS (
      SELECT
        PLACEMENT_ID,
        CANDIDATE_NEXUS_ID,
        CANDIDATE_EMAIL,
        PHONE_NUMBER,
        CLIENT_ID,
        PARENT_CLIENT_NAME AS deal_parent_client,
        END_CLIENT_DEPT_FACILITY AS deal_facility,
        START_DATE AS extension_start_date,
        TENTATIVE_DATE AS extension_tentative_date,
        TRIM(CAST(VMS_JOB_ID AS STRING)) AS deal_vms_job_id
      FROM `cynetdatabase.rr_project_data.%s`
      WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
        AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')
        AND CANDIDATE_NEXUS_ID IS NOT NULL
        AND PLACEMENT_ID IS NOT NULL
    ),
    runrate AS (
      SELECT
        ID AS runrate_id,
        CANDIDATE_NEXUS_ID AS nexus_id,
        LOWER(TRIM(CANDIDATE_EMAIL)) AS email,
        TRIM(CAST(VMS_JOB_ID AS STRING)) AS vms_job_id,
        PARENT_CLIENT_NAME AS runrate_parent_client,
        END_CLIENT_DEPT_FACILITY AS runrate_facility,
        START_DATE AS runrate_start_date,
        TENTATIVE_DATE AS runrate_tentative_date,
        SKU_NUMBER AS runrate_sku,
        NEW_HIRE_DATE AS runrate_new_hire_date,
        TEAM_LEAD AS runrate_team_lead,
        ATL AS runrate_atl,
        RM AS runrate_rm,
        ACCOUNT_MANAGER AS runrate_account_manager,
        SECONDARY_AM AS runrate_secondary_am,
        ASSOCIATE_AM AS runrate_associate_am,
        GRP_DIR_ASSOC_GRP_DIR AS runrate_grp_dir_assoc_grp_dir,
        VP_SRVP AS runrate_vp_srvp
      FROM `cynetdatabase.rr_project_data.%s`
      WHERE START_DATE < DATE '2026-05-01'
        AND UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
    ),
    client_first_assignment AS (
      SELECT
        CANDIDATE_NEXUS_ID,
        LOWER(TRIM(PARENT_CLIENT_NAME)) AS parent_client_key,
        START_DATE AS client_original_start_date,
        NEW_HIRE_DATE AS client_new_hire_date,
        ROW_NUMBER() OVER (
          PARTITION BY CANDIDATE_NEXUS_ID, LOWER(TRIM(PARENT_CLIENT_NAME))
          ORDER BY START_DATE ASC, PLACEMENT_ID ASC, ID
        ) AS rn
      FROM `cynetdatabase.rr_project_data.%s`
      WHERE CANDIDATE_NEXUS_ID IS NOT NULL
        AND TRIM(IFNULL(PARENT_CLIENT_NAME, '')) != ''
        AND START_DATE IS NOT NULL
        AND UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
    ),
    sku_first_assignment AS (
      SELECT
        TRIM(SKU_NUMBER) AS sku_key,
        MIN(START_DATE) AS sku_original_start_date,
        ARRAY_AGG(NEW_HIRE_DATE IGNORE NULLS ORDER BY START_DATE ASC LIMIT 1)[SAFE_OFFSET(0)] AS sku_new_hire_date
      FROM `cynetdatabase.rr_project_data.%s`
      WHERE SKU_NUMBER IS NOT NULL AND TRIM(SKU_NUMBER) != '' AND START_DATE IS NOT NULL
        AND UPPER(TRIM(CAST(PLACEMENT_STATUS AS STRING))) IN ('STARTED', 'BOOKED', 'ENDED', 'ENDED<30')
      GROUP BY sku_key
    ),
    joined AS (
      SELECT
        e.PLACEMENT_ID,
        e.CANDIDATE_NEXUS_ID AS ext_candidate_nexus_id,
        e.CANDIDATE_EMAIL AS ext_candidate_email,
        e.PHONE_NUMBER AS ext_phone_number,
        e.CLIENT_ID AS ext_client_id,
        r.*,
        CASE
          WHEN e.CANDIDATE_NEXUS_ID = r.nexus_id
           AND e.extension_tentative_date = r.runrate_tentative_date
            THEN 'EXACT_NEXUS_TENTATIVE'
          WHEN e.CANDIDATE_NEXUS_ID = r.nexus_id
           AND LOWER(IFNULL(e.deal_parent_client, '')) = LOWER(IFNULL(r.runrate_parent_client, ''))
           AND (
             LOWER(IFNULL(e.deal_facility, '')) = LOWER(IFNULL(r.runrate_facility, ''))
             OR STRPOS(LOWER(IFNULL(r.runrate_facility, '')), LOWER(IFNULL(e.deal_facility, ''))) > 0
             OR STRPOS(LOWER(IFNULL(e.deal_facility, '')), LOWER(IFNULL(r.runrate_facility, ''))) > 0
           )
           AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
            THEN 'NEXUS_PARENT_FACILITY'
          WHEN e.CANDIDATE_NEXUS_ID = r.nexus_id
           AND LOWER(IFNULL(e.deal_parent_client, '')) = LOWER(IFNULL(r.runrate_parent_client, ''))
           AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
            THEN 'NEXUS_PARENT_CLIENT'
          WHEN LOWER(TRIM(IFNULL(e.CANDIDATE_EMAIL, ''))) = IFNULL(r.email, '')
           AND NULLIF(e.deal_vms_job_id, '') IS NOT NULL
           AND e.deal_vms_job_id = NULLIF(r.vms_job_id, '')
            THEN 'EMAIL_VMS_JOB_ID'
          WHEN e.CANDIDATE_NEXUS_ID = r.nexus_id
           AND (e.extension_start_date IS NULL OR r.runrate_start_date < e.extension_start_date)
            THEN 'NEXUS_LATEST_BEFORE_EXT'
          ELSE NULL
        END AS match_method
      FROM extensions e
      JOIN runrate r
        ON e.CANDIDATE_NEXUS_ID = r.nexus_id
        OR (
          LOWER(TRIM(IFNULL(e.CANDIDATE_EMAIL, ''))) = IFNULL(r.email, '')
          AND NULLIF(e.deal_vms_job_id, '') IS NOT NULL
          AND e.deal_vms_job_id = NULLIF(r.vms_job_id, '')
        )
    ),
    ranked AS (
      SELECT
        j.*,
        CASE j.match_method
          WHEN 'EXACT_NEXUS_TENTATIVE' THEN 1
          WHEN 'NEXUS_PARENT_FACILITY' THEN 2
          WHEN 'NEXUS_PARENT_CLIENT' THEN 3
          WHEN 'EMAIL_VMS_JOB_ID' THEN 4
          WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 5
          ELSE 99
        END AS match_priority,
        ROW_NUMBER() OVER (
          PARTITION BY j.PLACEMENT_ID
          ORDER BY
            CASE j.match_method
              WHEN 'EXACT_NEXUS_TENTATIVE' THEN 1
              WHEN 'NEXUS_PARENT_FACILITY' THEN 2
              WHEN 'NEXUS_PARENT_CLIENT' THEN 3
              WHEN 'EMAIL_VMS_JOB_ID' THEN 4
              WHEN 'NEXUS_LATEST_BEFORE_EXT' THEN 5
              ELSE 99
            END,
            j.runrate_start_date DESC NULLS LAST,
            j.runrate_id
        ) AS rn
      FROM joined j
      WHERE j.match_method IS NOT NULL
    ),
    best_match AS (
      SELECT * FROM ranked WHERE rn = 1
    ),
    -- Same-table CONTRACT_ID reuse: latest CONTRACT_ID (DEAL or EXTENSION) already present for
    -- this candidate+client identity elsewhere in the SAME target table. This is the only
    -- CONTRACT_ID source available to pure SQL — see the file header for why a brand-new
    -- CHC/CAC/LOC id can't be minted here.
    own_table_contract_ids AS (
      SELECT
        CANDIDATE_NEXUS_ID,
        LOWER(IFNULL(CANDIDATE_EMAIL, '')) AS candidate_email_norm,
        IFNULL(PHONE_NUMBER, '') AS phone_norm,
        CLIENT_ID,
        CONTRACT_ID,
        ROW_NUMBER() OVER (
          PARTITION BY CANDIDATE_NEXUS_ID, LOWER(IFNULL(CANDIDATE_EMAIL, '')), IFNULL(PHONE_NUMBER, ''), CLIENT_ID
          ORDER BY START_DATE DESC NULLS LAST, EDIT_DATE DESC NULLS LAST
        ) AS rn
      FROM `cynetdatabase.rr_project_data.%s`
      WHERE CONTRACT_ID IS NOT NULL
        AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
        AND CANDIDATE_NEXUS_ID IS NOT NULL
        AND CLIENT_ID IS NOT NULL
    ),
    proposed AS (
      SELECT
        e.PLACEMENT_ID,
        IF(
          REGEXP_CONTAINS(UPPER(TRIM(o.CONTRACT_ID)), r'^(CHC|CAC|LOC)[0-9]+$'),
          UPPER(TRIM(o.CONTRACT_ID)),
          NULL
        ) AS proposed_contract_id,
        COALESCE(c.client_original_start_date, s.sku_original_start_date) AS proposed_original_start_date,
        COALESCE(c.client_new_hire_date, s.sku_new_hire_date, b.runrate_new_hire_date) AS proposed_new_hire_date,
        b.runrate_team_lead AS proposed_team_lead,
        b.runrate_atl AS proposed_atl,
        b.runrate_rm AS proposed_rm,
        b.runrate_account_manager AS proposed_account_manager,
        b.runrate_secondary_am AS proposed_secondary_am,
        b.runrate_associate_am AS proposed_associate_am,
        b.runrate_grp_dir_assoc_grp_dir AS proposed_grp_dir_assoc_grp_dir,
        b.runrate_vp_srvp AS proposed_vp_srvp
      FROM extensions e
      JOIN best_match b ON e.PLACEMENT_ID = b.PLACEMENT_ID
      LEFT JOIN client_first_assignment c
        ON e.CANDIDATE_NEXUS_ID = c.CANDIDATE_NEXUS_ID
       AND LOWER(TRIM(IFNULL(e.deal_parent_client, ''))) = c.parent_client_key
       AND c.rn = 1
      LEFT JOIN sku_first_assignment s
        ON NULLIF(TRIM(b.runrate_sku), '') = s.sku_key
      LEFT JOIN own_table_contract_ids o
        ON e.CANDIDATE_NEXUS_ID = o.CANDIDATE_NEXUS_ID
       AND LOWER(IFNULL(e.CANDIDATE_EMAIL, '')) = o.candidate_email_norm
       AND IFNULL(e.PHONE_NUMBER, '') = o.phone_norm
       AND e.CLIENT_ID = o.CLIENT_ID
       AND o.rn = 1
    )
    UPDATE `cynetdatabase.rr_project_data.%s` AS t
    SET
      CONTRACT_ID = IF(t.CONTRACT_ID IS NULL, p.proposed_contract_id, t.CONTRACT_ID),
      ORIGINAL_START_DATE = IF(t.ORIGINAL_START_DATE IS NULL, p.proposed_original_start_date, t.ORIGINAL_START_DATE),
      NEW_HIRE_DATE = IF(t.NEW_HIRE_DATE IS NULL, p.proposed_new_hire_date, t.NEW_HIRE_DATE),
      TEAM_LEAD = IF(t.TEAM_LEAD IS NULL, p.proposed_team_lead, t.TEAM_LEAD),
      ATL = IF(t.ATL IS NULL, p.proposed_atl, t.ATL),
      RM = IF(t.RM IS NULL, p.proposed_rm, t.RM),
      ACCOUNT_MANAGER = IF(t.ACCOUNT_MANAGER IS NULL, p.proposed_account_manager, t.ACCOUNT_MANAGER),
      SECONDARY_AM = IF(t.SECONDARY_AM IS NULL, p.proposed_secondary_am, t.SECONDARY_AM),
      ASSOCIATE_AM = IF(t.ASSOCIATE_AM IS NULL, p.proposed_associate_am, t.ASSOCIATE_AM),
      GRP_DIR_ASSOC_GRP_DIR = IF(t.GRP_DIR_ASSOC_GRP_DIR IS NULL, p.proposed_grp_dir_assoc_grp_dir, t.GRP_DIR_ASSOC_GRP_DIR),
      VP_SRVP = IF(t.VP_SRVP IS NULL, p.proposed_vp_srvp, t.VP_SRVP)
    FROM proposed p
    WHERE t.PLACEMENT_ID = p.PLACEMENT_ID
      AND UPPER(TRIM(t.DEAL_TYPE)) = 'EXTENSION'
      AND (t.CONTRACT_ID IS NULL OR TRIM(CAST(t.CONTRACT_ID AS STRING)) = '')
  """, rec.tbl, rec.runrate_tbl, rec.runrate_tbl, rec.runrate_tbl, rec.tbl, rec.tbl);
END FOR;

-- =============================================================================
-- Verification (extension_no_contract should shrink after each run; re-run until it plateaus —
-- rows with no run-rate match, or no reusable CONTRACT_ID anywhere in the table, will never
-- resolve CONTRACT_ID here — those need a live re-sync/backfill call to mint a fresh id)
-- =============================================================================

SELECT 'cynet_health_deal_sheet' AS tbl,
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')) AS extension_no_contract,
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION') AS extension_rows
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
UNION ALL
SELECT 'cynet_health_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
UNION ALL
SELECT 'cynet_health_canada_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_health_canada_ended_deal_sheet`
UNION ALL
SELECT 'cynet_locums_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet`
UNION ALL
SELECT 'cynet_locums_ended_deal_sheet',
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION' AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')),
  COUNTIF(UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION')
FROM `cynetdatabase.rr_project_data.cynet_locums_ended_deal_sheet`
ORDER BY tbl;
