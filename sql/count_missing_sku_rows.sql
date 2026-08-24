-- ============================================================================
-- Kitni rows aisi hain jinpe run-rate ki CONTRACT_ID to hai, run-rate pe SKU
-- bhi hai, par hamari deal-sheet row pe SKU_NUMBER khali hai.
--
-- Wajah: applyLegacyContractIdentityToDealRows me `if (row.CONTRACT_ID != null)
-- continue` — CONTRACT_ID mil jaane ke baad run-rate lookup dobara chalta hi
-- nahi, isliye baad me aaya SKU kabhi uthta nahi.
--
-- Sirf latest row per (DEAL_SHEET_ID, PLACEMENT_ID) dekhte hain — purane
-- append-history rows ginne se count phool jaata.
--
-- DID NOT START / DID NOT ACCEPT chhode hain: unpe SKU jaana hi nahi chahiye
-- (SKU_INELIGIBLE_PLACEMENT_STATUSES).
-- ============================================================================
WITH latest AS (
  SELECT *
  FROM (
    SELECT
      d.*,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(d.DEAL_SHEET_ID AS STRING), CAST(d.PLACEMENT_ID AS STRING)
        ORDER BY d.LAST_UPDATED DESC NULLS LAST
      ) AS _rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS d
    WHERE d.CONTRACT_ID IS NOT NULL AND TRIM(d.CONTRACT_ID) != ''
  )
  WHERE _rn = 1
),
-- run-rate pe har CONTRACT_ID ka SKU (ek contract ki kai rows ho sakti hain)
rr AS (
  SELECT
    TRIM(CAST(CONTRACT_ID AS STRING)) AS contract_id,
    MAX(TRIM(CAST(SKU_NUMBER AS STRING))) AS rr_sku
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
    AND SKU_NUMBER  IS NOT NULL AND TRIM(CAST(SKU_NUMBER  AS STRING)) != ''
  GROUP BY contract_id
)
SELECT
  COUNT(*)                                                      AS rows_missing_sku,
  COUNT(DISTINCT l.CONTRACT_ID)                                 AS distinct_contracts,
  COUNTIF(UPPER(TRIM(l.PLACEMENT_STATUS)) = 'STARTED')          AS started,
  COUNTIF(UPPER(TRIM(l.PLACEMENT_STATUS)) = 'BOOKED')           AS booked,
  COUNTIF(UPPER(TRIM(l.PLACEMENT_STATUS)) LIKE 'ENDED%')        AS ended,
  COUNTIF(UPPER(TRIM(l.PLACEMENT_STATUS)) NOT IN ('STARTED','BOOKED')
          AND UPPER(TRIM(l.PLACEMENT_STATUS)) NOT LIKE 'ENDED%') AS other_status
FROM latest l
JOIN rr ON TRIM(l.CONTRACT_ID) = rr.contract_id
WHERE (l.SKU_NUMBER IS NULL OR TRIM(l.SKU_NUMBER) = '')
  AND UPPER(TRIM(COALESCE(l.PLACEMENT_STATUS, ''))) NOT IN ('DID NOT START', 'DID NOT ACCEPT');


-- ============================================================================
-- BREAKDOWN — status ke hisaab se, aur sample rows.
-- ============================================================================
WITH latest AS (
  SELECT *
  FROM (
    SELECT
      d.*,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(d.DEAL_SHEET_ID AS STRING), CAST(d.PLACEMENT_ID AS STRING)
        ORDER BY d.LAST_UPDATED DESC NULLS LAST
      ) AS _rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS d
    WHERE d.CONTRACT_ID IS NOT NULL AND TRIM(d.CONTRACT_ID) != ''
  )
  WHERE _rn = 1
),
rr AS (
  SELECT
    TRIM(CAST(CONTRACT_ID AS STRING)) AS contract_id,
    MAX(TRIM(CAST(SKU_NUMBER AS STRING))) AS rr_sku
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
    AND SKU_NUMBER  IS NOT NULL AND TRIM(CAST(SKU_NUMBER  AS STRING)) != ''
  GROUP BY contract_id
)
SELECT
  l.PLACEMENT_STATUS,
  l.DEAL_TYPE,
  COUNT(*) AS rows_missing_sku,
  ANY_VALUE(l.CANDIDATE_NAME)  AS sample_candidate,
  ANY_VALUE(l.CONTRACT_ID)     AS sample_contract_id,
  ANY_VALUE(rr.rr_sku)         AS sample_sku_available_in_runrate
FROM latest l
JOIN rr ON TRIM(l.CONTRACT_ID) = rr.contract_id
WHERE (l.SKU_NUMBER IS NULL OR TRIM(l.SKU_NUMBER) = '')
  AND UPPER(TRIM(COALESCE(l.PLACEMENT_STATUS, ''))) NOT IN ('DID NOT START', 'DID NOT ACCEPT')
GROUP BY l.PLACEMENT_STATUS, l.DEAL_TYPE
ORDER BY rows_missing_sku DESC;
