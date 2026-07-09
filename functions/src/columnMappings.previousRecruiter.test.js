const test = require("node:test");
const assert = require("node:assert/strict");

const { mapDealSheetUsersToBq } = require("./columnMappings");
const { applyPreviousRecruiterFillForInsertRows } = require("./bigQueryClient");

const currentRecruiterUser = { id: 561722, first_name: "Sonam", last_name: "Chaudhary (R4A)", email: "sonam.c@cynethealth.com" };
const submittalWithPrevRecruiter = {
  recruiter: { id: 256183, first_name: "Shim", last_name: "Kashung (R2N)", email: "shim.k@cynethealth.com" },
  sales_rep: 2959734,
};

test("mapDealSheetUsersToBq: DEAL handover stashes previous recruiter in temp fields, ASSIGNMENT stays current", () => {
  const out = mapDealSheetUsersToBq(
    { type: "DEAL", recruiter: 561722 },
    currentRecruiterUser,
    { first_name: "Elisa", last_name: "An", email: "elisa.a@cynethealth.com" },
    submittalWithPrevRecruiter
  );
  assert.equal(out.ASSIGNMENT_RECRUITER, "Sonam Chaudhary (R4A)");
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, "sonam.c@cynethealth.com");
  assert.equal(out.__PREV_RECRUITER_NAME, "Shim Kashung (R2N)");
  assert.equal(out.__PREV_RECRUITER_EMAIL, "shim.k@cynethealth.com");
  // Never sets the real (manual) column directly — that's filled when-empty later.
  assert.equal(out.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("mapDealSheetUsersToBq: no previous when submittal recruiter == current recruiter", () => {
  const out = mapDealSheetUsersToBq(
    { type: "DEAL", recruiter: 561722 },
    currentRecruiterUser,
    null,
    { recruiter: { id: 561722, first_name: "Sonam", last_name: "Chaudhary (R4A)", email: "sonam.c@cynethealth.com" } }
  );
  assert.equal(out.__PREV_RECRUITER_NAME, null);
  assert.equal(out.__PREV_RECRUITER_EMAIL, null);
});

test("mapDealSheetUsersToBq: EXTENSION never stashes previous recruiter from submittal", () => {
  const out = mapDealSheetUsersToBq(
    { type: "EXTENSION", recruiter: 561722 },
    currentRecruiterUser,
    null,
    submittalWithPrevRecruiter
  );
  assert.equal(out.__PREV_RECRUITER_NAME, null);
  assert.equal(out.__PREV_RECRUITER_EMAIL, null);
});

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
