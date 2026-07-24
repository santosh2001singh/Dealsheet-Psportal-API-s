/**
 * Compute W2_PAY_RATE_NEW and chained FINAL_*_NEW / NEW_MARGIN fields.
 */

function toNumberOrZero(v) {
  if (v === "" || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  if (v == null || !Number.isFinite(v)) return v;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function normPlacementType(v) {
  return v == null ? "" : String(v).trim().toUpperCase();
}

/**
 * Parse BILLABLE_ORIENTATION percent string to fraction (e.g. "70.00%" -> 0.70).
 */
function parseBillableOrientationFraction(value) {
  if (value == null || String(value).trim() === "") return 0;
  const raw = String(value).trim().replace(/%/g, "");
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

/**
 * CA and AK use REGULAR_HOURS_1/2 vs schedule hours for the NEW-rate OT split.
 * All other states use the 40-hour weekly OT threshold.
 * @param {string|null|undefined} clientState
 * @returns {boolean}
 */
function usesRegularHoursOtSplit(clientState) {
  const s = clientState == null ? "" : String(clientState).trim().toUpperCase();
  return s === "CA" || s === "AK";
}

/**
 * @param {Record<string, *>} row Merged deal-sheet row before derived fields
 */
function computeW2PayRateNew(row) {
  const placement = normPlacementType(row?.PLACEMENT_TYPE);
  if (placement === "") return { W2_PAY_RATE_NEW: null };
  if (placement === "FT" || placement === "INTERNAL") return { W2_PAY_RATE_NEW: 0 };

  const useRegularHours = usesRegularHoursOtSplit(row?.CLIENT_STATE);

  const sh1 = toNumberOrZero(row?.SCHEDULE_HOURS_1);
  const sh2 = toNumberOrZero(row?.SCHEDULE_HOURS_2);
  const rh1 = toNumberOrZero(row?.REGULAR_HOURS_1);
  const rh2 = toNumberOrZero(row?.REGULAR_HOURS_2);
  const fwh = toNumberOrZero(row?.FIRST_WEEK_HOURS);
  const swh = toNumberOrZero(row?.SECOND_WEEK_HOURS);
  const pay = toNumberOrZero(row?.PAY_RATE);
  const ot = toNumberOrZero(row?.OT_RATE);
  const taxable = toNumberOrZero(row?.TOTAL_BONUS_TAXABLE);
  const nonTaxable = toNumberOrZero(row?.TOTAL_BONUS_NON_TAXABLE);
  const po = toNumberOrZero(row?.PO_HOURS);
  const orient = toNumberOrZero(row?.ORIENTATION_HOURS);

  const stateBranch = useRegularHours
    ? rh1 * fwh * pay
      + (sh1 - rh1) * ot * fwh
      + rh2 * swh * pay
      + (sh2 - rh2) * ot * swh
    : Math.min(sh1, 40) * fwh * pay
      + Math.max(sh1 - 40, 0) * ot * fwh
      + Math.min(sh2, 40) * swh * pay
      + Math.max(sh2 - 40, 0) * ot * swh;

  const numerator = 1.23 * stateBranch + (1.23 * taxable + nonTaxable);
  const denominator = po - orient;
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { W2_PAY_RATE_NEW: null };
  }

  const value = numerator / denominator;
  return { W2_PAY_RATE_NEW: Number.isFinite(value) ? value : null };
}

function computeFinalPayRateNew(row, w2PayRateNew) {
  if (w2PayRateNew === 0) return 0;
  if (w2PayRateNew == null) return null;

  const perDiem = toNumberOrZero(row?.WEEKLY_PER_DIEM_NON_TAXED);
  const fwh = toNumberOrZero(row?.FIRST_WEEK_HOURS);
  const swh = toNumberOrZero(row?.SECOND_WEEK_HOURS);
  const po = toNumberOrZero(row?.PO_HOURS);
  const orient = toNumberOrZero(row?.ORIENTATION_HOURS);
  const denom = po - orient;
  if (!Number.isFinite(denom) || denom === 0) return null;

  const value = (perDiem * (fwh + swh) * 1.09) / denom + w2PayRateNew;
  return Number.isFinite(value) ? value : null;
}

function computeFinalCostNew(row, finalPayRateNew) {
  if (finalPayRateNew == null) return null;

  const po = toNumberOrZero(row?.PO_HOURS);
  const orient = toNumberOrZero(row?.ORIENTATION_HOURS);
  const denom = po - orient;
  if (!Number.isFinite(denom) || denom === 0) return null;

  const value = finalPayRateNew + po / denom;
  return Number.isFinite(value) ? value : null;
}

function computeFinalBillRateNew(row) {
  const po = toNumberOrZero(row?.PO_HOURS);
  const orient = toNumberOrZero(row?.ORIENTATION_HOURS);
  const denom = po - orient;
  if (!Number.isFinite(denom) || denom === 0) return null;

  const br = toNumberOrZero(row?.BILL_RATE);
  const cot = toNumberOrZero(row?.CLIENT_OT_RATE);
  const fee = toNumberOrZero(row?.CLIENT_MSP_FEE);
  const sh1 = toNumberOrZero(row?.SCHEDULE_HOURS_1);
  const sh2 = toNumberOrZero(row?.SCHEDULE_HOURS_2);
  const rh1 = toNumberOrZero(row?.REGULAR_HOURS_1);
  const rh2 = toNumberOrZero(row?.REGULAR_HOURS_2);
  const fwh = toNumberOrZero(row?.FIRST_WEEK_HOURS);
  const swh = toNumberOrZero(row?.SECOND_WEEK_HOURS);

  const useRegularHours = usesRegularHoursOtSplit(row?.CLIENT_STATE);

  const gross = useRegularHours
    ? rh1 * fwh * br
      + (sh1 - rh1) * cot * fwh
      + rh2 * swh * br
      + (sh2 - rh2) * cot * swh
      - orient * br
    : po * br - br * orient;

  const value = (gross * (1 - fee)) / denom;
  return Number.isFinite(value) ? value : null;
}

function computeNewMargin(row, finalBillRateNew, finalCostNew) {
  if (finalBillRateNew == null) return null;
  if (finalCostNew == null) return null;

  const po = toNumberOrZero(row?.PO_HOURS);
  if (po === 0) return null;

  const hrs = toNumberOrZero(row?.BILLABLE_ORIENTATION_HRS);
  const pct = parseBillableOrientationFraction(row?.BILLABLE_ORIENTATION);
  const adjustment = (finalBillRateNew * hrs * (1 - pct)) / po;
  const value = finalBillRateNew - adjustment - finalCostNew;
  return Number.isFinite(value) ? value : null;
}

function computeNewRateFamily(row) {
  const { W2_PAY_RATE_NEW } = computeW2PayRateNew(row);
  const FINAL_PAY_RATE_NEW = computeFinalPayRateNew(row, W2_PAY_RATE_NEW);
  const FINAL_COST_NEW = computeFinalCostNew(row, FINAL_PAY_RATE_NEW);
  const FINAL_BILL_RATE_NEW = computeFinalBillRateNew(row);
  const NEW_MARGIN = computeNewMargin(row, FINAL_BILL_RATE_NEW, FINAL_COST_NEW);
  return {
    W2_PAY_RATE_NEW: round2(W2_PAY_RATE_NEW),
    FINAL_PAY_RATE_NEW: round2(FINAL_PAY_RATE_NEW),
    FINAL_COST_NEW: round2(FINAL_COST_NEW),
    FINAL_BILL_RATE_NEW: round2(FINAL_BILL_RATE_NEW),
    NEW_MARGIN: round2(NEW_MARGIN),
  };
}

module.exports = {
  usesRegularHoursOtSplit,
  computeW2PayRateNew,
  computeFinalPayRateNew,
  computeFinalCostNew,
  computeFinalBillRateNew,
  computeNewMargin,
  computeNewRateFamily,
  parseBillableOrientationFraction,
};
