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
  { column: "AVP", empNoColumn: "AVP_EMP_NO" },
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
  ASSOCIATE_AM: ["associate delivery manager", "associate account manager"],
  ACCOUNT_MANAGER: [
    "delivery manager",
    "sr. delivery manager",
    "sr delivery manager",
    "senior delivery manager",
    "account manager",
    "sr. account manager",
    "sr account manager",
    "senior account manager",
  ],
  DELIVERY_DIRECTOR: ["delivery director", "director - delivery", "director delivery"],
  GRP_DIR_ASSOC_GRP_DIR: [
    "director",
    "associate director",
    "assoc director",
    "associate group director",
    "associate group directeor",
    "associate director - delivery",
    "associate director delivery",
    // Real Workspace titles that are not stripped by DESIGNATION_TITLE_TRAILING_QUALIFIER
    // (qualifier allowlist is only delivery/rec/recruitment/staffing), e.g. Anup Bhel.
    "director - business operations",
    "director delivery for public sector",
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
  ],
  // Associate VP is its OWN designation (AVP column), split out of VP_SRVP. Exact-map lookup means
  // "associate vice president" never collides with VP_SRVP's "vice president".
  AVP: [
    "avp",
    "associate vice president",
    "associate vice president - delivery",
    "associate vice president delivery",
  ],
};

/**
 * Trailing department/qualifier suffixes real Google Workspace titles append to a role, e.g.
 * "Vice President - Delivery", "AVP - Delivery", "Recruitment Manager - REC". These are stripped
 * before the synonym lookup so the base role still matches.
 */
const DESIGNATION_TITLE_TRAILING_QUALIFIER = /\s*[-–/]\s*(delivery|rec|recruitment|staffing)\s*$/;

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
  const direct = SYNONYM_TO_COLUMN.get(normalized);
  if (direct) return direct;
  // Retry after stripping a trailing " - Delivery"/" - REC"/etc. qualifier (real titles like
  // "Vice President - Delivery" carry the department; the base role is what's in the synonym map).
  const stripped = normalized.replace(DESIGNATION_TITLE_TRAILING_QUALIFIER, "").trim();
  if (stripped && stripped !== normalized) {
    return SYNONYM_TO_COLUMN.get(stripped) ?? null;
  }
  return null;
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
  AVP: { column: "INORGANIC_AVP", empNoColumn: "INORGANIC_AVP_EMP_NO" },
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

/**
 * The designations whose deal-sheet regular hierarchy fields are AUTO-managed (the same set the
 * inorganic log tracks). SECONDARY_RECRUITER and SECONDARY_AM are deliberately excluded — they are
 * manual-only fields, never auto-filled or moved.
 */
const MANAGED_HIERARCHY_DESIGNATIONS = Object.freeze(Object.keys(DESIGNATION_TO_INORGANIC_LOG_COLUMN));

/** designation -> { column, empNoColumn }, or null. */
function hierarchyTargetForDesignation(designation) {
  return DEAL_RECRUITER_HIERARCHY_TARGETS.find((t) => t.column === designation) || null;
}

/** Emp-no identity key: unwrap {value}, trim, lowercase; "" when empty. */
function normalizeEmpNoKey(value) {
  if (value == null) return "";
  const unwrapped = typeof value === "object" && value !== null && "value" in value ? value.value : value;
  if (unwrapped == null) return "";
  return String(unwrapped).trim().toLowerCase();
}

/**
 * Person-centric (emp-no) reconciliation of a placement's FROZEN regular recruiter-hierarchy fields
 * against the recruiter's CURRENT live manager chain.
 *
 * Rules (all confirmed by the business):
 *  - A person already sitting in a managed regular field who now holds a DIFFERENT managed
 *    designation in the live chain is MOVED: their old field is vacated (set null) and the new
 *    role's field takes their name + emp-no. Same emp-no travels with them.
 *  - Collision (the mover's new role field is held by a DIFFERENT frozen person): the mover wins
 *    ("new wins, old displaced"); the displaced person, if not itself a mover, is surfaced as an
 *    inorganic person.
 *  - A frozen person no longer anywhere in the live chain is LEFT FROZEN (no vacate) — unless
 *    displaced by a collision.
 *  - An emp-no present in the live chain but NOT in the frozen set is a genuinely NEW person and is
 *    surfaced for the inorganic log — never written into a regular field.
 *
 * @param {object} storedRow - the placement's latest row (frozen regular hierarchy name+emp fields)
 * @param {Object<string,{name:?string,empNo:?string}>} currentByDesignation - live chain resolved
 *        to managed-designation -> {name, empNo} (closest level wins)
 * @returns {{moves:object[], updatedFields:object, newPersons:object[], changed:boolean}}
 *          moves: [{ empKey, name, empNoRaw, fromRole, toRole, displacedName, displacedEmpNoRaw }]
 *          updatedFields: regular columns to write back (old cleared to null, new set)
 *          newPersons: [{ empKey, designation, name, empNoRaw }] -> inorganic log
 */
