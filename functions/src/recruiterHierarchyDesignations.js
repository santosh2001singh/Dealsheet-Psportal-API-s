/**
 * Recruiter hierarchy designation matching.
 * Maps a manager_title string from cynetdatabase.MISC.directory_employee_hierarchy to the
 * deal sheet hierarchy column it represents, for DEAL_TYPE = DEAL insert-time backfill.
 */

/** Deal sheet hierarchy columns filled from the employee directory, each with its emp-no companion. */
const DEAL_RECRUITER_HIERARCHY_TARGETS = [
  { column: "ATL", empNoColumn: "ATL_EMP_NO" },
  { column: "SECONDARY_RECRUITER", empNoColumn: "SECONDARY_RECRUITER_EMP_NO" },
  { column: "TEAM_LEAD", empNoColumn: "TEAM_LEAD_EMP_NO" },
  { column: "RM", empNoColumn: "RM_EMP_NO" },
  { column: "SECONDARY_AM", empNoColumn: "SECONDARY_AM_EMP_NO" },
  { column: "ASSOCIATE_AM", empNoColumn: "ASSOCIATE_AM_EMP_NO" },
  { column: "ACCOUNT_MANAGER", empNoColumn: "ACCOUNT_MANAGER_EMP_NO" },
  { column: "DELIVERY_DIRECTOR", empNoColumn: "DELIVERY_DIRECTOR_EMP_NO" },
  { column: "GRP_DIR_ASSOC_GRP_DIR", empNoColumn: "GRP_DIR_ASSOC_GRP_DIR_EMP_NO" },
  { column: "VP_SRVP", empNoColumn: "VP_SRVP_EMP_NO" },
];
Object.freeze(DEAL_RECRUITER_HIERARCHY_TARGETS);

/** Known manager_title synonyms (lowercase) per hierarchy column, as supplied by the business. */
const HIERARCHY_DESIGNATION_SYNONYMS = {
  ATL: ["atl", "associate team lead"],
  SECONDARY_RECRUITER: ["secondary recruiter", "secondary rm", "secondary recruitment manager"],
  TEAM_LEAD: [
    "tl",
    "team lead",
    "senior team lead",
    "senior teamlead",
    "senior tl",
    "sr team lead",
    "sr. team lead",
  ],
  RM: [
    "rm",
    "recruitement manager",
    "recruitment manager",
    "associate recruitment manager",
    "associate recruitement manager",
    "associate recruiterment manager",
  ],
  SECONDARY_AM: ["secondary am", "secondary account manager", "secondary delivery manager"],
  ASSOCIATE_AM: ["associate delivery manager"],
  ACCOUNT_MANAGER: [
    "delivery manager",
    "sr. delivery manager",
    "sr delivery manager",
    "senior delivery manager",
  ],
  DELIVERY_DIRECTOR: ["delivery director"],
  GRP_DIR_ASSOC_GRP_DIR: [
    "director",
    "associate director",
    "assoc director",
    "associate group director",
    "associate group directeor",
  ],
  VP_SRVP: [
    "vice president",
    "vp",
    "sr vp",
    "sr. vp",
    "svp",
    "srvp",
    "vp srvp",
    "vp/srvp",
    "associate vice president - delivery",
    "associate vice president delivery",
  ],
};

/** normalized synonym -> hierarchy column (built once at module load). */
const SYNONYM_TO_COLUMN = new Map();
for (const [column, synonyms] of Object.entries(HIERARCHY_DESIGNATION_SYNONYMS)) {
  for (const synonym of synonyms) {
    SYNONYM_TO_COLUMN.set(synonym, column);
  }
}

/**
 * Normalize a manager_title for exact synonym lookup: lowercase, trim, collapse whitespace.
 */
