const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCanadaProvince,
  isCanadaDealSheetRow,
  CANADA_PROVINCES,
  CANADA_BURDEN_BY_PROVINCE,
  normPaymentTypeForBurden,
  resolveCanadaBurdenMultiplier,
  computeCanadaT4PayRate,
  computeCanadaDerivedPlacementFields,
} = require("./canadaDerivedPlacementFields");
const {
  resolveActiveDealSheetTableIdForRow,
  resolveEndedDealSheetTableIdForRow,
} = require("./recruiterDomainTables");

const ALL_PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "ON", "QC", "SK"];

// --------------------------------------------------------------------------
// Province set
// --------------------------------------------------------------------------

test("the nine Cynet Health Canada provinces are recognised", () => {
  assert.deepEqual(Object.keys(CANADA_PROVINCES).sort(), [...ALL_PROVINCES].sort());
  for (const p of ALL_PROVINCES) {
    assert.ok(isCanadaProvince(p), p);
    assert.ok(isCanadaProvince(p.toLowerCase()), `${p} lowercase`);
    assert.ok(isCanadaProvince(` ${p} `), `${p} padded`);
  }
});

test("US states and blanks are not Canada provinces", () => {
  // "CA" is California, not Canada — it must never be treated as a province.
  for (const s of ["CA", "AZ", "TX", "NY", "AK", "", null, undefined]) {
    assert.ok(!isCanadaProvince(s), String(s));
  }
});

// --------------------------------------------------------------------------
// Routing: CLIENT_STATE decides, not the recruiter email
// --------------------------------------------------------------------------

test("a Canadian province routes to the canada table whoever recruited it", () => {
  for (const p of ALL_PROVINCES) {
    for (const email of [
      "x@cynethealth.com", "x@cynethealth.ca", "x@cynetlocums.com", "", null,
    ]) {
      const row = { CLIENT_STATE: p, ASSIGNMENT_RECRUITER_EMAIL: email };
      assert.equal(
        resolveActiveDealSheetTableIdForRow(row),
        "cynet_health_canada_deal_sheet",
        `${p} / ${email}`
      );
      assert.equal(
        resolveEndedDealSheetTableIdForRow(row),
        "cynet_health_canada_ended_deal_sheet",
        `${p} / ${email} ended`
      );
    }
  }
});

test("a canada recruiter placing a US state does NOT land in the canada table", () => {
  // Real case: stella.s@cynethealth.ca with CLIENT_STATE=AZ. The Canada schema has no US rate
  // family, so the row belongs in health.
  const row = { CLIENT_STATE: "AZ", ASSIGNMENT_RECRUITER_EMAIL: "stella.s@cynethealth.ca" };
  assert.equal(resolveActiveDealSheetTableIdForRow(row), "cynet_health_deal_sheet");
  assert.equal(resolveEndedDealSheetTableIdForRow(row), "cynet_health_ended_deal_sheet");
});

test("a canada recruiter placing US locums business routes to locums", () => {
  const row = {
    CLIENT_STATE: "TX",
    ASSIGNMENT_RECRUITER_EMAIL: "x@cynethealth.ca",
    OFFERING: "LOCUMS",
  };
  assert.equal(resolveActiveDealSheetTableIdForRow(row), "cynet_locums_deal_sheet");
});

test("OFFERING=LOCUMS never pulls a Canadian province out of the canada table", () => {
  // Canada is a separate legal entity: the kind of work does not move the row.
  const row = {
    CLIENT_STATE: "ON",
    ASSIGNMENT_RECRUITER_EMAIL: "x@cynethealth.com",
    OFFERING: "LOCUMS",
  };
  assert.equal(resolveActiveDealSheetTableIdForRow(row), "cynet_health_canada_deal_sheet");
});

test("health routing is unchanged for US rows", () => {
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      CLIENT_STATE: "TX", ASSIGNMENT_RECRUITER_EMAIL: "x@cynethealth.com",
    }),
    "cynet_health_deal_sheet"
  );
  assert.equal(
    resolveActiveDealSheetTableIdForRow({
      CLIENT_STATE: "TX", ASSIGNMENT_RECRUITER_EMAIL: "x@cynetlocums.com",
    }),
    "cynet_locums_deal_sheet"
  );
});

