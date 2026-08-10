-- Backfill CONTRACT_ID / SKU_NUMBER on DEAL rows from the legacy run-rate table.
--
-- Until Aug 2026 every DEAL_TYPE='DEAL' row minted a fresh Firestore CONTRACT_ID, even when the
-- placement was already tracked in the run-rate table with an id of its own. One real contract
-- therefore carries two ids (run-rate CHC22144 vs minted CHC23016) and its SKU_NUMBER is empty.
-- functions/src/contractIdResolver.js now looks the run-rate row up before minting; this aligns the
-- rows written before that change.
--
-- Matching (same two tiers the code uses):
--   1. CANDIDATE_ID + INTERNAL_JOB_ID  — 17,005 of 21,849 run-rate rows.
--   2. CANDIDATE_EMAIL + START_DATE    — the remaining 4,844, which carry no Nexus ids but all have
--                                        an email.
-- Tier 1 wins where both match. START_DATE, FACILITY_NAME and VMS_JOB_ID were each measured as
-- additional key parts and every one dropped real matches (816 / 857 / 851 of 865) without
-- separating a genuinely new deal from the legacy one, so none of them are used.
--
-- Ambiguity: a key mapping to several CONTRACT_IDs resolves to the earliest START_DATE, then the
-- lowest CONTRACT_ID — the same rule as the code, and it affects 1 DEAL row today.
--
-- ORDER OF OPERATIONS: deploy the functions change FIRST, then run this. CONTRACT_ID and SKU_NUMBER
-- are both in API_OWNED_COLUMNS, so a still-old deployment would see the backfilled value as a
-- change and append a row that reverts it.
--
-- SKU_NUMBER is only filled where the row has none and the run-rate row actually carries one; many
-- older run-rate rows have a CONTRACT_ID and no SKU, and a null must never overwrite a real value.
--
-- Run the preview first. Repeat the UPDATE per domain table, swapping both table names in the two
-- places marked TABLE (deal sheet) and RUNRATE.

