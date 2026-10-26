-- Canada VP seat blank for recruiters under Varun Gupta (CY760).
--
-- Varun's directory titles are "Sr. Vice President - Delivery" / "Sr. Vice President (SVP)". Neither
-- resolved to VP (recruiterHierarchyDesignations.js had "sr. vp" but not "sr. vice president"), so
-- the Canada VP seat came out blank: 308 placements never had it, and 56 lost it on 2026-09-25
-- 17:17:40 (Varun -> NULL). Canada treats a blank seat as "NA", so the ownership scan would log
-- "VP Varun Gupta -> NA" for the 56, and "NA -> Varun Gupta" on the next version of every other one
-- once the synonym fix is deployed. Varun held the seat throughout; the blanks are the mapping gap.
--
-- Scope: Canada deal sheet versions whose VP is blank/NA and whose recruiter has Varun in their
-- directory chain. Recruiters not under Varun (35 placements) are left alone. Health and locums
-- are not touched. Run this BEFORE the Canada trigger runs with OWNERSHIP_LOG_WRITES_ENABLED=true.

-- 1. Backup.
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet_backup_20261009`
COPY `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`;

-- 2. Preview: expected ~412 versions / ~310 placements.
WITH under_varun AS (
  SELECT DISTINCT LOWER(TRIM(e.email)) AS email
  FROM `cynetdatabase.MISC.directory_employee_hierarchy` h
  JOIN `cynetdatabase.MISC.directory_employees` e ON e.external_id = h.employee_external_id
  WHERE h.manager_employee_id = 'CY760'
)
SELECT COUNT(*) AS versions, COUNT(DISTINCT d.PLACEMENT_ID) AS placements
FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` d
JOIN under_varun u ON u.email = LOWER(TRIM(d.ASSIGNMENT_RECRUITER_EMAIL))
WHERE IFNULL(UPPER(TRIM(d.VP)), '') IN ('', 'NA');

-- 3. Fix.
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` d
SET VP = 'Varun Gupta',
    VP_EMP_NO = 'CY760'
WHERE IFNULL(UPPER(TRIM(d.VP)), '') IN ('', 'NA')
  AND LOWER(TRIM(d.ASSIGNMENT_RECRUITER_EMAIL)) IN (
    SELECT DISTINCT LOWER(TRIM(e.email))
    FROM `cynetdatabase.MISC.directory_employee_hierarchy` h
    JOIN `cynetdatabase.MISC.directory_employees` e ON e.external_id = h.employee_external_id
    WHERE h.manager_employee_id = 'CY760'
  );

-- 4. Check: no placement should flip between Varun and blank any more (expected 0).
WITH v AS (
  SELECT PLACEMENT_ID,
         IFNULL(NULLIF(TRIM(VP), ''), 'NA') AS vp,
         LAG(IFNULL(NULLIF(TRIM(VP), ''), 'NA')) OVER (PARTITION BY PLACEMENT_ID ORDER BY LAST_UPDATED) AS prev
  FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet`
)
SELECT COUNT(DISTINCT PLACEMENT_ID) AS still_flipping
FROM v
WHERE prev IS NOT NULL AND prev != vp;