test("isCanadaDealSheetRow keys on CLIENT_STATE only", () => {
  assert.ok(isCanadaDealSheetRow({ CLIENT_STATE: "NS" }));
  assert.ok(!isCanadaDealSheetRow({ ASSIGNMENT_RECRUITER_EMAIL: "x@cynethealth.ca" }));
  assert.ok(!isCanadaDealSheetRow({}));
  assert.ok(!isCanadaDealSheetRow(null));
});

// --------------------------------------------------------------------------
// Burden table vs Finance's 2026 figures
// --------------------------------------------------------------------------

test("T4 loading matches Finance's Final Loading Cost per province", () => {
  const expected = {
    ON: 1.2155, BC: 1.2258, NS: 1.2013, NL: 1.2072,
    AB: 1.1818, MB: 1.1818, SK: 1.1818, QC: 1.1818, NB: 1.1818,
  };
  for (const [p, mult] of Object.entries(expected)) {
    assert.equal(CANADA_BURDEN_BY_PROVINCE[p].t4, mult, p);
  }
});

test("T4A loading matches Finance's Final Corp Cost, null where no business", () => {
  const expected = {
    ON: 1.0337, BC: 1.0, NS: 1.0195, NL: 1.0254,
    AB: null, MB: null, SK: null, QC: null, NB: null,
  };
  for (const [p, mult] of Object.entries(expected)) {
    assert.equal(CANADA_BURDEN_BY_PROVINCE[p].t4a, mult, p);
  }
});

test("payment type normalises to the burden table's keys", () => {
  for (const v of ["T4", "t4", " T4 "]) assert.equal(normPaymentTypeForBurden(v), "T4");
  for (const v of ["T4A", "t4a", "Inc", "INC", "T4A/Inc"]) {
    assert.equal(normPaymentTypeForBurden(v), "T4A", v);
  }
  // Blank falls through to T4, matching the sheet's IF(TYPE="T4",...) default.
  for (const v of ["", null, undefined]) assert.equal(normPaymentTypeForBurden(v), "T4");
  assert.equal(normPaymentTypeForBurden("W2"), null);
});

test("no multiplier exists for a No-business province + T4A", () => {
  for (const p of ["AB", "MB", "SK", "QC", "NB"]) {
    assert.equal(resolveCanadaBurdenMultiplier(p, "T4A"), null, p);
    assert.equal(resolveCanadaBurdenMultiplier(p, "T4"), 1.1818, `${p} T4`);
  }
});

// --------------------------------------------------------------------------
// T4/T4A pay rate
// --------------------------------------------------------------------------

/** PAY_RATE 100, no bonus, so T4_PAY_RATE is exactly 100 x the burden multiplier. */
function payRow(overrides) {
  return {
    PLACEMENT_TYPE: "CT",
    PAYMENT_TYPE: "T4",
    PAY_RATE: 100,
    ADDITIONAL_BONUS: 0,
    SCHEDULE_HOURS_1: 40,
    PROJECT_DURATION: 13,
    ...overrides,
  };
}

test("T4 pay rate applies the province multiplier to the pay rate", () => {
  const expected = {
    ON: 121.55, BC: 122.58, NS: 120.13, NL: 120.72,
    AB: 118.18, MB: 118.18, SK: 118.18, QC: 118.18, NB: 118.18,
  };
  for (const [p, want] of Object.entries(expected)) {
    assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: p })), want, p);
  }
});

test("AB group does not double-count the 4% vacation", () => {
  // The old sheet formula was (PAY*1.04 + bonus)*1.1818 = 122.91, which double-counted vacation
  // already inside the 18.18%. Finance's figure is 18.18% flat.
  const out = computeCanadaT4PayRate(payRow({ CLIENT_STATE: "AB" }));
  assert.equal(out, 118.18);
  assert.notEqual(out, 122.91);
});

test("NL uses the flat 20.72% loading, not 1.04 x 1.1672", () => {
  const out = computeCanadaT4PayRate(payRow({ CLIENT_STATE: "NL" }));
  assert.equal(out, 120.72);
  assert.notEqual(out, 121.39);
});

