const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  isCynetHealthCanadaRecruiter,
  computeCanadaT4PayRate,
  computeCanadaDerivedPlacementFields,
  sanitizeCanadaDealSheetRow,
  pickCanadaDealSheetHoursPart,
} = require("./canadaDerivedPlacementFields");
const { computeDerivedPlacementFields } = require("./columnMappings");

const canadaBase = {
  ASSIGNMENT_RECRUITER_EMAIL: "recruiter@cynethealth.ca",
  PAY_RATE: 50,
  TYPE: "T4",
  SCHEDULE_HOURS_1: 40,
  INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
  ADDITIONAL_BONUS: 500,
  WEEKLY_PER_DIEM_NON_TAXED: 1000,
  BILL_RATE: 100,
  CLIENT_MSP_FEE: 0.1,
  PLACEMENT_TYPE: "CT",
};

test("isCynetHealthCanadaRecruiter matches @cynethealth.ca", () => {
  assert.equal(isCynetHealthCanadaRecruiter("x@CynetHealth.CA"), true);
  assert.equal(isCynetHealthCanadaRecruiter("x@cynethealth.com"), false);
  assert.equal(isCynetHealthCanadaRecruiter(null), false);
});

test("computeCanadaT4PayRate returns null when PLACEMENT_TYPE is null", () => {
  assert.equal(computeCanadaT4PayRate({ ...canadaBase, PLACEMENT_TYPE: null }), null);
});

test("computeCanadaT4PayRate returns 0 for FT and INTERNAL", () => {
  assert.equal(computeCanadaT4PayRate({ ...canadaBase, PLACEMENT_TYPE: "FT" }), 0);
  assert.equal(computeCanadaT4PayRate({ ...canadaBase, PLACEMENT_TYPE: "internal" }), 0);
});

test("computeCanadaT4PayRate returns null when guaranteed hours * weeks is zero", () => {
  assert.equal(
    computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NL", SCHEDULE_HOURS_1: 0 }),
    null
  );
});

test("computeCanadaT4PayRate null TYPE defaults to T4 multipliers", () => {
  const withType = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NS", TYPE: "T4" });
  const withoutType = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NS", TYPE: null });
  assert.equal(withoutType, withType);
});

test("computeCanadaT4PayRate NL T4 vs T4A produce different rates", () => {
  const t4 = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NL", TYPE: "T4" });
  const t4a = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NL", TYPE: "T4A" });
  assert.notEqual(t4, t4a);
  assert.ok(t4 > t4a);
});

test("computeCanadaT4PayRate NL T4 branch", () => {
  const out = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NL", TYPE: "T4" });
  const bonusTerm = 500 / (40 * 13);
  const expected = Math.round(
    ((50 * 1.04 + bonusTerm) * 1.1672 + 1000 / 11.25 + Number.EPSILON) * 100
  ) / 100;
  assert.equal(out, expected);
  assert.equal(out, 150.71);
});

test("computeCanadaT4PayRate NS T4A branch", () => {
  const out = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "NS", TYPE: "T4A" });
  const bonusTerm = 500 / (40 * 13);
  const expected = Math.round(((50 + bonusTerm) * 1.0195 + Number.EPSILON) * 100) / 100;
  assert.equal(out, expected);
});

test("computeCanadaT4PayRate BC T4 branch", () => {
  const out = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "BC", TYPE: "T4" });
  const bonusTerm = 500 / (40 * 13);
  const expected = Math.round(((50 + bonusTerm) * 1.2258 + Number.EPSILON) * 100) / 100;
  assert.equal(out, expected);
});

test("computeCanadaT4PayRate AB group T4 branch", () => {
  const out = computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "AB", TYPE: "T4" });
  const bonusTerm = 500 / (40 * 13);
  const expected = Math.round(((50 + bonusTerm) * 1.1818 + Number.EPSILON) * 100) / 100;
  assert.equal(out, expected);
});

test("computeCanadaT4PayRate unknown province returns null", () => {
  assert.equal(computeCanadaT4PayRate({ ...canadaBase, CLIENT_STATE: "ON" }), null);
});

test("computeCanadaDerivedPlacementFields chains FINAL_COST and margins", () => {
  const row = {
    ...canadaBase,
    CLIENT_STATE: "AB",
    OT_RATE: 75,
    CLIENT_OT_RATE: 130,
  };
  const out = computeCanadaDerivedPlacementFields(row);

  assert.equal(out.T4_PAY_RATE, out.FINAL_PAY_RATE);
  assert.equal(out.FINAL_BILL_RATE, 90);
  assert.equal(out.FINAL_COST, Math.round((out.FINAL_PAY_RATE * 1.03 + Number.EPSILON) * 100) / 100);
  assert.equal(out.NET_MARGIN, Math.round((90 - out.FINAL_COST + Number.EPSILON) * 100) / 100);
  assert.equal(
    out.GROSS_MARGIN,
    Math.round((90 - out.FINAL_PAY_RATE + Number.EPSILON) * 100) / 100
  );
  assert.equal(out.GM_OT, 29.75);
});

