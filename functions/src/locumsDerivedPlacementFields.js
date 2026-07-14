/**
 * Locums (@cynetlocums.com) derived placement metrics from locumns deal sheet formulas.
 */

const DAYS_WORKED_ELIGIBLE_STATUSES = new Set([
  "ENDED",
  "ENDED<30",
  "DID NOT START",
  "DID NOT ACCEPT",
]);

const MAY_2024_UTC_MS = Date.UTC(2024, 4, 1);

/** ENTITY value stamped on all @cynetlocums.com deal sheet rows. */
const LOCUMS_ENTITY = "Locum";

function toNumberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function safeDivide(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function sumOrNull(values) {
  let total = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}

function normalizeMspFeeFraction(value) {
  const fee = toNumberOrNull(value);
  if (fee == null) return 0;
  let out = fee;
  if (out >= 1) out = out / 100;
  if (out < 0) out = 0;
  if (out > 1) out = 1;
  return out;
}

function parseYmdToUtcMs(value) {
  if (value == null || String(value).trim() === "") return null;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo, d);
  return Number.isFinite(ms) ? ms : null;
}

function dateDiffDaysEndMinusStart(startRaw, endRaw) {
  const startMs = parseYmdToUtcMs(startRaw);
  const endMs = parseYmdToUtcMs(endRaw);
  if (startMs == null || endMs == null) return null;
  return Math.floor((endMs - startMs) / 86400000);
}

function nexusBinaryFlagToBoolean(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 1) return true;
  if (v === 0) return false;
  if (v == null) return false;
  const s = String(v);
  if (s.length === 1) {
    const c = s.charCodeAt(0);
    if (c === 1) return true;
    if (c === 0) return false;
  }
  if (s.indexOf("\u0001") !== -1 || s.indexOf("\\x01") !== -1) return true;
  if (s.indexOf("\u0000") !== -1 || s.indexOf("\\x00") !== -1) return false;
  const low = s.trim().toLowerCase();
  if (low === "true" || low === "t" || low === "yes" || low === "1") return true;
  if (low === "false" || low === "f" || low === "no" || low === "0") return false;
  return false;
}

function isTypeBlank(row) {
  const typeVal = row?.TYPE;
  if (typeVal == null) return true;
  return String(typeVal).trim() === "";
}

function isGainwellException(row) {
  const entity = row?.ENTITY == null ? "" : String(row.ENTITY).trim();
  const parent = row?.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim();
  const position = row?.POSITION == null ? "" : String(row.POSITION).trim().toUpperCase();
  return entity === "" && parent === "Gainwell Technologies" && position !== "DENTIST";
}

function spanBase(scheduleHours1, initialWeeks) {
  return scheduleHours1 === 0 || initialWeeks === 0
    ? 40 * 13
    : scheduleHours1 * initialWeeks;
}

function ghBase(scheduleHours1) {
  return scheduleHours1 === 0 ? 40 : scheduleHours1;
}

/**
 * @param {unknown} email
 * @returns {boolean}
 */
function isCynetLocumsRecruiter(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase()
    .endsWith("@cynetlocums.com");
}

/**
 * Locums tax type from Nexus deal sheet ten_ninty_nine_checked.
 * true (1099) -> "1099"; false/null -> null (W2 path).
 * @param {Record<string, *>|null|undefined} dealSheet
 * @returns {string|null}
 */
function mapLocumsTypeFromTenNintyNine(dealSheet) {
  const is1099 = nexusBinaryFlagToBoolean(dealSheet?.ten_ninty_nine_checked);
  return is1099 ? "1099" : null;
}

function computeLocumsFinalBillRate(row) {
  const billRate = toNumberOrNull(row?.BILL_RATE);
  if (billRate == null || billRate === 0) return null;
  const mspFeeFraction = normalizeMspFeeFraction(row?.CLIENT_MSP_FEE);
  return round2(billRate * (1 - mspFeeFraction));
}

