-- INSERT all lo_run_rate rows into all_locums_runrate.
-- Pehle CREATE TABLE `sql/recreate_all_locums_runrate.sql` chalao.
-- No filter — pura lo_run_rate data (913 rows).
--
-- Source: cynetdatabase.cynet_locum.lo_run_rate            (123 columns)
-- Target: cynetdatabase.rr_project_data.all_locums_runrate (255 columns)
--
-- Key renames (lo_run_rate -> target), same conventions as the canada load:
--   POSITION                    -> SPECIALTY
--   NEXUS_INTERNAL_JOBID        -> INTERNAL_JOB_ID
--   END_CLIENT_OR_FACILITY      -> FACILITY_NAME        (the column the failing sync asked for)
--   INITIAL_PROJ_IN_WK          -> PROJECT_DURATION
--   CND_NEXUS_ID                -> CANDIDATE_ID         ("NA" on internal rows -> NULL)
--   ORIENTATION_HOURS           -> NBO_HOURS
--   CANDIDATE_NO                -> CELL_PHONE           (a phone number, e.g. "248-417-3219")
--   EMAIL_ID                    -> CANDIDATE_EMAIL      (candidate's email, not the recruiter's)
--   CATEG_OF_POS                -> PROFESSION
--   CLT_PYMT_TERM               -> CLIENT_PAYMENT_TERMS
--   INV_CYC_TO_CLT              -> INVOICE_CYCLE_TO_CLIENT
--   CAND_PYMT_TERMS             -> CANDIDATE_PAYMENT_TERMS
--   VP_SRVP                     -> VP
--   GRP_DIR_ASSOC_GRP_DIR       -> ASSOCIATE_DELIVERY_DIRECTOR
--   BO_OR_END_REASON            -> BACKOUT_OR_TERMINATION
--   CLIENT_TYPE                 -> TYPE_OF_CLIENT
--   OFFER_TIME_ST_DATE          -> OFFER_TIME_START_DATE
--   WEEKLY_PER_DIEM             -> WEEKLY_PER_DIEM_NON_TAXED
--   GUARANTEED_HOURS            -> SCHEDULE_HOURS_1
--   TOTAL_EXT_RECD              -> NO_OF_TIME_EXTENSION_RECEIVED
--   EXTERNAL_JOB_POSTING_ID     -> VMS_JOB_ID
--   DELIVERYPOC_EMAIL           -> DELIVERY_POC_EMAIL
--   FINAL_CALL_BACK_PAY_RATE    -> FINAL_CALLBACK_PAY_RATE
--   REBOOKING_OR_EXTENSION      -> REBOOKING_EXTENSION
--   OWNERSHIP_CHANGE_DATE       -> OWNERSHIP_EFFECTIVE_DATE
--   UPDATED_BY                  -> EDITED_BY            (STRING -> INT64 via SAFE_CAST)
--   EMP_CODE_OR_NAME            -> RECRUITER_EMP_NO     (empty in every sampled row — verify)
--   RECRUITER / RECRUITER_EMAIL_ID -> ASSIGNMENT_RECRUITER / ASSIGNMENT_RECRUITER_EMAIL
--   TYPE (1099/W2)              -> PAYMENT_TYPE
--
-- Margin maps (matching the Sep 2026 locums rename):
--   NET_MARGIN   -> CALCULATED_MARGIN
--   GROSS_MARGIN -> GROSS_MARGIN
--   MARGIN       -> NULL (blank)
--
-- LOADING_COST_EXCEPTION rides across as itself (20 non-null rows): the target now carries a
-- matching column, mirroring cynet_locums_deal_sheet.LOADING_COST_EXCEPTION.
-- Every one of the source's 123 columns is carried.
--
-- SAFE_CAST is used wherever the types differ, so a bad value lands as NULL instead of failing
-- the whole load.

