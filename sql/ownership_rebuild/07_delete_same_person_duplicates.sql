-- Delete ownership rows that put a person in a seat they already hold ("same designation, same person").
--
-- Per SKU + role, rows are read in effective-date order. A row is a duplicate when its new owner is
-- already the one in the seat (the row before on the same SKU + role brought them in), or when the
-- previous and new owner are the same person (emp no and name). A person who left and came back is
-- NOT a duplicate: someone else's row sits in between. Same date: the row naming a real previous
-- owner is kept over "NA -> X", data team over system. Manual rows (RR dashboard) are never deleted; they
-- replace any other row with the same SKU + role + previous + new owner.
--
-- Found 2026-10-12 (after 06): ~80 rows, all data team; the reload loaded their table as-is, so their own
-- repeats came along:
--   exact repeats            L1212 ONSITE_AM Ana Gedeon -> Katie Arrington @2026-02-21, twice
--   later re-arrival         H7366 ASSOCIATE_AM NA -> Sai Panchal @2023-07-01, again @2023-11-12 (first kept)
--   same arrival, NA + real  11668_H11664 ATL: NA -> Somya and Ashmita -> Somya, same day (Ashmita kept)
--   self                     H9879 ACCOUNT_MANAGER Sandeep Shah -> Sandeep Shah
--   replaced by manual edit H14906 RECRUITER / ONSITE_AM and H14777 RECRUITER: an RR dashboard date edit
--                            added a new row next to the data team's; the manual one (the correction) is kept
-- The same data comes back if Cluster_Data.ownership_data is reloaded without fixing it there.
--
-- Safe before or after 06: a system row never makes a data team row a duplicate. Run it after 06 anyway,
-- so the preview shows only what is left.

-- 1. Backup (same backup as 06; skipped when it already exists).
CREATE TABLE IF NOT EXISTS `cynetdatabase.rr_project_data.ownership_change_logs_backup_20261012`
COPY `cynetdatabase.rr_project_data.ownership_change_logs`;

