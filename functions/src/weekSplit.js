/**
 * Compute FIRST_WEEK_HOURS and SECOND_WEEK_HOURS from Nexus week buckets.
 *
 * Prefer job_duration_1 / job_duration_2 (already in weeks). Fall back to
 * hours.total_weeks with the legacy ceil/floor split only when both buckets
 * are 0/null. 0 + 0.43 is valid and must not fall through.
 */

function toNumberOrZero(v) {
  if (v === "" || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function splitTotalWeeks(totalWeeks, scheduleHours2) {
  const w = toNumberOrZero(totalWeeks);
  if (w <= 0) {
    return { FIRST_WEEK_HOURS: 0, SECOND_WEEK_HOURS: 0 };
  }
  if (toNumberOrZero(scheduleHours2) > 0) {
    return {
      FIRST_WEEK_HOURS: Math.ceil(w / 2),
      SECOND_WEEK_HOURS: Math.floor(w / 2),
    };
  }
  return { FIRST_WEEK_HOURS: w, SECOND_WEEK_HOURS: 0 };
}

/**
 * @param {{ week1?: *, week2?: *, totalWeeks?: *, scheduleHours2?: * }} params
 */
function computeWeekSplit({ week1, week2, totalWeeks, scheduleHours2 } = {}) {
  const first = toNumberOrZero(week1);
  const second = toNumberOrZero(week2);
  if (first > 0 || second > 0) {
    return { FIRST_WEEK_HOURS: first, SECOND_WEEK_HOURS: second };
  }
  return splitTotalWeeks(totalWeeks, scheduleHours2);
}

module.exports = { computeWeekSplit };
