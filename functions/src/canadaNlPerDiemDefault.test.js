const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CANADA_NL_DEFAULT_WEEKLY_PER_DIEM,
  CANADA_NL_PER_DIEM_DEFAULTED_FLAG,
  applyCanadaNlDefaultPerDiem,
  applyCanadaNlPerDiemCarryForward,
  computeCanadaDerivedPlacementFields,
} = require("./canadaDerivedPlacementFields");
const { hasBusinessColumnChanges, applyManualColumnsCarryForward } = require("./bigQueryClient");
const { computeChangedFields } = require("./syncService");

// SKU CH1423's shape: 57.70 * 1.213888 + 70 / 11.25 = 76.26, exactly the run-rate figure.
function nlRow(overrides = {}) {
  return {
    DEAL_SHEET_ID: 5000001,
    PLACEMENT_ID: 1400001,
    CLIENT_STATE: "NL",
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "T4",
    PAY_RATE: 57.7,
    SCHEDULE_HOURS_1: 36,
    PROJECT_DURATION: 13,
    ADDITIONAL_BONUS: 0,
    BILL_RATE: 100,
    CLIENT_MSP_FEE: 0,
    WEEKLY_PER_DIEM_NON_TAXED: 0,
    ...overrides,
  };
}

/** What the enricher produces: default first, then the derived step. */
function enrich(row) {
  const defaulted = applyCanadaNlDefaultPerDiem(row);
  return { ...defaulted, ...computeCanadaDerivedPlacementFields(defaulted) };
}

/** A stored row whose per diem a user changed on the dashboard (derived fields saved with it). */
function storedWithPerDiem(perDiem) {
  const row = nlRow({ WEEKLY_PER_DIEM_NON_TAXED: perDiem });
  return { ...row, ...computeCanadaDerivedPlacementFields(row) };
}

test("NL row with no Nexus per diem defaults to 70 and loads it into T4_PAY_RATE", () => {
  for (const nexus of [0, null, undefined, ""]) {
    const out = enrich(nlRow({ WEEKLY_PER_DIEM_NON_TAXED: nexus }));
    assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, CANADA_NL_DEFAULT_WEEKLY_PER_DIEM, String(nexus));
    assert.equal(out[CANADA_NL_PER_DIEM_DEFAULTED_FLAG], true);
    assert.equal(out.T4_PAY_RATE, 76.26);
  }
});

test("a real Nexus per diem on an NL row is kept and not flagged", () => {
  const out = enrich(nlRow({ WEEKLY_PER_DIEM_NON_TAXED: 112.5 }));
  assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, 112.5);
  assert.equal(out[CANADA_NL_PER_DIEM_DEFAULTED_FLAG], undefined);
});

test("other provinces and US health rows get no default", () => {
  for (const state of ["BC", "ON", "NS", "AB", "TX", "CA"]) {
    const row = nlRow({ CLIENT_STATE: state });
    assert.equal(applyCanadaNlDefaultPerDiem(row), row, state);
  }
});

test("a per diem the user edited survives the next sync and recomputes the chain", () => {
  const incoming = enrich(nlRow());
  const out = applyCanadaNlPerDiemCarryForward(incoming, storedWithPerDiem(50));
  assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, 50);
  // 57.70 * 1.213888 + 50 / 11.25 = 74.49
  assert.equal(out.T4_PAY_RATE, 74.49);
  assert.equal(out.FINAL_PAY_RATE, 74.49);
  assert.equal(out.FINAL_COST, 76.72);
  assert.equal(out.CALCULATED_MARGIN, 23.28);
  assert.equal(out.GROSS_MARGIN, 25.51);
});

test("a typed 0 is a deliberate value and is kept too", () => {
  const out = applyCanadaNlPerDiemCarryForward(enrich(nlRow()), storedWithPerDiem(0));
  assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, 0);
  assert.equal(out.T4_PAY_RATE, 70.04);
});

test("the edited row reads as unchanged, so the sync does not append over it", () => {
  const incoming = enrich(nlRow());
  const stored = storedWithPerDiem(50);
  assert.equal(hasBusinessColumnChanges(incoming, stored, new Set()), false);
  assert.deepEqual(computeChangedFields(incoming, stored, []), []);
});

test("a genuine Nexus change still appends, carrying the edited per diem", () => {
  const incoming = enrich(nlRow({ PAY_RATE: 60 }));
  const stored = storedWithPerDiem(50);
  assert.equal(hasBusinessColumnChanges(incoming, stored, new Set()), true);
  const { row } = applyManualColumnsCarryForward(incoming, stored);
  assert.equal(row.WEEKLY_PER_DIEM_NON_TAXED, 50);
  // 60 * 1.213888 + 50 / 11.25 = 77.28
  assert.equal(row.T4_PAY_RATE, 77.28);
});

test("a real Nexus per diem wins over the stored value", () => {
  const incoming = enrich(nlRow({ WEEKLY_PER_DIEM_NON_TAXED: 90 }));
  const out = applyCanadaNlPerDiemCarryForward(incoming, storedWithPerDiem(50));
  assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, 90);
  assert.equal(hasBusinessColumnChanges(incoming, storedWithPerDiem(50), new Set()), true);
});

test("a row the derived step left blank stays blank", () => {
  const incoming = enrich(nlRow({ PAY_RATE: null }));
  assert.equal(incoming.T4_PAY_RATE, null);
  const out = applyCanadaNlPerDiemCarryForward(incoming, storedWithPerDiem(50));
  assert.equal(out.WEEKLY_PER_DIEM_NON_TAXED, 50);
  assert.equal(out.T4_PAY_RATE, null);
});
