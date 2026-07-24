const test = require("node:test");
const assert = require("node:assert/strict");

const { mapDealSheetUsersToBq } = require("./columnMappings");
const {
  applyPreviousRecruiterFillForInsertRows,
  applyPreviousRecruiterOnRecruiterChange,
} = require("./bigQueryClient");

const currentRecruiterUser = { id: 561722, first_name: "Sonam", last_name: "Chaudhary (R4A)", email: "sonam.c@cynethealth.com" };
const submittalWithDifferentRecruiter = {
  recruiter: { id: 256183, first_name: "Shim", last_name: "Kashung (R2N)", email: "shim.k@cynethealth.com" },
  sales_rep: 2959734,
};

// ---------------------------------------------------------------------------
// Rule: ASSIGNMENT_RECRUITER is ALWAYS the deal-sheet's recruiter. The
// job-submittal recruiter is NEVER used to derive a PREVIOUS_RECRUITER — it is
// only a last-resort fallback for the ASSIGNMENT name when the user lookup is
// missing. A previous recruiter is recorded solely when the deal-sheet
// recruiter changes across an update-append (Mechanism B, tested below).
// ---------------------------------------------------------------------------

test("mapDealSheetUsersToBq: DEAL uses deal-sheet recruiter, never stashes previous from a differing submittal recruiter", () => {
  const out = mapDealSheetUsersToBq(
    { type: "DEAL", recruiter: 561722 },
    currentRecruiterUser,
    { first_name: "Elisa", last_name: "An", email: "elisa.a@cynethealth.com" },
    submittalWithDifferentRecruiter
  );
  assert.equal(out.ASSIGNMENT_RECRUITER, "Sonam Chaudhary (R4A)");
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, "sonam.c@cynethealth.com");
  // Nothing about the submittal recruiter leaks into a previous-recruiter field.
  assert.equal(out.__PREV_RECRUITER_NAME, undefined);
  assert.equal(out.__PREV_RECRUITER_EMAIL, undefined);
  assert.equal(out.PREVIOUS_RECRUITER_NAME, undefined);
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("mapDealSheetUsersToBq: falls back to submittal recruiter for ASSIGNMENT only when the user lookup is missing", () => {
  const out = mapDealSheetUsersToBq(
    { type: "DEAL", recruiter: 561722 },
    null, // no user lookup
    null,
    submittalWithDifferentRecruiter
  );
  assert.equal(out.ASSIGNMENT_RECRUITER, "Shim Kashung (R2N)");
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, "shim.k@cynethealth.com");
  assert.equal(out.__PREV_RECRUITER_EMAIL, undefined);
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("mapDealSheetUsersToBq: EXTENSION never stashes previous recruiter from submittal", () => {
  const out = mapDealSheetUsersToBq(
    { type: "EXTENSION", recruiter: 561722 },
    currentRecruiterUser,
    null,
    submittalWithDifferentRecruiter
  );
  assert.equal(out.ASSIGNMENT_RECRUITER, "Sonam Chaudhary (R4A)");
  assert.equal(out.__PREV_RECRUITER_NAME, undefined);
  assert.equal(out.__PREV_RECRUITER_EMAIL, undefined);
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, undefined);
});

// ---------------------------------------------------------------------------
// Mechanism B — the ONLY source of a previous recruiter: the deal-sheet's
// recruiter actually changes between the baseline row and the incoming row.
// ---------------------------------------------------------------------------

test("applyPreviousRecruiterOnRecruiterChange: deal-sheet recruiter change -> outgoing recruiter becomes previous", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    {
      ASSIGNMENT_RECRUITER: "Sonam Chaudhary (R4A)",
      ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com",
      TENTATIVE_DATE: "2026-06-08",
    },
    {
      ASSIGNMENT_RECRUITER: "Shim Kashung (R2N)",
      ASSIGNMENT_RECRUITER_EMAIL: "shim.k@cynethealth.com",
      RECRUITER_EMP_NO: "CY1554",
    }
  );
  assert.equal(changed, true);
  assert.equal(row.PREVIOUS_RECRUITER_NAME, "Shim Kashung (R2N)");
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, "shim.k@cynethealth.com");
  assert.equal(row.PREVIOUS_RECRUITER_EMP_NO, "CY1554");
  // Current owner stays the new recruiter.
  assert.equal(row.ASSIGNMENT_RECRUITER_EMAIL, "sonam.c@cynethealth.com");
});

test("applyPreviousRecruiterOnRecruiterChange: same recruiter -> no previous, unchanged", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    { ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com" },
    { ASSIGNMENT_RECRUITER_EMAIL: "Sonam.C@cynethealth.com" } // case-insensitive match
  );
  assert.equal(changed, false);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("applyPreviousRecruiterOnRecruiterChange: no baseline recruiter (first insert) -> no previous", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    { ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com" },
    { ASSIGNMENT_RECRUITER_EMAIL: null }
  );
  assert.equal(changed, false);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
});

// ---------------------------------------------------------------------------
// applyPreviousRecruiterFillForInsertRows — fills the frozen manual column from
// a captured temp value (used by the EXTENSION legacy backfill path). Kept as-is.
// ---------------------------------------------------------------------------

test("applyPreviousRecruiterFillForInsertRows: fills PREVIOUS_RECRUITER when empty (existing deal backfill)", () => {
  const out = applyPreviousRecruiterFillForInsertRows([
    {
      DEAL_TYPE: "DEAL",
      PREVIOUS_RECRUITER_NAME: null,
      PREVIOUS_RECRUITER_EMAIL: null,
      PREVIOUS_RECRUITER_EMP_NO: null,
      __PREV_RECRUITER_NAME: "Shim Kashung (R2N)",
      __PREV_RECRUITER_EMAIL: "shim.k@cynethealth.com",
      __PREV_RECRUITER_EMP_NO: "CY1554",
    },
  ]);
  assert.equal(out[0].PREVIOUS_RECRUITER_NAME, "Shim Kashung (R2N)");
  assert.equal(out[0].PREVIOUS_RECRUITER_EMAIL, "shim.k@cynethealth.com");
  assert.equal(out[0].PREVIOUS_RECRUITER_EMP_NO, "CY1554");
});

test("applyPreviousRecruiterFillForInsertRows: never overwrites an already-set PREVIOUS_RECRUITER (frozen)", () => {
  const out = applyPreviousRecruiterFillForInsertRows([
    {
      PREVIOUS_RECRUITER_EMAIL: "already.set@cynethealth.com",
      PREVIOUS_RECRUITER_NAME: "Already Set",
      __PREV_RECRUITER_EMAIL: "shim.k@cynethealth.com",
      __PREV_RECRUITER_NAME: "Shim Kashung (R2N)",
    },
  ]);
  assert.equal(out[0].PREVIOUS_RECRUITER_EMAIL, "already.set@cynethealth.com");
  assert.equal(out[0].PREVIOUS_RECRUITER_NAME, "Already Set");
});

test("applyPreviousRecruiterFillForInsertRows: no temp -> untouched", () => {
  const out = applyPreviousRecruiterFillForInsertRows([
    { DEAL_TYPE: "DEAL", PREVIOUS_RECRUITER_EMAIL: null },
  ]);
  assert.equal(out[0].PREVIOUS_RECRUITER_EMAIL, null);
});