-- 2. Preview: each row with the row before it on the same SKU + role. Expected ~77.
WITH k AS (
  SELECT ID, SKU_NO,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS prev_name,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS new_name, OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME, OWNERSHIP_EFFECTIVE_DATE, EDITED_BY,
         IF(EDITED_BY = 'DATA_TEAM_SYNC', 'data_team', IF(EDITED_BY IS NULL, 'system', 'manual')) AS src,
         IF(UPPER(TRIM(IFNULL(NEW_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(NEW_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS new_key,
         IF(UPPER(TRIM(IFNULL(PREVIOUS_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(PREVIOUS_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS prev_key
  FROM `cynetdatabase.rr_project_data.ownership_change_logs`
  WHERE IS_DELETED IS NOT TRUE AND SKU_NO IS NOT NULL
),
-- An RR dashboard edit of the effective date inserts a NEW row and leaves the old one (rrupdateOwnershipDataRow
-- versioning). The manual row is the correction: the same SKU + role + previous + new owner on any other
-- row is the stale version. H14906 RECRUITER Vikash Kumar -> Anjali Dhiman: data team 10-08, Shubham 10-09
-- (the extension 1470210 started 10-09).
superseded AS (
  SELECT o.ID
  FROM k o
  JOIN k m
    ON m.src = 'manual' AND o.src != 'manual'
   AND UPPER(TRIM(m.SKU_NO)) = UPPER(TRIM(o.SKU_NO))
   AND m.OWNERSHIP_ROLE = o.OWNERSHIP_ROLE
   AND m.prev_key = o.prev_key AND m.new_key = o.new_key
),
-- Who sat in the seat just before each row: the previous row's new owner on the same SKU + role.
-- Same date: a row naming a real previous owner first, then data team, then system, then manual.
-- A data team row is only measured against data team + manual rows: a system row never makes a data
-- team row a duplicate (the data team history is the trusted one). System rows are measured against all.
seq_trusted AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded) AND src != 'system'
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 ELSE 2 END, ID
  )
),
seq_all AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded)
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 WHEN 'system' THEN 1 ELSE 2 END, ID
  )
),
seq AS (
  SELECT * FROM seq_trusted WHERE src = 'data_team'
  UNION ALL
  SELECT * FROM seq_all WHERE src = 'system'
),
dup AS (
  SELECT *,
         CASE WHEN prev_key = new_key AND prev_name = new_name THEN 'self (prev = new)'
              ELSE 'already in the seat' END AS reason
  FROM seq
  WHERE new_key NOT IN ('', 'na')
    AND src != 'manual'
    AND ((prev_key = new_key AND prev_name = new_name) OR seat_before = new_key)
  UNION ALL
  SELECT k.*, CAST(NULL AS STRING) AS seat_before, 'replaced by a manual edit' AS reason
  FROM k
  WHERE ID IN (SELECT ID FROM superseded)
)
SELECT SKU_NO, OWNERSHIP_ROLE, reason, src,
       CONCAT(IFNULL(PREVIOUS_OWNER_NAME, '?'), ' -> ', IFNULL(NEW_OWNER_NAME, '?'), ' @', CAST(OWNERSHIP_EFFECTIVE_DATE AS STRING)) AS duplicate_row,
       ID
FROM dup
ORDER BY SKU_NO, OWNERSHIP_ROLE, OWNERSHIP_EFFECTIVE_DATE;

-- 3. Delete.
DELETE FROM `cynetdatabase.rr_project_data.ownership_change_logs`
WHERE ID IN (
  WITH k AS (
  SELECT ID, SKU_NO,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS prev_name,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS new_name, OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME, OWNERSHIP_EFFECTIVE_DATE, EDITED_BY,
         IF(EDITED_BY = 'DATA_TEAM_SYNC', 'data_team', IF(EDITED_BY IS NULL, 'system', 'manual')) AS src,
         IF(UPPER(TRIM(IFNULL(NEW_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(NEW_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS new_key,
         IF(UPPER(TRIM(IFNULL(PREVIOUS_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(PREVIOUS_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS prev_key
  FROM `cynetdatabase.rr_project_data.ownership_change_logs`
  WHERE IS_DELETED IS NOT TRUE AND SKU_NO IS NOT NULL
),
-- An RR dashboard edit of the effective date inserts a NEW row and leaves the old one (rrupdateOwnershipDataRow
-- versioning). The manual row is the correction: the same SKU + role + previous + new owner on any other
-- row is the stale version. H14906 RECRUITER Vikash Kumar -> Anjali Dhiman: data team 10-08, Shubham 10-09
-- (the extension 1470210 started 10-09).
superseded AS (
  SELECT o.ID
  FROM k o
  JOIN k m
    ON m.src = 'manual' AND o.src != 'manual'
   AND UPPER(TRIM(m.SKU_NO)) = UPPER(TRIM(o.SKU_NO))
   AND m.OWNERSHIP_ROLE = o.OWNERSHIP_ROLE
   AND m.prev_key = o.prev_key AND m.new_key = o.new_key
),
-- Who sat in the seat just before each row: the previous row's new owner on the same SKU + role.
-- Same date: a row naming a real previous owner first, then data team, then system, then manual.
-- A data team row is only measured against data team + manual rows: a system row never makes a data
-- team row a duplicate (the data team history is the trusted one). System rows are measured against all.
seq_trusted AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded) AND src != 'system'
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 ELSE 2 END, ID
  )
),
seq_all AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded)
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 WHEN 'system' THEN 1 ELSE 2 END, ID
  )
),
seq AS (
  SELECT * FROM seq_trusted WHERE src = 'data_team'
  UNION ALL
  SELECT * FROM seq_all WHERE src = 'system'
),
dup AS (
  SELECT *,
         CASE WHEN prev_key = new_key AND prev_name = new_name THEN 'self (prev = new)'
              ELSE 'already in the seat' END AS reason
  FROM seq
  WHERE new_key NOT IN ('', 'na')
    AND src != 'manual'
    AND ((prev_key = new_key AND prev_name = new_name) OR seat_before = new_key)
  UNION ALL
  SELECT k.*, CAST(NULL AS STRING) AS seat_before, 'replaced by a manual edit' AS reason
  FROM k
  WHERE ID IN (SELECT ID FROM superseded)
)
  SELECT ID FROM dup
);

-- 4. Check: expected 0.
WITH k AS (
  SELECT ID, SKU_NO,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS prev_name,
         LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', ''))) AS new_name, OWNERSHIP_ROLE, PREVIOUS_OWNER_NAME, NEW_OWNER_NAME, OWNERSHIP_EFFECTIVE_DATE, EDITED_BY,
         IF(EDITED_BY = 'DATA_TEAM_SYNC', 'data_team', IF(EDITED_BY IS NULL, 'system', 'manual')) AS src,
         IF(UPPER(TRIM(IFNULL(NEW_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(NEW_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(NEW_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS new_key,
         IF(UPPER(TRIM(IFNULL(PREVIOUS_OWNER_EMP_NO, ''))) NOT IN ('', 'NA'), UPPER(TRIM(PREVIOUS_OWNER_EMP_NO)),
            LOWER(TRIM(REGEXP_REPLACE(IFNULL(PREVIOUS_OWNER_NAME, ''), r'\s*\(.*\)$', '')))) AS prev_key
  FROM `cynetdatabase.rr_project_data.ownership_change_logs`
  WHERE IS_DELETED IS NOT TRUE AND SKU_NO IS NOT NULL
),
-- An RR dashboard edit of the effective date inserts a NEW row and leaves the old one (rrupdateOwnershipDataRow
-- versioning). The manual row is the correction: the same SKU + role + previous + new owner on any other
-- row is the stale version. H14906 RECRUITER Vikash Kumar -> Anjali Dhiman: data team 10-08, Shubham 10-09
-- (the extension 1470210 started 10-09).
superseded AS (
  SELECT o.ID
  FROM k o
  JOIN k m
    ON m.src = 'manual' AND o.src != 'manual'
   AND UPPER(TRIM(m.SKU_NO)) = UPPER(TRIM(o.SKU_NO))
   AND m.OWNERSHIP_ROLE = o.OWNERSHIP_ROLE
   AND m.prev_key = o.prev_key AND m.new_key = o.new_key
),
-- Who sat in the seat just before each row: the previous row's new owner on the same SKU + role.
-- Same date: a row naming a real previous owner first, then data team, then system, then manual.
-- A data team row is only measured against data team + manual rows: a system row never makes a data
-- team row a duplicate (the data team history is the trusted one). System rows are measured against all.
seq_trusted AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded) AND src != 'system'
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 ELSE 2 END, ID
  )
),
seq_all AS (
  SELECT *, LAG(new_key) OVER w AS seat_before
  FROM k
  WHERE ID NOT IN (SELECT ID FROM superseded)
  WINDOW w AS (
    PARTITION BY UPPER(TRIM(SKU_NO)), OWNERSHIP_ROLE
    ORDER BY OWNERSHIP_EFFECTIVE_DATE, IF(prev_key IN ('', 'na'), 1, 0), CASE src WHEN 'data_team' THEN 0 WHEN 'system' THEN 1 ELSE 2 END, ID
  )
),
seq AS (
  SELECT * FROM seq_trusted WHERE src = 'data_team'
  UNION ALL
  SELECT * FROM seq_all WHERE src = 'system'
),
dup AS (
  SELECT *,
         CASE WHEN prev_key = new_key AND prev_name = new_name THEN 'self (prev = new)'
              ELSE 'already in the seat' END AS reason
  FROM seq
  WHERE new_key NOT IN ('', 'na')
    AND src != 'manual'
    AND ((prev_key = new_key AND prev_name = new_name) OR seat_before = new_key)
  UNION ALL
  SELECT k.*, CAST(NULL AS STRING) AS seat_before, 'replaced by a manual edit' AS reason
  FROM k
  WHERE ID IN (SELECT ID FROM superseded)
)
SELECT COUNT(*) AS duplicates_left FROM dup;
