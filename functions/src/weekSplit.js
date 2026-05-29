/**
 * Compute FIRST_WEEK_HOURS and SECOND_WEEK_HOURS from INITIAL_PROJECT_DURATION_IN_WEEKS
 * and SCHEDULE_HOURS_1 / SCHEDULE_HOURS_2.
 */

function toNumberOrZero(v) {
  if (v === "" || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Split project duration in weeks across first/second week buckets.
 * @param {{ scheduleHours1?: *, scheduleHours2?: *, initialWeeks?: * }} params
 */
function computeWeekSplit({ scheduleHours1, scheduleHours2, initialWeeks }) {
  const sh2 = toNumberOrZero(scheduleHours2);
  const w = toNumberOrZero(initialWeeks);

  if (w <= 0) {
    return { FIRST_WEEK_HOURS: 0, SECOND_WEEK_HOURS: 0 };
  }

  if (sh2 > 0) {
    return {
      FIRST_WEEK_HOURS: Math.ceil(w / 2),
      SECOND_WEEK_HOURS: Math.floor(w / 2),
    };
  }

  return { FIRST_WEEK_HOURS: w, SECOND_WEEK_HOURS: 0 };
}

module.exports = { computeWeekSplit };
