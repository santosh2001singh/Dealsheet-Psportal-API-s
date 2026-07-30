-- One-time backfill: fill empty GRP_DIR_ASSOC_GRP_DIR (+ EMP_NO) on LATEST active deal-sheet
-- rows from MISC.directory_employee_hierarchy (same synonym map as recruiterHierarchyDesignations.js).
--
-- WHY: titles like "Director - Business Operations" were unmapped at insert time, so GRP_DIR stayed
-- null; update-trigger freezes hierarchy and will not re-derive. Without this fill, reconciliation
-- treats the group director as a "new person" and may write them only to inorganic_hierarchy_logs.
--
-- RULES:
--   - Latest row per DEAL_SHEET_ID only (append-only tables).
--   - DEAL_TYPE = DEAL only (EXTENSION hierarchy is inherited / separate paths).
--   - Fill-if-empty ONLY — never overwrite a non-blank GRP_DIR (protects MOVE-vacated / manual).
--   - Does NOT touch inorganic_hierarchy_logs / ownership_change_logs.
--   - Anchor = NEW_HIRE_DATE (on_or_before snapshot); if null, CURRENT_TIMESTAMP() (latest chain).
--
-- HOW TO RUN:
--   1) Run each PREVIEW block; confirm counts / sample names.
--   2) Run the matching UPDATE block per table.
--   3) Streaming buffer: recently inserted rows may reject UPDATE — re-run after ~90 min.
--
-- Tables: cynet_health_deal_sheet, cynet_health_canada_deal_sheet, cynet_locums_deal_sheet

-- =============================================================================
-- Shared: title -> role (strip trailing - Delivery/- REC/etc., then synonym match)
-- =============================================================================
-- Used inline below. Keep in sync with functions/src/recruiterHierarchyDesignations.js
-- GRP_DIR_ASSOC_GRP_DIR synonyms (incl. director - business operations).

-- =============================================================================
-- cynet_health_deal_sheet — PREVIEW
-- =============================================================================
WITH latest AS (
  SELECT * EXCEPT(rn)
  FROM (
    SELECT
      t.*,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(t.DEAL_SHEET_ID AS STRING)
        ORDER BY t.DATE_AND_TIME DESC NULLS LAST
      ) AS rn
    FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
    WHERE t.DEAL_SHEET_ID IS NOT NULL
  )
  WHERE rn = 1
),
candidates AS (
  SELECT
    ID,
    CAST(DEAL_SHEET_ID AS STRING) AS deal_sheet_id,
    CAST(PLACEMENT_ID AS STRING) AS placement_id,
    LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS recruiter_email,
    NEW_HIRE_DATE AS anchor_date,
    CANDIDATE_NAME,
    ASSIGNMENT_RECRUITER
  FROM latest
  WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'DEAL'
    AND (GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '')
    AND TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
),
emp AS (
  SELECT
    LOWER(TRIM(email)) AS email,
    external_id
  FROM `cynetdatabase.MISC.directory_employees`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY LOWER(TRIM(email))
    ORDER BY (UPPER(TRIM(IFNULL(status, ''))) = 'ACTIVE') DESC, updated_at DESC
  ) = 1
),
cand_emp AS (
  SELECT c.*, e.external_id
  FROM candidates c
  JOIN emp e ON e.email = c.recruiter_email
),
ranked AS (
  SELECT
    c.ID,
    c.deal_sheet_id,
    c.placement_id,
    c.recruiter_email,
    c.CANDIDATE_NAME,
    c.ASSIGNMENT_RECRUITER,
    h.hierarchy_level,
    h.manager_name,
    h.manager_employee_id,
    h.manager_title,
    ROW_NUMBER() OVER (
      PARTITION BY c.ID, h.hierarchy_level
      ORDER BY
        CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN 0 ELSE 1 END,
        CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN h.synced_at END DESC,
        h.synced_at ASC
    ) AS rn
  FROM cand_emp c
  JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
    ON h.employee_external_id = c.external_id
),
levels AS (
  SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1
),
mapped AS (
  SELECT
    ID,
    deal_sheet_id,
    placement_id,
    recruiter_email,
    CANDIDATE_NAME,
    ASSIGNMENT_RECRUITER,
    manager_name,
    manager_employee_id,
    SAFE_CAST(hierarchy_level AS INT64) AS lvl,
    CASE (
      TRIM(REGEXP_REPLACE(
        REGEXP_REPLACE(LOWER(TRIM(manager_title)), r'\s+', ' '),
        r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$',
        ''
      ))
    )
      WHEN 'director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'associate director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'assoc director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'associate group director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'associate group directeor' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'associate director - delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'associate director delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
      ELSE CASE LOWER(TRIM(REGEXP_REPLACE(IFNULL(manager_title, ''), r'\s+', ' ')))
        WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        ELSE NULL
      END
    END AS role
  FROM levels
),
proposed AS (
  SELECT
    ID,
    deal_sheet_id,
    placement_id,
    recruiter_email,
    CANDIDATE_NAME,
    ASSIGNMENT_RECRUITER,
    manager_name AS proposed_grp_dir,
    CAST(manager_employee_id AS STRING) AS proposed_grp_dir_emp_no
  FROM mapped
  WHERE role = 'GRP_DIR_ASSOC_GRP_DIR'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY lvl ASC) = 1
)
SELECT
  COUNT(*) AS rows_with_proposed_grp_dir,
  COUNT(DISTINCT recruiter_email) AS distinct_recruiters
