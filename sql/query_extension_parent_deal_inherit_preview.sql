-- Preview: parent DEAL inherit fields for EXTENSION rows with null CONTRACT_ID.
-- Mirrors fetchExtensionParentDealInheritByPlacementId in functions/src/bigQueryClient.js:
--   earliest matching DEAL row (START_DATE ASC) using the same 4-field match key as
--   CONTRACT_ID resolution (CANDIDATE_NEXUS_ID + email + phone + CLIENT_ID).
-- ORIGINAL_START_DATE = COALESCE(parent.ORIGINAL_START_DATE, parent.START_DATE).
-- Excludes CLIENT_RECRUITER, PRIMARY_SALES_PERSON, SECONDARY_SALES_PERSON, and RECRUITER_CLUSTER —
-- these are manual BigQuery-edited columns and must never be auto-inherited from a parent DEAL row.

WITH extensions AS (
  SELECT
    PLACEMENT_ID,
    CANDIDATE_NAME,
    CANDIDATE_NEXUS_ID,
    LOWER(TRIM(CANDIDATE_EMAIL)) AS candidate_email,
    IFNULL(PHONE_NUMBER, '') AS phone_number,
    CLIENT_ID,
    PARENT_CLIENT_NAME AS deal_parent_client,
    START_DATE AS extension_start_date,
    CONTRACT_ID AS current_contract_id
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'EXTENSION'
    AND (CONTRACT_ID IS NULL OR TRIM(CAST(CONTRACT_ID AS STRING)) = '')
    AND CANDIDATE_NEXUS_ID IS NOT NULL
    AND PLACEMENT_ID IS NOT NULL
    AND CLIENT_ID IS NOT NULL
),

parent_deals AS (
  SELECT
    CANDIDATE_NEXUS_ID,
    LOWER(IFNULL(CANDIDATE_EMAIL, '')) AS candidate_email_norm,
    IFNULL(PHONE_NUMBER, '') AS phone_norm,
    CLIENT_ID,
    START_DATE AS parent_start_date,
    PLACEMENT_ID AS parent_placement_id,
    COALESCE(ORIGINAL_START_DATE, START_DATE) AS proposed_original_start_date,
    NEW_HIRE_DATE AS proposed_new_hire_date,
    TEAM_LEAD,
    TEAM_LEAD_EMP_NO,
    ATL,
    ATL_EMP_NO,
    RM,
    RM_EMP_NO,
    ACCOUNT_MANAGER,
    ACCOUNT_MANAGER_EMP_NO,
    SECONDARY_AM,
    SECONDARY_AM_EMP_NO,
    ASSOCIATE_AM,
    ASSOCIATE_AM_EMP_NO,
    GRP_DIR_ASSOC_GRP_DIR,
    GRP_DIR_ASSOC_GRP_DIR_EMP_NO,
    VP_SRVP,
    VP_SRVP_EMP_NO,
    SECONDARY_RECRUITER,
    SECONDARY_RECRUITER_EMP_NO,
    DELIVERY_DIRECTOR,
    DELIVERY_DIRECTOR_EMP_NO,
    DELIVERY_POC,
    ACC_DIR_OR_VERT_HEAD,
    CREDENTIALING_SPECIALIST,
    CREDENTIALING_LEAD,
    ROW_NUMBER() OVER (
      PARTITION BY CANDIDATE_NEXUS_ID,
        LOWER(IFNULL(CANDIDATE_EMAIL, '')),
        IFNULL(PHONE_NUMBER, ''),
        CLIENT_ID
      ORDER BY START_DATE ASC NULLS LAST, PLACEMENT_ID ASC NULLS LAST
    ) AS rn
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE UPPER(TRIM(DEAL_TYPE)) = 'DEAL'
)

SELECT
  e.PLACEMENT_ID,
  e.CANDIDATE_NAME,
  e.CANDIDATE_NEXUS_ID,
  e.deal_parent_client,
  e.extension_start_date,
  e.current_contract_id,

  p.parent_placement_id,
  p.parent_start_date,
  p.proposed_original_start_date,
  p.proposed_new_hire_date,
  p.TEAM_LEAD,
  p.TEAM_LEAD_EMP_NO,
  p.ATL,
  p.ATL_EMP_NO,
  p.RM,
  p.RM_EMP_NO,
  p.ACCOUNT_MANAGER,
  p.ACCOUNT_MANAGER_EMP_NO,
  p.SECONDARY_AM,
  p.SECONDARY_AM_EMP_NO,
  p.ASSOCIATE_AM,
  p.ASSOCIATE_AM_EMP_NO,
  p.GRP_DIR_ASSOC_GRP_DIR,
  p.GRP_DIR_ASSOC_GRP_DIR_EMP_NO,
  p.VP_SRVP,
  p.VP_SRVP_EMP_NO,
  p.SECONDARY_RECRUITER,
  p.SECONDARY_RECRUITER_EMP_NO,
  p.DELIVERY_DIRECTOR,
  p.DELIVERY_DIRECTOR_EMP_NO,
  p.DELIVERY_POC,
  p.ACC_DIR_OR_VERT_HEAD,
  p.CREDENTIALING_SPECIALIST,
  p.CREDENTIALING_LEAD,

  IF(p.parent_placement_id IS NOT NULL, 'PARENT_DEAL_MATCHED', 'NO_PARENT_DEAL') AS inherit_status

FROM extensions e
LEFT JOIN parent_deals p
  ON e.CANDIDATE_NEXUS_ID = p.CANDIDATE_NEXUS_ID
 AND e.candidate_email = p.candidate_email_norm
 AND e.phone_number = p.phone_norm
 AND e.CLIENT_ID = p.CLIENT_ID
 AND p.rn = 1
ORDER BY inherit_status, e.CANDIDATE_NAME, e.PLACEMENT_ID;

-- Summary
-- SELECT
--   inherit_status,
--   COUNT(*) AS row_count
-- FROM ( ... above without ORDER BY ... )
-- GROUP BY inherit_status;
