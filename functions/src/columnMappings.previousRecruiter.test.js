const test = require("node:test");
const assert = require("node:assert/strict");

const { mapDealSheetUsersToBq } = require("./columnMappings");
const {
  applyPreviousRecruiterOnRecruiterChange,
  buildRecruiterHandoverOwnershipLogRows,
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
// Mechanism B — a deal-sheet recruiter change across an update-append. The
// outgoing recruiter is captured on the IN-MEMORY __PREV_RECRUITER_* temp
// fields only; PREVIOUS_RECRUITER_* is never written to the deal sheet.
// ---------------------------------------------------------------------------

test("applyPreviousRecruiterOnRecruiterChange: recruiter change captures outgoing recruiter on temp fields only", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    {
      ASSIGNMENT_RECRUITER: "Sonam Chaudhary (R4A)",
      ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com",
      TENTATIVE_END_DATE: "2026-06-08",
    },
    {
      ASSIGNMENT_RECRUITER: "Shim Kashung (R2N)",
      ASSIGNMENT_RECRUITER_EMAIL: "shim.k@cynethealth.com",
      RECRUITER_EMP_NO: "CY1554",
    }
  );
  assert.equal(changed, true);
  // In-memory only — feeds the ownership log.
  assert.equal(row.__PREV_RECRUITER_NAME, "Shim Kashung (R2N)");
  assert.equal(row.__PREV_RECRUITER_EMAIL, "shim.k@cynethealth.com");
  assert.equal(row.__PREV_RECRUITER_EMP_NO, "CY1554");
  // The deal-sheet columns stay untouched.
  assert.equal(row.PREVIOUS_RECRUITER_NAME, undefined);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
  assert.equal(row.PREVIOUS_RECRUITER_EMP_NO, undefined);
  // Current owner stays the new recruiter; effective date still stamped.
  assert.equal(row.ASSIGNMENT_RECRUITER_EMAIL, "sonam.c@cynethealth.com");
  assert.equal(row.OWNERSHIP_EFFECTIVE_DATE, "2026-06-09");
});

test("applyPreviousRecruiterOnRecruiterChange: same recruiter -> no capture, unchanged", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    { ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com" },
    { ASSIGNMENT_RECRUITER_EMAIL: "Sonam.C@cynethealth.com" } // case-insensitive match
  );
  assert.equal(changed, false);
  assert.equal(row.__PREV_RECRUITER_EMAIL, undefined);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
});

test("applyPreviousRecruiterOnRecruiterChange: no baseline recruiter (first insert) -> no capture", () => {
  const { row, changed } = applyPreviousRecruiterOnRecruiterChange(
    { ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com" },
    { ASSIGNMENT_RECRUITER_EMAIL: null }
  );
  assert.equal(changed, false);
  assert.equal(row.__PREV_RECRUITER_EMAIL, undefined);
  assert.equal(row.PREVIOUS_RECRUITER_EMAIL, undefined);
});

// ---------------------------------------------------------------------------
// The ownership log still fires on a handover — now sourced from the in-memory
// temp fields rather than the (removed) PREVIOUS_RECRUITER_EMAIL column.
// ---------------------------------------------------------------------------

test("buildRecruiterHandoverOwnershipLogRows: builds RECRUITER row from __PREV_RECRUITER_* temp fields", async () => {
  const rows = await buildRecruiterHandoverOwnershipLogRows(
    [
      {
        DEAL_TYPE: "DEAL",
        PLACEMENT_ID: "1452278",
        ASSIGNMENT_RECRUITER: "Sonam Chaudhary (R4A)",
        ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com",
        RECRUITER_EMP_NO: "CY9001",
        __PREV_RECRUITER_NAME: "Shim Kashung (R2N)",
        __PREV_RECRUITER_EMAIL: "shim.k@cynethealth.com",
        __PREV_RECRUITER_EMP_NO: "CY1554",
      },
    ],
    {
      directoryFetchFn: async () => new Map(),
      hierarchyFetchFn: async () => new Map(),
    }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].OWNERSHIP_ROLE, "RECRUITER");
  assert.equal(rows[0].PREVIOUS_OWNER_NAME, "Shim Kashung (R2N)");
  assert.equal(rows[0].PREVIOUS_OWNER_EMP_NO, "CY1554");
  assert.equal(rows[0].NEW_OWNER_NAME, "Sonam Chaudhary (R4A)");
  assert.equal(rows[0].NEW_OWNER_EMP_NO, "CY9001");
});

test("buildRecruiterHandoverOwnershipLogRows: a stale PREVIOUS_RECRUITER_EMAIL column is ignored", async () => {
  const rows = await buildRecruiterHandoverOwnershipLogRows(
    [
      {
        DEAL_TYPE: "DEAL",
        ASSIGNMENT_RECRUITER_EMAIL: "sonam.c@cynethealth.com",
        // Left over on an old row; no temp field -> no handover log.
        PREVIOUS_RECRUITER_EMAIL: "shim.k@cynethealth.com",
      },
    ],
    {
      directoryFetchFn: async () => new Map(),
      hierarchyFetchFn: async () => new Map(),
    }
  );
  assert.equal(rows.length, 0);
});