FROM proposed;

-- Sample (uncomment to inspect):
-- SELECT * FROM proposed ORDER BY recruiter_email, deal_sheet_id LIMIT 100;

-- =============================================================================
-- cynet_health_deal_sheet — UPDATE (fill-if-empty on latest empty-GRP_DIR DEAL rows)
-- =============================================================================
UPDATE `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS t
SET
  GRP_DIR_ASSOC_GRP_DIR = p.proposed_grp_dir,
  GRP_DIR_ASSOC_GRP_DIR_EMP_NO = p.proposed_grp_dir_emp_no
FROM (
  WITH latest AS (
    SELECT * EXCEPT(rn)
    FROM (
      SELECT
        x.*,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(x.DEAL_SHEET_ID AS STRING)
          ORDER BY x.DATE_AND_TIME DESC NULLS LAST
        ) AS rn
      FROM `cynetdatabase.rr_project_data.cynet_health_deal_sheet` AS x
      WHERE x.DEAL_SHEET_ID IS NOT NULL
    )
    WHERE rn = 1
  ),
  candidates AS (
    SELECT
      ID,
      LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS recruiter_email,
      NEW_HIRE_DATE AS anchor_date
    FROM latest
    WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'DEAL'
      AND (GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '')
      AND TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
  ),
  emp AS (
    SELECT LOWER(TRIM(email)) AS email, external_id
    FROM `cynetdatabase.MISC.directory_employees`
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(email))
      ORDER BY (UPPER(TRIM(IFNULL(status, ''))) = 'ACTIVE') DESC, updated_at DESC
    ) = 1
  ),
  cand_emp AS (
    SELECT c.*, e.external_id
    FROM candidates c
    JOIN emp e ON e.email = c.recruiter_email
  ),
  ranked AS (
    SELECT
      c.ID,
      h.hierarchy_level,
      h.manager_name,
      h.manager_employee_id,
      h.manager_title,
      ROW_NUMBER() OVER (
        PARTITION BY c.ID, h.hierarchy_level
        ORDER BY
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN 0 ELSE 1 END,
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN h.synced_at END DESC,
          h.synced_at ASC
      ) AS rn
    FROM cand_emp c
    JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
      ON h.employee_external_id = c.external_id
  ),
  levels AS (
    SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1
  ),
  mapped AS (
    SELECT
      ID,
      manager_name,
      manager_employee_id,
      SAFE_CAST(hierarchy_level AS INT64) AS lvl,
      CASE (
        TRIM(REGEXP_REPLACE(
          REGEXP_REPLACE(LOWER(TRIM(manager_title)), r'\s+', ' '),
          r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$',
          ''
        ))
      )
        WHEN 'director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'assoc director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group directeor' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director - delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        ELSE CASE LOWER(TRIM(REGEXP_REPLACE(IFNULL(manager_title, ''), r'\s+', ' ')))
          WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          ELSE NULL
        END
      END AS role
    FROM levels
  )
  SELECT
    ID,
    manager_name AS proposed_grp_dir,
    CAST(manager_employee_id AS STRING) AS proposed_grp_dir_emp_no
  FROM mapped
  WHERE role = 'GRP_DIR_ASSOC_GRP_DIR'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY lvl ASC) = 1
) AS p
WHERE t.ID = p.ID
  AND (t.GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(t.GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '');

-- =============================================================================
-- cynet_health_canada_deal_sheet — UPDATE (same logic; change table id only)
-- =============================================================================
UPDATE `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS t
SET
  GRP_DIR_ASSOC_GRP_DIR = p.proposed_grp_dir,
  GRP_DIR_ASSOC_GRP_DIR_EMP_NO = p.proposed_grp_dir_emp_no
