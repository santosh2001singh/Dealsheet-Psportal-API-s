const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dedupeLogRowsByCompositeKey,
  hasAdditionalCostLogChange,
  hasTerminationReasonLogChange,
} = require("./syncService");
const {
  buildAdditionalCostLogCompositeKey,
  buildTerminationReasonLogCompositeKey,
} = require("./bigQueryClient");

const costKey = (row) =>
  buildAdditionalCostLogCompositeKey(row?.DEAL_SHEET_ID, row?.PLACEMENT_ID, row?.ADDITIONAL_COST_ID);

const termKey = (row) =>
  buildTerminationReasonLogCompositeKey(row?.PLACEMENT_ID, row?.TERMINATION_DETAIL_ID);

test("same-batch: duplicate additional-cost composite key keeps first only", () => {
  const rows = [
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 10, ADDITIONAL_COST_ID: 100, VALUE: 50, NOTES: "a" },
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 10, ADDITIONAL_COST_ID: 100, VALUE: 99, NOTES: "dup" },
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 10, ADDITIONAL_COST_ID: 101, VALUE: 10 },
  ];
  const { kept, sameBatchDropped, skippedMissingKey } = dedupeLogRowsByCompositeKey(rows, costKey);
  assert.equal(sameBatchDropped, 1);
  assert.equal(skippedMissingKey, 0);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].NOTES, "a");
  assert.equal(kept[1].ADDITIONAL_COST_ID, 101);
});

test("same-batch: duplicate termination composite key keeps first only", () => {
  const rows = [
    { PLACEMENT_ID: 10, TERMINATION_DETAIL_ID: 55, VALUE: "quit" },
    { PLACEMENT_ID: 10, TERMINATION_DETAIL_ID: 55, VALUE: "dup" },
  ];
  const { kept, sameBatchDropped } = dedupeLogRowsByCompositeKey(rows, termKey);
  assert.equal(sameBatchDropped, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].VALUE, "quit");
});

test("missing ADDITIONAL_COST_ID is skipped (no blind insert)", () => {
  const rows = [
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 10, ADDITIONAL_COST_ID: null, VALUE: 1 },
    { DEAL_SHEET_ID: 1, PLACEMENT_ID: 10, ADDITIONAL_COST_ID: 200, VALUE: 2 },
  ];
  const { kept, skippedMissingKey } = dedupeLogRowsByCompositeKey(rows, costKey);
  assert.equal(skippedMissingKey, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ADDITIONAL_COST_ID, 200);
});

test("missing TERMINATION_DETAIL_ID is skipped", () => {
  const rows = [
    { PLACEMENT_ID: 10, TERMINATION_DETAIL_ID: null, VALUE: "x" },
    { PLACEMENT_ID: 10, TERMINATION_DETAIL_ID: 9, VALUE: "y" },
  ];
  const { kept, skippedMissingKey } = dedupeLogRowsByCompositeKey(rows, termKey);
  assert.equal(skippedMissingKey, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].VALUE, "y");
});

test("hasAdditionalCostLogChange: unchanged snapshot is false", () => {
  const row = {
    ADDITIONAL_COST_NAME: "Housing",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    NOTES: "n",
    VALUE: 100.005,
  };
  const existing = { ...row, VALUE: 100 };
  assert.equal(hasAdditionalCostLogChange(row, existing), false);
});

test("hasAdditionalCostLogChange: value change beyond tolerance is true", () => {
  const row = { ADDITIONAL_COST_NAME: "Housing", CATEGORY: "BONUS", DURATION: "ONE_TIME", NOTES: "n", VALUE: 110 };
  const existing = { ...row, VALUE: 100 };
  assert.equal(hasAdditionalCostLogChange(row, existing), true);
});

test("hasTerminationReasonLogChange: unchanged snapshot is false", () => {
  const row = {
    VALUE: "Client cancel",
    NOTES: "n",
    CANCELLED_BY: "MSP",
    TERMINATION_TYPE: "CANCEL",
    DNR_AT: null,
    CONTRACT_ID: "C1",
  };
  assert.equal(hasTerminationReasonLogChange(row, { ...row }), false);
});

test("hasTerminationReasonLogChange: VALUE change is true", () => {
  const existing = { VALUE: "A", NOTES: null, CANCELLED_BY: null, TERMINATION_TYPE: null, DNR_AT: null, CONTRACT_ID: null };
  assert.equal(hasTerminationReasonLogChange({ ...existing, VALUE: "B" }, existing), true);
});
