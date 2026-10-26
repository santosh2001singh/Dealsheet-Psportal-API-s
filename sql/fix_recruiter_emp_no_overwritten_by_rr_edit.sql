-- RECRUITER_EMP_NO overwritten on older versions by an RR dashboard edit.
--
-- rrupdateApiCandidate.js updates the deal sheet WHERE PLACEMENT_ID = @placementId, so one edit
-- rewrites EVERY version of the placement. Example 1470999 (2026-10-08 20:00 UTC): the older
-- Abdul Sami version (CY4098) got Aaron Panchal's CY5998. Ownership logs then show
-- PREVIOUS_OWNER_EMP_NO = NEW_OWNER_EMP_NO. 7 rows / 7 placements on 2026-10-09.
--
-- Fix: on placements whose recruiter changed, put back the emp no that belongs to the row's own
-- recruiter email (MISC.directory_employees).

-- 1. Preview.
WITH v AS (
  SELECT ID, PLACEMENT_ID, LAST_UPDATED, ASSIGNMENT_RECRUITER,
         LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS em, TRIM(RECRUITER_EMP_NO) AS emp
  FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
  WHERE IFNULL(TRIM(ASSIGNMENT_RECRUITER_EMAIL), '') != ''
    AND IFNULL(TRIM(RECRUITER_EMP_NO), '') NOT IN ('', 'NA')
),
changed AS (SELECT PLACEMENT_ID FROM v GROUP BY 1 HAVING COUNT(DISTINCT em) > 1)
SELECT v.PLACEMENT_ID, v.LAST_UPDATED, v.ASSIGNMENT_RECRUITER, v.em, v.emp AS wrong_emp_no, d.employee_id AS correct_emp_no
FROM v
JOIN changed USING (PLACEMENT_ID)
JOIN `cynetdatabase.MISC.directory_employees` d ON LOWER(TRIM(d.email)) = v.em
WHERE d.employee_id IS NOT NULL AND d.employee_id != v.emp
ORDER BY v.PLACEMENT_ID, v.LAST_UPDATED;

-- 2. Fix (expected 7 rows).
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` t
SET RECRUITER_EMP_NO = f.correct_emp_no
FROM (
  WITH v AS (
    SELECT CAST(ID AS STRING) AS id, PLACEMENT_ID,
           LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS em, TRIM(RECRUITER_EMP_NO) AS emp
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
    WHERE IFNULL(TRIM(ASSIGNMENT_RECRUITER_EMAIL), '') != ''
      AND IFNULL(TRIM(RECRUITER_EMP_NO), '') NOT IN ('', 'NA')
  ),
  changed AS (SELECT PLACEMENT_ID FROM v GROUP BY 1 HAVING COUNT(DISTINCT em) > 1)
  SELECT v.id, d.employee_id AS correct_emp_no
  FROM v
  JOIN changed USING (PLACEMENT_ID)
  JOIN `cynetdatabase.MISC.directory_employees` d ON LOWER(TRIM(d.email)) = v.em
  WHERE d.employee_id IS NOT NULL AND d.employee_id != v.emp
) f
WHERE CAST(t.ID AS STRING) = f.id;

-- 3. Check 1470999: expected CY4098 (Abdul Sami) then CY5998 (Aaron Panchal).
SELECT LAST_UPDATED, ASSIGNMENT_RECRUITER, RECRUITER_EMP_NO
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE PLACEMENT_ID = 1470999
ORDER BY LAST_UPDATED;
