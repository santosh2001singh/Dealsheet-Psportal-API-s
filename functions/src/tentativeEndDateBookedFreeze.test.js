const test = require("node:test");
const assert = require("node:assert/strict");

const { mapJobSubmittalToBq, resolveTentativeDateForPlacementRow } = require("./columnMappings");
const { applyTentativeDateFreeze, hasBusinessColumnChanges } = require("./bigQueryClient");
const { computeChangedFields } = require("./syncService");

// Business rule (Oct 2026): TENTATIVE_END_DATE is the SUBMITTAL's end_date. It follows the API while
// the placement is OFFERED / BOOKED / STARTED (a change there appends on its own), holds the last
// stored value at every other status, and is cleared at DID NOT START. END_DATE keeps its own
// submittal-based flow.

const JOB = { start_date: "2026-06-22", end_date: "2026-09-19" };
const submittal = (code, endDate = "2026-08-30") => ({
  id: 1,
  start_date: "2026-06-22",
  end_date: endDate,
  organization_submittal_status: { code },
});

test("source: TENTATIVE_END_DATE comes from the submittal end_date, not the job", () => {
  assert.equal(mapJobSubmittalToBq(submittal("BOOKED"), JOB).TENTATIVE_END_DATE, "2026-08-30");
});

test("source: falls back to job.end_date only when the submittal has none", () => {
  assert.equal(mapJobSubmittalToBq(submittal("BOOKED", null), JOB).TENTATIVE_END_DATE, "2026-09-19");
});

test("END_DATE flow is untouched: null while BOOKED/STARTED, submittal date once ENDED", () => {
  assert.equal(mapJobSubmittalToBq(submittal("BOOKED"), JOB).END_DATE, null);
  assert.equal(mapJobSubmittalToBq(submittal("ACTIVE"), JOB).END_DATE, null);
  assert.equal(mapJobSubmittalToBq(submittal("COMPLETED"), JOB).END_DATE, "2026-08-30");
  assert.equal(mapJobSubmittalToBq(submittal("EARLY_TERM"), JOB).END_DATE, "2026-08-30");
});

test("capture window: OFFERED, BOOKED and STARTED keep the API value when a baseline exists", () => {
  assert.equal(resolveTentativeDateForPlacementRow("OFFERED", "2026-08-30", true), "2026-08-30");
  assert.equal(resolveTentativeDateForPlacementRow("BOOKED", "2026-08-30", true), "2026-08-30");
  assert.equal(resolveTentativeDateForPlacementRow("STARTED", "2026-08-30", true), "2026-08-30");
});

test("capture window: held statuses drop the API value (freeze restores it)", () => {
  assert.equal(resolveTentativeDateForPlacementRow("ENDED", "2026-08-30", true), null);
  assert.equal(resolveTentativeDateForPlacementRow("DID NOT ACCEPT", "2026-08-30", true), null);
  assert.equal(resolveTentativeDateForPlacementRow("ENDED<30", "2026-08-30", true), null);
});

test("no baseline (BOOKED never observed): API value is kept so the column is not stuck null", () => {
  assert.equal(resolveTentativeDateForPlacementRow("STARTED", "2026-08-30", false), "2026-08-30");
  assert.equal(resolveTentativeDateForPlacementRow("ENDED", "2026-08-30", false), "2026-08-30");
});

test("DID NOT START always clears the tentative date", () => {
  assert.equal(resolveTentativeDateForPlacementRow("DID NOT START", "2026-08-30", true), null);
  assert.equal(resolveTentativeDateForPlacementRow("DID NOT START", "2026-08-30", false), null);
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "DID NOT START", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" },
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, null);
  assert.equal(out.frozen, false);
});

test("OFFERED is a soft capture: the API value still moves the stored date", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-09-05" },
    { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-09-05");
  assert.equal(out.frozen, false);
});

test("BOOKED with an empty baseline captures and becomes the frozen value", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" },
    { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: null }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30");
});

test("BOOKED and STARTED follow a later API change", () => {
  for (const status of ["BOOKED", "STARTED"]) {
    const out = applyTentativeDateFreeze(
      { PLACEMENT_STATUS: status, START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-10-31" },
      { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
    );
    assert.equal(out.row.TENTATIVE_END_DATE, "2026-10-31", status);
    assert.equal(out.frozen, false, status);
  }
});

test("live status with a blank API value keeps the stored date", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: null },
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30");
});

