/**
 * Employee STATUS / IMMEDIATE_MANAGER lookup against cynetdatabase.Department_Data."Ph and India".
 *
 * Used by the EXTENSION inorganic hierarchy resolution: runrate gives inorganic people by NAME only,
 * so each name is looked up here (by EMPLOYEE_NAME / GOES_BY_NAME, disambiguated by DESIGNATION) to
 * get its EMPLOYEE_NO + STATUS. When a person is Inactive, we walk up IMMEDIATE_MANAGER until an
 * Active person is found and place them in the column their DESIGNATION maps to; if the whole chain
 * is inactive/unknown the slot becomes NA (null).
 */

const config = require("./config");
const { resolveHierarchyColumnForTitle } = require("./recruiterHierarchyDesignations");

/** Max IMMEDIATE_MANAGER hops when the person (and their managers) are inactive. */
const MANAGER_WALK_MAX_DEPTH = 10;

/** lowercase / trim / collapse whitespace for name-key matching. */
function normalizeNameKey(name) {
  if (name == null) return "";
  return String(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when a Department_Data STATUS value means the employee is currently active. */
function isActiveStatus(status) {
  return status != null && String(status).trim().toUpperCase() === "ACTIVE";
}

/** Escape a value for a single-quoted BigQuery string literal (backslash escaping). */
function escapeSqlString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function departmentDataFqn() {
  // Table id contains a space ("Ph and India") -> must be backtick-quoted on its own.
  return `\`${config.projectId}.${config.departmentData.datasetId}\`.\`${config.departmentData.tableId}\``;
}

/**
 * Fetch Department_Data rows for a set of employee names (matched on EMPLOYEE_NAME or GOES_BY_NAME).
 * @param {string[]} names
 * @param {object} [deps] - { queryFn(sql): Promise<object[]> } (required in practice; injectable for tests)
 * @returns {Promise<Map<string, Array<{empNo, name, designation, status, immediateManager}>>>}
 *          normalized-name -> entries (a name can resolve to multiple people)
 */
async function fetchDepartmentEmployeesByNames(names, deps = {}) {
  const byName = new Map();
  if (!names || names.length === 0) return byName;
  const queryFn = deps.queryFn;
  if (typeof queryFn !== "function") {
    throw new Error("fetchDepartmentEmployeesByNames requires deps.queryFn");
  }

  const uniq = [];
  const seen = new Set();
  for (const n of names) {
    const key = normalizeNameKey(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(key);
  }
  if (uniq.length === 0) return byName;

  const inList = uniq.map((k) => `'${escapeSqlString(k)}'`).join(", ");
  // Match ONLY on GOES_BY_NAME: runrate inorganic names are the short/goes-by form, and matching on
  // the full EMPLOYEE_NAME pulled wrong people. Map is therefore keyed by GOES_BY_NAME only.
  const sql = `
    SELECT EMPLOYEE_NO, EMPLOYEE_NAME, GOES_BY_NAME, DESIGNATION, IMMEDIATE_MANAGER, STATUS
    FROM ${departmentDataFqn()}
    WHERE LOWER(TRIM(GOES_BY_NAME)) IN (${inList})
  `;
  const rows = await queryFn(sql);

  const add = (key, entry) => {
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  };
  for (const r of rows || []) {
    const entry = {
      empNo: r?.EMPLOYEE_NO == null ? null : String(r.EMPLOYEE_NO).trim() || null,
      name: r?.EMPLOYEE_NAME == null ? null : String(r.EMPLOYEE_NAME).trim() || null,
      goesByName: r?.GOES_BY_NAME == null ? null : String(r.GOES_BY_NAME).trim() || null,
      designation: r?.DESIGNATION == null ? null : String(r.DESIGNATION).trim() || null,
      status: r?.STATUS == null ? null : String(r.STATUS).trim() || null,
      immediateManager:
        r?.IMMEDIATE_MANAGER == null ? null : String(r.IMMEDIATE_MANAGER).trim() || null,
    };
    add(normalizeNameKey(r?.GOES_BY_NAME), entry);
  }
  return byName;
}

/**
 * From the entries for one name, pick the row whose DESIGNATION maps to `expectedColumn` (when given
 * and more than one candidate). Falls back to the first entry.
 */
function pickEmployeeEntry(entries, expectedColumn) {
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1 || !expectedColumn) return entries[0];
  const match = entries.find((e) => resolveHierarchyColumnForTitle(e.designation) === expectedColumn);
  return match || entries[0];
}

/**
 * Resolve a runrate inorganic person to the actual person + column that should be logged.
 *  - Not found in Department_Data -> keep the given name at `expectedColumn` (cannot verify), empNo null.
 *  - Active -> keep name + empNo at `expectedColumn`.
 *  - Inactive -> walk IMMEDIATE_MANAGER until an Active person is found; that person is placed in the
 *    column their DESIGNATION maps to. If nobody active is reachable (or a manager's designation does
 *    not map to a column) -> null (=> NA).
 *
 * @param {string} name
 * @param {string} expectedColumn - deal-sheet-style column key (e.g. "ASSOCIATE_AM", "VP_SRVP")
 * @param {Map} byName - output of fetchDepartmentEmployeesByNames
 * @returns {{name: string, empNo: (string|null), column: string}|null}
 */
function resolveActiveOrManager(name, expectedColumn, byName) {
  const originalName = name == null ? "" : String(name).trim();
  if (!originalName || originalName.toUpperCase() === "NA") return null;

  const entries = byName instanceof Map ? byName.get(normalizeNameKey(originalName)) : null;
  const entry = pickEmployeeEntry(entries, expectedColumn);

  // Not found -> cannot verify status; keep as-is at the runrate-provided column.
  if (!entry) {
    return { name: originalName, empNo: null, column: expectedColumn };
  }

  if (isActiveStatus(entry.status)) {
    // Output the GOES_BY_NAME (e.g. "Amy Gupta"), not the full EMPLOYEE_NAME ("Amrita Gupta").
    return { name: entry.goesByName || entry.name || originalName, empNo: entry.empNo, column: expectedColumn };
  }

  // Inactive -> climb the IMMEDIATE_MANAGER chain until an active person is found.
  const seen = new Set([normalizeNameKey(originalName)]);
  let managerName = entry.immediateManager;
  for (let depth = 0; depth < MANAGER_WALK_MAX_DEPTH; depth++) {
    const mgrKey = normalizeNameKey(managerName);
    if (!mgrKey || seen.has(mgrKey)) return null;
    seen.add(mgrKey);

    const mgrEntries = byName.get(mgrKey);
    const mgrEntry = mgrEntries && mgrEntries.length > 0 ? mgrEntries[0] : null;
    if (!mgrEntry) return null;

    if (isActiveStatus(mgrEntry.status)) {
      const mgrColumn = resolveHierarchyColumnForTitle(mgrEntry.designation);
      if (!mgrColumn) return null;
      // Prefer GOES_BY_NAME for the resolved manager too.
      return { name: mgrEntry.goesByName || mgrEntry.name || managerName, empNo: mgrEntry.empNo, column: mgrColumn };
    }
    managerName = mgrEntry.immediateManager;
  }
  return null;
}

module.exports = {
  MANAGER_WALK_MAX_DEPTH,
  normalizeNameKey,
  isActiveStatus,
  fetchDepartmentEmployeesByNames,
  pickEmployeeEntry,
  resolveActiveOrManager,
};