function computeRecruiterHierarchyRoleChanges(storedRow, currentByDesignation) {
  const row = storedRow && typeof storedRow === "object" ? storedRow : {};
  const current =
    currentByDesignation && typeof currentByDesignation === "object" ? currentByDesignation : {};

  // frozen: empKey -> { designation, name, empNoRaw }  (first managed designation wins per emp-no)
  const frozenByEmp = new Map();
  for (const designation of MANAGED_HIERARCHY_DESIGNATIONS) {
    const target = hierarchyTargetForDesignation(designation);
    if (!target) continue;
    const empKey = normalizeEmpNoKey(row[target.empNoColumn]);
    if (!empKey || frozenByEmp.has(empKey)) continue;
    frozenByEmp.set(empKey, {
      designation,
      name: row[target.column] ?? null,
      empNoRaw: row[target.empNoColumn] ?? null,
    });
  }

  // current: empKey -> { designation, name, empNoRaw }
  const currentByEmp = new Map();
  for (const designation of MANAGED_HIERARCHY_DESIGNATIONS) {
    const info = current[designation];
    if (!info) continue;
    const empKey = normalizeEmpNoKey(info.empNo);
    if (!empKey || currentByEmp.has(empKey)) continue;
    currentByEmp.set(empKey, { designation, name: info.name ?? null, empNoRaw: info.empNo ?? null });
  }

  // Frozen person now holding a DIFFERENT managed designation => move.
  const moves = [];
  const moverEmps = new Set();
  for (const [empKey, frozen] of frozenByEmp) {
    const cur = currentByEmp.get(empKey);
    if (!cur) continue; // disappeared -> leave frozen
    if (cur.designation === frozen.designation) continue; // unchanged
    moves.push({ empKey, name: cur.name, empNoRaw: cur.empNoRaw, fromRole: frozen.designation, toRole: cur.designation });
    moverEmps.add(empKey);
  }

  const updatedFields = {};
  const displaced = [];
  if (moves.length > 0) {
    const frozenOccupantByDesignation = {};
    for (const [empKey, frozen] of frozenByEmp) {
      frozenOccupantByDesignation[frozen.designation] = { empKey, ...frozen };
    }
    // Vacate each mover's old field first...
    for (const mv of moves) {
      const fromTarget = hierarchyTargetForDesignation(mv.fromRole);
      updatedFields[fromTarget.column] = null;
      updatedFields[fromTarget.empNoColumn] = null;
    }
    // ...then fill each mover's new field (overwriting any occupant — "new wins").
    for (const mv of moves) {
      const toTarget = hierarchyTargetForDesignation(mv.toRole);
      const occupant = frozenOccupantByDesignation[mv.toRole];
      const isCollision = occupant && occupant.empKey !== mv.empKey;
      mv.displacedName = isCollision ? occupant.name : null;
      mv.displacedEmpNoRaw = isCollision ? occupant.empNoRaw : null;
      mv.displacedEmpKey = isCollision ? occupant.empKey : null;
      updatedFields[toTarget.column] = mv.name;
      updatedFields[toTarget.empNoColumn] = mv.empNoRaw;
    }
    for (const mv of moves) {
      if (mv.displacedEmpKey && !moverEmps.has(mv.displacedEmpKey)) {
        displaced.push({ empKey: mv.displacedEmpKey, designation: mv.toRole, name: mv.displacedName, empNoRaw: mv.displacedEmpNoRaw });
      }
    }
  }

  const newPersons = [];
  for (const [empKey, cur] of currentByEmp) {
    if (frozenByEmp.has(empKey)) continue;
    newPersons.push({ empKey, designation: cur.designation, name: cur.name, empNoRaw: cur.empNoRaw });
  }
  for (const d of displaced) newPersons.push(d);

  return { moves, updatedFields, newPersons, changed: moves.length > 0 };
}

module.exports = {
  DEAL_RECRUITER_HIERARCHY_TARGETS,
  HIERARCHY_DESIGNATION_SYNONYMS,
  DESIGNATION_TO_INORGANIC_LOG_COLUMN,
  MANAGED_HIERARCHY_DESIGNATIONS,
  CSM_LEVEL_TARGETS,
  CSM_LEVEL_TO_INORGANIC_COLUMN,
  CSM_HIERARCHY_EXCLUDED_TITLES,
  OWNERSHIP_CHANGE_DIFF_ROLES,
  isCsmHierarchyExcludedTitle,
  resolveCsmLevelsFromChain,
  normalizeDesignationTitle,
  resolveHierarchyColumnForTitle,
  hierarchyTargetForDesignation,
  computeRecruiterHierarchyRoleChanges,
};
