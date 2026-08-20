const test = require("node:test");
const assert = require("node:assert/strict");

const { computeWeekSplit } = require("./weekSplit");

test("Kinta: 0 + 0.43 duration buckets are used as-is, not ceil/floor of days", () => {
  const out = computeWeekSplit({
    week1: 0,
    week2: 0.43,
    totalWeeks: 0.43,
    scheduleHours2: 48,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 0, SECOND_WEEK_HOURS: 0.43 });
});

test("Alexis: 7 + 6 duration buckets pass through", () => {
  const out = computeWeekSplit({
    week1: 7,
    week2: 6,
    totalWeeks: 13,
    scheduleHours2: 48,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 7, SECOND_WEEK_HOURS: 6 });
});

test("fallback dual schedule: both buckets 0 uses ceil/floor of total_weeks", () => {
  const out = computeWeekSplit({
    week1: 0,
    week2: 0,
    totalWeeks: 13,
    scheduleHours2: 48,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 7, SECOND_WEEK_HOURS: 6 });
});

test("fallback single schedule: both buckets 0 puts total_weeks in FIRST", () => {
  const out = computeWeekSplit({
    week1: 0,
    week2: 0,
    totalWeeks: 13,
    scheduleHours2: 0,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 13, SECOND_WEEK_HOURS: 0 });
});

test("both buckets 0 and total_weeks 0 yields zeros", () => {
  const out = computeWeekSplit({
    week1: 0,
    week2: 0,
    totalWeeks: 0,
    scheduleHours2: 48,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 0, SECOND_WEEK_HOURS: 0 });
});

test("null buckets fall back the same as zeros", () => {
  const out = computeWeekSplit({
    week1: null,
    week2: null,
    totalWeeks: 13,
    scheduleHours2: 48,
  });
  assert.deepEqual(out, { FIRST_WEEK_HOURS: 7, SECOND_WEEK_HOURS: 6 });
});
