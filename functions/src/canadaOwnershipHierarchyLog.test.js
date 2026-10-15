const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");

const {
  buildOwnershipChangeLogRowsFromVersions,
  CANADA_OWNERSHIP_HIERARCHY_TARGETS,
} = require("./bigQueryClient");

// These fixtures predate the data-team cutoff; the cutoff has its own tests
// (ownershipChangeLogRules.test.js "data team cutoff").
config.ownershipLogDataTeamCutoff = "2000-01-01T00:00:00Z";

/**
 * Canada has no inorganic hierarchy: a person joining, leaving or moving within the recruiter's chain
 * lands on the deal sheet straight away, and ownership_change_logs records it (Sep 2026). Health and
 * locums log only the OWNERSHIP_CHANGE_DIFF_ROLES (plus the seat a new recruiter vacates).
 */

function canadaRow(overrides = {}) {
  return {
    DEAL_SHEET_ID: "D1",
    PLACEMENT_ID: "1001",
    CONTRACT_ID: "CAC1001",
    DEAL_TYPE: "DEAL",
    PLACEMENT_STATUS: "STARTED",
    CLIENT_STATE: "ON",
    START_DATE: "2026-06-01",
    TENTATIVE_END_DATE: "2026-09-30",
    LAST_UPDATED: "2026-08-01T00:00:00Z",
    ASSIGNMENT_RECRUITER: "Rec One",
    ASSIGNMENT_RECRUITER_EMAIL: "rec1@cynethealth.ca",
    RECRUITER_EMP_NO: "CY1",
    TEAM_LEAD: "Priya",
    TEAM_LEAD_EMP_NO: "CY10",
    RM: "Rahul",
    RM_EMP_NO: "CY20",
    VP: "Varun",
    VP_EMP_NO: "CY30",
    ...overrides,
  };
}

const healthRow = (overrides) => canadaRow({ CLIENT_STATE: "TX", CONTRACT_ID: "CHC23001", ...overrides });
const later = (row, overrides) => ({ ...row, LAST_UPDATED: "2026-09-01T00:00:00Z", ...overrides });
const rowsFor = (...versions) => buildOwnershipChangeLogRowsFromVersions(versions, { nowIso: "2026-10-02T00:00:00Z" });
const byRole = (rows) => Object.fromEntries(rows.map((r) => [r.OWNERSHIP_ROLE, r]));

test("canada logs every managed hierarchy seat except AVP and the manual secondaries", () => {
  const cols = CANADA_OWNERSHIP_HIERARCHY_TARGETS.map((t) => t.column);
  assert.ok(cols.includes("RM") && cols.includes("TEAM_LEAD") && cols.includes("VP"));
  for (const c of ["AVP", "SECONDARY_RECRUITER", "SECONDARY_AM"]) assert.ok(!cols.includes(c), c);
});

test("a person added to an empty seat is logged with PREVIOUS = NA", () => {
  const prev = canadaRow({ ATL: null, ATL_EMP_NO: null });
  const rows = rowsFor(prev, later(prev, { ATL: "Harsh Arora", ATL_EMP_NO: "CY40" }));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].OWNERSHIP_ROLE, rows[0].NEW_OWNER_NAME, rows[0].NEW_OWNER_EMP_NO, rows[0].PREVIOUS_OWNER_NAME, rows[0].PREVIOUS_OWNER_EMP_NO],
    ["ATL", "Harsh Arora", "CY40", "NA", "NA"]
  );
});

test("a vacated seat is logged with NEW = NA", () => {
  const prev = canadaRow();
  const rows = rowsFor(prev, later(prev, { VP: null, VP_EMP_NO: null }));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.OWNERSHIP_ROLE, r.NEW_OWNER_NAME, r.PREVIOUS_OWNER_NAME, r.PREVIOUS_OWNER_EMP_NO], ["VP", "NA", "Varun", "CY30"]);
});

test("a promotion logs the old seat's vacate and the new seat's fill for the same person", () => {
  const prev = canadaRow();
  const rows = byRole(rowsFor(prev, later(prev, { TEAM_LEAD: null, TEAM_LEAD_EMP_NO: null, RM: "Priya", RM_EMP_NO: "CY10" })));
  assert.deepEqual(Object.keys(rows).sort(), ["RM", "TEAM_LEAD"]);
  assert.equal(rows.TEAM_LEAD.PREVIOUS_OWNER_NAME, "Priya");
  assert.equal(rows.TEAM_LEAD.NEW_OWNER_NAME, "NA");
  assert.equal(rows.RM.NEW_OWNER_NAME, "Priya");
  assert.equal(rows.RM.NEW_OWNER_EMP_NO, "CY10");
  assert.equal(rows.RM.PREVIOUS_OWNER_NAME, "Rahul");
});

test("a change while the placement runs: effective = TENTATIVE_END_DATE + 1 until an extension exists", () => {
  const prev = canadaRow();
  const [r] = rowsFor(prev, later(prev, { VP: null, VP_EMP_NO: null }));
  assert.equal(r.START_DATE, "2026-06-01");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-09-30");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-10-01");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, "TENTATIVE_PLUS_1");
  assert.equal(r.CHANGE_REASON_NOTES, null);
});

