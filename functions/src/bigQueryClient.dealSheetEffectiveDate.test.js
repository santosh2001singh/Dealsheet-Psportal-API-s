const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyPreviousRecruiterOnRecruiterChange,
  dealSheetEffectiveDateFromTentative,
  addOneDayToDateOnly,
} = require("./bigQueryClient");

test("dealSheetEffectiveDateFromTentative: TENTATIVE_END_DATE + 1 (matches ownership, not extension START)", () => {
  // Gabriel Tamayo case: TENTATIVE_END_DATE=2026-10-17 → ownership OWNERSHIP_EFFECTIVE_DATE=2026-10-18.
  // Must NOT become an older CONTRACT_ID extension START (e.g. 2024-07-08).
  assert.equal(dealSheetEffectiveDateFromTentative("2026-10-17"), "2026-10-18");
  assert.equal(addOneDayToDateOnly("2026-10-17"), "2026-10-18");
  assert.notEqual(dealSheetEffectiveDateFromTentative("2026-10-17"), "2024-07-08");
  assert.notEqual(dealSheetEffectiveDateFromTentative("2026-10-17"), "2026-07-19");
});

test("dealSheetEffectiveDateFromTentative: null/blank tentative → null", () => {
  assert.equal(dealSheetEffectiveDateFromTentative(null), null);
  assert.equal(dealSheetEffectiveDateFromTentative(""), null);
});

test("applyPreviousRecruiterOnRecruiterChange: stamps OWNERSHIP_EFFECTIVE_DATE = TENTATIVE_END_DATE + 1 (Gabriel-style)", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    {
      ASSIGNMENT_RECRUITER: "Srijana Chhetri (R1N)",
      ASSIGNMENT_RECRUITER_EMAIL: "srijana.c@cynethealth.com",
      RECRUITER_EMP_NO: "CY2365",
      TENTATIVE_END_DATE: "2026-10-17",
      OWNERSHIP_EFFECTIVE_DATE: null,
    },
    {
      ASSIGNMENT_RECRUITER: "Kumkum Belwal (R5N)",
      ASSIGNMENT_RECRUITER_EMAIL: "kumkum.b@cynethealth.com",
      RECRUITER_EMP_NO: "CY4006",
      TENTATIVE_END_DATE: "2026-10-17",
      OWNERSHIP_EFFECTIVE_DATE: null,
    }
  );
  assert.equal(changed, true);
  // Captured in memory for the ownership log; not written to the deal sheet.
  assert.equal(row.__PREV_RECRUITER_EMAIL, "kumkum.b@cynethealth.com");
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
  assert.equal(row.OWNERSHIP_EFFECTIVE_DATE, "2026-10-18");
});