FROM (
  WITH latest AS (
    SELECT * EXCEPT(rn)
    FROM (
      SELECT
        x.*,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(x.DEAL_SHEET_ID AS STRING)
          ORDER BY x.DATE_AND_TIME DESC NULLS LAST
        ) AS rn
      FROM `cynetdatabase.rr_project_data.cynet_health_canada_deal_sheet` AS x
      WHERE x.DEAL_SHEET_ID IS NOT NULL
    )
    WHERE rn = 1
  ),
  candidates AS (
    SELECT
      ID,
      LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS recruiter_email,
      NEW_HIRE_DATE AS anchor_date
    FROM latest
    WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'DEAL'
      AND (GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '')
      AND TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
  ),
  emp AS (
    SELECT LOWER(TRIM(email)) AS email, external_id
    FROM `cynetdatabase.MISC.directory_employees`
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(email))
      ORDER BY (UPPER(TRIM(IFNULL(status, ''))) = 'ACTIVE') DESC, updated_at DESC
    ) = 1
  ),
  cand_emp AS (
    SELECT c.*, e.external_id
    FROM candidates c
    JOIN emp e ON e.email = c.recruiter_email
  ),
  ranked AS (
    SELECT
      c.ID,
      h.hierarchy_level,
      h.manager_name,
      h.manager_employee_id,
      h.manager_title,
      ROW_NUMBER() OVER (
        PARTITION BY c.ID, h.hierarchy_level
        ORDER BY
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN 0 ELSE 1 END,
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN h.synced_at END DESC,
          h.synced_at ASC
      ) AS rn
    FROM cand_emp c
    JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
      ON h.employee_external_id = c.external_id
  ),
  levels AS (
    SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1
  ),
  mapped AS (
    SELECT
      ID,
      manager_name,
      manager_employee_id,
      SAFE_CAST(hierarchy_level AS INT64) AS lvl,
      CASE (
        TRIM(REGEXP_REPLACE(
          REGEXP_REPLACE(LOWER(TRIM(manager_title)), r'\s+', ' '),
          r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$',
          ''
        ))
      )
        WHEN 'director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'assoc director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group directeor' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director - delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        ELSE CASE LOWER(TRIM(REGEXP_REPLACE(IFNULL(manager_title, ''), r'\s+', ' ')))
          WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          ELSE NULL
        END
      END AS role
    FROM levels
  )
  SELECT
    ID,
    manager_name AS proposed_grp_dir,
    CAST(manager_employee_id AS STRING) AS proposed_grp_dir_emp_no
  FROM mapped
  WHERE role = 'GRP_DIR_ASSOC_GRP_DIR'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY lvl ASC) = 1
) AS p
WHERE t.ID = p.ID
  AND (t.GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(t.GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '');

-- =============================================================================
-- cynet_locums_deal_sheet — UPDATE
-- =============================================================================
UPDATE `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS t
SET
  GRP_DIR_ASSOC_GRP_DIR = p.proposed_grp_dir,
  GRP_DIR_ASSOC_GRP_DIR_EMP_NO = p.proposed_grp_dir_emp_no
FROM (
  WITH latest AS (
    SELECT * EXCEPT(rn)
    FROM (
      SELECT
        x.*,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(x.DEAL_SHEET_ID AS STRING)
          ORDER BY x.DATE_AND_TIME DESC NULLS LAST
        ) AS rn
      FROM `cynetdatabase.rr_project_data.cynet_locums_deal_sheet` AS x
      WHERE x.DEAL_SHEET_ID IS NOT NULL
    )
    WHERE rn = 1
  ),
  candidates AS (
    SELECT
      ID,
      LOWER(TRIM(ASSIGNMENT_RECRUITER_EMAIL)) AS recruiter_email,
      NEW_HIRE_DATE AS anchor_date
    FROM latest
    WHERE UPPER(TRIM(IFNULL(DEAL_TYPE, ''))) = 'DEAL'
      AND (GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '')
      AND TRIM(IFNULL(ASSIGNMENT_RECRUITER_EMAIL, '')) != ''
  ),
  emp AS (
    SELECT LOWER(TRIM(email)) AS email, external_id
    FROM `cynetdatabase.MISC.directory_employees`
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(email))
      ORDER BY (UPPER(TRIM(IFNULL(status, ''))) = 'ACTIVE') DESC, updated_at DESC
    ) = 1
  ),
  cand_emp AS (
    SELECT c.*, e.external_id
    FROM candidates c
    JOIN emp e ON e.email = c.recruiter_email
  ),
  ranked AS (
    SELECT
      c.ID,
      h.hierarchy_level,
      h.manager_name,
      h.manager_employee_id,
      h.manager_title,
      ROW_NUMBER() OVER (
        PARTITION BY c.ID, h.hierarchy_level
        ORDER BY
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN 0 ELSE 1 END,
          CASE WHEN h.synced_at <= COALESCE(c.anchor_date, CURRENT_TIMESTAMP()) THEN h.synced_at END DESC,
          h.synced_at ASC
      ) AS rn
    FROM cand_emp c
    JOIN `cynetdatabase.MISC.directory_employee_hierarchy` h
      ON h.employee_external_id = c.external_id
  ),
  levels AS (
    SELECT * EXCEPT(rn) FROM ranked WHERE rn = 1
  ),
  mapped AS (
    SELECT
      ID,
      manager_name,
      manager_employee_id,
      SAFE_CAST(hierarchy_level AS INT64) AS lvl,
      CASE (
        TRIM(REGEXP_REPLACE(
          REGEXP_REPLACE(LOWER(TRIM(manager_title)), r'\s+', ' '),
          r'\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$',
          ''
        ))
      )
        WHEN 'director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'assoc director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group director' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate group directeor' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director - delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'associate director delivery' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
        ELSE CASE LOWER(TRIM(REGEXP_REPLACE(IFNULL(manager_title, ''), r'\s+', ' ')))
          WHEN 'director - business operations' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          WHEN 'director delivery for public sector' THEN 'GRP_DIR_ASSOC_GRP_DIR'
          ELSE NULL
        END
      END AS role
    FROM levels
  )
  SELECT
    ID,
    manager_name AS proposed_grp_dir,
    CAST(manager_employee_id AS STRING) AS proposed_grp_dir_emp_no
  FROM mapped
  WHERE role = 'GRP_DIR_ASSOC_GRP_DIR'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ID ORDER BY lvl ASC) = 1
) AS p
WHERE t.ID = p.ID
  AND (t.GRP_DIR_ASSOC_GRP_DIR IS NULL OR TRIM(CAST(t.GRP_DIR_ASSOC_GRP_DIR AS STRING)) = '');
