const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyExtensionLegacyPreviousRecruiterForInsertRows,
  rowNeedsExtensionLegacyPreviousRecruiter,
  chooseLegacyPreviousRecruiter,
  bqCellString,
} = require("./bigQueryClient");

// Legacy tracker rows for SKU H14218 (Recruiter handover Rashmi -> Neelesh).
const LEGACY_ROWS = [
  { sku: "H14218", new_emp: "CY1615", old_name: "Rashmi Lakhmani", old_emp: "CY3933", eff: "2026-05-10" },
];
const fakeQuery = async () => LEGACY_ROWS;
const fakeEmails = async (emps) => ({
  byEmp: new Map(emps.includes("CY3933") ? [["CY3933", "rashmi.l@cynethealth.com"]] : []),
  byName: new Map(),
});
const DEPS = { queryObjectsFn: fakeQuery, emailFetchFn: fakeEmails };

test("rowNeedsExtensionLegacyPreviousRecruiter: EXTENSION with SKU and empty PREVIOUS qualifies", () => {
  const base = { DEAL_TYPE: "EXTENSION", SKU_NUMBER: "H14218" };
  assert.equal(rowNeedsExtensionLegacyPreviousRecruiter(base), true);
  assert.equal(rowNeedsExtensionLegacyPreviousRecruiter({ ...base, DEAL_TYPE: "DEAL" }), false);
  assert.equal(rowNeedsExtensionLegacyPreviousRecruiter({ ...base, SKU_NUMBER: null }), false);
  assert.equal(rowNeedsExtensionLegacyPreviousRecruiter({ ...base, PREVIOUS_RECRUITER_NAME: "X" }), false);
  assert.equal(rowNeedsExtensionLegacyPreviousRecruiter({ ...base, PREVIOUS_RECRUITER_EMAIL: "x@y.com" }), false);
});

test("fills PREVIOUS_RECRUITER from legacy tracker (NEW_EMP = current recruiter -> OLD is previous), email from directory", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      SKU_NUMBER: "H14218",
      RECRUITER_EMP_NO: "CY1615", // current recruiter Neelesh
      PREVIOUS_RECRUITER_NAME: null,
      PREVIOUS_RECRUITER_EMAIL: null,
    },
  ];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, DEPS);
  assert.equal(out.PREVIOUS_RECRUITER_NAME, "Rashmi Lakhmani");
  assert.equal(out.PREVIOUS_RECRUITER_EMP_NO, "CY3933");
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, "rashmi.l@cynethealth.com");
});

test("does not touch a row that already has PREVIOUS_RECRUITER (freeze-once-set)", async () => {
  const rows = [
    { DEAL_TYPE: "EXTENSION", SKU_NUMBER: "H14218", RECRUITER_EMP_NO: "CY1615", PREVIOUS_RECRUITER_NAME: "Someone", PREVIOUS_RECRUITER_EMAIL: "s@x.com" },
  ];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, DEPS);
  assert.equal(out.PREVIOUS_RECRUITER_NAME, "Someone");
});

test("DEAL rows are untouched (extension-only)", async () => {
  const rows = [{ DEAL_TYPE: "DEAL", SKU_NUMBER: "H14218", RECRUITER_EMP_NO: "CY1615" }];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, DEPS);
  assert.equal(out.PREVIOUS_RECRUITER_NAME ?? null, null);
});

test("no legacy match -> PREVIOUS_RECRUITER stays null", async () => {
  const rows = [{ DEAL_TYPE: "EXTENSION", SKU_NUMBER: "NOPE", RECRUITER_EMP_NO: "CY1615", PREVIOUS_RECRUITER_NAME: null, PREVIOUS_RECRUITER_EMAIL: null }];
  const deps = { queryObjectsFn: async () => [], emailFetchFn: fakeEmails };
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, deps);
  assert.equal(out.PREVIOUS_RECRUITER_NAME ?? null, null);
});

test("falls back to latest OWNERSHIP_EFFECTIVE_DATE when no NEW_EMP matches current recruiter", async () => {
  const rows = [
    { DEAL_TYPE: "EXTENSION", SKU_NUMBER: "H14218", RECRUITER_EMP_NO: "CY9999", PREVIOUS_RECRUITER_NAME: null, PREVIOUS_RECRUITER_EMAIL: null },
  ];
  const multi = async () => [
    { sku: "H14218", new_emp: "CY1615", old_name: "Rashmi Lakhmani", old_emp: "CY3933", eff: "2026-05-10" },
    { sku: "H14218", new_emp: "CY1111", old_name: "Older Person", old_emp: "CY0001", eff: "2025-01-01" },
  ];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, { queryObjectsFn: multi, emailFetchFn: fakeEmails });
  assert.equal(out.PREVIOUS_RECRUITER_NAME, "Rashmi Lakhmani"); // latest eff wins
  assert.equal(out.PREVIOUS_RECRUITER_EMP_NO, "CY3933");
});

