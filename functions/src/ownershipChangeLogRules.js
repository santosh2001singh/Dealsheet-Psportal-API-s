/**
 * ownership_change_logs: WHICH ownership changes are logged and WHAT their dates are.
 *
 * Pure functions only — no BigQuery. bigQueryClient feeds them deal-sheet versions and existing log
 * rows; every rule lives here so it can be tested in isolation. Full write-up: docs/OWNERSHIP_LOGS.md.
 *
 * The rules (agreed 2026-10-02):
 *
 *  1. One change is ONE row per contract. A contract's placements are ordered by START_DATE and read
 *     as one timeline per role. A change is logged once, at the placement where it first appeared;
 *     the same change showing up again on a later extension (an update applied to every open
 *     placement of the contract) is the same change, not a new one.
 *
 *  2. The data team's rows (Cluster_Data.ownership_data, loaded once, EDITED_BY = 'DATA_TEAM_SYNC')
 *     are history the system never rewrites. The system only adds changes the data team does not
 *     already have: same SKU or CONTRACT_ID, same role, same previous and new owner (emp no when both
 *     sides carry one, otherwise the name without its "(SPA)"-style team tag). The same person
 *     arriving within SAME_ARRIVAL_TOLERANCE_DAYS also counts, whoever the previous owner was.
 *
 *  3. Effective date, from the change's ANCHOR placement:
 *       - the next EXTENSION of the contract after the anchor exists -> its START_DATE   (final)
 *       - otherwise the anchor's END_DATE + 1                                            (provisional)
 *       - no END_DATE -> the anchor's TENTATIVE_END_DATE + 1                             (provisional)
 *     A provisional date is upgraded on a later run, once the extension is booked.
 *     DID NOT START / DID NOT ACCEPT anchors never get an extension: they keep END_DATE + 1.
 *
 *  4. The anchor:
 *       - the change happened while the placement was running -> that placement
 *         (so it takes effect after it: its END_DATE + 1, then the next extension's START_DATE)
 *       - the placement started with the new owner (first record, or changed before its
 *         START_DATE) -> the placement before it, so the next extension IS this placement and the
 *         date is its START_DATE
 *       - a placement that never started -> itself (rule 3's END_DATE + 1)
 */

/** Where a row's OWNERSHIP_EFFECTIVE_DATE came from (column EFFECTIVE_DATE_SOURCE). */
const OWNERSHIP_LOG_SOURCE = Object.freeze({
  DATA_TEAM: "DATA_TEAM",
  END_PLUS_1: "END_PLUS_1",
  TENTATIVE_PLUS_1: "TENTATIVE_PLUS_1",
  EXTENSION_START: "EXTENSION_START",
});

/** EDITED_BY on the rows loaded from the data team's table; the system never rewrites them. */
const DATA_TEAM_EDITED_BY = "DATA_TEAM_SYNC";

/** CHANGE_REASON_NOTES on a change that came in with a new placement (not mid-placement). */
const CONTRACT_CHAIN_NOTE = "CONTRACT_CHAIN";

/** Placeholder for an empty hierarchy seat / an owner that left. */
const VACANT = "NA";

// ---------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------

/** BigQuery returns DATE / TIMESTAMP as { value }; unwrap it. */
function unwrap(value) {
  if (value != null && typeof value === "object" && !(value instanceof Date) && "value" in value) {
    return value.value;
  }
  return value;
}

/** YYYY-MM-DD from a DATE-ish value, else null. */
function dateOnly(value) {
  const v = unwrap(value);
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}

/** YYYY-MM-DD shifted by `days`, else null. */
function addDays(ymd, days) {
  if (ymd == null) return null;
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

/** Epoch ms of a row's LAST_UPDATED; NaN when missing. */
function versionTimeMs(row) {
  const v = unwrap(row?.LAST_UPDATED);
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v));
}