test("computeCanadaDerivedPlacementFields FT margins are zero", () => {
  const out = computeCanadaDerivedPlacementFields({
    ...canadaBase,
    CLIENT_STATE: "AB",
    PLACEMENT_TYPE: "FT",
  });
  assert.equal(out.T4_PAY_RATE, 0);
  assert.equal(out.FINAL_PAY_RATE, 0);
  assert.equal(out.NET_MARGIN, 0);
  assert.equal(out.GROSS_MARGIN, 0);
});

test("computeCanadaDerivedPlacementFields CLIENT_STATE CA uses numeric ENTITY for margins", () => {
  const out = computeCanadaDerivedPlacementFields({
    ...canadaBase,
    CLIENT_STATE: "CA",
    ENTITY: "12.5",
  });
  assert.equal(out.NET_MARGIN, 12.5);
  assert.equal(out.GROSS_MARGIN, 12.5);
});

test("pickCanadaDealSheetHoursPart keeps SCHEDULE_HOURS_1 and PO_HOURS only", () => {
  const out = pickCanadaDealSheetHoursPart({
    PO_HOURS: 160,
    SCHEDULE_HOURS_1: 40,
    SCHEDULE_HOURS_2: 48,
    REGULAR_HOURS_1: 36,
    REGULAR_HOURS_2: 40,
  });
  assert.deepEqual(out, { PO_HOURS: 160, SCHEDULE_HOURS_1: 40 });
});

test("sanitizeCanadaDealSheetRow removes US-only columns for @cynethealth.ca", () => {
  const out = sanitizeCanadaDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.ca",
    W2_PAY_RATE: 99,
    T4_PAY_RATE: 88,
    W2_PAY_RATE_NEW: 77,
    FINAL_PAY_RATE_NEW: 76,
    FINAL_COST_NEW: 75,
    NEW_MARGIN: 74,
    FINAL_BILL_RATE_NEW: 73,
    FIRST_WEEK_HOURS: 7,
    SECOND_WEEK_HOURS: 6,
    TOTAL_BONUS_TAXABLE: 500,
    TOTAL_BONUS_NON_TAXABLE: 1000,
    REGULAR_HOURS_1: 36,
    REGULAR_HOURS_2: 40,
    SCHEDULE_HOURS_2: 48,
    SCHEDULE_HOURS_1: 40,
  });
  assert.equal(Object.hasOwn(out, "W2_PAY_RATE"), false);
  assert.equal(Object.hasOwn(out, "W2_PAY_RATE_NEW"), false);
  assert.equal(Object.hasOwn(out, "FINAL_PAY_RATE_NEW"), false);
  assert.equal(Object.hasOwn(out, "FINAL_COST_NEW"), false);
  assert.equal(Object.hasOwn(out, "NEW_MARGIN"), false);
  assert.equal(Object.hasOwn(out, "FINAL_BILL_RATE_NEW"), false);
  assert.equal(Object.hasOwn(out, "FIRST_WEEK_HOURS"), false);
  assert.equal(Object.hasOwn(out, "SECOND_WEEK_HOURS"), false);
  assert.equal(Object.hasOwn(out, "TOTAL_BONUS_TAXABLE"), false);
  assert.equal(Object.hasOwn(out, "TOTAL_BONUS_NON_TAXABLE"), false);
  assert.equal(Object.hasOwn(out, "REGULAR_HOURS_1"), false);
  assert.equal(Object.hasOwn(out, "REGULAR_HOURS_2"), false);
  assert.equal(Object.hasOwn(out, "SCHEDULE_HOURS_2"), false);
  assert.equal(out.T4_PAY_RATE, 88);
  assert.equal(out.SCHEDULE_HOURS_1, 40);
});

test("sanitizeCanadaDealSheetRow keeps excluded columns for US recruiter", () => {
  const out = sanitizeCanadaDealSheetRow({
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com",
    W2_PAY_RATE: 99,
    W2_PAY_RATE_NEW: 77,
    NEW_MARGIN: 74,
    SCHEDULE_HOURS_2: 48,
    FIRST_WEEK_HOURS: 7,
  });
  assert.equal(out.W2_PAY_RATE, 99);
  assert.equal(out.W2_PAY_RATE_NEW, 77);
  assert.equal(out.NEW_MARGIN, 74);
  assert.equal(out.SCHEDULE_HOURS_2, 48);
  assert.equal(out.FIRST_WEEK_HOURS, 7);
});

test("computeDerivedPlacementFields routes Canada recruiter to T4_PAY_RATE", () => {
  const out = computeDerivedPlacementFields({
    ...canadaBase,
    CLIENT_STATE: "NS",
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.ca",
  });
  assert.equal(Object.hasOwn(out, "T4_PAY_RATE"), true);
  assert.equal(Object.hasOwn(out, "W2_PAY_RATE"), false);
  assert.equal(out.GROSS_MARGIN != null, true);
});

test("computeDerivedPlacementFields keeps US W2 path for .com recruiter", () => {
  const out = computeDerivedPlacementFields({
    ...canadaBase,
    CLIENT_STATE: "NS",
    ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com",
    TYPE: "SomeType",
    WEEKLY_WALLET_MONEY: 0,
    ORIENTATION_HOURS: 0,
  });
  assert.equal(Object.hasOwn(out, "W2_PAY_RATE"), true);
  assert.equal(Object.hasOwn(out, "T4_PAY_RATE"), false);
});