test("the NA placeholder and an empty seat are the same, so no row", () => {
  const prev = canadaRow({ ATL: "NA", ATL_EMP_NO: "NA" });
  assert.equal(rowsFor(prev, later(prev, { ATL: null, ATL_EMP_NO: null })).length, 0);
});

test("a re-spelled name with the same emp-no is not a change", () => {
  const prev = canadaRow();
  assert.equal(rowsFor(prev, later(prev, { RM: "Rahul Kumar" })).length, 0);
});

test("a recruiter change is still logged, with no duplicate vacate row for canada", () => {
  // The new recruiter was the RM; the live hierarchy then vacates RM in the same version.
  const prev = canadaRow();
  const rows = rowsFor(
    prev,
    later(prev, {
      ASSIGNMENT_RECRUITER: "Rahul",
      ASSIGNMENT_RECRUITER_EMAIL: "rahul@cynethealth.ca",
      RECRUITER_EMP_NO: "CY20",
      RM: null,
      RM_EMP_NO: null,
    })
  );
  const rm = rows.filter((r) => r.OWNERSHIP_ROLE === "RM");
  assert.equal(rm.length, 1, "exactly one RM row");
  assert.equal(rm[0].NEW_OWNER_NAME, "NA");
  assert.ok(rows.some((r) => r.OWNERSHIP_ROLE === "RECRUITER" && r.NEW_OWNER_NAME === "Rahul"));
});

test("health: hierarchy seat changes are not logged here (the inorganic path owns them)", () => {
  const prev = healthRow();
  assert.equal(rowsFor(prev, later(prev, { VP: null, VP_EMP_NO: null, ATL: "Harsh", ATL_EMP_NO: "CY40" })).length, 0);
});

test("health: the recruiter-handover vacate row is still written", () => {
  const prev = healthRow();
  const rows = byRole(
    rowsFor(prev, later(prev, { ASSIGNMENT_RECRUITER: "Rahul", ASSIGNMENT_RECRUITER_EMAIL: "rahul@cynetsystems.com", RECRUITER_EMP_NO: "CY20" }))
  );
  assert.deepEqual(Object.keys(rows).sort(), ["RECRUITER", "RM"]);
  assert.equal(rows.RM.NEW_OWNER_NAME, "NA");
  assert.equal(rows.RM.PREVIOUS_OWNER_NAME, "Rahul");
});

test("contract chain: an extension that starts with a different VP is effective from its START_DATE", () => {
  const deal = canadaRow({ PLACEMENT_ID: "1001", DEAL_TYPE: "DEAL" });
  const ext = canadaRow({
    PLACEMENT_ID: "1002",
    DEAL_TYPE: "EXTENSION",
    START_DATE: "2026-10-01",
    TENTATIVE_END_DATE: "2026-12-31",
    LAST_UPDATED: "2026-09-20T00:00:00Z",
    VP: "Sr VP",
    VP_EMP_NO: "CY99",
  });
  const [r] = rowsFor(deal, ext);
  assert.equal(r.OWNERSHIP_ROLE, "VP");
  assert.equal(r.PLACEMENT_ID, "1002");
  assert.equal(r.CHANGE_REASON_NOTES, "CONTRACT_CHAIN");
  assert.equal(r.OWNERSHIP_EFFECTIVE_DATE, "2026-10-01");
  assert.equal(r.END_DATE_PREVIOUS_OWNER, "2026-09-30");
  assert.equal(r.EFFECTIVE_DATE_SOURCE, "EXTENSION_START");
});

test("every version is walked, not just the latest pair", () => {
  // v1 -> v2: recruiter change. v2 -> v3: live hierarchy append (VP vacated). A latest-vs-previous
  // scan would only see v2 -> v3 and miss the recruiter change.
  const v1 = canadaRow({ LAST_UPDATED: { value: "2026-09-01T00:00:00Z" } });
  const v2 = canadaRow({
    LAST_UPDATED: { value: "2026-09-02T00:00:00Z" },
    ASSIGNMENT_RECRUITER: "Rec Two",
    ASSIGNMENT_RECRUITER_EMAIL: "rec2@cynethealth.ca",
    RECRUITER_EMP_NO: "CY2",
  });
  const v3 = { ...v2, LAST_UPDATED: { value: "2026-09-03T00:00:00Z" }, VP: null, VP_EMP_NO: null };
  const noChange = { ...v3, LAST_UPDATED: { value: "2026-09-04T00:00:00Z" } };
  const rows = rowsFor(v3, noChange, v1, v2);
  assert.deepEqual(rows.map((r) => r.OWNERSHIP_ROLE).sort(), ["RECRUITER", "VP"]);
});

test("placements of different contracts are never compared", () => {
  const a = canadaRow({ PLACEMENT_ID: "1", CONTRACT_ID: "CAC1" });
  const b = canadaRow({ PLACEMENT_ID: "2", CONTRACT_ID: "CAC2", VP: null, VP_EMP_NO: null });
  assert.equal(rowsFor(a, b).length, 0);
});
