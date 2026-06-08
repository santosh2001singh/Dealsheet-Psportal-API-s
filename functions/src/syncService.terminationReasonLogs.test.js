/**
 * Unit tests for termination-reason log append-on-change helpers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasTerminationReasonLogChange } = require("./syncService");
const { buildTerminationReasonLogCompositeKey } = require("./bigQueryClient");

test("buildTerminationReasonLogCompositeKey requires placement and detail id", () => {
  assert.equal(buildTerminationReasonLogCompositeKey("1454975", "76581"), "1454975|76581");
  assert.equal(buildTerminationReasonLogCompositeKey("1454975", null), "");
  assert.equal(buildTerminationReasonLogCompositeKey(null, "76581"), "");
});

test("hasTerminationReasonLogChange: identical rows -> no change", () => {
  const row = {
    PLACEMENT_ID: 1454975,
    TERMINATION_DETAIL_ID: 76581,
    VALUE: "Other",
    NOTES: "client cancelled",
    CANCELLED_BY: "CLIENT",
    TERMINATION_TYPE: null,
    DNR_AT: null,
    CONTRACT_ID: 100015,
  };
  assert.equal(hasTerminationReasonLogChange(row, { ...row }), false);
});

test("hasTerminationReasonLogChange: VALUE change -> change", () => {
  const existing = {
    VALUE: "Other",
    NOTES: "n",
    CANCELLED_BY: "CLIENT",
    TERMINATION_TYPE: null,
    DNR_AT: null,
    CONTRACT_ID: 100015,
  };
  const incoming = { ...existing, VALUE: "Other Job Opportunity" };
  assert.equal(hasTerminationReasonLogChange(incoming, existing), true);
});

test("hasTerminationReasonLogChange: NOTES change -> change", () => {
  const existing = {
    VALUE: "Other",
    NOTES: "old note",
    CANCELLED_BY: "CLIENT",
    TERMINATION_TYPE: null,
    DNR_AT: null,
    CONTRACT_ID: 100015,
  };
  const incoming = { ...existing, NOTES: "new note" };
  assert.equal(hasTerminationReasonLogChange(incoming, existing), true);
});

test("hasTerminationReasonLogChange: missing existing -> change", () => {
  const incoming = {
    VALUE: "Other",
    NOTES: "n",
    CANCELLED_BY: "CLIENT",
    TERMINATION_TYPE: "VOLUNTARY",
    DNR_AT: "AT_CLIENT_ONLY",
    CONTRACT_ID: 100015,
  };
  assert.equal(hasTerminationReasonLogChange(incoming, null), true);
});
