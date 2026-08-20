const test = require("node:test");
const assert = require("node:assert/strict");

const {
  vacateSelfReferencedHierarchyRoles,
  normalizeHierarchyPersonName,
} = require("./bigQueryClient");

// One person cannot hold two roles on one placement. The live case this guards (CANDIDATE_ID
// 30947933, Aug 2026): Srijana Chhetri was ATL over recruiter Yuvraj Gupta on DEAL placements
// 1445680 / 1452652, then became the recruiter herself on extension 1465994. Hierarchy is
// OVERWRITTEN from the parent DEAL, so the extension inherited ATL='Srijana Chhetri' — she became
// her own ATL. Run-rate and the prior extension both held the correct 'NA' but are fill-if-empty,
// so neither could correct it.

test("the cluster-code suffix comes off before names are compared", () => {
  // ASSIGNMENT_RECRUITER carries it, the manager columns do not.
  assert.equal(normalizeHierarchyPersonName("Srijana Chhetri (R1N)"), "srijana chhetri");
  assert.equal(normalizeHierarchyPersonName("Srijana Chhetri"), "srijana chhetri");
  assert.equal(normalizeHierarchyPersonName("  Yuvraj Gupta (R4N)  "), "yuvraj gupta");
  assert.equal(normalizeHierarchyPersonName(null), "");
});

test("the recruiter's own ATL role is vacated to NA and its emp-no cleared", () => {
  const out = vacateSelfReferencedHierarchyRoles({
    ASSIGNMENT_RECRUITER: "Srijana Chhetri (R1N)",
    RECRUITER_EMP_NO: "CY2365",
    ATL: "Srijana Chhetri",
    ATL_EMP_NO: "CY2365",
  });
  assert.equal(out.changed, true);
  assert.deepEqual(out.vacatedColumns, ["ATL"]);
  assert.equal(out.row.ATL, "NA");
  assert.equal(out.row.ATL_EMP_NO, null);
  // The Nexus assignment is the authority on who the recruiter is — never rewritten.
  assert.equal(out.row.ASSIGNMENT_RECRUITER, "Srijana Chhetri (R1N)");
  assert.equal(out.row.RECRUITER_EMP_NO, "CY2365");
});

test("a genuine manager is left alone", () => {
  const row = {
    ASSIGNMENT_RECRUITER: "Yuvraj Gupta (R4N)",
    RECRUITER_EMP_NO: "CY5748",
    ATL: "Srijana Chhetri",
    ATL_EMP_NO: "CY2365",
    RM: "Gavin Kumar",
    RM_EMP_NO: "CY1704",
  };
  const out = vacateSelfReferencedHierarchyRoles(row);
  assert.equal(out.changed, false);
  assert.equal(out.row, row, "expected the row to pass through untouched");
});

test("emp-no decides the match, not the name", () => {
  // Two different people who happen to share a name must NOT be collapsed when both emp-nos are
  // present and differ.
  const out = vacateSelfReferencedHierarchyRoles({
    ASSIGNMENT_RECRUITER: "Alex Kumar (R1N)",
    RECRUITER_EMP_NO: "CY1111",
    ATL: "Alex Kumar",
    ATL_EMP_NO: "CY2222",
  });
  assert.equal(out.changed, false);
  assert.equal(out.row.ATL, "Alex Kumar");
});

test("the name is the fallback when an emp-no is missing on either side", () => {
  const out = vacateSelfReferencedHierarchyRoles({
    ASSIGNMENT_RECRUITER: "Srijana Chhetri (R1N)",
    RECRUITER_EMP_NO: null,
    ATL: "Srijana Chhetri",
    ATL_EMP_NO: null,
  });
  assert.equal(out.changed, true);
  assert.equal(out.row.ATL, "NA");
});

test("every managed role is checked, not just ATL", () => {
  const out = vacateSelfReferencedHierarchyRoles({
    ASSIGNMENT_RECRUITER: "Srijana Chhetri (R1N)",
    RECRUITER_EMP_NO: "CY2365",
    ATL: "Srijana Chhetri",
    ATL_EMP_NO: "CY2365",
    TEAM_LEAD: "Srijana Chhetri",
    TEAM_LEAD_EMP_NO: "CY2365",
    RM: "Gavin Kumar",
    RM_EMP_NO: "CY1704",
  });
  assert.equal(out.changed, true);
  assert.deepEqual(out.vacatedColumns.sort(), ["ATL", "TEAM_LEAD"]);
  assert.equal(out.row.RM, "Gavin Kumar", "a real manager stays");
});

test("an already-vacated NA role is not re-processed", () => {
  const row = {
    ASSIGNMENT_RECRUITER: "Srijana Chhetri (R1N)",
    RECRUITER_EMP_NO: "CY2365",
    ATL: "NA",
    ATL_EMP_NO: null,
  };
  const out = vacateSelfReferencedHierarchyRoles(row);
  assert.equal(out.changed, false);
  assert.equal(out.row, row);
});

test("a row with no recruiter identity at all is left alone", () => {
  const row = { ASSIGNMENT_RECRUITER: null, RECRUITER_EMP_NO: null, ATL: "Srijana Chhetri" };
  const out = vacateSelfReferencedHierarchyRoles(row);
  assert.equal(out.changed, false);
  assert.equal(out.row.ATL, "Srijana Chhetri");
});
