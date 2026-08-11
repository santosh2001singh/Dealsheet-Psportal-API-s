const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDerivedPlacementFields,
  API_OWNED_COLUMNS,
} = require("./columnMappings");
const { sanitizeLocumsDealSheetRow } = require("./locumsDerivedPlacementFields");
const { sanitizeCanadaDealSheetRow } = require("./canadaDerivedPlacementFields");

/** Cynet Health row: a recruiter email that is neither locums nor canada. */
function healthRow(overrides) {
  return {
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com",
    PLACEMENT_TYPE: "CONTRACT",
    PAYMENT_TYPE: "W2",
    BILL_RATE: 100,
    PAY_RATE: 40,
    CLIENT_MSP_FEE: 0,
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 13,
    ...overrides,
  };
}

test("GROSS_MARGIN is FINAL_BILL_RATE - FINAL_PAY_RATE in the default branch", () => {
  const out = computeDerivedPlacementFields(healthRow());
  assert.equal(out.GROSS_MARGIN, Math.round((out.FINAL_BILL_RATE - out.FINAL_PAY_RATE) * 100) / 100);
});

test("GROSS_MARGIN is 0 for FT placements", () => {
  const out = computeDerivedPlacementFields(healthRow({ PLACEMENT_TYPE: "FT" }));
  assert.equal(out.GROSS_MARGIN, 0);
});

test("GROSS_MARGIN uses FINAL_COST for Cynet Locum dentists", () => {
  const out = computeDerivedPlacementFields(healthRow({
    PARENT_CLIENT_NAME: "Cynet Locum",
    SPECIALTY: "Dentist",
  }));
  assert.equal(out.GROSS_MARGIN, Math.round((out.FINAL_BILL_RATE - out.FINAL_COST) * 100) / 100);
});

test("Cynet Locum dentist branch wins over the missing-bill-rate guard", () => {
  // Sheet parity: branch order puts the dentist carve-out ahead of the NA/blank check, so a blank
  // bill rate yields a negative margin here rather than 0.
  const out = computeDerivedPlacementFields(healthRow({
    PARENT_CLIENT_NAME: "Cynet Locum",
    SPECIALTY: "DENTIST",
    BILL_RATE: null,
  }));
  assert.equal(out.FINAL_BILL_RATE, null);
  assert.equal(out.GROSS_MARGIN, -out.FINAL_COST);
  assert.ok(out.GROSS_MARGIN < 0);
});

test("GROSS_MARGIN is 0 when FINAL_BILL_RATE is missing or blank", () => {
  for (const billRate of [null, "", "NA"]) {
    const out = computeDerivedPlacementFields(healthRow({ BILL_RATE: billRate }));
    assert.equal(out.FINAL_BILL_RATE, null);
    assert.equal(out.GROSS_MARGIN, 0, `BILL_RATE=${JSON.stringify(billRate)}`);
  }
});

test("GROSS_MARGIN falls back to bill rate alone when pay rate is missing", () => {
  const out = computeDerivedPlacementFields(healthRow({ PAY_RATE: null }));
  assert.equal(out.FINAL_PAY_RATE, 0);
  assert.equal(out.GROSS_MARGIN, out.FINAL_BILL_RATE);
});

test("GROSS_MARGIN is API-owned", () => {
  assert.ok(API_OWNED_COLUMNS.has("GROSS_MARGIN"));
});

test("locums and canada rows never carry GROSS_MARGIN", () => {
  const locums = sanitizeLocumsDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynetlocums.com",
    GROSS_MARGIN: 12.5,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(locums, "GROSS_MARGIN"));

  const canada = sanitizeCanadaDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.ca",
    GROSS_MARGIN: 12.5,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(canada, "GROSS_MARGIN"));
});

test("locums and canada derived fields do not compute GROSS_MARGIN", () => {
  for (const email of ["recruiter@cynetlocums.com", "recruiter@cynethealth.ca"]) {
    const out = computeDerivedPlacementFields(healthRow({ ASSIGNMENT_RECRUITER_EMAIL: email }));
    assert.ok(!Object.prototype.hasOwnProperty.call(out, "GROSS_MARGIN"), email);
  }
});