-- ---------------------------------------------------------------------------
-- Preview: which rows would change, and to what (cynet_health_deal_sheet)
-- ---------------------------------------------------------------------------
WITH runrate_ranked AS (
  SELECT
    CAST(CANDIDATE_ID AS STRING) AS cand,
    CAST(INTERNAL_JOB_ID AS STRING) AS job,
    LOWER(TRIM(CANDIDATE_EMAIL)) AS email,
    START_DATE,
    CONTRACT_ID,
    SKU_NUMBER,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(CANDIDATE_ID AS STRING), CAST(INTERNAL_JOB_ID AS STRING)
      ORDER BY START_DATE ASC, CONTRACT_ID ASC, ID ASC
    ) AS rn_nexus,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(CANDIDATE_EMAIL)), START_DATE
      ORDER BY START_DATE ASC, CONTRACT_ID ASC, ID ASC
    ) AS rn_email
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`   -- RUNRATE
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
),
tier1 AS (
  SELECT cand, job, CONTRACT_ID, SKU_NUMBER
  FROM runrate_ranked
  WHERE rn_nexus = 1 AND cand IS NOT NULL AND job IS NOT NULL
),
tier2 AS (
  SELECT email, START_DATE, CONTRACT_ID, SKU_NUMBER
  FROM runrate_ranked
  WHERE rn_email = 1 AND email IS NOT NULL AND email != '' AND START_DATE IS NOT NULL
)
SELECT
  d.DEAL_SHEET_ID,
  d.CANDIDATE_NAME,
  d.CONTRACT_ID AS current_contract_id,
  COALESCE(t1.CONTRACT_ID, t2.CONTRACT_ID) AS legacy_contract_id,
  d.SKU_NUMBER AS current_sku,
  COALESCE(t1.SKU_NUMBER, t2.SKU_NUMBER) AS legacy_sku,
  IF(t1.CONTRACT_ID IS NOT NULL, 'nexus_ids', 'email_start_date') AS matched_by
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d   -- TABLE
LEFT JOIN tier1 t1
  ON CAST(d.CANDIDATE_ID AS STRING) = t1.cand
 AND CAST(d.INTERNAL_JOB_ID AS STRING) = t1.job
LEFT JOIN tier2 t2
  ON LOWER(TRIM(d.CANDIDATE_EMAIL)) = t2.email
 AND d.START_DATE = t2.START_DATE
WHERE d.DEAL_TYPE = 'DEAL'
  AND COALESCE(t1.CONTRACT_ID, t2.CONTRACT_ID) IS NOT NULL
  AND (
    d.CONTRACT_ID IS DISTINCT FROM COALESCE(t1.CONTRACT_ID, t2.CONTRACT_ID)
    OR (
      (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '')
      AND COALESCE(t1.SKU_NUMBER, t2.SKU_NUMBER) IS NOT NULL
    )
  )
ORDER BY d.DEAL_SHEET_ID
LIMIT 100;

-- ---------------------------------------------------------------------------
-- Apply (cynet_health_deal_sheet). Swap TABLE + RUNRATE for the other domains:
--   cynet_health_canada_deal_sheet -> all_Health_Canada_data_Runrate
--   cynet_locums_deal_sheet        -> all_locums_runrate
-- Ended tables (cynet_*_ended_deal_sheet) never carry a CONTRACT_ID — skip them.
-- ---------------------------------------------------------------------------
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d   -- TABLE
SET
  CONTRACT_ID = legacy.contract_id,
  SKU_NUMBER = IF(
    (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '') AND legacy.sku_number IS NOT NULL,
    legacy.sku_number,
    d.SKU_NUMBER
  )
FROM (
  WITH runrate_ranked AS (
    SELECT
      CAST(CANDIDATE_ID AS STRING) AS cand,
      CAST(INTERNAL_JOB_ID AS STRING) AS job,
      LOWER(TRIM(CANDIDATE_EMAIL)) AS email,
      START_DATE,
      CONTRACT_ID,
      SKU_NUMBER,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(CANDIDATE_ID AS STRING), CAST(INTERNAL_JOB_ID AS STRING)
        ORDER BY START_DATE ASC, CONTRACT_ID ASC, ID ASC
      ) AS rn_nexus,
      ROW_NUMBER() OVER (
        PARTITION BY LOWER(TRIM(CANDIDATE_EMAIL)), START_DATE
        ORDER BY START_DATE ASC, CONTRACT_ID ASC, ID ASC
      ) AS rn_email
    FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`   -- RUNRATE
    WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
  ),
  tier1 AS (
    SELECT cand, job, CONTRACT_ID, SKU_NUMBER
    FROM runrate_ranked
    WHERE rn_nexus = 1 AND cand IS NOT NULL AND job IS NOT NULL
  ),
  tier2 AS (
    SELECT email, START_DATE, CONTRACT_ID, SKU_NUMBER
    FROM runrate_ranked
    WHERE rn_email = 1 AND email IS NOT NULL AND email != '' AND START_DATE IS NOT NULL
  )
  -- One row per DEAL_SHEET_ID: a deal sheet can hold several appended rows, and every one of them
  -- must land on the same legacy identity.
  SELECT
    ds.DEAL_SHEET_ID AS deal_sheet_id,
    ANY_VALUE(COALESCE(t1.CONTRACT_ID, t2.CONTRACT_ID)) AS contract_id,
    ANY_VALUE(COALESCE(t1.SKU_NUMBER, t2.SKU_NUMBER)) AS sku_number
  FROM (
    SELECT DISTINCT DEAL_SHEET_ID, CANDIDATE_ID, INTERNAL_JOB_ID, CANDIDATE_EMAIL, START_DATE
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`   -- TABLE
    WHERE DEAL_TYPE = 'DEAL' AND DEAL_SHEET_ID IS NOT NULL
  ) ds
  LEFT JOIN tier1 t1
    ON CAST(ds.CANDIDATE_ID AS STRING) = t1.cand
   AND CAST(ds.INTERNAL_JOB_ID AS STRING) = t1.job
  LEFT JOIN tier2 t2
    ON LOWER(TRIM(ds.CANDIDATE_EMAIL)) = t2.email
   AND ds.START_DATE = t2.START_DATE
  WHERE COALESCE(t1.CONTRACT_ID, t2.CONTRACT_ID) IS NOT NULL
  GROUP BY ds.DEAL_SHEET_ID
) legacy
WHERE d.DEAL_SHEET_ID = legacy.deal_sheet_id
  AND d.DEAL_TYPE = 'DEAL'
  AND (
    d.CONTRACT_ID IS DISTINCT FROM legacy.contract_id
    OR (
      (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '')
      AND legacy.sku_number IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- Verify: should return 0 rows once the UPDATE has run for that table
-- ---------------------------------------------------------------------------
WITH runrate_ranked AS (
  SELECT
    CAST(CANDIDATE_ID AS STRING) AS cand,
    CAST(INTERNAL_JOB_ID AS STRING) AS job,
    CONTRACT_ID,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(CANDIDATE_ID AS STRING), CAST(INTERNAL_JOB_ID AS STRING)
      ORDER BY START_DATE ASC, CONTRACT_ID ASC, ID ASC
    ) AS rn
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`   -- RUNRATE
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
)
SELECT COUNT(*) AS still_mismatched
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d   -- TABLE
JOIN runrate_ranked r
  ON CAST(d.CANDIDATE_ID AS STRING) = r.cand
 AND CAST(d.INTERNAL_JOB_ID AS STRING) = r.job
 AND r.rn = 1
WHERE d.DEAL_TYPE = 'DEAL'
  AND d.CONTRACT_ID IS DISTINCT FROM r.CONTRACT_ID;
