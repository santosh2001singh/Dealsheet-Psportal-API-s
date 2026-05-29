const test = require("node:test");
const assert = require("node:assert/strict");

const { computeWeekSplit } = require("./weekSplit");

test("computeWeekSplit both schedules odd W=13 -> 7/6", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    scheduleHours2: 48,
    initialWeeks: 13,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 7);
  assert.equal(out.SECOND_WEEK_HOURS, 6);
});

test("computeWeekSplit both schedules even W=14 -> 7/7", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    scheduleHours2: 48,
    initialWeeks: 14,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 7);
  assert.equal(out.SECOND_WEEK_HOURS, 7);
});

test("computeWeekSplit both schedules even W=12 -> 6/6", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    scheduleHours2: 48,
    initialWeeks: 12,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 6);
  assert.equal(out.SECOND_WEEK_HOURS, 6);
});

test("computeWeekSplit only SH1 SH2=0 W=13 -> 13/0", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    scheduleHours2: 0,
    initialWeeks: 13,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 13);
  assert.equal(out.SECOND_WEEK_HOURS, 0);
});

test("computeWeekSplit only SH1 SH2 missing W=13 -> 13/0", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    initialWeeks: 13,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 13);
  assert.equal(out.SECOND_WEEK_HOURS, 0);
});

test("computeWeekSplit only SH1 SH2 blank/null W=13 -> 13/0", () => {
  assert.deepEqual(
    computeWeekSplit({ scheduleHours1: 36, scheduleHours2: "", initialWeeks: 13 }),
    { FIRST_WEEK_HOURS: 13, SECOND_WEEK_HOURS: 0 }
  );
  assert.deepEqual(
    computeWeekSplit({ scheduleHours1: 36, scheduleHours2: null, initialWeeks: 13 }),
    { FIRST_WEEK_HOURS: 13, SECOND_WEEK_HOURS: 0 }
  );
});

test("computeWeekSplit W null blank 0 negative -> 0/0", () => {
  const base = { scheduleHours1: 36, scheduleHours2: 48 };
  for (const w of [null, "", 0, -1]) {
    const out = computeWeekSplit({ ...base, initialWeeks: w });
    assert.equal(out.FIRST_WEEK_HOURS, 0, `W=${String(w)}`);
    assert.equal(out.SECOND_WEEK_HOURS, 0, `W=${String(w)}`);
  }
});

test("computeWeekSplit SH1=0 SH2=0 uses only-SH1 branch", () => {
  const out = computeWeekSplit({
    scheduleHours1: 0,
    scheduleHours2: 0,
    initialWeeks: 13,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 13);
  assert.equal(out.SECOND_WEEK_HOURS, 0);
});

test("computeWeekSplit non-numeric SH2 treated as 0 -> only-SH1 branch", () => {
  const out = computeWeekSplit({
    scheduleHours1: 36,
    scheduleHours2: "abc",
    initialWeeks: 13,
  });
  assert.equal(out.FIRST_WEEK_HOURS, 13);
  assert.equal(out.SECOND_WEEK_HOURS, 0);
});