test("NL alone adds the weekly per diem over 11.25 hours", () => {
  const withPerDiem = computeCanadaT4PayRate(
    payRow({ CLIENT_STATE: "NL", WEEKLY_PER_DIEM_NON_TAXED: 112.5 })
  );
  // 120.72 + 112.5/11.25 = 120.72 + 10 = 130.72
  assert.equal(withPerDiem, 130.72);

  // Every other province ignores per diem.
  const bc = computeCanadaT4PayRate(
    payRow({ CLIENT_STATE: "BC", WEEKLY_PER_DIEM_NON_TAXED: 112.5 })
  );
  assert.equal(bc, 122.58);
});

test("T4A pay rate uses the corp cost, and BC T4A adds nothing", () => {
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "BC", PAYMENT_TYPE: "T4A" })), 100);
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "ON", PAYMENT_TYPE: "T4A" })), 103.37);
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "NS", PAYMENT_TYPE: "T4A" })), 101.95);
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "NL", PAYMENT_TYPE: "T4A" })), 102.54);
});

test("a No-business province + T4A yields a blank pay rate, not a 1.0 multiplier", () => {
  for (const p of ["AB", "MB", "SK", "QC", "NB"]) {
    assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: p, PAYMENT_TYPE: "T4A" })), null, p);
  }
});

test("the additional bonus is spread over guaranteed hours x weeks", () => {
  // bonus 5200 / (40 * 13) = 10/hr, so BC gives (100 + 10) * 1.2258 = 134.84
  const out = computeCanadaT4PayRate(
    payRow({ CLIENT_STATE: "BC", ADDITIONAL_BONUS: 5200 })
  );
  assert.equal(out, 134.84);
});

test("INTERNAL and FT placements carry no hourly cost", () => {
  for (const t of ["INTERNAL", "FT"]) {
    assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "BC", PLACEMENT_TYPE: t })), 0, t);
  }
});

test("missing guaranteed hours or duration leaves the rate blank", () => {
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "BC", SCHEDULE_HOURS_1: 0 })), null);
  assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: "BC", PROJECT_DURATION: null })), null);
});

test("a non-Canada state leaves the rate blank", () => {
  for (const s of ["AZ", "TX", "CA"]) {
    assert.equal(computeCanadaT4PayRate(payRow({ CLIENT_STATE: s })), null, s);
  }
});

// --------------------------------------------------------------------------
// Downstream chain
// --------------------------------------------------------------------------

test("final cost, bill rate and both margins chain off the pay rate", () => {
  const out = computeCanadaDerivedPlacementFields(payRow({
    CLIENT_STATE: "BC",
    BILL_RATE: 200,
    CLIENT_MSP_FEE: 0,
  }));
  assert.equal(out.T4_PAY_RATE, 122.58);
  assert.equal(out.FINAL_PAY_RATE, 122.58);
  assert.equal(out.FINAL_COST, 126.26);          // 122.58 * 1.03
  assert.equal(out.FINAL_BILL_RATE, 200);
  assert.equal(out.CALCULATED_MARGIN, 73.74);    // 200 - 126.26
  assert.equal(out.GROSS_MARGIN, 77.42);         // 200 - 122.58
});

test("the MSP fee comes off the bill rate", () => {
  const out = computeCanadaDerivedPlacementFields(payRow({
    CLIENT_STATE: "ON",
    BILL_RATE: 200,
    CLIENT_MSP_FEE: 0.05,
  }));
  assert.equal(out.FINAL_BILL_RATE, 190);
});

test("FT placements zero both margins", () => {
  const out = computeCanadaDerivedPlacementFields(payRow({
    CLIENT_STATE: "BC",
    PLACEMENT_TYPE: "FT",
    BILL_RATE: 200,
  }));
  assert.equal(out.CALCULATED_MARGIN, 0);
  assert.equal(out.GROSS_MARGIN, 0);
});

test("a blank pay rate leaves the downstream chain blank", () => {
  const out = computeCanadaDerivedPlacementFields(payRow({
    CLIENT_STATE: "AB",
    PAYMENT_TYPE: "T4A",
    BILL_RATE: 200,
  }));
  assert.equal(out.T4_PAY_RATE, null);
  assert.equal(out.FINAL_PAY_RATE, null);
  assert.equal(out.FINAL_COST, null);
  assert.equal(out.CALCULATED_MARGIN, null);
  assert.equal(out.GROSS_MARGIN, null);
});
