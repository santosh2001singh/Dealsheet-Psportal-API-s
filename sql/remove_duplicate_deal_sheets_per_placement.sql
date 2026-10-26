-- One deal sheet per placement in cynet_health_deal_sheet (2026-10-20).
--
-- 16 placements held rows for two DEAL_SHEET_IDs. The deal sheet to KEEP was chosen from Nexus
-- /api/deal-sheet-candidates/ with the same rule the code now uses:
--   1. type PRIMARY   2. deal sheet status FINAL   3. newest created_date
-- Every row of the other (DROP) deal sheet is removed. Run the steps in order.

-- ---------------------------------------------------------------------------------------------
-- STEP 0: the decision list
-- ---------------------------------------------------------------------------------------------
-- placement | keep    (why)                          | drop    (what it is in Nexus)
-- 1430942   | 5105335 PRIMARY FINAL                  | 5106759 SECONDARY VERBAL
-- 1437555   | 5126958 PRIMARY FINAL                  | 5237289 PRIMARY VERBAL (is_extension)
-- 1443009   | 5146646 PRIMARY FINAL                  | 5199010 PRIMARY VERBAL (is_extension)
-- 1444485   | 5153878 PRIMARY FINAL                  | 5160467 SECONDARY VERBAL (archived)
-- 1445719   | 5159170 PRIMARY FINAL                  | 5159977 SECONDARY VERBAL
-- 1448637   | 5171341 PRIMARY VERBAL                 | 5174261 SECONDARY VERBAL (newer)
-- 1450666   | 5183649 PRIMARY FINAL                  | 5213215 PRIMARY VERBAL (is_extension)
-- 1451128   | 5185486 PRIMARY FINAL                  | 5218962 PRIMARY VERBAL (is_extension)
-- 1452725   | 5191931 PRIMARY FINAL                  | 5199013 PRIMARY VERBAL (is_extension)
-- 1460705   | 5231399 PRIMARY FINAL  (CHC23962)      | 5231105 SECONDARY VERBAL (CHC23961)
-- 1464301   | 5248292 PRIMARY VERBAL                 | 5248308 no longer listed on the job in Nexus
-- 1464339   | 5248438 PRIMARY FINAL                  | 5250067 SECONDARY VERBAL (archived)
-- 1464725   | 5250169 PRIMARY FINAL                  | 5251466 SECONDARY VERBAL (archived)
-- 1465579   | 5253880 PRIMARY FINAL                  | 5253886 SECONDARY VERBAL
-- 1468157   | 5265190 PRIMARY FINAL                  | 5265179 SECONDARY VERBAL
-- 1470015   | 5274477 PRIMARY FINAL                  | 5271770 SECONDARY VERBAL (archived)

-- ---------------------------------------------------------------------------------------------
-- STEP 1: preview — rows that will be deleted (expected 45 rows, 16 placements)
-- ---------------------------------------------------------------------------------------------
WITH drop_list AS (
  SELECT * FROM UNNEST([
    STRUCT('1430942' AS placement_id, '5105335' AS keep_ds, '5106759' AS drop_ds),
    ('1437555', '5126958', '5237289'),
    ('1443009', '5146646', '5199010'),
    ('1444485', '5153878', '5160467'),
    ('1445719', '5159170', '5159977'),
    ('1448637', '5171341', '5174261'),
    ('1450666', '5183649', '5213215'),
    ('1451128', '5185486', '5218962'),
    ('1452725', '5191931', '5199013'),
    ('1460705', '5231399', '5231105'),
    ('1464301', '5248292', '5248308'),
    ('1464339', '5248438', '5250067'),
    ('1464725', '5250169', '5251466'),
    ('1465579', '5253880', '5253886'),
    ('1468157', '5265190', '5265179'),
    ('1470015', '5274477', '5271770')
  ])
)
SELECT d.placement_id, d.keep_ds, d.drop_ds,
       COUNT(*) AS rows_to_delete,
       -- safety: the KEEP deal sheet must still have rows for the placement
       (SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` k
         WHERE CAST(k.PLACEMENT_ID AS STRING) = d.placement_id
           AND CAST(k.DEAL_SHEET_ID AS STRING) = d.keep_ds) AS keep_rows
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
JOIN drop_list d
  ON CAST(t.PLACEMENT_ID AS STRING) = d.placement_id
 AND CAST(t.DEAL_SHEET_ID AS STRING) = d.drop_ds
GROUP BY 1, 2, 3
ORDER BY 1;

-- ---------------------------------------------------------------------------------------------
-- STEP 2: backup the rows being deleted
-- ---------------------------------------------------------------------------------------------
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261020_dup_deal_sheet_rows` AS
SELECT t.*
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
WHERE STRUCT(CAST(t.PLACEMENT_ID AS STRING), CAST(t.DEAL_SHEET_ID AS STRING)) IN UNNEST([
  STRUCT('1430942' AS p, '5106759' AS d), ('1437555', '5237289'), ('1443009', '5199010'),
  ('1444485', '5160467'), ('1445719', '5159977'), ('1448637', '5174261'), ('1450666', '5213215'),
  ('1451128', '5218962'), ('1452725', '5199013'), ('1460705', '5231105'), ('1464301', '5248308'),
  ('1464339', '5250067'), ('1464725', '5251466'), ('1465579', '5253886'), ('1468157', '5265179'),
  ('1470015', '5271770')
]);

-- check: expect 45
SELECT COUNT(*) FROM `cynetdatabase.rr_project_data.bkp_20261020_dup_deal_sheet_rows`;

-- ---------------------------------------------------------------------------------------------
-- STEP 3: delete
-- ---------------------------------------------------------------------------------------------
DELETE FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
WHERE STRUCT(CAST(t.PLACEMENT_ID AS STRING), CAST(t.DEAL_SHEET_ID AS STRING)) IN UNNEST([
  STRUCT('1430942' AS p, '5106759' AS d), ('1437555', '5237289'), ('1443009', '5199010'),
  ('1444485', '5160467'), ('1445719', '5159977'), ('1448637', '5174261'), ('1450666', '5213215'),
  ('1451128', '5218962'), ('1452725', '5199013'), ('1460705', '5231105'), ('1464301', '5248308'),
  ('1464339', '5250067'), ('1464725', '5251466'), ('1465579', '5253886'), ('1468157', '5265179'),
  ('1470015', '5271770')
]);

-- ---------------------------------------------------------------------------------------------
-- STEP 4: verify — expect 0 rows
-- ---------------------------------------------------------------------------------------------
SELECT CAST(PLACEMENT_ID AS STRING) AS placement_id,
       ARRAY_AGG(DISTINCT CAST(DEAL_SHEET_ID AS STRING)) AS deal_sheets
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE PLACEMENT_ID IS NOT NULL AND DEAL_SHEET_ID IS NOT NULL
GROUP BY 1
HAVING COUNT(DISTINCT CAST(DEAL_SHEET_ID AS STRING)) > 1;

-- ---------------------------------------------------------------------------------------------
-- ROLLBACK (only if needed)
-- ---------------------------------------------------------------------------------------------
-- INSERT INTO `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
-- SELECT * FROM `cynetdatabase.rr_project_data.bkp_20261020_dup_deal_sheet_rows`;
