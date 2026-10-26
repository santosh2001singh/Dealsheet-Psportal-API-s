-- EXTENSION rows whose INITIAL_START_DATE is the run-rate row's START_DATE instead of the contract's
-- real initial start.
--
-- Cause: the run-rate backfill took "earliest START_DATE of the SKU in the run-rate", but the
-- run-rate keeps only a contract's LATEST segment, so that is the previous extension's start. The
-- run-rate row's own INITIAL_START_DATE (the real one) was ignored. Fixed in
-- fetchExtensionRunrateBackfillByPlacementId; this repairs the rows written before.
-- Live case: Angela Addy, PLACEMENT_ID 1468972, CHC10980 -> 2026-08-30 instead of 2023-05-08.
--
-- INITIAL_START_DATE is a MANUAL_COLUMNS field, so later update-appends carry the repaired value.


-- STEP 1 - preview (5 rows on 2026-09-30).
WITH rr AS (
  SELECT TRIM(CONTRACT_ID) AS contract_id, TRIM(SKU_NUMBER) AS sku,
         START_DATE AS rr_start, INITIAL_START_DATE AS rr_initial
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
    AND INITIAL_START_DATE IS NOT NULL
    AND INITIAL_START_DATE < START_DATE
)
SELECT d.CANDIDATE_NAME, d.DEAL_SHEET_ID, d.PLACEMENT_ID, d.CONTRACT_ID, d.START_DATE,
       d.INITIAL_START_DATE AS current_initial, rr.rr_initial AS correct_initial, COUNT(*) AS row_versions
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
JOIN rr ON rr.contract_id = TRIM(d.CONTRACT_ID) AND rr.sku = TRIM(d.SKU_NUMBER)
WHERE d.DEAL_TYPE = 'EXTENSION'
  AND d.INITIAL_START_DATE = rr.rr_start
  AND rr.rr_initial <= d.START_DATE
GROUP BY 1, 2, 3, 4, 5, 6, 7
ORDER BY d.CONTRACT_ID;


-- STEP 2 - fix. Every version of each placement, so the history agrees with the latest row.
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` d
SET INITIAL_START_DATE = rr.rr_initial
FROM (
  SELECT TRIM(CONTRACT_ID) AS contract_id, TRIM(SKU_NUMBER) AS sku,
         START_DATE AS rr_start, INITIAL_START_DATE AS rr_initial
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate`
  WHERE CONTRACT_ID IS NOT NULL AND TRIM(CONTRACT_ID) != ''
    AND INITIAL_START_DATE IS NOT NULL
    AND INITIAL_START_DATE < START_DATE
  QUALIFY COUNT(*) OVER (PARTITION BY TRIM(CONTRACT_ID), TRIM(SKU_NUMBER)) = 1
) rr
WHERE rr.contract_id = TRIM(d.CONTRACT_ID)
  AND rr.sku = TRIM(d.SKU_NUMBER)
  AND d.DEAL_TYPE = 'EXTENSION'
  AND d.INITIAL_START_DATE = rr.rr_start
  AND rr.rr_initial <= d.START_DATE;
