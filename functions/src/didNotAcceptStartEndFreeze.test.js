const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyDidNotAcceptStartEndFreeze,
  applyDidNotAcceptDateOverridesForRow,
  hasBusinessColumnChanges,
} = require("./bigQueryClient");

// Nov 2026 rule: a DID NOT ACCEPT row's START_DATE / END_DATE are taken once, when the offer is
// rejected (row turns DNA), and frozen after that — a reused job's moved start date is ignored.

test("already-DNA baseline: incoming job date is ignored, START/END stay frozen", () => {
  const baseline = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-06-01", END_DATE: "2026-06-01" };
  const incoming = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-09-15", END_DATE: "2026-09-15" };
  const { row, frozen } = applyDidNotAcceptStartEndFreeze(incoming, baseline);
  assert.equal(frozen, true);
  assert.equal(row.START_DATE, "2026-06-01");
  assert.equal(row.END_DATE, "2026-06-01");
});

test("row TURNING DNA (baseline OFFERED) takes the incoming job date once", () => {
  const baseline = { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-05-01", END_DATE: null };
  const incoming = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-06-01", END_DATE: "2026-06-01" };
  const { row, frozen } = applyDidNotAcceptStartEndFreeze(incoming, baseline);
  assert.equal(frozen, false);
  assert.equal(row.START_DATE, "2026-06-01");
});

test("DNA baseline with empty START_DATE does not freeze", () => {
  const baseline = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: null };
  const incoming = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-06-01" };
  assert.equal(applyDidNotAcceptStartEndFreeze(incoming, baseline).frozen, false);
});

test("non-DNA incoming is untouched (e.g. reopened to OFFERED)", () => {
  const baseline = { PLACEMENT_STATUS: "DID NOT ACCEPT", START_DATE: "2026-06-01" };
  const incoming = { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-09-15" };
  const { row, frozen } = applyDidNotAcceptStartEndFreeze(incoming, baseline);
  assert.equal(frozen, false);
  assert.equal(row.START_DATE, "2026-09-15");
});

test("frozen DNA row: a moved job date is not a change for the gate", () => {
  const baseline = {
    PLACEMENT_STATUS: "DID NOT ACCEPT",
    DEAL_TYPE: "DEAL",
    START_DATE: "2026-06-01",
    END_DATE: "2026-06-01",
  };
  const incoming = { ...baseline, START_DATE: "2026-09-15", END_DATE: "2026-09-15" };
  const compareRow = applyDidNotAcceptDateOverridesForRow(
    applyDidNotAcceptStartEndFreeze(incoming, baseline).row
  );
  assert.equal(hasBusinessColumnChanges(compareRow, baseline), false);
  assert.equal(compareRow.INITIAL_START_DATE, "2026-06-01");
});
