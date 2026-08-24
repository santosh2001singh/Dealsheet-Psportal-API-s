-- ============================================================================
-- ASLI WASTE COUNT — consecutive-row level pe, pair level pe nahi.
--
-- Pehli summary query (Q1) galat metric thi: usne poocha "kya pair BILKUL flat
-- hai", isliye jis pair me 2 genuine change the wo "changed" mark ho gaya aur
-- uske 41 zero-diff appends chhup gaye.
--
-- Ye query har consecutive jodi ko alag se dekhti hai: jitni baar row apne
-- pichhle row ke bilkul barabar hai, utne appends faltu the.
-- ============================================================================
WITH ranked AS (
  SELECT
    CAST(t.DEAL_SHEET_ID AS STRING) AS ds_id,
    CAST(t.PLACEMENT_ID  AS STRING) AS pl_id,
    TO_JSON_STRING((SELECT AS STRUCT t.* EXCEPT (ID, LAST_UPDATED, MOVE_RUNRATE))) AS j,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(t.DEAL_SHEET_ID AS STRING), CAST(t.PLACEMENT_ID AS STRING)
      ORDER BY t.LAST_UPDATED
    ) AS rn
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
  WHERE t.DEAL_SHEET_ID IS NOT NULL
    AND t.PLACEMENT_ID  IS NOT NULL
)
SELECT
  COUNT(*)                          AS total_appends_compared,
  COUNTIF(a.j = b.j)                AS zero_diff_appends,
  COUNT(DISTINCT IF(a.j = b.j, CONCAT(a.ds_id, '|', a.pl_id), NULL))
                                    AS placements_with_waste
FROM ranked a
JOIN ranked b
  ON a.ds_id = b.ds_id
 AND a.pl_id = b.pl_id
 AND a.rn    = b.rn + 1;


-- ============================================================================
-- PER-PLACEMENT BREAKDOWN — kaunse placements sabse zyada waste kar rahe hain.
-- ============================================================================
WITH ranked AS (
  SELECT
    CAST(t.DEAL_SHEET_ID AS STRING) AS ds_id,
    CAST(t.PLACEMENT_ID  AS STRING) AS pl_id,
    t.CANDIDATE_NAME,
    t.PLACEMENT_STATUS,
    TO_JSON_STRING((SELECT AS STRUCT t.* EXCEPT (ID, LAST_UPDATED, MOVE_RUNRATE))) AS j,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(t.DEAL_SHEET_ID AS STRING), CAST(t.PLACEMENT_ID AS STRING)
      ORDER BY t.LAST_UPDATED
    ) AS rn
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
  WHERE t.DEAL_SHEET_ID IS NOT NULL
    AND t.PLACEMENT_ID  IS NOT NULL
)
SELECT
  a.ds_id                        AS deal_sheet_id,
  a.pl_id                        AS placement_id,
  ANY_VALUE(a.CANDIDATE_NAME)    AS candidate_name,
  ANY_VALUE(a.PLACEMENT_STATUS)  AS placement_status,
  COUNT(*)                       AS appends_compared,
  COUNTIF(a.j = b.j)             AS zero_diff_appends,
  COUNTIF(a.j != b.j)            AS real_change_appends
FROM ranked a
JOIN ranked b
  ON a.ds_id = b.ds_id
 AND a.pl_id = b.pl_id
 AND a.rn    = b.rn + 1
GROUP BY a.ds_id, a.pl_id
HAVING COUNTIF(a.j = b.j) > 0
ORDER BY zero_diff_appends DESC
LIMIT 100;
