/**
 * Placement statuses at which a placement's hierarchy is final: ENDED (incl. ENDED<30), DID NOT START,
 * DID NOT ACCEPT. Once a placement's row carries one of these, nothing updates its hierarchy or logs a
 * hierarchy change any more — inorganic_hierarchy_logs, the organic RM / AM / TL / ATL / AGD / DD /
 * AVP / VP seats, LEVEL_2/3/4_CSM and ownership_change_logs all stop. Judged on the row itself, so a
 * placement that goes back to STARTED / BOOKED is picked up again. A deal that ARRIVES with one of
 * these statuses still gets its hierarchy at insert. Prefix match, same as LIKE '...%'.
 */
const HIERARCHY_FROZEN_STATUS_PREFIXES = Object.freeze(["ENDED", "DID NOT START", "DID NOT ACCEPT"]);

function normalizeStatus(status) {
  return status == null ? "" : String(status).trim().toUpperCase();
}

/** True when `status` is a hierarchy-frozen status. */
function isHierarchyFrozenStatus(status) {
  const s = normalizeStatus(status);
  return HIERARCHY_FROZEN_STATUS_PREFIXES.some((prefix) => s.startsWith(prefix));
}

/** SQL predicate: TRUE when `statusColumn` is NOT a hierarchy-frozen status. */
function hierarchyOpenStatusSqlPredicate(statusColumn = "PLACEMENT_STATUS") {
  const normalized = `UPPER(TRIM(IFNULL(${statusColumn}, '')))`;
  return HIERARCHY_FROZEN_STATUS_PREFIXES.map((prefix) => `${normalized} NOT LIKE '${prefix}%'`).join(" AND ");
}

module.exports = {
  HIERARCHY_FROZEN_STATUS_PREFIXES,
  isHierarchyFrozenStatus,
  hierarchyOpenStatusSqlPredicate,
};