function computeLocumsW2PayRate(row, finalBillRate) {
  if (isGainwellException(row)) return finalBillRate;

  const payRate = toNumberOrNull(row?.PAY_RATE);
  if (payRate == null) return null;

  const weeklyPerDiem = toNumberOrNull(row?.WEEKLY_PER_DIEM_NON_TAXED) ?? 0;
  const weeklyWalletMoney = toNumberOrNull(row?.WEEKLY_WALLET_MONEY) ?? 0;
  const scheduleHours1 = toNumberOrNull(row?.SCHEDULE_HOURS_1) ?? 0;
  const additionalBonus = toNumberOrNull(row?.ADDITIONAL_BONUS) ?? 0;
  const orientationHours = toNumberOrNull(row?.ORIENTATION_HOURS) ?? 0;
  const initialWeeks = toNumberOrNull(row?.INITIAL_PROJECT_DURATION_IN_WEEKS) ?? 0;

  if (isTypeBlank(row)) {
    const gh = ghBase(scheduleHours1);
    const span = spanBase(scheduleHours1, initialWeeks);
    const perDiemTerm = safeDivide(weeklyPerDiem + weeklyWalletMoney * 1.14, gh);
    const bonusTerm = safeDivide(additionalBonus * 1.14, span);
    const orientationPayTerm = safeDivide(orientationHours * (payRate * 1.14), span);
    const orientationPerDiemTerm = scheduleHours1 === 0 || initialWeeks === 0
      ? safeDivide(
        orientationHours * (safeDivide(weeklyPerDiem, 40) ?? 0),
        (40 * 13) - 40
      )
      : safeDivide(
        orientationHours * (safeDivide(weeklyPerDiem, scheduleHours1 === 0 ? 1 : scheduleHours1) ?? 0),
        (scheduleHours1 * initialWeeks) - orientationHours
      );
    return round2(sumOrNull([
      payRate * 1.14,
      perDiemTerm,
      bonusTerm,
      orientationPayTerm,
      orientationPerDiemTerm,
    ]));
  }

  const gh = ghBase(scheduleHours1);
  const span = spanBase(scheduleHours1, initialWeeks);
  return round2(sumOrNull([
    payRate,
    safeDivide(weeklyPerDiem + weeklyWalletMoney, gh),
    safeDivide(additionalBonus, span),
    safeDivide(orientationHours * payRate, span),
  ]));
}

function isStartBeforeMay2024(startRaw) {
  const ms = parseYmdToUtcMs(startRaw);
  return ms != null && ms < MAY_2024_UTC_MS;
}

function computeLocumsFinalPayRate(row, w2PayRate, finalBillRate) {
  if (isGainwellException(row)) return finalBillRate;
  if (w2PayRate == null) return null;
  if (toNumberOrNull(row?.PAY_RATE) == null) return null;

  if (isTypeBlank(row)) return round2(w2PayRate * 1.08);
  if (isStartBeforeMay2024(row?.START_DATE)) return round2(w2PayRate);
  return round2(w2PayRate * 1.09);
}

function computeLocumsFinalCost(finalPayRate) {
  if (finalPayRate == null) return null;
  return round2(finalPayRate);
}

function computeLocumsNetMargin(row, finalBillRate, finalCost) {
  const placementType = row?.PLACEMENT_TYPE == null ? "" : String(row.PLACEMENT_TYPE).trim().toUpperCase();
  if (placementType === "FT") return 0;
  if (finalBillRate == null || finalBillRate === 0) return null;
  if (finalCost == null || finalCost === 0) return null;
  return round2(finalBillRate - finalCost);
}

function computeLocumsGrossMargin(row, finalBillRate, w2PayRate, finalPayRate) {
  const placementType = row?.PLACEMENT_TYPE == null ? "" : String(row.PLACEMENT_TYPE).trim().toUpperCase();
  if (placementType === "FT") return 0;
  if (finalBillRate == null || finalBillRate === 0) return null;

  if (isTypeBlank(row)) {
    if (w2PayRate == null) return null;
    return round2(finalBillRate - w2PayRate);
  }
  if (finalPayRate == null) return null;
  return round2(finalBillRate - finalPayRate);
}

function computeGmOt(row) {
  const otRate = toNumberOrNull(row?.OT_RATE);
  const clientOtRate = toNumberOrNull(row?.CLIENT_OT_RATE);
  const mspFeeFraction = normalizeMspFeeFraction(row?.CLIENT_MSP_FEE);
  if (otRate == null || otRate === 0) return null;
  if (clientOtRate != null && otRate * clientOtRate !== 0) {
    return round2(clientOtRate * (1 - mspFeeFraction) - (otRate * 1.15 + 1));
  }
  return null;
}

function computeDaysWorked(row) {
  const statusRaw = row?.PLACEMENT_STATUS == null
    ? ""
    : String(row.PLACEMENT_STATUS).trim().toUpperCase();
  if (!DAYS_WORKED_ELIGIBLE_STATUSES.has(statusRaw)) return 0;

  const endDateRaw = row?.END_DATE == null ? "" : String(row.END_DATE).trim();
  const startDateRaw = row?.START_DATE == null ? "" : String(row.START_DATE).trim();
  if (!endDateRaw || !startDateRaw) return 0;

  const diff = dateDiffDaysEndMinusStart(startDateRaw, endDateRaw);
  return diff == null ? 0 : diff;
}