function normalizeDesignationTitle(title) {
  if (title == null) return "";
  return String(title).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve which deal sheet hierarchy column a manager_title represents, or null when the
 * title doesn't match any known designation.
 * @param {string|null|undefined} title
 * @returns {string|null}
 */
function resolveHierarchyColumnForTitle(title) {
  const normalized = normalizeDesignationTitle(title);
  if (!normalized) return null;
  return SYNONYM_TO_COLUMN.get(normalized) ?? null;
}

/**
 * CSM hierarchy columns, positional (not designation-matched): hierarchy_level N of the ONSITE_AM's
 * manager chain maps straight to the corresponding LEVEL_*_CSM column.
 */
const CSM_LEVEL_TARGETS = [
  { hierarchyLevel: "1", column: "LEVEL_2_CSM" },
  { hierarchyLevel: "2", column: "LEVEL_3_CSM" },
  { hierarchyLevel: "3", column: "LEVEL_4_CSM" },
];
Object.freeze(CSM_LEVEL_TARGETS);

/** LEVEL_*_CSM (deal sheet) -> INORGANIC_LEVEL_*_CSM (log table) column name. */
const CSM_LEVEL_TO_INORGANIC_COLUMN = {
  LEVEL_2_CSM: "INORGANIC_LEVEL_2_CSM",
  LEVEL_3_CSM: "INORGANIC_LEVEL_3_CSM",
  LEVEL_4_CSM: "INORGANIC_LEVEL_4_CSM",
};
Object.freeze(CSM_LEVEL_TO_INORGANIC_COLUMN);

/**
 * Manager titles excluded when resolving CSM hierarchy — a level whose manager_title matches one
 * of these (case/whitespace-insensitive) is left unmapped (that LEVEL_*_CSM stays null for that
 * level; other levels are unaffected).
 */
const CSM_HIERARCHY_EXCLUDED_TITLES = new Set([
  "cfo",
  "ceo-co",
  "cgo",
  "cso",
  "permanent",
  "chief growth officer",
  "chief strategy officer",
  "co-ceo",
]);

/**
 * True when a manager_title is excluded from CSM hierarchy resolution (case/whitespace-insensitive,
 * substring match — real titles combine abbreviation and full form, e.g. "Chief Growth Officer
 * (CGO)", so an exact match against CSM_HIERARCHY_EXCLUDED_TITLES would miss it).
 * @param {string|null|undefined} title
 * @returns {boolean}
 */
function isCsmHierarchyExcludedTitle(title) {
  const normalized = normalizeDesignationTitle(title);
  if (normalized === "") return false;
  for (const excluded of CSM_HIERARCHY_EXCLUDED_TITLES) {
    if (normalized.includes(excluded)) return true;
  }
  return false;
}

/**
 * Resolve LEVEL_2_CSM/LEVEL_3_CSM/LEVEL_4_CSM names from an ONSITE_AM's hierarchy chain
 * (hierarchy_level rows from a single chosen snapshot). Excluded titles (see
 * CSM_HIERARCHY_EXCLUDED_TITLES) leave that specific level null without shifting other levels.
 * @param {Array<{hierarchy_level: string, manager_name: string, manager_title: string}>} levelRows
 * @returns {{LEVEL_2_CSM: string|null, LEVEL_3_CSM: string|null, LEVEL_4_CSM: string|null}}
 */
function resolveCsmLevelsFromChain(levelRows) {
  const out = { LEVEL_2_CSM: null, LEVEL_3_CSM: null, LEVEL_4_CSM: null };
  if (!levelRows || levelRows.length === 0) return out;

  const byLevel = new Map();
  for (const row of levelRows) {
    const level = row?.hierarchy_level == null ? "" : String(row.hierarchy_level).trim();
    if (level && !byLevel.has(level)) byLevel.set(level, row);
  }

  for (const target of CSM_LEVEL_TARGETS) {
    const row = byLevel.get(target.hierarchyLevel);
    if (!row) continue;
    if (isCsmHierarchyExcludedTitle(row.manager_title)) continue;
    const name = row.manager_name == null ? null : String(row.manager_name).trim() || null;
    out[target.column] = name;
  }
  return out;
}

/**
 * Maps a resolved hierarchy designation (see HIERARCHY_DESIGNATION_SYNONYMS keys) to the
 * inorganic_hierarchy_logs column pair it fills. Used when a recruiter change is detected on
 * update: the newly-assigned recruiter's manager chain is matched against these same
 * designations, one level at a time, and logged here.
 * SECONDARY_RECRUITER and SECONDARY_AM are intentionally absent — not tracked in this log.
 * INORGANIC_DELIVERY_POC, INORGANIC_ONSITE_AM, and INORGANIC_ACCOUNTS_DIRECTOR_SR_AM_VERTICAL_HEAD
 * have no designation synonym list yet, so they are not resolvable — those log columns stay null
 * until synonym lists are supplied (see recruiterHierarchyDesignations.js history for context).
 */
const DESIGNATION_TO_INORGANIC_LOG_COLUMN = {
  ACCOUNT_MANAGER: { column: "INORGANIC_ACCOUNT_MANAGER", empNoColumn: "INORGANIC_ACCOUNT_MANAGER_EMP_NO" },
  ASSOCIATE_AM: { column: "INORGANIC_ASSOCIATE_AM", empNoColumn: "INORGANIC_ASSOCIATE_AM_EMP_NO" },
  RM: { column: "INORGANIC_RM", empNoColumn: "INORGANIC_RM_EMP_NO" },
  TEAM_LEAD: { column: "INORGANIC_TL", empNoColumn: "INORGANIC_TL_EMP_NO" },
  ATL: { column: "INORGANIC_ATL", empNoColumn: "INORGANIC_ATL_EMP_NO" },
  GRP_DIR_ASSOC_GRP_DIR: {
    column: "INORGANIC_ASSOCIATE_GROUP_DIRECTOR",
    empNoColumn: "INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO",
  },
  DELIVERY_DIRECTOR: { column: "INORGANIC_DELIVERY_DIRECTOR", empNoColumn: "INORGANIC_DELIVERY_DIRECTOR_EMP_NO" },
  VP_SRVP: { column: "INORGANIC_VP_SR_VP", empNoColumn: "INORGANIC_VP_SR_VP_EMP_NO" },
};
Object.freeze(DESIGNATION_TO_INORGANIC_LOG_COLUMN);

/**
 * Roles tracked in ownership_change_logs by comparing a placement's latest deal-sheet row against
 * the one before it. `role` is the OWNERSHIP_ROLE value logged; `nameField` is the deal-sheet
 * column holding the owner's display name; `changeField` is the column whose value defines "did
 * this role change" (email for people-roles so it's case/spelling stable, the name itself for CSM
 * levels which have no email); `empField` is the deal-sheet emp-no column (only RECRUITER has one —
 * ONSITE_AM and the CSM levels have no emp-no column, so their log emp-no stays null).
 */
const OWNERSHIP_CHANGE_DIFF_ROLES = [
  { role: "RECRUITER", nameField: "ASSIGNMENT_RECRUITER", changeField: "ASSIGNMENT_RECRUITER_EMAIL", empField: "RECRUITER_EMP_NO" },
  { role: "ONSITE_AM", nameField: "ONSITE_AM", changeField: "ONSITE_AM_EMAIL", empField: null },
  { role: "LEVEL_2_CSM", nameField: "LEVEL_2_CSM", changeField: "LEVEL_2_CSM", empField: null },
  { role: "LEVEL_3_CSM", nameField: "LEVEL_3_CSM", changeField: "LEVEL_3_CSM", empField: null },
  { role: "LEVEL_4_CSM", nameField: "LEVEL_4_CSM", changeField: "LEVEL_4_CSM", empField: null },
];
Object.freeze(OWNERSHIP_CHANGE_DIFF_ROLES);

module.exports = {
  DEAL_RECRUITER_HIERARCHY_TARGETS,
  HIERARCHY_DESIGNATION_SYNONYMS,
  DESIGNATION_TO_INORGANIC_LOG_COLUMN,
  CSM_LEVEL_TARGETS,
  CSM_LEVEL_TO_INORGANIC_COLUMN,
  CSM_HIERARCHY_EXCLUDED_TITLES,
  OWNERSHIP_CHANGE_DIFF_ROLES,
  isCsmHierarchyExcludedTitle,
  resolveCsmLevelsFromChain,
  normalizeDesignationTitle,
  resolveHierarchyColumnForTitle,
};