// --- H13614: Neelesh current, future Aug-30 ownership still counts -> previous = Shim ---

const H13614_OWNERSHIP = [
  {
    sku: "H13614",
    new_emp: "CY1554",
    old_name: "Philaso Angkang",
    old_emp: "CY4380",
    eff: "2026-07-19",
  },
  {
    sku: "H13614",
    new_emp: "CY1615",
    old_name: "Shim Kashung",
    old_emp: "CY1554",
    eff: "2026-08-30", // future / Upcoming Extension — still counts
  },
];

test("chooseLegacyPreviousRecruiter H13614: NEW=Neelesh -> previous Shim (future eff counts)", () => {
  const chosen = chooseLegacyPreviousRecruiter(H13614_OWNERSHIP, "CY1615");
  assert.deepEqual(chosen, { name: "Shim Kashung", emp: "CY1554" });
});

test("H13614 apply: PREVIOUS_RECRUITER = Shim Kashung / CY1554", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      SKU_NUMBER: "H13614",
      RECRUITER_EMP_NO: "CY1615",
      PREVIOUS_RECRUITER_NAME: null,
      PREVIOUS_RECRUITER_EMAIL: null,
      PREVIOUS_RECRUITER_EMP_NO: null,
    },
  ];
  const deps = {
    queryObjectsFn: async () => H13614_OWNERSHIP,
    emailFetchFn: async (emps) => ({
      byEmp: new Map(emps.includes("CY1554") ? [["CY1554", "shim.k@cynethealth.com"]] : []),
      byName: new Map(),
    }),
  };
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, deps);
  assert.equal(out.PREVIOUS_RECRUITER_NAME, "Shim Kashung");
  assert.equal(out.PREVIOUS_RECRUITER_EMP_NO, "CY1554");
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, "shim.k@cynethealth.com");
});

test("case-insensitive emp match still picks Shim", () => {
  const chosen = chooseLegacyPreviousRecruiter(H13614_OWNERSHIP, "cy1615");
  assert.equal(chosen.emp, "CY1554");
  assert.equal(chosen.name, "Shim Kashung");
});

test("bqCellString handles {value} wrappers and alternate casing", () => {
  assert.equal(bqCellString({ sku: { value: "H13614" } }, "sku"), "H13614");
  assert.equal(bqCellString({ SKU: "H13614" }, "sku"), "H13614");
  assert.equal(bqCellString({ eff: { value: "2026-08-30" } }, "eff"), "2026-08-30");
});

test("H13614 apply still fills when BQ returns value wrappers + uppercase keys", async () => {
  const wrapped = [
    {
      SKU: { value: "H13614" },
      NEW_EMP: { value: "CY1554" },
      OLD_ONE: "Philaso Angkang",
      OLD_EMP: { value: "CY4380" },
      OWNERSHIP_EFFECTIVE_DATE: { value: "2026-07-19" },
    },
    {
      SKU: { value: "H13614" },
      NEW_EMP: { value: "CY1615" },
      OLD_ONE: "Shim Kashung",
      OLD_EMP: { value: "CY1554" },
      OWNERSHIP_EFFECTIVE_DATE: { value: "2026-08-30" },
    },
  ];
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      SKU_NUMBER: "H13614",
      RECRUITER_EMP_NO: "CY1615",
      PREVIOUS_RECRUITER_NAME: null,
      PREVIOUS_RECRUITER_EMAIL: null,
    },
  ];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, {
    queryObjectsFn: async () => wrapped,
    emailFetchFn: async () => ({ byEmp: new Map(), byName: new Map() }),
  });
  assert.equal(out.PREVIOUS_RECRUITER_NAME, "Shim Kashung");
  assert.equal(out.PREVIOUS_RECRUITER_EMP_NO, "CY1554");
});

test("ownership query failure is non-fatal (rows unchanged)", async () => {
  const rows = [
    {
      DEAL_TYPE: "EXTENSION",
      SKU_NUMBER: "H13614",
      RECRUITER_EMP_NO: "CY1615",
      PREVIOUS_RECRUITER_NAME: null,
      PREVIOUS_RECRUITER_EMAIL: null,
    },
  ];
  const [out] = await applyExtensionLegacyPreviousRecruiterForInsertRows(rows, {
    queryObjectsFn: async () => {
      throw new Error("permission denied");
    },
    emailFetchFn: fakeEmails,
  });
  assert.equal(out.PREVIOUS_RECRUITER_NAME ?? null, null);
});
