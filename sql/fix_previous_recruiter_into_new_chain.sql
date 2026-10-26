-- 2026-10-23: previous recruiter sits in the new recruiter's chain -> fill that regular field.
-- Cases from sql/preview_previous_recruiter_into_new_chain.sql (Health deal sheet only, FILL_EMPTY):
--   1472372  RM            Alex Smith       CY3248  (Alex Smith -> Kartik Gupta)      1 row
--   1470924  ASSOCIATE_AM  Sonam Chaudhary  CY3474  (Sonam Chaudhary -> Sid Kumar)    4 rows
--   1466541  ATL           Hritick Diwakar  CY3515  (Hritick Diwakar -> Payal Dhami)  2 rows
--            (08-20, 09-08 only: 09-15 already has ATL=Hritick, 10-13 moved him to TEAM_LEAD — not touched)
-- Rows = the recruiter-change row and every later version (they carried the hierarchy forward).
-- Only touches the field when it is still empty / NA.

-- 1) Backup
CREATE TABLE `cynetdatabase.rr_project_data.bkp_20261023_prev_recruiter_into_chain` AS
SELECT *
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE (CAST(PLACEMENT_ID AS STRING) = '1472372' AND CAST(DEAL_SHEET_ID AS STRING) = '5281490' AND LAST_UPDATED >= TIMESTAMP '2026-10-22 15:43:52')
   OR (CAST(PLACEMENT_ID AS STRING) = '1470924' AND CAST(DEAL_SHEET_ID AS STRING) = '5275755' AND LAST_UPDATED >= TIMESTAMP '2026-10-08 15:49:26')
   OR (CAST(PLACEMENT_ID AS STRING) = '1466541' AND LAST_UPDATED >= TIMESTAMP '2026-08-20 16:24:59' AND LAST_UPDATED < TIMESTAMP '2026-09-15 17:05:18');

-- 2) Updates
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET RM = 'Alex Smith', RM_EMP_NO = 'CY3248'
WHERE CAST(PLACEMENT_ID AS STRING) = '1472372' AND CAST(DEAL_SHEET_ID AS STRING) = '5281490'
  AND LAST_UPDATED >= TIMESTAMP '2026-10-22 15:43:52'
  AND RECRUITER_EMP_NO = 'CY5372'
  AND (RM IS NULL OR TRIM(RM) IN ('', 'NA'));

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET ASSOCIATE_AM = 'Sonam Chaudhary', ASSOCIATE_AM_EMP_NO = 'CY3474'
WHERE CAST(PLACEMENT_ID AS STRING) = '1470924' AND CAST(DEAL_SHEET_ID AS STRING) = '5275755'
  AND LAST_UPDATED >= TIMESTAMP '2026-10-08 15:49:26'
  AND (ASSOCIATE_AM IS NULL OR TRIM(ASSOCIATE_AM) IN ('', 'NA'));

UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET ATL = 'Hritick Diwakar', ATL_EMP_NO = 'CY3515'
WHERE CAST(PLACEMENT_ID AS STRING) = '1466541'
  AND LAST_UPDATED >= TIMESTAMP '2026-08-20 16:24:59' AND LAST_UPDATED < TIMESTAMP '2026-09-15 17:05:18'
  AND (ATL IS NULL OR TRIM(ATL) IN ('', 'NA'));
