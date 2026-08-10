const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeBqEndDateFromSubmittal,
  mapJobSubmittalToBq,
  computeDerivedPlacementFields,
} = require("./columnMappings");
const {
  applyDidNotAcceptDateOverrides,
  hasBusinessColumnChanges,
} = require("./bigQueryClient");

// Regression: placement 1458981 / deal sheet 5215316 (Kendra Wheeler, DID NOT ACCEPT) appended an
// identical row on every dealSheetSyncUpdateTrigger run. The job's start_date (2026-06-01, surfaced as
// OFFER_TIME_START_DATE) was pushed back on the submittal to 2026-06-15, and:
//   - START_DATE is submittal-first  -> 2026-06-15
//   - END_DATE for cancelled rows was job-first -> 2026-06-01  (the bug)
// so the enriched END_DATE never matched the stored END_DATE (which the insert pipeline forces to
// START_DATE), the change-gate reported a change on every run, and DAYS_WORKED came out as -14.
const JOB = { start_date: "2026-06-01", end_date: "2026-09-14" };
const SUBMITTAL = {
  id: 1458981,
  start_date: "2026-06-15",
  end_date: null,
  organization_submittal_status: { code: "OFFER_REJECTED" },
};

test("cancelled END_DATE uses the submittal start (same precedence as START_DATE) on a start-date pushback", () => {
  assert.equal(computeBqEndDateFromSubmittal(SUBMITTAL, JOB), "2026-06-15");
});

test("cancelled END_DATE equals the mapped START_DATE (never diverges from it)", () => {
  const mapped = mapJobSubmittalToBq(SUBMITTAL, JOB);
  assert.equal(mapped.START_DATE, "2026-06-15");
  assert.equal(mapped.END_DATE, mapped.START_DATE);
});

test("cancelled END_DATE still falls back to the job start when the submittal has none", () => {
  assert.equal(
    computeBqEndDateFromSubmittal({ ...SUBMITTAL, start_date: null }, JOB),
    "2026-06-01"
  );
  assert.equal(
    computeBqEndDateFromSubmittal({ ...SUBMITTAL, start_date: "   " }, JOB),
    "2026-06-01"
  );
});

test("DAYS_WORKED is 0 (not negative) for a DID NOT ACCEPT row after the pushback", () => {
  const mapped = mapJobSubmittalToBq(SUBMITTAL, JOB);
  const derived = computeDerivedPlacementFields({
    PLACEMENT_STATUS: "DID NOT ACCEPT",
    START_DATE: mapped.START_DATE,
    END_DATE: mapped.END_DATE,
  });
  assert.equal(derived.DAYS_WORKED, 0);
});

// The gate-level guard: even if the enriched END_DATE/TENTATIVE_END_DATE diverge again for any reason,
// pre-applying the override to the compare row must make the gate see no change vs the stored row.
test("gate sees no change once the DID NOT ACCEPT override is applied to the compare row", () => {
  const stored = {
    DEAL_SHEET_ID: "5215316",
    PLACEMENT_ID: "1458981",
    PLACEMENT_STATUS: "DID NOT ACCEPT",
    START_DATE: "2026-06-15",
    END_DATE: "2026-06-15",
    TENTATIVE_END_DATE: null,
    ASSIGNMENT_RECRUITER_EMAIL: "preety.n@cynethealth.com",
    CONTRACT_ID: "CHC2152",
  };
  // Enriched row as it arrives at the gate: pre-override END_DATE/TENTATIVE_END_DATE.
  const incoming = { ...stored, END_DATE: "2026-06-01", TENTATIVE_END_DATE: "2026-09-14", CONTRACT_ID: null };

  assert.equal(hasBusinessColumnChanges(incoming, stored, new Set()), true);

  const [compareRow] = applyDidNotAcceptDateOverrides([incoming]);
  assert.equal(hasBusinessColumnChanges(compareRow, stored, new Set()), false);
});
