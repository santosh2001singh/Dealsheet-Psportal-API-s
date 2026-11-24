-- 2026-11-23: ownership_change_logs system rows written while a contract id was split (before the
-- 2026-11-09 contract id fix) — blank SKU_NO, one wrong previous recruiter, data-team duplicates.
-- Case: Paul Peter Wolka CHC22153 / H15247, placement 1474333.

-- 1. Backup
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261123_own_log_sku_fix` AS
SELECT * FROM `cynetdatabase.rr_project_data.ownership_change_logs`;

-- 2. Fill blank SKU_NO on health system rows from the placement's latest non-blank deal sheet SKU
UPDATE `cynetdatabase.rr_project_data.ownership_change_logs` o
SET SKU_NO = k.sku_now
FROM (
  SELECT CAST(PLACEMENT_ID AS STRING) pid, SKU_NUMBER sku_now
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE SKU_NUMBER IS NOT NULL AND TRIM(SKU_NUMBER) != ''
  QUALIFY ROW_NUMBER() OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED DESC) = 1
) k
WHERE o.PLACEMENT_ID = k.pid
  AND o.EDITED_BY IS DISTINCT FROM 'DATA_TEAM_SYNC'
  AND (o.SKU_NO IS NULL OR TRIM(o.SKU_NO) = '')
  AND UPPER(o.CONTRACT_ID) LIKE 'CHC%';

-- 3. CHC22153 recruiter handover: previous owner was Sonam (ext 1465566), not Philaso
UPDATE `cynetdatabase.rr_project_data.ownership_change_logs`
SET PREVIOUS_OWNER_NAME = 'Sonam Chaudhary (R4A)', PREVIOUS_OWNER_EMP_NO = 'CY3474'
WHERE ID = '7fe31e91-8f35-40f6-914b-c67c80f8d954';

-- 4. System rows that repeat a data team row (same SKU, role, previous + new owner, dates 0-1 day apart)
DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE ID IN (
  '076b7209-c9ad-4db7-b44d-83cb979d5466',  -- CHC22153 ONSITE_AM Derick Yi -> Vish Singh
  '43469e29-f537-4e94-afb8-8affbad3a952',  -- CHC22740 ONSITE_AM Derick Yi -> Jessica Van Essen
  '82a4af4c-4709-4fc1-9455-b0afe24f638e',  -- CHC22823 ONSITE_AM Derick Yi -> Jessica Van Essen
  'd5905e5c-fdec-42a5-8db3-80b7f561b05b',  -- CHC23307 LEVEL_2_CSM Jessica Van Essen -> Jodi Stanton
  '97764a04-9442-45f6-a725-8f6fc43e0110'   -- CHC23307 ONSITE_AM Elisa An -> Jessica Van Essen
);

-- Rollback:
-- DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs` WHERE TRUE;
-- INSERT INTO `cynetdatabase.rr_project_data.ownership_change_logs`
-- SELECT * FROM `cynetdatabase.rr_project_data.bkp_20261123_own_log_sku_fix`;
