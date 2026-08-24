-- ============================================================================
-- BACKFILL: run-rate se SKU_NUMBER bharo un rows pe jo guard ki wajah se
-- chhut gayi thin (29 rows / 27 contracts).
--
-- Wajah: applyLegacyContractIdentityToDealRows me `if (row.CONTRACT_ID != null)
-- continue` — CONTRACT_ID mil jaane ke baad run-rate lookup dobara chalta hi
-- nahi, isliye baad me aaya SKU kabhi uthta nahi.
--
-- Ye sirf DATA theek karta hai. Code fix alag se chahiye, warna naye cases
-- bante rahenge.
-- ============================================================================


-- ============================================================================
-- STEP 1 — PREVIEW. Pehle ye chalao: exactly kaunsi rows badlengi aur kya
-- value jayegi. Verify karke hi STEP 2 chalana.
-- ============================================================================
WITH rr AS (
  SELECT
    TRIM(CAST(CONTRACT_ID AS STRING)) AS contract_id,
    MAX(TRIM(CAST(SKU_NUMBER AS STRING))) AS rr_sku,
    COUNT(DISTINCT TRIM(CAST(SKU_NUMBER AS STRING))) AS distinct_skus
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
    AND SKU_NUMBER  IS NOT NULL AND TRIM(CAST(SKU_NUMBER  AS STRING)) != ''
  GROUP BY contract_id
)
SELECT
  d.ID,
  d.CANDIDATE_NAME,
  d.CONTRACT_ID,
  d.PLACEMENT_STATUS,
  d.DEAL_TYPE,
  d.SKU_NUMBER      AS current_sku,
  rr.rr_sku         AS will_become,
  rr.distinct_skus  AS runrate_sku_variants,   -- >1 hua to manually dekhna
  d.LAST_UPDATED
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS d
JOIN rr ON TRIM(d.CONTRACT_ID) = rr.contract_id
WHERE (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '')
  AND d.CONTRACT_ID IS NOT NULL AND TRIM(d.CONTRACT_ID) != ''
  AND UPPER(TRIM(COALESCE(d.PLACEMENT_STATUS, ''))) NOT IN ('DID NOT START', 'DID NOT ACCEPT')
ORDER BY rr.distinct_skus DESC, d.CANDIDATE_NAME;


-- ============================================================================
-- STEP 2 — UPDATE. Preview verify karne ke baad hi chalao.
--
-- NOTE: ye HAR matching row update karta hai, sirf latest nahi — append-history
-- ki purani rows bhi. Jaan-boojh ke, taaki ek placement ki saari rows same SKU
-- dikhayein. Sirf latest chahiye to neeche wala variant use karo.
-- ============================================================================
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS d
SET SKU_NUMBER = rr.rr_sku
FROM (
  SELECT
    TRIM(CAST(CONTRACT_ID AS STRING)) AS contract_id,
    MAX(TRIM(CAST(SKU_NUMBER AS STRING))) AS rr_sku
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
    AND SKU_NUMBER  IS NOT NULL AND TRIM(CAST(SKU_NUMBER  AS STRING)) != ''
  GROUP BY contract_id
) AS rr
WHERE TRIM(d.CONTRACT_ID) = rr.contract_id
  AND (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '')
  AND d.CONTRACT_ID IS NOT NULL AND TRIM(d.CONTRACT_ID) != ''
  AND UPPER(TRIM(COALESCE(d.PLACEMENT_STATUS, ''))) NOT IN ('DID NOT START', 'DID NOT ACCEPT');


-- ============================================================================
-- STEP 3 — VERIFY. Update ke baad chalao, 0 aana chahiye.
-- ============================================================================
-- WITH rr AS (
--   SELECT TRIM(CAST(CONTRACT_ID AS STRING)) AS contract_id
--   FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
--   WHERE CONTRACT_ID IS NOT NULL AND TRIM(CAST(CONTRACT_ID AS STRING)) != ''
--     AND SKU_NUMBER  IS NOT NULL AND TRIM(CAST(SKU_NUMBER  AS STRING)) != ''
--   GROUP BY contract_id
-- )
-- SELECT COUNT(*) AS still_missing
-- FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS d
-- JOIN rr ON TRIM(d.CONTRACT_ID) = rr.contract_id
-- WHERE (d.SKU_NUMBER IS NULL OR TRIM(d.SKU_NUMBER) = '')
--   AND UPPER(TRIM(COALESCE(d.PLACEMENT_STATUS, ''))) NOT IN ('DID NOT START', 'DID NOT ACCEPT');