INSERT INTO `cynetdatabase.rr_project_data.all_locums_runrate` (
  `CANDIDATE_NAME`,
  `SPECIALTY`,
  `SPECIALTY_ID`,
  `INTERNAL_JOB_ID`,
  `PLACEMENT_STATUS`,
  `FACILITY_NAME`,
  `START_DATE`,
  `TENTATIVE_END_DATE`,
  `END_DATE`,
  `REGION`,
  `OT_RATE`,
  `BILL_RATE`,
  `CANDIDATE_STATUS`,
  `PLACEMENT_ID`,
  `CONTRACT_ID`,
  `DEAL_SHEET_STATUS`,
  `DEAL_TYPE`,
  `CLIENT_MSP_FEE`,
  `ASSIGNMENT_RECRUITER`,
  `ASSIGNMENT_RECRUITER_EMAIL`,
  `BOOKING_DATE`,
  `JOB_TYPE`,
  `VMS`,
  `CLIENT_OT_RATE`,
  `PROJECT_DURATION`,
  `CLIENT_CALL_BACK_RATE`,
  `CALL_BACK_RATE`,
  `CANDIDATE_ID`,
  `PLACEMENT_TYPE`,
  `CLIENT_ID`,
  `CLIENT_SALES_REP`,
  `CLIENT_SALES_REP_ID`,
  `CLIENT_STATE`,
  `CLIENT_TYPE`,
  `CITY_ZIPCODE`,
  `CLIENT_HOLIDAY_RATE`,
  `HOLIDAY_RATE`,
  `ON_CALL_RATE`,
  `RATE_CHANGE`,
  `CLIENT_ON_CALL_RATE`,
  `PAY_RATE`,
  `VMS_JOB_ID`,
  `OFFERING`,
  `ADDITIONAL_BONUS`,
  `PO_HOURS`,
  `OFFER_TIME_START_DATE`,
  `PARENT_CLIENT_NAME`,
  `INITIAL_START_DATE`,
  `WEEKLY_PER_DIEM_NON_TAXED`,
  `NBO_HOURS`,
  `BILLABLE_ORIENTATION_HRS`,
  `BILLABLE_ORIENTATION`,
  `SCHEDULE_HOURS_1`,
  `SCHEDULE_HOURS_2`,
  `GM_OT`,
  `DAYS_WORKED`,
  `CELL_PHONE`,
  `CANDIDATE_EMAIL`,
  `DEAL_SHEET_ID`,
  `PROFESSION`,
  `PROFESSION_ID`,
  `HOURLY_GP`,
  `AGENCY_SWITCH`,
  `ONSITE_OWNER`,
  `DIRECTOR_CLIENT_PARTNERSHIP`,
  `IS_DELETED`,
  `GROUP_DIRECTOR`,
  `ASSOCIATE_JUNIOR_CSM`,
  `ONSITE_VP_AVP`,
  `ONSITE_CLIENT_OWNER`,
  `ASSOCIATE_SALES_PERSON`,
  `CLIENT_NAME_IN_CONREP`,
  `EDIT_DATE`,
  `EDITED_BY`,
  `OWNERSHIP_EFFECTIVE_DATE`,
  `UPDATED_AT`,
  `GP_PERCENTAGE`,
  `ONSITE_AM`,
  `ONSITE_AM_EMAIL`,
  `SECONDARY_CELL_PHN`,
  `PAYMENT_TYPE`,
  `WEEKLY_WALLET_MONEY`,
  `PROVIDER_TYPE`,
  `MSP_ID`,
  `NEXUS_PARENT_CLIENT_ID`,
  `MSP_NAME`,
  `LINE_OF_BUSINESS`,
  `RECRUITER_ID`,
  `RECRUITER_EMP_NO`,
  `SUBMISSION_DATE`,
  `ONB_CAND_DOB`,
  `ONB_I9_RECIEVED`,
  `ONB_SUPP_DOC1`,
  `ONB_SUPP_DOC1_EXP_DT`,
  `ONB_SUPP_DOC2`,
  `ONB_SUPP_DOC2_EXP_DT`,
  `ONB_E_VERIFY`,
  `BGC_CATEGORY1`,
  `BGC_AMOUNT1`,
  `BGC_CATEGORY2`,
  `BGC_AMOUNT2`,
  `BGC_CATEGORY3`,
  `BGC_AMOUNT3`,
  `BGC_TOTAL_BGV_COST`,
  `BGC_AGENCY_NAME`,
  `DIVERSITY_STATUS`,
  `BACKOUT_OR_TERMINATION`,
  `CLIENT_RECRUITER`,
  `CLIENT_PAYMENT_TERMS`,
  `INVOICE_CYCLE_TO_CLIENT`,
  `CANDIDATE_PAYMENT_TERMS`,
  `VP`,
  `SR_VP`,
  `PO_RECEIVED`,
  `PAYLOCITY_ID`,
  `COMMENTS`,
  `TERMINATION_REASON`,
  `ENTITY`,
  `SKU_NUMBER`,
  `FIFTYTWO_TENURE_RTO_LASTDATE`,
  `FIFTYTWO_TENURE_CANDIDATE_STATUS`,
  `NEW_HIRE_DATE`,
  `RECRUITMENT_MENTOR`,
  `TYPE_OF_CLIENT`,
  `ST_DT_PUSHBACK_REASON`,
  `EXTENSION_DATE`,
  `EXTENSION_START_DATE`,
  `EXT_OR_REHIRE_BY_RMG`,
  `CLIENT_START_DATE`,
  `CLIENT_CREATED_DATE`,
  `W2_PAY_RATE`,
  `FINAL_PAY_RATE`,
  `FINAL_BILL_RATE`,
  `FINAL_COST`,
  `NET_MARGIN`,
  `MARGIN`,
  `FIRST_WEEK_HOURS`,
  `SECOND_WEEK_HOURS`,
  `TOTAL_BONUS_TAXABLE`,
  `TOTAL_BONUS_NON_TAXABLE`,
  `W2_PAY_RATE_NEW`,
  `FINAL_PAY_RATE_NEW`,
  `FINAL_COST_NEW`,
  `CALCULATED_MARGIN`,
  `REGULAR_HOURS_1`,
  `REGULAR_HOURS_2`,
  `FINAL_BILL_RATE_NEW`,
  `ATL`,
  `TEAM_LEAD`,
  `SECONDARY_AM`,
  `ASSOCIATE_AM`,
  `RM`,
  `ACCOUNT_MANAGER`,
  `ASSOCIATE_DELIVERY_DIRECTOR`,
  `DELIVERY_POC`,
  `DELIVERY_POC_EMP_NO`,
  `DELIVERY_POC_EMAIL`,
  `ACC_DIR_OR_VERT_HEAD`,
  `CLIENT_OWNER`,
  `PRIMARY_SALES_PERSON`,
  `SECONDARY_SALES_PERSON`,
  `CREDENTIALING_SPECIALIST`,
  `CREDENTIALING_LEAD`,
  `RECRUITER_CLUSTER_REGION`,
  `CLIENT_CLUSTER_REGION`,
  `CLUSTER_TYPE`,
  `LAST_UPDATED`,
  `DELIVERY_DIRECTOR`,
  `ATL_EMP_NO`,
  `SECONDARY_RECRUITER`,
  `SECONDARY_RECRUITER_EMP_NO`,
  `TEAM_LEAD_EMP_NO`,
  `RM_EMP_NO`,
  `SECONDARY_AM_EMP_NO`,
  `ASSOCIATE_AM_EMP_NO`,
  `ACCOUNT_MANAGER_EMP_NO`,
  `VP_EMP_NO`,
  `AVP`,
  `AVP_EMP_NO`,
  `ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO`,
  `DELIVERY_DIRECTOR_EMP_NO`,
  `ID`,
  `MOVE_RUNRATE`,
  `IS_REJECTED`,
  `REJECTION_REASON`,
  `DT_RATE`,
  `CLIENT_DT_RATE`,
  `LEVEL_2_CSM`,
  `LEVEL_3_CSM`,
  `LEVEL_4_CSM`,
  `PREVIOUS_RECRUITER_NAME`,
  `OWNERSHIP_DELETED`,
  `IS_EXTENSION`,
  `IS_FUTURE_ENDED`,
  `EXT_PENDING_ID`,
  `EXT_CANCELLED`,
  `CA_GM`,
  `CA_NM`,
  `RECRUITER_CHANGE_DATE`,
  `BEFORE_EXTENSION_RECRUITER`,
  `TOTAL_EXT_RECD`,
  `SECONDARY_PHN`,
  `SECONDARY_EMAIL`,
  `SOURCER_NAME`,
  `EMPLOYEE_ID`,
  `NEW_ID`,
  `ORIGINAL_RECRUITER`,
  `TYPE`,
  `INORGANIC_RECRUITER`,
  `INORGANIC_ACCOUNT_MANAGER`,
  `INORGANIC_ASSOCIATE_AM`,
  `INORGANIC_RM`,
  `INORGANIC_TL`,
  `INORGANIC_ATL`,
  `INORGANIC_ASSOCIATE_GROUP_DIRECTOR`,
  `INORGANIC_DELIVERY_DIRECTOR`,
  `INORGANIC_VP_SR_VP`,
  `INORGANIC_DELIVERY_POC`,
  `INORGANIC_ONSITE_AM`,
  `INORGANIC_ACCOUNTS_DIRECTOR_SR_AM_VERTICAL_HEAD`,
  `GROSS_MARGIN`,
  `POSITION`,
  `NEXUS_INTERNAL_JOB_ID`,
  `END_CLIENT_DEPT_FACILITY`,
  `TENTATIVE_DATE`,
  `INITIAL_PROJECT_DURATION_IN_WEEKS`,
  `CANDIDATE_NEXUS_ID`,
  `ACTUAL_HOURS`,
  `PROJECTED_GP`,
  `ACTUAL_GP`,
  `ORIGINAL_START_DATE`,
  `ORIENTATION_HOURS`,
  `PHONE_NUMBER`,
  `CATEGORIZATION_OF_POSITION`,
  `EFFECTIVE_DATE`,
  `CLT_PYMT_TERM`,
  `INV_CYC_TO_CLT`,
  `CAND_PYMT_TERMS`,
  `VP_SRVP`,
  `FINAL_OT_PAY_RATE`,
  `FINAL_HOLIDAY_PAY_RATE`,
  `FINAL_DT_PAY_RATE`,
  `FINAL_CALLBACK_PAY_RATE`,
  `GRP_DIR_ASSOC_GRP_DIR`,
  `CREDENTIALED_DATE`,
  `DATE_AND_TIME`,
  `DIRECT_MANAGER`,
  `VP_SRVP_EMP_NO`,
  `GRP_DIR_ASSOC_GRP_DIR_EMP_NO`,
  `POSITION_ID`,
  `CATEGORIZATION_OF_POSITION_ID`,
  `SHIFTS`,
  `REBOOKING_EXTENSION`,
  `NO_OF_TIME_EXTENSION_RECEIVED`,
  `EXTENSION_REHIRE`,
  `LOADING_COST_EXCEPTION`
)
SELECT
  r.`CANDIDATE_NAME`,
  r.`POSITION`,                                                       -- SPECIALTY
  CAST(NULL AS INT64),                                                -- SPECIALTY_ID
  SAFE_CAST(r.`NEXUS_INTERNAL_JOBID` AS INT64),                       -- INTERNAL_JOB_ID
  r.`PLACEMENT_STATUS`,
  r.`END_CLIENT_OR_FACILITY`,                                         -- FACILITY_NAME
  r.`START_DATE`,
  r.`TENTATIVE_END_DATE`,
  r.`END_DATE`,
  CAST(NULL AS STRING),                                               -- REGION
  r.`OT_RATE`,
  r.`BILL_RATE`,
  CAST(NULL AS STRING),                                               -- CANDIDATE_STATUS
  CAST(NULL AS INT64),                                                -- PLACEMENT_ID
  CAST(NULL AS STRING),                                               -- CONTRACT_ID
  CAST(NULL AS STRING),                                               -- DEAL_SHEET_STATUS
  CAST(NULL AS STRING),                                               -- DEAL_TYPE
  r.`CLIENT_MSP_FEE`,
  r.`RECRUITER`,                                                      -- ASSIGNMENT_RECRUITER
  r.`RECRUITER_EMAIL_ID`,                                             -- ASSIGNMENT_RECRUITER_EMAIL
  CAST(NULL AS DATE),                                                 -- BOOKING_DATE
  CAST(NULL AS STRING),                                               -- JOB_TYPE
  CAST(NULL AS STRING),                                               -- VMS
  r.`CLIENT_OT_RATE`,
  SAFE_CAST(r.`INITIAL_PROJ_IN_WK` AS FLOAT64),                       -- PROJECT_DURATION
  r.`CLIENT_CALL_BACK_RATE`,
  r.`CALL_BACK_RATE`,
  SAFE_CAST(r.`CND_NEXUS_ID` AS INT64),                               -- CANDIDATE_ID
  r.`PLACEMENT_TYPE`,
  CAST(NULL AS INT64),                                                -- CLIENT_ID
  CAST(NULL AS STRING),                                               -- CLIENT_SALES_REP
  CAST(NULL AS INT64),                                                -- CLIENT_SALES_REP_ID
  r.`CLIENT_STATE`,
  r.`CLIENT_TYPE`,
  r.`CITY_ZIPCODE`,
  r.`CLIENT_HOLIDAY_RATE`,
  r.`HOLIDAY_RATE`,
  r.`ON_CALL_RATE`,
  CAST(NULL AS STRING),                                               -- RATE_CHANGE
  r.`CLIENT_ON_CALL_RATE`,
  r.`PAY_RATE`,
  r.`EXTERNAL_JOB_POSTING_ID`,                                        -- VMS_JOB_ID
  CAST(NULL AS STRING),                                               -- OFFERING
  r.`ADDITIONAL_BONUS`,
  r.`PO_HOURS`,
  r.`OFFER_TIME_ST_DATE`,                                             -- OFFER_TIME_START_DATE
  r.`PARENT_CLIENT_NAME`,
  CAST(NULL AS DATE),                                                 -- INITIAL_START_DATE
  r.`WEEKLY_PER_DIEM`,                                                -- WEEKLY_PER_DIEM_NON_TAXED
  r.`ORIENTATION_HOURS`,                                              -- NBO_HOURS
  CAST(NULL AS FLOAT64),                                              -- BILLABLE_ORIENTATION_HRS
  CAST(NULL AS STRING),                                               -- BILLABLE_ORIENTATION
  r.`GUARANTEED_HOURS`,                                               -- SCHEDULE_HOURS_1
  CAST(NULL AS FLOAT64),                                              -- SCHEDULE_HOURS_2
  r.`GM_OT`,
  r.`DAYS_WORKED`,
  r.`CANDIDATE_NO`,                                                   -- CELL_PHONE
  r.`EMAIL_ID`,                                                       -- CANDIDATE_EMAIL
  CAST(NULL AS INT64),                                                -- DEAL_SHEET_ID
  r.`CATEG_OF_POS`,                                                   -- PROFESSION
  CAST(NULL AS INT64),                                                -- PROFESSION_ID
  CAST(NULL AS FLOAT64),                                              -- HOURLY_GP
  CAST(NULL AS INT64),                                                -- AGENCY_SWITCH
  CAST(NULL AS INT64),                                                -- ONSITE_OWNER
  CAST(NULL AS INT64),                                                -- DIRECTOR_CLIENT_PARTNERSHIP
  CAST(NULL AS INT64),                                                -- IS_DELETED
  CAST(NULL AS INT64),                                                -- GROUP_DIRECTOR
  CAST(NULL AS INT64),                                                -- ASSOCIATE_JUNIOR_CSM
  CAST(NULL AS INT64),                                                -- ONSITE_VP_AVP
  CAST(NULL AS INT64),                                                -- ONSITE_CLIENT_OWNER
  CAST(NULL AS INT64),                                                -- ASSOCIATE_SALES_PERSON
  CAST(NULL AS STRING),                                               -- CLIENT_NAME_IN_CONREP
  CAST(NULL AS TIMESTAMP),                                            -- EDIT_DATE
  SAFE_CAST(r.`UPDATED_BY` AS INT64),                                 -- EDITED_BY
  r.`OWNERSHIP_CHANGE_DATE`,                                          -- OWNERSHIP_EFFECTIVE_DATE
  r.`LAST_UPDATED`,                                                   -- UPDATED_AT
  CAST(NULL AS FLOAT64),                                              -- GP_PERCENTAGE
  r.`ONSITE_AM`,
  r.`ONSITE_AM_EMAIL`,
  CAST(NULL AS STRING),                                               -- SECONDARY_CELL_PHN
  r.`TYPE`,                                                           -- PAYMENT_TYPE
  r.`WEEKLY_WALLET_MONEY`,
  r.`PROVIDER_TYPE`,
  CAST(NULL AS INT64),                                                -- MSP_ID
  CAST(NULL AS INT64),                                                -- NEXUS_PARENT_CLIENT_ID
  r.`MSP_NAME`,
  CAST(NULL AS STRING),                                               -- LINE_OF_BUSINESS
  CAST(NULL AS INT64),                                                -- RECRUITER_ID
  r.`EMP_CODE_OR_NAME`,                                               -- RECRUITER_EMP_NO
  CAST(NULL AS TIMESTAMP),                                            -- SUBMISSION_DATE
  r.`ONB_CAND_DOB`,
  r.`ONB_I9_RECIEVED`,
  r.`ONB_SUPP_DOC1`,
  r.`ONB_SUPP_DOC1_EXP_DT`,
  r.`ONB_SUPP_DOC2`,
  r.`ONB_SUPP_DOC2_EXP_DT`,
  r.`ONB_E_VERIFY`,
  r.`BGC_CATEGORY1`,
  r.`BGC_AMOUNT1`,
  r.`BGC_CATEGORY2`,
  r.`BGC_AMOUNT2`,
  r.`BGC_CATEGORY3`,
  r.`BGC_AMOUNT3`,
  r.`BGC_TOTAL_BGV_COST`,
  r.`BGC_AGENCY_NAME`,
  r.`DIVERSITY_STATUS`,
  r.`BO_OR_END_REASON`,                                               -- BACKOUT_OR_TERMINATION
  r.`CLIENT_RECRUITER`,
  r.`CLT_PYMT_TERM`,                                                  -- CLIENT_PAYMENT_TERMS
  r.`INV_CYC_TO_CLT`,                                                 -- INVOICE_CYCLE_TO_CLIENT
  r.`CAND_PYMT_TERMS`,                                                -- CANDIDATE_PAYMENT_TERMS
  r.`VP_SRVP`,                                                        -- VP
  CAST(NULL AS STRING),                                               -- SR_VP
  r.`PO_RECEIVED`,
  CAST(NULL AS STRING),                                               -- PAYLOCITY_ID
  r.`COMMENTS`,
  CAST(NULL AS STRING),                                               -- TERMINATION_REASON
  r.`ENTITY`,
  r.`SKU_NUMBER`,
  CAST(NULL AS DATE),                                                 -- FIFTYTWO_TENURE_RTO_LASTDATE
  CAST(NULL AS STRING),                                               -- FIFTYTWO_TENURE_CANDIDATE_STATUS
  r.`NEW_HIRE_DATE`,
  r.`RECRUITMENT_MENTOR`,
  r.`CLIENT_TYPE`,                                                    -- TYPE_OF_CLIENT
  r.`ST_DT_PUSHBACK_REASON`,
  TIMESTAMP(r.`EXTENSION_DATE`),
  r.`EXTENSION_START_DATE`,
  CAST(NULL AS STRING),                                               -- EXT_OR_REHIRE_BY_RMG
  CAST(NULL AS DATE),                                                 -- CLIENT_START_DATE
  CAST(NULL AS DATE),                                                 -- CLIENT_CREATED_DATE
  r.`W2_PAY_RATE`,
  r.`FINAL_PAY_RATE`,
  r.`FINAL_BILL_RATE`,
  r.`FINAL_COST`,
  r.`NET_MARGIN`,
  CAST(NULL AS FLOAT64),                                              -- MARGIN (blank — GROSS_MARGIN carries the figure)
  CAST(NULL AS FLOAT64),                                              -- FIRST_WEEK_HOURS
  CAST(NULL AS FLOAT64),                                              -- SECOND_WEEK_HOURS
  CAST(NULL AS FLOAT64),                                              -- TOTAL_BONUS_TAXABLE
  CAST(NULL AS FLOAT64),                                              -- TOTAL_BONUS_NON_TAXABLE
  CAST(NULL AS FLOAT64),                                              -- W2_PAY_RATE_NEW
  CAST(NULL AS FLOAT64),                                              -- FINAL_PAY_RATE_NEW
  CAST(NULL AS FLOAT64),                                              -- FINAL_COST_NEW
  r.`NET_MARGIN`,                                                     -- CALCULATED_MARGIN
  CAST(NULL AS FLOAT64),                                              -- REGULAR_HOURS_1
  CAST(NULL AS FLOAT64),                                              -- REGULAR_HOURS_2
  CAST(NULL AS FLOAT64),                                              -- FINAL_BILL_RATE_NEW
  r.`ATL`,
  r.`TEAM_LEAD`,
  r.`SECONDARY_AM`,
  r.`ASSOCIATE_AM`,
  r.`RM`,
  r.`ACCOUNT_MANAGER`,
  r.`GRP_DIR_ASSOC_GRP_DIR`,                                          -- ASSOCIATE_DELIVERY_DIRECTOR
  r.`DELIVERY_POC`,
  CAST(NULL AS STRING),                                               -- DELIVERY_POC_EMP_NO
  r.`DELIVERYPOC_EMAIL`,                                              -- DELIVERY_POC_EMAIL
  r.`ACC_DIR_OR_VERT_HEAD`,
  CAST(NULL AS STRING),                                               -- CLIENT_OWNER
  r.`PRIMARY_SALES_PERSON`,
  r.`SECONDARY_SALES_PERSON`,
  r.`CREDENTIALING_SPECIALIST`,
  r.`CREDENTIALING_LEAD`,
  CAST(NULL AS STRING),                                               -- RECRUITER_CLUSTER_REGION
  CAST(NULL AS STRING),                                               -- CLIENT_CLUSTER_REGION
  CAST(NULL AS STRING),                                               -- CLUSTER_TYPE
  r.`LAST_UPDATED`,
  CAST(NULL AS STRING),                                               -- DELIVERY_DIRECTOR
  CAST(NULL AS STRING),                                               -- ATL_EMP_NO
  r.`SECONDARY_RECRUITER`,
  CAST(NULL AS STRING),                                               -- SECONDARY_RECRUITER_EMP_NO
  CAST(NULL AS STRING),                                               -- TEAM_LEAD_EMP_NO
  CAST(NULL AS STRING),                                               -- RM_EMP_NO
  CAST(NULL AS STRING),                                               -- SECONDARY_AM_EMP_NO
  CAST(NULL AS STRING),                                               -- ASSOCIATE_AM_EMP_NO
  CAST(NULL AS STRING),                                               -- ACCOUNT_MANAGER_EMP_NO
  CAST(NULL AS STRING),                                               -- VP_EMP_NO
  CAST(NULL AS STRING),                                               -- AVP
  CAST(NULL AS STRING),                                               -- AVP_EMP_NO
  CAST(NULL AS STRING),                                               -- ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO
  CAST(NULL AS STRING),                                               -- DELIVERY_DIRECTOR_EMP_NO
  r.`ID`,
  CAST(NULL AS STRING),                                               -- MOVE_RUNRATE
  CAST(NULL AS STRING),                                               -- IS_REJECTED
  CAST(NULL AS STRING),                                               -- REJECTION_REASON
  r.`DT_RATE`,
  r.`CLIENT_DT_RATE`,
  CAST(NULL AS STRING),                                               -- LEVEL_2_CSM
  CAST(NULL AS STRING),                                               -- LEVEL_3_CSM
  CAST(NULL AS STRING),                                               -- LEVEL_4_CSM
  CAST(NULL AS STRING),                                               -- PREVIOUS_RECRUITER_NAME
  CAST(NULL AS BOOL),                                                 -- OWNERSHIP_DELETED
  CAST(NULL AS BOOL),                                                 -- IS_EXTENSION
  CAST(NULL AS BOOL),                                                 -- IS_FUTURE_ENDED
  CAST(NULL AS STRING),                                               -- EXT_PENDING_ID
  CAST(NULL AS BOOL),                                                 -- EXT_CANCELLED
  r.`CA_GM`,
  CAST(NULL AS FLOAT64),                                              -- CA_NM
  CAST(NULL AS DATE),                                                 -- RECRUITER_CHANGE_DATE
  r.`BEFORE_EXTENSION_RECRUITER`,
  r.`TOTAL_EXT_RECD`,
  r.`SECONDARY_PHN`,
  r.`SECONDARY_EMAIL`,
  CAST(NULL AS STRING),                                               -- SOURCER_NAME
  CAST(NULL AS STRING),                                               -- EMPLOYEE_ID
  r.`NEW_ID`,
  CAST(NULL AS STRING),                                               -- ORIGINAL_RECRUITER
  r.`TYPE`,
  CAST(NULL AS STRING),                                               -- INORGANIC_RECRUITER
  CAST(NULL AS STRING),                                               -- INORGANIC_ACCOUNT_MANAGER
  CAST(NULL AS STRING),                                               -- INORGANIC_ASSOCIATE_AM
  CAST(NULL AS STRING),                                               -- INORGANIC_RM
  CAST(NULL AS STRING),                                               -- INORGANIC_TL
  CAST(NULL AS STRING),                                               -- INORGANIC_ATL
  CAST(NULL AS STRING),                                               -- INORGANIC_ASSOCIATE_GROUP_DIRECTOR
  CAST(NULL AS STRING),                                               -- INORGANIC_DELIVERY_DIRECTOR
  CAST(NULL AS STRING),                                               -- INORGANIC_VP_SR_VP
  CAST(NULL AS STRING),                                               -- INORGANIC_DELIVERY_POC
  CAST(NULL AS STRING),                                               -- INORGANIC_ONSITE_AM
  CAST(NULL AS STRING),                                               -- INORGANIC_ACCOUNTS_DIRECTOR_SR_AM_VERTICAL_HEAD
  r.`GROSS_MARGIN`,
  r.`POSITION`,
  CAST(NULL AS INT64),                                                -- NEXUS_INTERNAL_JOB_ID
  CAST(NULL AS STRING),                                               -- END_CLIENT_DEPT_FACILITY
  CAST(NULL AS DATE),                                                 -- TENTATIVE_DATE
  CAST(NULL AS FLOAT64),                                              -- INITIAL_PROJECT_DURATION_IN_WEEKS
  CAST(NULL AS INT64),                                                -- CANDIDATE_NEXUS_ID
  r.`ACTUAL_HOURS`,
  r.`PROJECTED_GP`,
  r.`ACTUAL_GP`,
  CAST(NULL AS DATE),                                                 -- ORIGINAL_START_DATE
  r.`ORIENTATION_HOURS`,
  CAST(NULL AS STRING),                                               -- PHONE_NUMBER
  CAST(NULL AS STRING),                                               -- CATEGORIZATION_OF_POSITION
  CAST(NULL AS DATE),                                                 -- EFFECTIVE_DATE
  r.`CLT_PYMT_TERM`,
  r.`INV_CYC_TO_CLT`,
  r.`CAND_PYMT_TERMS`,
  r.`VP_SRVP`,
  r.`FINAL_OT_PAY_RATE`,
  r.`FINAL_HOLIDAY_PAY_RATE`,
  r.`FINAL_DT_PAY_RATE`,
  r.`FINAL_CALL_BACK_PAY_RATE`,                                       -- FINAL_CALLBACK_PAY_RATE
  r.`GRP_DIR_ASSOC_GRP_DIR`,
  r.`CREDENTIALED_DATE`,
  CAST(NULL AS TIMESTAMP),                                            -- DATE_AND_TIME
  r.`DIRECT_MANAGER`,
  CAST(NULL AS STRING),                                               -- VP_SRVP_EMP_NO
  CAST(NULL AS STRING),                                               -- GRP_DIR_ASSOC_GRP_DIR_EMP_NO
  CAST(NULL AS INT64),                                                -- POSITION_ID
  CAST(NULL AS INT64),                                                -- CATEGORIZATION_OF_POSITION_ID
  SAFE_CAST(r.`SHIFTS` AS STRING),
  r.`REBOOKING_OR_EXTENSION`,                                         -- REBOOKING_EXTENSION
  r.`TOTAL_EXT_RECD`,                                                 -- NO_OF_TIME_EXTENSION_RECEIVED
  CAST(NULL AS STRING),                                               -- EXTENSION_REHIRE
  r.`LOADING_COST_EXCEPTION`
FROM `cynetdatabase.cynet_locum.lo_run_rate` AS r;
