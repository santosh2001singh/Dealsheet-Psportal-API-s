const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyExtensionLegacyPreviousRecruiterForInsertRows,
  rowNeedsExtensionLegacyPreviousRecruiter,
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

test("falls back to latest EFFECTIVE_DATE when no NEW_EMP matches current recruiter", async () => {
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
