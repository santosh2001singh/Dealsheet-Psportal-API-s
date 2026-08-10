/**
 * Canada (@cynethealth.ca) derived placement metrics: T4/T4A pay rate and margins.
 */

const AB_GROUP_STATES = new Set(["AB", "NB", "SK", "QC", "MB"]);

const DAYS_WORKED_ELIGIBLE_STATUSES = new Set([
  "ENDED",
  "ENDED<30",
  "DID NOT START",
  "DID NOT ACCEPT",
]);

function toNumberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeMspFeeFraction(value) {
  const fee = toNumberOrNull(value);
  if (fee == null) return 0;
  let out = fee;
  if (out > 1) out = out / 100;
  if (out < 0) out = 0;
  if (out > 1) out = 1;
  return out;
}

function normPlacementType(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim().toUpperCase();
}

function normClientState(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim().toUpperCase();
}

function isT4Type(value) {
  if (value == null || String(value).trim() === "") return true;
  return String(value).trim().toUpperCase() === "T4";
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

/**
 * @param {unknown} email
 * @returns {boolean}
 */
function isCynetHealthCanadaRecruiter(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase()
    .endsWith("@cynethealth.ca");
}

/**
 * @param {Record<string, *>} row
 * @returns {number|null}
 */
function computeCanadaT4PayRate(row) {
  const placementType = normPlacementType(row?.PLACEMENT_TYPE);
  if (placementType == null) return null;
  if (placementType === "INTERNAL" || placementType === "FT") return 0;

  const payRate = toNumberOrNull(row?.PAY_RATE);
  if (payRate == null) return null;

  const guaranteedHours = toNumberOrNull(row?.SCHEDULE_HOURS_1);
  const initialWeeks = toNumberOrNull(row?.PROJECT_DURATION);
  if (
    guaranteedHours == null ||
    initialWeeks == null ||
    guaranteedHours === 0 ||
    initialWeeks === 0
  ) {
    return null;
  }

  const bonus = toNumberOrNull(row?.ADDITIONAL_BONUS) ?? 0;
  const perDiem = toNumberOrNull(row?.WEEKLY_PER_DIEM_NON_TAXED) ?? 0;
  const bonusTerm = bonus / (guaranteedHours * initialWeeks);
  const state = normClientState(row?.CLIENT_STATE);
  const t4Multiplier = isT4Type(row?.PAYMENT_TYPE);

  if (state === "NL") {
    const core = (payRate * 1.04 + bonusTerm) * (t4Multiplier ? 1.1672 : 1.0254);
    return round2(core + perDiem / 11.25);
  }
  if (state === "NS") {
    return round2((payRate + bonusTerm) * (t4Multiplier ? 1.2013 : 1.0195));
  }
  if (state === "BC") {
    return round2((payRate + bonusTerm) * (t4Multiplier ? 1.2258 : 1.044));
  }
  if (state != null && AB_GROUP_STATES.has(state)) {
    return round2((payRate + bonusTerm) * (t4Multiplier ? 1.1818 : 1.0));
  }
  return null;
}

function computeFinalBillRate(row) {
  const billRate = toNumberOrNull(row?.BILL_RATE);
  if (billRate == null || billRate === 0) return null;
  const mspFeeFraction = normalizeMspFeeFraction(row?.CLIENT_MSP_FEE);
  return round2(billRate * (1 - mspFeeFraction));
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

function computeCanadaNetMargin(row, finalBillRate, finalCost, finalPayRate) {
  const placementType = normPlacementType(row?.PLACEMENT_TYPE);
  const clientState = normClientState(row?.CLIENT_STATE);

  if (clientState === "CA") {
    return toNumberOrNull(row?.ENTITY);
  }
  if (placementType === "FT") return 0;
  if (finalBillRate == null) return null;
  if (finalCost == null) return null;
  return round2(finalBillRate - finalCost);
}

function computeCanadaGrossMargin(row, finalBillRate, finalPayRate) {
  const placementType = normPlacementType(row?.PLACEMENT_TYPE);
  const clientState = normClientState(row?.CLIENT_STATE);

  if (clientState === "CA") {
    return toNumberOrNull(row?.ENTITY);
  }
  if (placementType === "FT") return 0;
  if (finalBillRate == null) return null;
  if (finalPayRate == null) return null;
  return round2(finalBillRate - finalPayRate);
}

/**
 * @param {Record<string, *>} row
 * @returns {Record<string, *>}
 */
function computeCanadaDerivedPlacementFields(row) {
  const t4PayRate = computeCanadaT4PayRate(row);
  const finalPayRate = t4PayRate == null ? null : round2(t4PayRate);
  const finalBillRate = computeFinalBillRate(row);

  let finalCost = null;
  if (toNumberOrNull(row?.PAY_RATE) != null && finalPayRate != null) {
    finalCost = round2(finalPayRate * 1.03);
  }

  const netMargin = computeCanadaNetMargin(row, finalBillRate, finalCost, finalPayRate);
  const grossMargin = computeCanadaGrossMargin(row, finalBillRate, finalPayRate);

  return {
    T4_PAY_RATE: t4PayRate,
    FINAL_PAY_RATE: finalPayRate,
    FINAL_BILL_RATE: finalBillRate,
    FINAL_COST: finalCost,
    NET_MARGIN: netMargin,
    MARGIN: grossMargin,
    GM_OT: computeGmOt(row),
    DAYS_WORKED: computeDaysWorked(row),
  };
}

/**
 * API-owned columns Canada deal sheets do not use (stripped on insert; skipped on append compare).
 */
const CANADA_EXCLUDED_API_OWNED_COLUMNS = new Set([
  "W2_PAY_RATE",
  "W2_PAY_RATE_NEW",
  "FINAL_PAY_RATE_NEW",
  "FINAL_COST_NEW",
  "CALCULATED_MARGIN",
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
Object.freeze(CANADA_EXCLUDED_API_OWNED_COLUMNS);

/**
 * Hours fields kept on Canada deal sheets (SCHEDULE_HOURS_1 + PO_HOURS only).
 * @param {Record<string, *>|null|undefined} hoursPart
 * @returns {Record<string, *>}
 */
function pickCanadaDealSheetHoursPart(hoursPart) {
  if (!hoursPart || typeof hoursPart !== "object") {
    return { SCHEDULE_HOURS_1: 0 };
  }
  const out = { SCHEDULE_HOURS_1: hoursPart.SCHEDULE_HOURS_1 ?? 0 };
  if (Object.prototype.hasOwnProperty.call(hoursPart, "PO_HOURS")) {
    out.PO_HOURS = hoursPart.PO_HOURS;
  }
  return out;
}

/**
 * Canada deal sheet rows use T4_PAY_RATE only — never stream W2_PAY_RATE or US NEW-rate family to BigQuery.
 * @param {Record<string, *>|null|undefined} row
 * @returns {Record<string, *>|null|undefined}
 */
function sanitizeCanadaDealSheetRow(row) {
  if (!row || typeof row !== "object") return row;
  if (!isCynetHealthCanadaRecruiter(row.ASSIGNMENT_RECRUITER_EMAIL)) return row;
  const out = { ...row };
  for (const key of CANADA_EXCLUDED_API_OWNED_COLUMNS) {
    delete out[key];
  }
  return out;
}

module.exports = {
  isCynetHealthCanadaRecruiter,
  CANADA_EXCLUDED_API_OWNED_COLUMNS,
  pickCanadaDealSheetHoursPart,
  computeCanadaT4PayRate,
  computeCanadaDerivedPlacementFields,
  sanitizeCanadaDealSheetRow,
};
