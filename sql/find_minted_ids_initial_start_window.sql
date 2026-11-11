-- Health DEAL contracts that minted a new CHC id (>= CHC23000) although the run-rate already had the
-- contract: approve had rewritten the run-rate row's START_DATE to a later extension's start, so the
-- DEAL's own dates fell before the window. Re-runs tier 1 of fetchLegacyContractIdentityForDealRows
-- with the window opening at INITIAL_START_DATE (2026-11-09), pooled per current CONTRACT_ID.
WITH deal_rows AS (
  SELECT 'active' AS src, DEAL_TYPE, CONTRACT_ID, CANDIDATE_ID, CANDIDATE_EMAIL, CLIENT_ID, NEXUS_PARENT_CLIENT_ID, FACILITY_NAME, PARENT_CLIENT_NAME, START_DATE, END_DATE, TENTATIVE_END_DATE FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  UNION ALL
  SELECT 'ended' AS src, DEAL_TYPE, CONTRACT_ID, CANDIDATE_ID, CANDIDATE_EMAIL, CLIENT_ID, NEXUS_PARENT_CLIENT_ID, END_CLIENT_DEPT_FACILITY AS FACILITY_NAME, PARENT_CLIENT_NAME, START_DATE, END_DATE, TENTATIVE_END_DATE FROM `cynetdatabase.rr_project_data.cynet_health_ended_deal_sheet`
),
minted AS (
  SELECT * FROM deal_rows
  WHERE DEAL_TYPE = 'DEAL'
    AND REGEXP_CONTAINS(CONTRACT_ID, r'^CHC\d+$')
    AND CAST(SUBSTR(CONTRACT_ID, 4) AS INT64) >= 23000
),
probes AS (
  SELECT DISTINCT
    CONTRACT_ID AS cur_id,
    CAST(CANDIDATE_ID AS STRING) AS cand,
    LOWER(TRIM(CANDIDATE_EMAIL)) AS em,
    CAST(CLIENT_ID AS STRING) AS fac_id,
    CAST(NEXUS_PARENT_CLIENT_ID AS STRING) AS pc_id,
    LOWER(TRIM(FACILITY_NAME)) AS fac,
    LOWER(TRIM(PARENT_CLIENT_NAME)) AS pc,
    probe
  FROM minted,
  UNNEST([START_DATE,
          IF(END_DATE >= START_DATE, END_DATE, NULL),
          IF(TENTATIVE_END_DATE >= START_DATE, TENTATIVE_END_DATE, NULL)]) AS probe
  WHERE probe IS NOT NULL
),
pooled AS (
  SELECT cur_id, cand, em, fac_id, pc_id, fac, pc, ARRAY_AGG(DISTINCT probe) AS probe_dates
  FROM probes GROUP BY 1, 2, 3, 4, 5, 6, 7
),
ranked AS (
  SELECT
    w.cur_id,
    r.CONTRACT_ID AS legacy_id,
    r.SKU_NUMBER AS legacy_sku,
    LEAST(COALESCE(r.INITIAL_START_DATE, r.START_DATE), r.START_DATE) AS legacy_initial_start,
    r.START_DATE AS runrate_start,
    COALESCE(r.END_DATE, r.TENTATIVE_END_DATE) AS runrate_end,
    r.PLACEMENT_ID AS runrate_placement_id,
    -- Did the OLD window (START_DATE) also cover a probe? Then the old rule matched too.
    (SELECT COUNT(1) FROM UNNEST(w.probe_dates) pd
      WHERE pd BETWEEN r.START_DATE AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)) AS old_cover,
    ROW_NUMBER() OVER (
      PARTITION BY w.cur_id, w.cand, w.em, w.fac_id, w.pc_id, w.fac, w.pc
      ORDER BY
        CASE WHEN LEAST(COALESCE(r.INITIAL_START_DATE, r.START_DATE), r.START_DATE) IN UNNEST(w.probe_dates)
               OR r.START_DATE IN UNNEST(w.probe_dates) THEN 0 ELSE 1 END,
        (SELECT COUNT(1) FROM UNNEST(w.probe_dates) pd
          WHERE pd BETWEEN LEAST(COALESCE(r.INITIAL_START_DATE, r.START_DATE), r.START_DATE)
                       AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE)) DESC,
        r.START_DATE DESC, r.CONTRACT_ID, r.ID
    ) AS rn
  FROM `cynetdatabase.rr_project_data.all_CH_data_runrate` r
  JOIN pooled w
    ON ((w.cand IS NOT NULL AND w.cand != '' AND CAST(r.CANDIDATE_ID AS STRING) = w.cand)
        OR (w.em IS NOT NULL AND w.em != '' AND LOWER(TRIM(r.CANDIDATE_EMAIL)) = w.em))
   AND (CASE
          WHEN IFNULL(w.fac_id, '') != '' AND IFNULL(w.pc_id, '') != ''
           AND r.CLIENT_ID IS NOT NULL AND r.NEXUS_PARENT_CLIENT_ID IS NOT NULL
            THEN CAST(r.CLIENT_ID AS STRING) = w.fac_id AND CAST(r.NEXUS_PARENT_CLIENT_ID AS STRING) = w.pc_id
          ELSE LOWER(TRIM(r.FACILITY_NAME)) = w.fac AND LOWER(TRIM(r.PARENT_CLIENT_NAME)) = w.pc
        END)
  WHERE EXISTS (SELECT 1 FROM UNNEST(w.probe_dates) pd
                WHERE pd BETWEEN LEAST(COALESCE(r.INITIAL_START_DATE, r.START_DATE), r.START_DATE)
                             AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE))
    AND TRIM(IFNULL(r.CONTRACT_ID, '')) != ''
    AND r.START_DATE IS NOT NULL
    AND COALESCE(r.END_DATE, r.TENTATIVE_END_DATE) IS NOT NULL
)
SELECT DISTINCT cur_id, legacy_id, legacy_sku, legacy_initial_start, runrate_start, runrate_end,
       runrate_placement_id, old_cover
FROM ranked
WHERE rn = 1 AND legacy_id != cur_id
ORDER BY cur_id
