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

// Oct 2026 (all domains): a DID NOT ACCEPT row's START_DATE and OFFER_TIME_START_DATE come from the
// JOB API's start_date, read live; every other status takes OFFER_TIME_START_DATE from the submittal.
const { applyDidNotAcceptDateOverridesForRow, applyOfferTimeStartDateFreeze } = require("./bigQueryClient");
const { resolveStartAndOfferTimeDates } = require("./columnMappings");

test("DNA: START_DATE, OFFER_TIME_START_DATE and END_DATE come from the job", () => {
  assert.deepEqual(resolveStartAndOfferTimeDates("DID NOT ACCEPT", "2026-10-19", "2026-11-02"), {
    START_DATE: "2026-11-02",
    OFFER_TIME_START_DATE: "2026-11-02",
    END_DATE: "2026-11-02",
  });
});

test("DNA with no job start falls back to the submittal start", () => {
  assert.deepEqual(resolveStartAndOfferTimeDates("DID NOT ACCEPT", "2026-10-19", null), {
    START_DATE: "2026-10-19",
    OFFER_TIME_START_DATE: "2026-10-19",
    END_DATE: "2026-10-19",
  });
});

// Regression (2026-10-15, PLACEMENT_ID 1450020): submittal start 04-13, job start 04-27. START_DATE took
// the job's date but END_DATE was still the submittal's start, so DAYS_WORKED came out -14 and, being
// API-owned, appended a new row on every sync. The DNA END_DATE must reach the row before the derive.
test("DNA job/submittal start mismatch: END = START on the enriched row, DAYS_WORKED stays 0", () => {
  const SUB = { id: 1450020, start_date: "2026-04-13", end_date: null, organization_submittal_status: { code: "OFFER_REJECTED", submittal_status: "Offer Rejected" } };
  const JOB_ = { start_date: "2026-04-27", end_date: "2026-07-26" };
  const mapped = mapJobSubmittalToBq(SUB, JOB_);
  const dates = resolveStartAndOfferTimeDates(mapped.PLACEMENT_STATUS, mapped.START_DATE, JOB_.start_date);
  const row = { ...mapped, START_DATE: dates.START_DATE, ...("END_DATE" in dates ? { END_DATE: dates.END_DATE } : {}) };
  assert.equal(mapped.PLACEMENT_STATUS, "DID NOT ACCEPT");
  assert.equal(mapped.END_DATE, "2026-04-13"); // the submittal-based END_DATE that caused -14
  assert.equal(row.START_DATE, "2026-04-27");
  assert.equal(row.END_DATE, "2026-04-27");
  assert.equal(computeDerivedPlacementFields(row).DAYS_WORKED, 0);
});

test("every other status: START_DATE and OFFER_TIME_START_DATE from the submittal, not the job", () => {
  for (const status of ["OFFERED", "BOOKED", "STARTED", "ENDED", "ENDED<30", "DID NOT START"]) {
    const out = resolveStartAndOfferTimeDates(status, "2026-10-19", "2026-11-02");
    assert.deepEqual(out, {
      START_DATE: "2026-10-19",
      OFFER_TIME_START_DATE: "2026-10-19",
    }, status);
    assert.equal("END_DATE" in out, false, status);
  }
});

const DNA_DEAL = {
  DEAL_SHEET_ID: "5300001",
  PLACEMENT_ID: "1470179",
  DEAL_TYPE: "DEAL",
  PLACEMENT_STATUS: "DID NOT ACCEPT",
  START_DATE: "2026-11-02",
  END_DATE: "2027-01-16",
  TENTATIVE_END_DATE: "2027-01-16",
  INITIAL_START_DATE: "2026-10-19",
};

test("DNA DEAL: END_DATE and INITIAL_START_DATE follow START_DATE, tentative blank", () => {
  const out = applyDidNotAcceptDateOverridesForRow(DNA_DEAL);
  assert.equal(out.START_DATE, "2026-11-02");
  assert.equal(out.END_DATE, "2026-11-02");
  assert.equal(out.INITIAL_START_DATE, "2026-11-02");
  assert.equal(out.TENTATIVE_END_DATE, null);
});

test("DNA EXTENSION: END_DATE / EXTENSION_START_DATE follow START_DATE, INITIAL_START_DATE does not", () => {
  const ext = { ...DNA_DEAL, DEAL_TYPE: "EXTENSION", INITIAL_START_DATE: "2025-03-01", EXTENSION_START_DATE: "2026-10-19" };
  const out = applyDidNotAcceptDateOverridesForRow(ext);
  assert.equal(out.END_DATE, "2026-11-02");
  assert.equal(out.EXTENSION_START_DATE, "2026-11-02");
  assert.equal(out.INITIAL_START_DATE, "2025-03-01");
});

test("same rule for Canada / Locums rows", () => {
  for (const row of [{ ...DNA_DEAL, CLIENT_STATE: "ON" }, { ...DNA_DEAL, OFFERING: "LOCUMS" }]) {
    const out = applyDidNotAcceptDateOverridesForRow(row);
    assert.equal(out.END_DATE, "2026-11-02");
    assert.equal(out.INITIAL_START_DATE, "2026-11-02");
  }
});

test("non-DNA rows are untouched", () => {
  const row = { ...DNA_DEAL, PLACEMENT_STATUS: "STARTED" };
  assert.equal(applyDidNotAcceptDateOverridesForRow(row), row);
});

test("offer-time freeze: a stored value stays frozen while the status does not change", () => {
  const baseline = { PLACEMENT_STATUS: "BOOKED", OFFER_TIME_START_DATE: { value: "2026-10-19" } };
  const { row, frozen } = applyOfferTimeStartDateFreeze({ PLACEMENT_STATUS: "STARTED", OFFER_TIME_START_DATE: "2026-10-25" }, baseline);
  assert.equal(frozen, true);
  assert.deepEqual(row.OFFER_TIME_START_DATE, baseline.OFFER_TIME_START_DATE);
});

test("offer-time freeze: the update that TURNS the row DNA takes the job date once", () => {
  const baseline = { PLACEMENT_STATUS: "OFFERED", OFFER_TIME_START_DATE: { value: "2026-10-19" } };
  const { row, frozen } = applyOfferTimeStartDateFreeze({ PLACEMENT_STATUS: "DID NOT ACCEPT", OFFER_TIME_START_DATE: "2026-11-02" }, baseline);
  assert.equal(frozen, false);
  assert.equal(row.OFFER_TIME_START_DATE, "2026-11-02");
});

test("offer-time freeze: once stored as DNA it is frozen again, even if the job moves", () => {
  const baseline = { PLACEMENT_STATUS: "DID NOT ACCEPT", OFFER_TIME_START_DATE: { value: "2026-11-02" } };
  const { row, frozen } = applyOfferTimeStartDateFreeze({ PLACEMENT_STATUS: "DID NOT ACCEPT", OFFER_TIME_START_DATE: "2026-12-01" }, baseline);
  assert.equal(frozen, true);
  assert.deepEqual(row.OFFER_TIME_START_DATE, baseline.OFFER_TIME_START_DATE);
});