/** Trimmed display value, or null when empty. */
function displayOrNull(value) {
  const v = unwrap(value);
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Lower-cased trimmed compare key; "" when empty. */
function compareKey(value) {
  const s = displayOrNull(value);
  return s == null ? "" : s.toLowerCase();
}

function upperKey(value) {
  const s = displayOrNull(value);
  return s == null ? "" : s.toUpperCase();
}

/** DID NOT START / DID NOT ACCEPT: the placement never ran, so no extension follows it. */
function isNeverStartedStatus(status) {
  const s = upperKey(status);
  return s.startsWith("DID NOT START") || s.startsWith("DID NOT ACCEPT");
}

// ---------------------------------------------------------------------------------------------
// Person identity (dedupe)
// ---------------------------------------------------------------------------------------------

/**
 * Name compare key: lower-cased, whitespace collapsed, a trailing "(SPA)" / "(R5A)" team tag removed
 * (recruiter names carry one that changes when they move team), and the "NA" placeholder treated as
 * empty.
 */
function normalizeOwnerName(value) {
  const s = displayOrNull(value);
  if (s == null) return "";
  const cleaned = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  return cleaned === "na" ? "" : cleaned;
}

/** Emp-no compare key: upper-cased; the "NA" placeholder treated as empty. */
function normalizeOwnerEmpNo(value) {
  const s = upperKey(value);
  return s === "NA" ? "" : s;
}

/** Same person: by emp no when both sides carry one, otherwise by name. */
function isSameOwner(aName, aEmp, bName, bEmp) {
  const ea = normalizeOwnerEmpNo(aEmp);
  const eb = normalizeOwnerEmpNo(bEmp);
  if (ea !== "" && eb !== "") return ea === eb;
  return normalizeOwnerName(aName) === normalizeOwnerName(bName);
}

/** Same contract (CONTRACT_ID) or same SKU — data team rows only carry the SKU. */
function isSameOwnershipScope(a, b) {
  const ca = upperKey(a?.CONTRACT_ID);
  const cb = upperKey(b?.CONTRACT_ID);
  if (ca !== "" && ca === cb) return true;
  const sa = upperKey(a?.SKU_NO);
  const sb = upperKey(b?.SKU_NO);
  return sa !== "" && sa === sb;
}

/**
 * The same person arriving in the same role within this many days is the same arrival, even when the
 * two records name a different previous owner: the deal sheet can miss an owner the data team
 * recorded in between (H8503: data team "Heather Hoffman -> Derick Yi", deal sheet "Jodi Stanton ->
 * Derick Yi", both effective 2026-05-03).
 */
const SAME_ARRIVAL_TOLERANCE_DAYS = 7;

/** True when two log rows record the same change (rule 2). */
function isSameOwnershipChange(a, b) {
  if (upperKey(a?.OWNERSHIP_ROLE) !== upperKey(b?.OWNERSHIP_ROLE)) return false;
  if (!isSameOwnershipScope(a, b)) return false;
  if (!isSameOwner(a.NEW_OWNER_NAME, a.NEW_OWNER_EMP_NO, b.NEW_OWNER_NAME, b.NEW_OWNER_EMP_NO)) return false;
  if (isSameOwner(a.PREVIOUS_OWNER_NAME, a.PREVIOUS_OWNER_EMP_NO, b.PREVIOUS_OWNER_NAME, b.PREVIOUS_OWNER_EMP_NO)) {
    return true;
  }
  // Only an arrival qualifies — a vacate (new owner NA) must match on who left.
  const arrivingKey = normalizeOwnerName(a.NEW_OWNER_NAME) || normalizeOwnerEmpNo(a.NEW_OWNER_EMP_NO);
  if (arrivingKey === "") return false;
  const da = dateOnly(a.OWNERSHIP_EFFECTIVE_DATE);
  const db = dateOnly(b.OWNERSHIP_EFFECTIVE_DATE);
  if (da == null || db == null) return false;
  const gapDays = Math.abs(Date.parse(`${da}T00:00:00Z`) - Date.parse(`${db}T00:00:00Z`)) / 86400000;
  return gapDays <= SAME_ARRIVAL_TOLERANCE_DAYS;
}

/**
 * Drop candidates already in the log (data team rows included) and repeats within the batch.
 * Candidates are kept in the order given, so pass them earliest-first: the first one wins.
 * @param {object[]} candidates - log rows about to be inserted
 * @param {object[]} existingRows - log rows already in the table for the same contracts / SKUs
 * @returns {{fresh: object[], skippedExisting: number, skippedBatch: number}}
 */
function filterNewOwnershipLogRows(candidates, existingRows) {
  const byRole = new Map();
  const index = (row) => {
    const role = upperKey(row?.OWNERSHIP_ROLE);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(row);
  };
  for (const row of existingRows || []) index(row);
  const existingCount = new Map([...byRole].map(([role, rows]) => [role, rows.length]));

  const fresh = [];
  let skippedExisting = 0;
  let skippedBatch = 0;
  for (const cand of candidates || []) {
    const role = upperKey(cand?.OWNERSHIP_ROLE);
    const pool = byRole.get(role) || [];
    const hit = pool.findIndex((row) => isSameOwnershipChange(cand, row));
    if (hit !== -1) {
      if (hit < (existingCount.get(role) || 0)) skippedExisting++;
      else skippedBatch++;
      continue;
    }
    fresh.push(cand);
    index(cand);
  }
  return { fresh, skippedExisting, skippedBatch };
}

// ---------------------------------------------------------------------------------------------
// Placements and contracts
// ---------------------------------------------------------------------------------------------

/**
 * One placement as the rules see it, from its latest deal-sheet version.
 * @param {object} latest - the placement's latest deal-sheet row
 * @param {object[]} [versions] - every version, oldest first
 */
function placementFromRow(latest, versions = [latest]) {
  return {
    pid: displayOrNull(latest?.PLACEMENT_ID),
    contractKey: upperKey(latest?.CONTRACT_ID),
    contractId: displayOrNull(latest?.CONTRACT_ID),
    sku: displayOrNull(latest?.SKU_NUMBER),
    dealType: upperKey(latest?.DEAL_TYPE),
    status: displayOrNull(latest?.PLACEMENT_STATUS),
    neverStarted: isNeverStartedStatus(latest?.PLACEMENT_STATUS),
    start: dateOnly(latest?.START_DATE),
    end: dateOnly(latest?.END_DATE),
    tentative: dateOnly(latest?.TENTATIVE_END_DATE),
    initialStart: dateOnly(latest?.INITIAL_START_DATE),
    candidateName: latest?.CANDIDATE_NAME ?? null,
    candidateEmail: latest?.CANDIDATE_EMAIL ?? null,
    latest,
    versions,
  };
}

function comparePlacementOrder(a, b) {
  const sa = a.start || "9999-12-31";
  const sb = b.start || "9999-12-31";
  if (sa !== sb) return sa < sb ? -1 : 1;
  const pa = a.pid || "";
  const pb = b.pid || "";
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/**
 * Group deal-sheet versions into placements and contracts.
 *
 * A placement belongs to the contract on its LATEST version: a CONTRACT_ID can be re-minted, and an
 * older version still carrying the old id must not pull the placement into the wrong chain.
 * Placements without a CONTRACT_ID are indexed (the date sync needs them) but join no contract.
 *
 * @param {object[]} versions - deal-sheet rows, any order
 * @returns {{byPid: Map<string, object>, contracts: Map<string, object[]>}} contracts are ordered by
 *   START_DATE, then PLACEMENT_ID
 */
function buildOwnershipPlacementIndex(versions) {
  const grouped = new Map();
  (versions || []).forEach((row, i) => {
    const pid = displayOrNull(row?.PLACEMENT_ID);
    if (pid == null) return;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid).push({ row, i, t: versionTimeMs(row) });
  });

  const byPid = new Map();
  const contracts = new Map();
  for (const [pid, list] of grouped) {
    list.sort((a, b) => {
      const ta = Number.isFinite(a.t) ? a.t : -Infinity;
      const tb = Number.isFinite(b.t) ? b.t : -Infinity;
      return ta !== tb ? ta - tb : a.i - b.i;
    });
    const rows = list.map((x) => x.row);
    const placement = placementFromRow(rows[rows.length - 1], rows);
    byPid.set(pid, placement);
    if (placement.contractKey === "") continue;
    if (!contracts.has(placement.contractKey)) contracts.set(placement.contractKey, []);
    contracts.get(placement.contractKey).push(placement);
  }
  for (const list of contracts.values()) list.sort(comparePlacementOrder);
  return { byPid, contracts };
}

// ---------------------------------------------------------------------------------------------
// Effective date (rule 3)
// ---------------------------------------------------------------------------------------------

/**
 * Effective date for a change anchored on `anchor` (rule 3).
 * @param {object|null} anchor - placement (see placementFromRow)
 * @param {object[]} orderedPlacements - the anchor's contract, ordered (buildOwnershipPlacementIndex)
 * @returns {{effectiveDate: ?string, endDatePreviousOwner: ?string, source: ?string, placementId: ?string}}
 */
function resolveOwnershipEffectiveDate(anchor, orderedPlacements) {
  const none = { effectiveDate: null, endDatePreviousOwner: null, source: null, placementId: null };
  if (!anchor) return none;
  const result = (effectiveDate, source, placementId) => ({
    effectiveDate,
    endDatePreviousOwner: addDays(effectiveDate, -1),
    source,
    placementId,
  });

  if (!anchor.neverStarted) {
    const list = orderedPlacements || [];
    const at = list.findIndex((p) => p.pid === anchor.pid);
    if (at !== -1) {
      for (let i = at + 1; i < list.length; i++) {
        const next = list[i];
        if (next.dealType === "EXTENSION" && !next.neverStarted && next.start) {
          return result(next.start, OWNERSHIP_LOG_SOURCE.EXTENSION_START, next.pid);
        }
      }
    }
  }
  if (anchor.end) return result(addDays(anchor.end, 1), OWNERSHIP_LOG_SOURCE.END_PLUS_1, anchor.pid);
  if (anchor.tentative) {
    return result(addDays(anchor.tentative, 1), OWNERSHIP_LOG_SOURCE.TENTATIVE_PLUS_1, anchor.pid);
  }
  return { ...none, placementId: anchor.pid };
}

/** The closest placement before `placement` that actually ran, or null. */
function previousRunPlacement(placement, orderedPlacements) {
  const list = orderedPlacements || [];
  const at = list.findIndex((p) => p.pid === placement.pid);
  for (let i = at - 1; i >= 0; i--) {
    if (!list[i].neverStarted) return list[i];
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

/**
 * A role whose owner is identified by one change field (email for people, the name for CSM levels).
 * An empty value is "unknown", in both directions: a version that lost the value is not a removal,
 * and a value filled in where none was known is not a handover (nobody handed it over).
 */
function changeFieldRoleSpec({ role, nameField, changeField, empField }) {
  return {
    role,
    emptyIsOwner: false,
    read(row) {
      return {
        key: compareKey(row?.[changeField]),
        name: displayOrNull(row?.[nameField]),
        emp: empField ? displayOrNull(row?.[empField]) : null,
      };
    },
    isEmpty(obs) {
      return obs.key === "";
    },
    same(a, b) {
      return a.key === b.key;
    },
  };
}

/**
 * A hierarchy seat (name + emp-no columns). An empty seat is a real state — "NA" — so a person
 * leaving it is logged (NEW = NA). Compared on emp no when both sides carry one (a name can be
 * re-spelled), otherwise on the name.
 */
function hierarchySeatRoleSpec({ column, empNoColumn }) {
  const clean = (v) => {
    const s = compareKey(v);
    return s === VACANT.toLowerCase() ? "" : s;
  };
  return {
    role: column,
    emptyIsOwner: true,
    read(row) {
      return {
        nameKey: clean(row?.[column]),
        empKey: clean(row?.[empNoColumn]),
        name: displayOrNull(row?.[column]) ?? VACANT,
        emp: displayOrNull(row?.[empNoColumn]) ?? VACANT,
      };
    },
    isEmpty() {
      return false;
    },
    same(a, b) {
      if (a.empKey !== "" && b.empKey !== "") return a.empKey === b.empKey;
      if (a.nameKey !== b.nameKey) return false;
      return a.nameKey !== "" || a.empKey === b.empKey;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Timeline (rules 1 and 4)
// ---------------------------------------------------------------------------------------------

/**
 * The version of `placement` that was current at `timeMs` and carries a usable value for `spec`.
 * Falls back to the placement's earliest usable version when none is that old (a contract rebuilt in
 * one go stamps every placement at the same moment, so "older" is not always available).
 */
function versionAsOf(placement, timeMs, spec) {
  let found = null;
  let earliest = null;
  for (const row of placement.versions) {
    const obs = spec.read(row);
    if (spec.isEmpty(obs)) continue;
    if (earliest == null) earliest = { row, obs };
    const t = versionTimeMs(row);
    if (!Number.isFinite(timeMs) || (Number.isFinite(t) && t <= timeMs)) found = { row, obs };
  }
  return found ?? earliest;
}

/**
 * Every ownership change of one contract for one role, oldest first, before dedupe.
 * Walks the contract as one stream: placements by START_DATE, each placement's versions by time.
 * Entering a placement re-reads the previous placement AS OF that moment, so an update that later
 * reached the previous placement too (applied to every open placement) is not mistaken for the
 * owner switching back.
 */
function roleEventsForContract(placements, spec) {
  const events = [];
  let carry = null;
  placements.forEach((placement, pi) => {
    const versions = placement.versions;
    if (versions.length === 0) return;
    if (pi > 0) {
      const ref = versionAsOf(placements[pi - 1], versionTimeMs(versions[0]), spec);
      if (ref) carry = ref;
    }
    versions.forEach((row, vi) => {
      const obs = spec.read(row);
      if (carry == null) {
        carry = { row, obs };
        return;
      }
      if (spec.isEmpty(obs)) return;
      // No known previous owner: the value was only filled in (the CSM levels were backfilled on
      // 2026-08-19 across the table), so there is no handover to log.
      if (!spec.emptyIsOwner && spec.isEmpty(carry.obs)) {
        carry = { row, obs };
        return;
      }
      if (!spec.same(carry.obs, obs)) {
        events.push({
          role: spec.role,
          placement,
          row,
          previousRow: carry.row,
          timeMs: versionTimeMs(row),
          firstVersion: vi === 0,
          previous: { name: carry.obs.name, emp: carry.obs.emp },
          next: { name: obs.name, emp: obs.emp },
        });
      }
      carry = { row, obs };
    });
  });
  return events;
}

/**
 * The recruiter became someone who sat in the previous version's hierarchy (e.g. the RM took the
 * placement over): that seat is vacated — a second row, NEW = NA. Not for Canada, whose hierarchy
 * seats are their own roles there.
 */
function recruiterVacateEvents(recruiterEvent, vacateTargets) {
  const newEmp = normalizeOwnerEmpNo(recruiterEvent.row?.RECRUITER_EMP_NO);
  if (newEmp === "") return [];
  const out = [];
  for (const target of vacateTargets || []) {
    const prevEmp = normalizeOwnerEmpNo(recruiterEvent.previousRow?.[target.empNoColumn]);
    if (prevEmp === "" || prevEmp !== newEmp) continue;
    out.push({
      ...recruiterEvent,
      role: target.column,
      previous: {
        name: displayOrNull(recruiterEvent.previousRow?.[target.column]),
        emp: displayOrNull(recruiterEvent.previousRow?.[target.empNoColumn]),
      },
      next: { name: VACANT, emp: VACANT },
    });
  }
  return out;
}

/** UTC calendar day of an epoch ms, or null. */
function dayOfMs(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** Rule 4: the placement whose dates decide this change's effective date. */
function anchorForEvent(event, placements) {
  const placement = event.placement;
  if (placement.neverStarted) return { anchor: placement, startsWithPlacement: false };
  const day = dayOfMs(event.timeMs);
  const startsWithPlacement =
    event.firstVersion || (placement.start != null && day != null && day < placement.start);
  if (!startsWithPlacement) return { anchor: placement, startsWithPlacement: false };
  return { anchor: previousRunPlacement(placement, placements) ?? placement, startsWithPlacement: true };
}

/**
 * ownership_change_logs rows for every contract in `index` (rules 1, 3, 4). Earliest change first
 * within each contract, so filterNewOwnershipLogRows keeps the first sighting of a change.
 *
 * @param {{contracts: Map<string, object[]>}} index - buildOwnershipPlacementIndex
 * @param {object} options
 * @param {(placements: object[]) => object[]} options.roleSpecsForContract - role specs to track
 * @param {(placements: object[]) => object[]} [options.recruiterVacateTargetsForContract] - hierarchy
 *   seats a new recruiter can vacate (empty for Canada)
 * @param {Set<string>} [options.observedPlacementIds] - only changes first seen on these placements
 * @param {(placements: object[]) => number|null} [options.seenAfterMsForContract] - only changes
 *   first seen AFTER this moment (the data team cutoff): everything seen before it is the data
 *   team's history, see config ownershipLogDataTeamCutoff. null = no cutoff for that contract.
 * @param {string} options.nowIso - LAST_UPDATED for the new rows
 * @returns {object[]}
 */
function buildOwnershipChangeLogRowsFromIndex(index, options) {
  const out = [];
  const observed = options.observedPlacementIds ?? null;
  for (const placements of index.contracts.values()) {
    const specs = options.roleSpecsForContract(placements) || [];
    const vacateTargets = options.recruiterVacateTargetsForContract
      ? options.recruiterVacateTargetsForContract(placements) || []
      : [];

    let events = [];
    for (const spec of specs) {
      for (const ev of roleEventsForContract(placements, spec)) {
        events.push(ev);
        if (spec.role === "RECRUITER" && vacateTargets.length > 0) {
          events.push(...recruiterVacateEvents(ev, vacateTargets));
        }
      }
    }
    events.sort((a, b) => {
      const ta = Number.isFinite(a.timeMs) ? a.timeMs : Infinity;
      const tb = Number.isFinite(b.timeMs) ? b.timeMs : Infinity;
      if (ta !== tb) return ta - tb;
      return comparePlacementOrder(a.placement, b.placement);
    });
    // Rule 1: the same change seen again later (an update that reached every open placement) is
    // dropped, keeping its first sighting. Done BEFORE the observed filter, so the insert-time path
    // never mistakes a later sighting for a new change.
    const kept = [];
    for (const ev of events) {
      const repeat = kept.some(
        (k) =>
          k.role === ev.role &&
          isSameOwner(k.previous.name, k.previous.emp, ev.previous.name, ev.previous.emp) &&
          isSameOwner(k.next.name, k.next.emp, ev.next.name, ev.next.emp)
      );
      if (!repeat) kept.push(ev);
    }
    events = observed ? kept.filter((ev) => observed.has(ev.placement.pid)) : kept;
    // Rule 2: the data team's reload is the history up to its cutoff. A change first seen before it
    // is theirs — logged by them, or deliberately not (the 2026-08-19 table reload stamped every
    // version with that day's owners, so "changes" read from it skip whoever held the seat between:
    // H13017_H13231 Briana -> Jodi -> Damian came out as Briana -> Damian on the data team's date).
    // Filtered after the repeat check above, so a pre-cutoff change re-seen later stays dropped.
    const seenAfterMs = options.seenAfterMsForContract ? options.seenAfterMsForContract(placements) : null;
    if (Number.isFinite(seenAfterMs)) {
      events = events.filter((ev) => Number.isFinite(ev.timeMs) && ev.timeMs > seenAfterMs);
    }

    for (const ev of events) {
      const placement = ev.placement;
      const { anchor, startsWithPlacement } = anchorForEvent(ev, placements);
      const dates = resolveOwnershipEffectiveDate(anchor, placements);
      out.push({
        LAST_UPDATED: options.nowIso,
        SKU_NO: placement.sku,
        CONTRACT_ID: placement.contractId,
        PLACEMENT_ID: placement.pid,
        CANDIDATE_NAME: placement.candidateName,
        CANDIDATE_EMAIL: placement.candidateEmail,
        START_DATE: placement.start,
        INITIAL_START_DATE: placement.initialStart,
        OWNERSHIP_EFFECTIVE_DATE: dates.effectiveDate,
        END_DATE_PREVIOUS_OWNER: dates.endDatePreviousOwner,
        EFFECTIVE_DATE_SOURCE: dates.source,
        EFFECTIVE_DATE_PLACEMENT_ID: dates.placementId,
        OWNERSHIP_ROLE: ev.role,
        NEW_OWNER_NAME: ev.next.name,
        NEW_OWNER_EMP_NO: ev.next.emp,
        PREVIOUS_OWNER_NAME: ev.previous.name,
        PREVIOUS_OWNER_EMP_NO: ev.previous.emp,
        CHANGE_REASON_NOTES: startsWithPlacement ? CONTRACT_CHAIN_NOTE : null,
        STATUS_REMARKS: null,
        EDITED_BY: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Date sync for rows already in the table
// ---------------------------------------------------------------------------------------------

/** Columns the date sync owns on a system row. */
const SYNCED_DATE_COLUMNS = Object.freeze([
  "START_DATE",
  "INITIAL_START_DATE",
  "OWNERSHIP_EFFECTIVE_DATE",
  "END_DATE_PREVIOUS_OWNER",
  "EFFECTIVE_DATE_SOURCE",
  "EFFECTIVE_DATE_PLACEMENT_ID",
]);

/** True for a row loaded from the data team's table (never rewritten). */
function isDataTeamOwnershipRow(row) {
  return displayOrNull(row?.EDITED_BY) === DATA_TEAM_EDITED_BY || displayOrNull(row?.PLACEMENT_ID) == null;
}

/**
 * Re-resolve one system row's dates against the CURRENT deal sheet (rule 3): a provisional date
 * follows its anchor's END / TENTATIVE dates and becomes final once the next extension is booked; a
 * final date follows that extension's START_DATE, and falls back if the extension never started.
 *
 * @param {object} row - stored log row
 * @param {{byPid: Map<string, object>, contracts: Map<string, object[]>}} index
 * @returns {object|null} {ID, ...SYNCED_DATE_COLUMNS} when anything changed; null when the row is a
 *   data team row, its placement is not in `index`, or nothing changed
 */
function resolveStoredOwnershipLogDates(row, index) {
  if (isDataTeamOwnershipRow(row)) return null;
  const stamped = index.byPid.get(displayOrNull(row.PLACEMENT_ID));
  if (!stamped) return null;
  const placements = (stamped.contractKey && index.contracts.get(stamped.contractKey)) || [stamped];

  const source = displayOrNull(row.EFFECTIVE_DATE_SOURCE);
  const pinnedPid = displayOrNull(row.EFFECTIVE_DATE_PLACEMENT_ID);
  const pinned = pinnedPid ? index.byPid.get(pinnedPid) : null;

  let dates;
  if (source === OWNERSHIP_LOG_SOURCE.EXTENSION_START && pinned && !pinned.neverStarted && pinned.start) {
    dates = {
      effectiveDate: pinned.start,
      endDatePreviousOwner: addDays(pinned.start, -1),
      source,
      placementId: pinned.pid,
    };
  } else {
    let anchor = stamped;
    if (source === OWNERSHIP_LOG_SOURCE.EXTENSION_START) {
      // The extension it pointed at never started (or is gone): anchor on what ran before it.
      anchor = (pinned && previousRunPlacement(pinned, placements)) || stamped;
    } else if (pinned) {
      anchor = pinned;
    }
    dates = resolveOwnershipEffectiveDate(anchor, placements);
  }

  const target = {
    START_DATE: stamped.start,
    INITIAL_START_DATE: stamped.initialStart,
    OWNERSHIP_EFFECTIVE_DATE: dates.effectiveDate,
    END_DATE_PREVIOUS_OWNER: dates.endDatePreviousOwner,
    EFFECTIVE_DATE_SOURCE: dates.source,
    EFFECTIVE_DATE_PLACEMENT_ID: dates.placementId,
  };
  const stored = {
    START_DATE: dateOnly(row.START_DATE),
    INITIAL_START_DATE: dateOnly(row.INITIAL_START_DATE),
    OWNERSHIP_EFFECTIVE_DATE: dateOnly(row.OWNERSHIP_EFFECTIVE_DATE),
    END_DATE_PREVIOUS_OWNER: dateOnly(row.END_DATE_PREVIOUS_OWNER),
    EFFECTIVE_DATE_SOURCE: source,
    EFFECTIVE_DATE_PLACEMENT_ID: pinnedPid,
  };
  const changed = SYNCED_DATE_COLUMNS.some((col) => (stored[col] ?? null) !== (target[col] ?? null));
  return changed ? { ID: row.ID, ...target } : null;
}

module.exports = {
  OWNERSHIP_LOG_SOURCE,
  DATA_TEAM_EDITED_BY,
  CONTRACT_CHAIN_NOTE,
  VACANT,
  SYNCED_DATE_COLUMNS,
  dateOnly,
  addDays,
  isNeverStartedStatus,
  normalizeOwnerName,
  normalizeOwnerEmpNo,
  SAME_ARRIVAL_TOLERANCE_DAYS,
  isSameOwner,
  isSameOwnershipChange,
  filterNewOwnershipLogRows,
  placementFromRow,
  buildOwnershipPlacementIndex,
  resolveOwnershipEffectiveDate,
  changeFieldRoleSpec,
  hierarchySeatRoleSpec,
  buildOwnershipChangeLogRowsFromIndex,
  isDataTeamOwnershipRow,
  resolveStoredOwnershipLogDates,
};
