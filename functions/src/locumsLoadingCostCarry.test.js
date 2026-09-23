const test = require("node:test");
const assert = require("node:assert/strict");

const {
  legacyCarryColumns,
  RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE,
} = require("./bigQueryClient");
const { computeLocumsDerivedPlacementFields } = require("./locumsDerivedPlacementFields");

/**
 * LOADING_COST_EXCEPTION is the one carried column that is an INPUT to the rate formulas rather
 * than an output. The enricher computes FINAL_PAY_RATE before the run-rate carry runs, so a row
 * that gains a loading fraction here still holds rates built from the 1.08 / 1.00 / 1.09 ladder —
 * applyLegacyContractIdentityToDealRows recomputes them. These assertions cover the contract that
 * makes that worth doing.
 */

const LOCUMS_RUNRATE = "all_locums_runrate";
const HEALTH_RUNRATE = "all_CH_data_runrate";

test("locums carries LOADING_COST_EXCEPTION off the matched run-rate row", () => {
  assert.ok(legacyCarryColumns(LOCUMS_RUNRATE).includes("LOADING_COST_EXCEPTION"));
  assert.ok(
    RUNRATE_EXTRA_MANUAL_COLUMNS_BY_TABLE.get(LOCUMS_RUNRATE).includes("LOADING_COST_EXCEPTION")
  );
});

test("health does not — its run-rate table has no such column", () => {
  assert.ok(!legacyCarryColumns(HEALTH_RUNRATE).includes("LOADING_COST_EXCEPTION"));
});

// --------------------------------------------------------------------------
// What the recompute is for: the same row, with and without a carried fraction.
// --------------------------------------------------------------------------

function locumsRow(overrides = {}) {
  return {
    ASSIGNMENT_RECRUITER_EMAIL: "selina.d@cynetlocums.com",
    PAY_RATE: 39,
    BILL_RATE: 53,
    CLIENT_MSP_FEE: 0.045,
    PAYMENT_TYPE: "1099",
    START_DATE: "2026-04-18",
    PLACEMENT_TYPE: "CT",
    SCHEDULE_HOURS_1: 36,
    PROJECT_DURATION: 13,
    ...overrides,
  };
}

test("without a loading fraction the row keeps the 1.09 ladder", () => {
  const out = computeLocumsDerivedPlacementFields(locumsRow());
  assert.equal(out.W2_PAY_RATE, 39);
  assert.equal(out.FINAL_PAY_RATE, 42.51); // 39 * 1.09
});

test("a carried 0.06 rebuilds the rate off (1 + fraction)", () => {
  // The live Sonia Johnson row: run-rate says 0.06, so 39 * 1.06 = 41.34, not 39 * 1.09 = 42.51.
  const out = computeLocumsDerivedPlacementFields(locumsRow({ LOADING_COST_EXCEPTION: 0.06 }));
  assert.equal(out.FINAL_PAY_RATE, 41.34);
  assert.equal(out.FINAL_COST, 41.34);
  // W2 and the bill side are upstream of the override and must not move.
  assert.equal(out.W2_PAY_RATE, 39);
  assert.equal(out.FINAL_BILL_RATE, 50.61); // 53 * (1 - 0.045)
  // ...so the margin moves with the cost.
  assert.equal(out.CALCULATED_MARGIN, 9.27);
});

test("recomputing is not a no-op — the two differ, which is why the carry has to trigger it", () => {
  const without = computeLocumsDerivedPlacementFields(locumsRow());
  const with006 = computeLocumsDerivedPlacementFields(locumsRow({ LOADING_COST_EXCEPTION: 0.06 }));
  assert.notEqual(without.FINAL_PAY_RATE, with006.FINAL_PAY_RATE);
  assert.notEqual(without.CALCULATED_MARGIN, with006.CALCULATED_MARGIN);
});

test("a blank carried value leaves the ladder alone", () => {
  for (const blank of [null, undefined, "", "   "]) {
    const row = locumsRow();
    if (blank !== undefined) row.LOADING_COST_EXCEPTION = blank;
    assert.equal(computeLocumsDerivedPlacementFields(row).FINAL_PAY_RATE, 42.51, String(blank));
  }
});

// --------------------------------------------------------------------------
// Cynet health must be untouched by every part of this change. Two independent guards keep it out
// of the recompute — the run-rate table's carry list, and the row's own recruiter email — so a
// health row cannot reach it even if one guard were ever loosened.
// --------------------------------------------------------------------------

test("health's carry list is byte-identical to the shared base", () => {
  // No extras, no removals: resolveRunrateTableIdForDealSheetTable hands health the plain list.
  assert.deepEqual(legacyCarryColumns(HEALTH_RUNRATE), legacyCarryColumns(undefined));
});

test("neither health nor canada carries any of the locums-only ops columns", () => {
  for (const table of [HEALTH_RUNRATE, "all_Health_Canada_data_Runrate"]) {
    const cols = legacyCarryColumns(table);
    for (const c of ["LOADING_COST_EXCEPTION", "DIRECT_MANAGER", "CREDENTIALED_DATE", "SHIFTS"]) {
      assert.ok(!cols.includes(c), `${table} must not carry ${c}`);
    }
  }
});

test("the recompute's table guard is false for every non-locums run-rate table", () => {
  // Mirrors `locumsLoadingCarried` in applyLegacyContractIdentityToDealRows.
  for (const table of [HEALTH_RUNRATE, "all_Health_Canada_data_Runrate", undefined, "some_future_table"]) {
    assert.equal(
      legacyCarryColumns(table).includes("LOADING_COST_EXCEPTION"),
      false,
      String(table)
    );
  }
});

test("the recompute's recruiter guard rejects health and canada emails", () => {
  const { isCynetLocumsRecruiter } = require("./locumsDerivedPlacementFields");
  for (const email of ["a@cynethealth.com", "b@cynethealth.ca", "", null, undefined]) {
    assert.equal(isCynetLocumsRecruiter(email), false, String(email));
  }
  assert.equal(isCynetLocumsRecruiter("c@cynetlocums.com"), true);
});

test("a health row is never reshaped by the locums derivation", () => {
  // computeDerivedPlacementFields routes on the row itself, so even a direct call with a health
  // recruiter goes down health's own path and never emits the locums-only shape.
  const { computeDerivedPlacementFields } = require("./columnMappings");
  const out = computeDerivedPlacementFields({
    ASSIGNMENT_RECRUITER_EMAIL: "someone@cynethealth.com",
    PAY_RATE: 39,
    BILL_RATE: 53,
    PAYMENT_TYPE: "1099",
    START_DATE: "2026-04-18",
    PLACEMENT_TYPE: "CT",
    LOADING_COST_EXCEPTION: 0.06,
  });
  // The locums derivation stamps ENTITY and emits CALCULATED_MARGIN; health's does neither.
  assert.notEqual(out.ENTITY, "Locum");
  assert.equal("CALCULATED_MARGIN" in out, false);
});
