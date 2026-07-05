-- Verification: given a recruiter/employee email, resolve external_id from directory_employees,
-- then pull their full manager hierarchy from directory_employee_hierarchy — mirrors what
-- fetchHierarchyLevelChainsByKey (functions/src/bigQueryClient.js) does for the CURRENT/latest
-- snapshot (direction = on_or_after with a null anchor date always falls back to latest).
--
-- Change the email below and run.

DECLARE target_email STRING DEFAULT "jessica.v@cynethealth.com";

WITH employee AS (
  SELECT external_id, employee_id, email, name_full, title, status
  FROM `cynetdatabase.MISC.directory_employees`
  WHERE LOWER(TRIM(email)) = LOWER(TRIM(target_email))
  QUALIFY ROW_NUMBER() OVER (
    ORDER BY (status = 'ACTIVE') DESC, updated_at DESC
  ) = 1
),

-- Every hierarchy_level row from the most recent synced_at snapshot for this employee
-- (each snapshot is a full org-chart pull, so all levels share the same synced_at).
latest_snapshot AS (
  SELECT MAX(synced_at) AS synced_at
  FROM `cynetdatabase.MISC.directory_employee_hierarchy` h
  JOIN employee e ON h.employee_external_id = e.external_id
)

SELECT
  e.name_full AS employee_name,
  e.email AS employee_email,
  e.employee_id,
  e.external_id,
  h.hierarchy_level,
  h.manager_name,
  h.manager_employee_id,
  h.manager_email,
  h.manager_title,
  h.manager_department,
  h.synced_at
FROM employee e
JOIN latest_snapshot ls ON TRUE
JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
  ON h.employee_external_id = e.external_id
 AND h.synced_at = ls.synced_at
ORDER BY SAFE_CAST(h.hierarchy_level AS INT64);

-- To see EVERY historical snapshot instead of just the latest (useful when checking the
-- NEW_HIRE_DATE-anchored "on-or-after"/"on-or-before" picks used at insert time), run this
-- instead of the query above:
--
-- SELECT h.*
-- FROM `cynetdatabase.MISC.directory_employees` e
-- JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
--   ON h.employee_external_id = e.external_id
-- WHERE LOWER(TRIM(e.email)) = LOWER(TRIM("jessica.v@cynethealth.com"))
-- ORDER BY h.synced_at DESC, SAFE_CAST(h.hierarchy_level AS INT64);
