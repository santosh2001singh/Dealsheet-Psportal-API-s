const test = require("node:test");
const assert = require("node:assert/strict");

const { mapJobSubmittalToBq, resolveTentativeDateForPlacementRow } = require("./columnMappings");
const { applyTentativeDateFreeze } = require("./bigQueryClient");

// Business rule (Sep 2026): TENTATIVE_END_DATE is the SUBMITTAL's end_date, captured while the
// placement is OFFERED (soft) or BOOKED, then hard-frozen at BOOKED and never updated again —
// not even when START_DATE changes. END_DATE keeps its own submittal-based flow.

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

test("capture window: OFFERED and BOOKED keep the API value when a baseline exists", () => {
  assert.equal(resolveTentativeDateForPlacementRow("OFFERED", "2026-08-30", true), "2026-08-30");
  assert.equal(resolveTentativeDateForPlacementRow("BOOKED", "2026-08-30", true), "2026-08-30");
});

test("capture window: post-BOOKED statuses drop the API value (freeze restores it)", () => {
  assert.equal(resolveTentativeDateForPlacementRow("STARTED", "2026-08-30", true), null);
  assert.equal(resolveTentativeDateForPlacementRow("ENDED", "2026-08-30", true), null);
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

test("BOOKED value is frozen: a later API change does not move it", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-10-31" },
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30");
  assert.equal(out.frozen, true);
});

test("freeze survives a START_DATE change (the old rule released it here)", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-15", TENTATIVE_END_DATE: "2026-09-15" },
    { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-01", TENTATIVE_END_DATE: "2026-08-30" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30");
  assert.equal(out.frozen, true);
});

test("STARTED and ENDED carry the BOOKED-time frozen value", () => {
  for (const status of ["STARTED", "ENDED", "ENDED<30"]) {
    const out = applyTentativeDateFreeze(
      { PLACEMENT_STATUS: status, START_DATE: "2026-06-22", TENTATIVE_END_DATE: null },
      { PLACEMENT_STATUS: "BOOKED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" }
    );
    assert.equal(out.row.TENTATIVE_END_DATE, "2026-08-30", status);
    assert.equal(out.frozen, true, status);
  }
});

test("legacy rows keep their stored (job-sourced) value — no backfill", () => {
  const out = applyTentativeDateFreeze(
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-08-30" },
    { PLACEMENT_STATUS: "STARTED", START_DATE: "2026-06-22", TENTATIVE_END_DATE: "2026-09-19" }
  );
  assert.equal(out.row.TENTATIVE_END_DATE, "2026-09-19");
});

test("no baseline row at all: incoming row passes through untouched", () => {
  const row = { PLACEMENT_STATUS: "BOOKED", TENTATIVE_END_DATE: "2026-08-30" };
  assert.equal(applyTentativeDateFreeze(row, null).row.TENTATIVE_END_DATE, "2026-08-30");
});

test("full lifecycle: OFFERED moves, BOOKED pins, later statuses hold", () => {
  let stored = { PLACEMENT_STATUS: "OFFERED", START_DATE: "2026-06-01", TENTATIVE_END_DATE: null };
  const step = (status, startDate, apiTentative) => {
    stored = applyTentativeDateFreeze(
      { PLACEMENT_STATUS: status, START_DATE: startDate, TENTATIVE_END_DATE: apiTentative },
      stored
    ).row;
    return stored.TENTATIVE_END_DATE;
  };
  assert.equal(step("OFFERED", "2026-06-01", "2026-08-15"), "2026-08-15"); // soft capture
  assert.equal(step("OFFERED", "2026-06-01", "2026-08-20"), "2026-08-20"); // still moves
  assert.equal(step("BOOKED", "2026-06-01", "2026-08-30"), "2026-08-30");  // booked capture
  assert.equal(step("BOOKED", "2026-06-01", "2026-10-31"), "2026-08-30");  // pinned
  assert.equal(step("STARTED", "2026-06-15", "2026-10-31"), "2026-08-30"); // start pushback ignored
  assert.equal(step("ENDED", "2026-06-15", "2026-07-10"), "2026-08-30");   // ended: still pinned
});
