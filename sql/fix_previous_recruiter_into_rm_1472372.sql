-- Placement 1472372 (Brittany Helena Covington, CHC24053), Oct 2026.
-- Recruiter Alex Smith (CY3248, Recruitment Manager) -> Kartik Gupta (CY5372), who reports to Alex.
-- The recruiter-change row (ID 29de4a39-...) was appended with RM empty. Rule: a previous recruiter
-- who sits in the new recruiter's chain becomes that regular field (RM here).
-- Code handles future changes (applyPreviousRecruiterIntoNewRecruiterHierarchyForRows); this fixes
-- the row already written.

-- 1) Preview
SELECT ID, ASSIGNMENT_RECRUITER, RECRUITER_EMP_NO, RM, RM_EMP_NO, LAST_UPDATED
FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
WHERE PLACEMENT_ID = '1472372'
ORDER BY LAST_UPDATED;

-- 2) Fix the Kartik row only (Alex's own row keeps RM empty — he was the recruiter then)
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet`
SET RM = 'Alex Smith', RM_EMP_NO = 'CY3248'
WHERE PLACEMENT_ID = '1472372'
  AND ID = '29de4a39-d81c-4dc5-b9c2-c8c461827944'
  AND RECRUITER_EMP_NO = 'CY5372';
