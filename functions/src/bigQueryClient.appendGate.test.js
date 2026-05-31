/**
 * Append-on-change + first-insert placement gate (hybrid rules).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasBusinessColumnChanges,
  resolveFirstInsertPlacementAllowlist,
  placementStatusAllowsFirstInsert,
  buildDealSheetPlacementCompositeKey,
  buildAdditionalCostLogCompositeKey,
  normalizeMoveRunrate,
  applyMoveRunrateAppendOverride,
  applyIsRejectedResetForChangedUpdate,
  applyManualColumnsCarryForward,
} = require("./bigQueryClient");

const IGNORE = new Set(["ID", "DATE_AND_TIME"]);

test("hasBusinessColumnChanges: ENDED vs ENDED<30 is a business change", () => {
  const existing = { PLACEMENT_STATUS: "ENDED", DEAL_SHEET_ID: 1, FOO: "a" };
  const incoming = { PLACEMENT_STATUS: "ENDED<30", DEAL_SHEET_ID: 1, FOO: "a" };
  assert.equal(hasBusinessColumnChanges(incoming, existing, IGNORE), true);
});

test("hasBusinessColumnChanges: identical placement status skips", () => {
  const row = { PLACEMENT_STATUS: "ENDED", DEAL_SHEET_ID: 1 };
  assert.equal(hasBusinessColumnChanges(row, { ...row }, IGNORE), false);
});

test("resolveFirstInsertPlacementAllowlist: defaults to STARTED and BOOKED", () => {
  const s = resolveFirstInsertPlacementAllowlist({});
  assert.ok(s.has("STARTED"));
  assert.ok(s.has("BOOKED"));
  assert.equal(s.size, 2);
});

test("resolveFirstInsertPlacementAllowlist: parses CSV string", () => {
  const s = resolveFirstInsertPlacementAllowlist({
    first_insert_placement_status_allowlist: "started, booked ",
  });
  assert.ok(s.has("STARTED"));
  assert.ok(s.has("BOOKED"));
});

test("placementStatusAllowsFirstInsert: BOOKED and STARTED allowed", () => {
  const s = resolveFirstInsertPlacementAllowlist({});
  assert.equal(placementStatusAllowsFirstInsert("BOOKED", s), true);
  assert.equal(placementStatusAllowsFirstInsert("STARTED", s), true);
});

test("placementStatusAllowsFirstInsert: ENDED and ENDED<30 blocked for first insert", () => {
  const s = resolveFirstInsertPlacementAllowlist({});
  assert.equal(placementStatusAllowsFirstInsert("ENDED", s), false);
  assert.equal(placementStatusAllowsFirstInsert("ENDED<30", s), false);
});

test("placementStatusAllowsFirstInsert: empty or missing status blocked", () => {
  const s = resolveFirstInsertPlacementAllowlist({});
  assert.equal(placementStatusAllowsFirstInsert("", s), false);
  assert.equal(placementStatusAllowsFirstInsert(null, s), false);
});

test("composite key: same deal sheet different placement IDs do not share baseline", () => {
  const k1 = buildDealSheetPlacementCompositeKey("5184482", "1451770");
  const k2 = buildDealSheetPlacementCompositeKey("5184482", "1450934");
  assert.notEqual(k1, k2);
});

test("additional-cost log triple key: requires all three parts", () => {
  assert.equal(buildAdditionalCostLogCompositeKey("1", "2", "3"), "1|2|3");
  assert.equal(buildAdditionalCostLogCompositeKey("1", "2", null), "");
  assert.equal(buildAdditionalCostLogCompositeKey("1", null, "3"), "");
  assert.equal(buildAdditionalCostLogCompositeKey(null, "2", "3"), "");
  assert.equal(buildAdditionalCostLogCompositeKey("1", "", "3"), "");
  assert.equal(buildAdditionalCostLogCompositeKey(" 1 ", " 2 ", " 3 "), "1|2|3");
});

test("additional-cost log triple key: distinguishes by ADDITIONAL_COST_ID", () => {
  const k1 = buildAdditionalCostLogCompositeKey("1354781", "412941", "521873");
  const k2 = buildAdditionalCostLogCompositeKey("1354781", "412941", "521874");
  assert.notEqual(k1, k2);
});

test("hasBusinessColumnChanges: same composite key status change appends", () => {
  const existing = { DEAL_SHEET_ID: "5184482", PLACEMENT_ID: "1450934", PLACEMENT_STATUS: "STARTED" };
  const incoming = { DEAL_SHEET_ID: "5184482", PLACEMENT_ID: "1450934", PLACEMENT_STATUS: "DID NOT ACCEPT" };
  assert.equal(hasBusinessColumnChanges(incoming, existing, IGNORE), true);
});

test("hasBusinessColumnChanges: ID/DATE_AND_TIME-only diff skips", () => {
  const existing = {
    DEAL_SHEET_ID: "5184482",
    PLACEMENT_ID: "1451770",
    PLACEMENT_STATUS: "STARTED",
    ID: "old-id",
    DATE_AND_TIME: "2026-04-28 01:04:11.649000 UTC",
  };
  const incoming = {
    DEAL_SHEET_ID: "5184482",
    PLACEMENT_ID: "1451770",
    PLACEMENT_STATUS: "STARTED",
    ID: "new-id",
    DATE_AND_TIME: "2026-04-28 05:04:33.988000 UTC",
  };
  assert.equal(hasBusinessColumnChanges(incoming, existing, IGNORE), false);
});

test("normalizeMoveRunrate: parses TRUE/FALSE strings and null", () => {
  assert.equal(normalizeMoveRunrate(" true "), "TRUE");
  assert.equal(normalizeMoveRunrate("FALSE"), "FALSE");
  assert.equal(normalizeMoveRunrate(null), null);
});

test("applyMoveRunrateAppendOverride: baseline TRUE forces FALSE", () => {
  const incoming = { MOVE_RUNRATE: "TRUE", DEAL_SHEET_ID: "1", PLACEMENT_ID: "2" };
  const baseline = { MOVE_RUNRATE: "TRUE" };
  const out = applyMoveRunrateAppendOverride(incoming, baseline);
  assert.equal(out.row.MOVE_RUNRATE, "FALSE");
  assert.equal(out.forcedFalse, true);
  assert.equal(out.keptNull, false);
});

test("applyMoveRunrateAppendOverride: baseline FALSE keeps incoming", () => {
  const incoming = { MOVE_RUNRATE: "TRUE" };
  const baseline = { MOVE_RUNRATE: "FALSE" };
  const out = applyMoveRunrateAppendOverride(incoming, baseline);
  assert.equal(out.row.MOVE_RUNRATE, "TRUE");
  assert.equal(out.forcedFalse, false);
  assert.equal(out.keptNull, false);
});

test("applyMoveRunrateAppendOverride: baseline NULL keeps NULL", () => {
  const incoming = { MOVE_RUNRATE: "TRUE" };
  const baseline = { MOVE_RUNRATE: null };
  const out = applyMoveRunrateAppendOverride(incoming, baseline);
  assert.equal(out.row.MOVE_RUNRATE, null);
  assert.equal(out.forcedFalse, false);
  assert.equal(out.keptNull, true);
});

test("applyIsRejectedResetForChangedUpdate: baseline exists sets False", () => {
  const incoming = { IS_REJECTED: "True", DEAL_SHEET_ID: "1", PLACEMENT_ID: "2" };
  const baseline = { DEAL_SHEET_ID: "1", PLACEMENT_ID: "2" };
  const out = applyIsRejectedResetForChangedUpdate(incoming, baseline);
  assert.equal(out.IS_REJECTED, "False");
});

test("applyIsRejectedResetForChangedUpdate: no baseline keeps value unchanged", () => {
  const incoming = { IS_REJECTED: "True", DEAL_SHEET_ID: "1", PLACEMENT_ID: "2" };
  const out = applyIsRejectedResetForChangedUpdate(incoming, null);
  assert.equal(out.IS_REJECTED, "True");
});

test("hasBusinessColumnChanges: manual column diff (SKU_NUMBER) is ignored", () => {
  const existing = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "STARTED",
    SKU_NUMBER: "23243",
    BGC_AGENCY_NAME: "Acme",
  };
  const incoming = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "STARTED",
    SKU_NUMBER: null,
    BGC_AGENCY_NAME: null,
  };
  assert.equal(hasBusinessColumnChanges(incoming, existing, IGNORE), false);
});

test("hasBusinessColumnChanges: API column change still detected with manual columns present", () => {
  const existing = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "STARTED",
    SKU_NUMBER: "23243",
  };
  const incoming = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "ENDED",
    SKU_NUMBER: null,
  };
  assert.equal(hasBusinessColumnChanges(incoming, existing, IGNORE), true);
});

test("applyManualColumnsCarryForward: copies manual columns from baseline to incoming", () => {
  const incoming = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "ENDED",
    SKU_NUMBER: null,
    BGC_AGENCY_NAME: null,
  };
  const baseline = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    PLACEMENT_STATUS: "STARTED",
    SKU_NUMBER: "23243",
    BGC_AGENCY_NAME: "Acme",
    ATL: "John Doe",
  };
  const out = applyManualColumnsCarryForward(incoming, baseline);
  assert.equal(out.row.SKU_NUMBER, "23243");
  assert.equal(out.row.BGC_AGENCY_NAME, "Acme");
  assert.equal(out.row.ATL, "John Doe");
  assert.equal(out.row.PLACEMENT_STATUS, "ENDED");
  assert.equal(out.carriedCount, 3);
});

test("applyManualColumnsCarryForward: does not carry API columns from baseline", () => {
  const incoming = {
    PLACEMENT_STATUS: "ENDED",
    ASSIGNMENT_RECRUITER: "New Recruiter",
    PAY_RATE: 50,
  };
  const baseline = {
    PLACEMENT_STATUS: "STARTED",
    ASSIGNMENT_RECRUITER: "Old Recruiter",
    PAY_RATE: 45,
    SKU_NUMBER: "9999",
  };
  const out = applyManualColumnsCarryForward(incoming, baseline);
  assert.equal(out.row.PLACEMENT_STATUS, "ENDED");
  assert.equal(out.row.ASSIGNMENT_RECRUITER, "New Recruiter");
  assert.equal(out.row.PAY_RATE, 50);
  assert.equal(out.row.SKU_NUMBER, "9999");
  assert.equal(out.carriedCount, 1);
});

test("applyManualColumnsCarryForward: does not carry system-controlled columns from baseline", () => {
  const incoming = {
    PLACEMENT_STATUS: "ENDED",
    ID: "incoming-uuid",
    DATE_AND_TIME: "2026-05-26T00:00:00Z",
    IS_REJECTED: "False",
    MOVE_RUNRATE: "FALSE",
  };
  const baseline = {
    PLACEMENT_STATUS: "STARTED",
    ID: "baseline-uuid",
    DATE_AND_TIME: "2026-05-01T00:00:00Z",
    IS_REJECTED: "True",
    MOVE_RUNRATE: "TRUE",
  };
  const out = applyManualColumnsCarryForward(incoming, baseline);
  assert.equal(out.row.ID, "incoming-uuid");
  assert.equal(out.row.DATE_AND_TIME, "2026-05-26T00:00:00Z");
  assert.equal(out.row.IS_REJECTED, "False");
  assert.equal(out.row.MOVE_RUNRATE, "FALSE");
  assert.equal(out.carriedCount, 0);
});

test("applyManualColumnsCarryForward: null baseline returns incoming unchanged with carriedCount=0", () => {
  const incoming = { PLACEMENT_STATUS: "ENDED", SKU_NUMBER: null };
  const out = applyManualColumnsCarryForward(incoming, null);
  assert.equal(out.row, incoming);
  assert.equal(out.carriedCount, 0);
});
