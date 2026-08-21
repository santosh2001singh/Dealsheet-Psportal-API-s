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

test("locums rows never carry GROSS_MARGIN", () => {
  const locums = sanitizeLocumsDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynetlocums.com",
    GROSS_MARGIN: 12.5,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(locums, "GROSS_MARGIN"));
});

// Canada gained a real GROSS_MARGIN column in Aug 2026, so the sanitizer must let it through
// (it used to be stripped alongside the US-only rate family).
test("canada rows keep GROSS_MARGIN", () => {
  const canada = sanitizeCanadaDealSheetRow({
    CLIENT_STATE: "BC",
    GROSS_MARGIN: 12.5,
  });
  assert.equal(canada.GROSS_MARGIN, 12.5);
});

// Canada does not use net margin (bill - cost); the column is dropped from the canada tables, so a
// stray value must never reach BigQuery.
test("canada rows never carry NET_MARGIN or W2_PAY_RATE", () => {
  const canada = sanitizeCanadaDealSheetRow({
    CLIENT_STATE: "BC",
    NET_MARGIN: 4.57,
    W2_PAY_RATE: 60,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(canada, "NET_MARGIN"));
  assert.ok(!Object.prototype.hasOwnProperty.call(canada, "W2_PAY_RATE"));
});

// Hierarchy / cluster columns dropped from the canada tables must be stripped, or the insert fails.
test("canada rows strip the dropped hierarchy and cluster columns", () => {
  const canada = sanitizeCanadaDealSheetRow({
    CLIENT_STATE: "BC",
    AVP: "Someone",
    AVP_EMP_NO: "E123",
    CLIENT_OWNER: "Someone Else",
    ONSITE_CLIENT_OWNER: 1,
    CLUSTER_TYPE: "X",
    HOURLY_GP: 9.5,
    EXT_PENDING_ID: "P1",
  });
  for (const col of [
    "AVP", "AVP_EMP_NO", "CLIENT_OWNER", "ONSITE_CLIENT_OWNER",
    "CLUSTER_TYPE", "HOURLY_GP", "EXT_PENDING_ID",
  ]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(canada, col), col);
  }
});

// LINE_OF_BUSINESS and EXT_OR_REHIRE_BY_RMG hold real Canada data and are explicitly kept.
test("canada rows keep LINE_OF_BUSINESS and EXT_OR_REHIRE_BY_RMG", () => {
  const canada = sanitizeCanadaDealSheetRow({
    CLIENT_STATE: "BC",
    LINE_OF_BUSINESS: "Some MSP",
    EXT_OR_REHIRE_BY_RMG: "EXTENSION",
  });
  assert.equal(canada.LINE_OF_BUSINESS, "Some MSP");
  assert.equal(canada.EXT_OR_REHIRE_BY_RMG, "EXTENSION");
});

test("locums derived fields do not compute GROSS_MARGIN", () => {
  const out = computeDerivedPlacementFields(
    healthRow({ ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynetlocums.com" })
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "GROSS_MARGIN"));
});

// ---------------------------------------------------------------------------
// Canada margin shape (Aug 2026)
//
//   CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_PAY_RATE   (was MARGIN)
//   MARGIN            = API hourly_revenue, never derived here
//   GROSS_MARGIN      = real column, not computed by the derived step
//   NET_MARGIN        = not used in Canada at all
// ---------------------------------------------------------------------------

/** Canada row: identified by its Canadian province, not the recruiter's email domain. */
function canadaRow(overrides) {
  return {
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.com",
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "T4",
    CLIENT_STATE: "BC",
    BILL_RATE: 100,
    PAY_RATE: 40,
    CLIENT_MSP_FEE: 0,
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 13,
    ...overrides,
  };
}

test("canada CALCULATED_MARGIN is bill - cost, GROSS_MARGIN is bill - pay", () => {
  const out = computeDerivedPlacementFields(canadaRow());
  assert.ok(out.FINAL_BILL_RATE != null);
  assert.ok(out.FINAL_PAY_RATE != null);
  assert.ok(out.FINAL_COST != null);
  assert.equal(
    out.CALCULATED_MARGIN,
    Math.round((out.FINAL_BILL_RATE - out.FINAL_COST) * 100) / 100
  );
  assert.equal(
    out.GROSS_MARGIN,
    Math.round((out.FINAL_BILL_RATE - out.FINAL_PAY_RATE) * 100) / 100
  );
});

test("canada derived fields never emit MARGIN or NET_MARGIN", () => {
  const out = computeDerivedPlacementFields(canadaRow());
  // MARGIN carries Nexus hourly_revenue, so the derived step must leave it untouched.
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "MARGIN"));
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "NET_MARGIN"));
});

test("canada API hourly revenue in MARGIN survives the derived step", () => {
  const row = canadaRow({ MARGIN: 27.89 });
  const merged = { ...row, ...computeDerivedPlacementFields(row) };
  assert.equal(merged.MARGIN, 27.89);
});

test("canada CALCULATED_MARGIN is 0 for FT placements", () => {
  const out = computeDerivedPlacementFields(canadaRow({ PLACEMENT_TYPE: "FT" }));
  assert.equal(out.CALCULATED_MARGIN, 0);
});

test("canada still emits T4_PAY_RATE rather than W2_PAY_RATE", () => {
  const out = computeDerivedPlacementFields(canadaRow());
  assert.ok(Object.prototype.hasOwnProperty.call(out, "T4_PAY_RATE"));
  assert.ok(!Object.prototype.hasOwnProperty.call(out, "W2_PAY_RATE"));
});