function normPlacementType(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim().toUpperCase();
}

function isType1099(row) {
  const typeVal = row?.TYPE;
  if (typeVal == null) return false;
  const s = String(typeVal).trim();
  return s === "1099" || s === String(1099);
}

function isGainwellParentClient(row) {
  const parent = row?.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim();
  return parent === "Gainwell Technologies";
}

/**
 * Locumns FINAL_*_PAY_RATE burden on pay-side base rates (OT / Holiday / Call Back).
 * @param {Record<string, *>} row
 * @param {unknown} baseRateRaw
 * @returns {number|null}
 */
function computeLocumsBurdenedPremiumRate(row, baseRateRaw) {
  const placementType = normPlacementType(row?.PLACEMENT_TYPE);
  if (placementType == null) return null;
  if (placementType === "FT" || placementType === "INTERNAL") return null;

  const baseRate = toNumberOrNull(baseRateRaw);
  if (baseRate == null) return null;

  if (isType1099(row)) return round2(baseRate * 1.09);
  if (isGainwellParentClient(row)) return round2(baseRate * 1.23);
  return null;
}

function computeLocumsFinalOtPayRate(row) {
  return computeLocumsBurdenedPremiumRate(row, row?.OT_RATE);
}

function computeLocumsFinalHolidayPayRate(row) {
  return computeLocumsBurdenedPremiumRate(row, row?.HOLIDAY_RATE);
}

function computeLocumsFinalCallBackPayRate(row) {
  return computeLocumsBurdenedPremiumRate(row, row?.CALL_BACK_RATE);
}

/**
 * @param {Record<string, *>} row
 * @returns {Record<string, *>}
 */
function computeLocumsDerivedPlacementFields(row) {
  const finalBillRate = computeLocumsFinalBillRate(row);
  const w2PayRate = computeLocumsW2PayRate(row, finalBillRate);
  const finalPayRate = computeLocumsFinalPayRate(row, w2PayRate, finalBillRate);
  const finalCost = computeLocumsFinalCost(finalPayRate);

  return {
    W2_PAY_RATE: w2PayRate,
    FINAL_PAY_RATE: finalPayRate,
    FINAL_BILL_RATE: finalBillRate,
    FINAL_COST: finalCost,
    NET_MARGIN: computeLocumsNetMargin(row, finalBillRate, finalCost),
    GROSS_MARGIN: computeLocumsGrossMargin(row, finalBillRate, w2PayRate, finalPayRate),
    GM_OT: computeGmOt(row),
    DAYS_WORKED: computeDaysWorked(row),
    ENTITY: LOCUMS_ENTITY,
    FINAL_OT_PAY_RATE: computeLocumsFinalOtPayRate(row),
    FINAL_HOLIDAY_PAY_RATE: computeLocumsFinalHolidayPayRate(row),
    FINAL_CALL_BACK_PAY_RATE: computeLocumsFinalCallBackPayRate(row),
  };
}

/**
 * API-owned columns locums deal sheets do not use (stripped on insert; skipped on append compare).
 */
const LOCUMS_EXCLUDED_API_OWNED_COLUMNS = new Set([
  "W2_PAY_RATE_NEW",
  "FINAL_PAY_RATE_NEW",
  "FINAL_COST_NEW",
  "NEW_MARGIN",
  "FINAL_BILL_RATE_NEW",
  "FIRST_WEEK_HOURS",
  "SECOND_WEEK_HOURS",
  "TOTAL_BONUS_TAXABLE",
  "TOTAL_BONUS_NON_TAXABLE",
  "REGULAR_HOURS_1",
  "REGULAR_HOURS_2",
  "SCHEDULE_HOURS_2",
  "BILLABLE_ORIENTATION_HRS",
  "BILLABLE_ORIENTATION",
]);
Object.freeze(LOCUMS_EXCLUDED_API_OWNED_COLUMNS);

/**
 * @param {Record<string, *>|null|undefined} row
 * @returns {Record<string, *>|null|undefined}
 */
function sanitizeLocumsDealSheetRow(row) {
  if (!row || typeof row !== "object") return row;
  if (!isCynetLocumsRecruiter(row.ASSIGNMENT_RECRUITER_EMAIL)) return row;
  const out = { ...row };
  for (const key of LOCUMS_EXCLUDED_API_OWNED_COLUMNS) {
    delete out[key];
  }
  return out;
}

module.exports = {
  isCynetLocumsRecruiter,
  mapLocumsTypeFromTenNintyNine,
  computeLocumsDerivedPlacementFields,
  LOCUMS_ENTITY,
  LOCUMS_EXCLUDED_API_OWNED_COLUMNS,
  sanitizeLocumsDealSheetRow,
};