test("ENDED / ENDED<30 / DID NOT ACCEPT hold the stored value and ignore the API", () => {
  for (const status of ["ENDED", "ENDED<30", "DID NOT ACCEPT"]) {
    const out = applyTentativeDateFreeze(
      { PLACEMENT_STATUS: status, START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-07-10" },
      { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
    );
    assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30", status);
    assert.equal(out.frozen, true, status);
  }
});

test("held status with nothing stored captures the API value", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "ENDED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" },
    { PLACEMENT_STATUS: "ENDED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: null }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30");
});

test("no baseline row at all: incoming row passes through untouched", () => {
  const row = { PLACEMENT_STATUS: "BOOKED", TENTATIVE_END_DATE: "2026-08-30" };
  assert.equal(applyTentativeDateFreeze(row, null).row.TENTATIVE_END_DATE, "2026-08-30");
});

test("full lifecycle: OFFERED/BOOKED/STARTED follow the API, ENDED holds", () => {
  let stored = { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-06-01", TENTATIVE_END_DATE: null };
  const step = (status, startDate, apiTentative) => {
    stored = applyTentativeDateFreeze(
      { PLACEMENT_STATUS: status, START_DATE: startDate, TENTATIVE_END_DATE: apiTentative },
      stored
    ).row;
    return stored.TENTATIVE_END_DATE;
  };
  assert.equal(step("OFFERED", "2026-06-01", "2026-08-15"), "2026-08-15");
  assert.equal(step("BOOKED", "2026-06-01", "2026-08-30"), "2026-08-30");
  assert.equal(step("BOOKED", "2026-06-01", "2026-09-12"), "2026-09-12");
  assert.equal(step("STARTED", "2026-06-15", "2026-10-31"), "2026-10-31");
  assert.equal(step("ENDED", "2026-06-15", "2026-07-10"), "2026-10-31");
  assert.equal(step("ENDED", "2026-06-15", "2026-12-01"), "2026-10-31");
});

// Change-gate: TENTATIVE_END_DATE is a system column, but at a live status it appends on its own.
const IGNORE = ["ID", "LAST_UPDATED", "IS_REJECTED"];
const stored = {
  DEAL_SHEET_ID: "1",
  PLACEMENT_ID: "2",
  ASSIGNMENT_RECRUITER_EMAIL: "a@cynethealth.com",
  DEAL_TYPE: "DEAL",
  START_DATE: "2026-06-22",
  END_DATE: null,
  TENTATIVE_END_DATE: "2026-08-30",
};

test("gate: tentative end date change alone appends for OFFERED / BOOKED / STARTED", () => {
  for (const status of ["OFFERED", "BOOKED", "STARTED"]) {
    const base = { ...stored, PLACEMENT_STATUS: status };
    const incoming = { ...base, TENTATIVE_END_DATE: "2026-10-31" };
    assert.equal(hasBusinessColumnChanges(incoming, base, new Set(IGNORE)), true, status);
    assert.deepEqual(computeChangedFields(incoming, base, IGNORE), ["TENTATIVE_END_DATE"], status);
  }
});

test("gate: same tentative date or a blank API value is not a change", () => {
  const base = { ...stored, PLACEMENT_STATUS: "STARTED" };
  assert.equal(hasBusinessColumnChanges({ ...base }, base, new Set(IGNORE)), false);
  assert.equal(hasBusinessColumnChanges({ ...base, TENTATIVE_END_DATE: null }, base, new Set(IGNORE)), false);
});

test("gate: tentative end date change alone does not append for held statuses", () => {
  for (const status of ["ENDED", "ENDED<30", "DID NOT ACCEPT"]) {
    const base = { ...stored, PLACEMENT_STATUS: status, END_DATE: "2026-08-01" };
    const incoming = { ...base, TENTATIVE_END_DATE: "2026-10-31" };
    assert.equal(hasBusinessColumnChanges(incoming, base, new Set(IGNORE)), false, status);
    assert.deepEqual(computeChangedFields(incoming, base, IGNORE), [], status);
  }
});
