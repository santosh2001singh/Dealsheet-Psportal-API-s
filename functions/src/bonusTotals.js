/**
 * Compute TOTAL_BONUS_TAXABLE and TOTAL_BONUS_NON_TAXABLE from additional costs
 * and travel allowances, using deal-sheet hours for duration multipliers.
 */

const TAXABLE_CATEGORIES = new Set(["BONUS", "BONUS_FACILITY_PAID"]);

function toNumberOrZero(v) {
  if (v === "" || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve duration multiplier from deal_sheet_cost_duration_id and hours row.
 */
function resolveDurationMultiplier(durationId, hoursRow) {
  const key = durationId == null ? "" : String(durationId).trim().toUpperCase();
  switch (key) {
    case "WEEKLY":
      return toNumberOrZero(hoursRow?.total_weeks);
    case "MONTHLY":
      return toNumberOrZero(hoursRow?.total_months);
    case "HOURLY":
      return toNumberOrZero(hoursRow?.total_billable_hrs);
    case "DAILY":
      return toNumberOrZero(hoursRow?.total_days);
    case "ONE_TIME":
    case "":
    default:
      return 1;
  }
}

/**
 * Sum taxable (BONUS / BONUS_FACILITY_PAID) and non-taxable additional costs,
 * plus travel allowance (always one-time) into non-taxable.
 */
function computeBonusTotals(addCostRows, travelRows, hoursRow, clientCostRows) {
  let taxable = 0;
  let nonTaxable = 0;

  if (Array.isArray(addCostRows)) {
    for (const row of addCostRows) {
      const cost = row?.deal_sheet_cost_data;
      const category = cost?.deal_sheet_category_id;
      const value = toNumberOrZero(row?.value);
      const mult = resolveDurationMultiplier(cost?.deal_sheet_cost_duration_id, hoursRow);
      const contribution = value * mult;
      const catKey = category == null ? "" : String(category).trim().toUpperCase();
      if (TAXABLE_CATEGORIES.has(catKey)) {
        taxable += contribution;
      } else {
        nonTaxable += contribution;
      }
    }
  }

  if (Array.isArray(travelRows)) {
    for (const row of travelRows) {
      nonTaxable += toNumberOrZero(row?.total_amount);
    }
  }

  if (Array.isArray(clientCostRows)) {
    for (const row of clientCostRows) {
      const value = toNumberOrZero(row?.cost);
      const mult = resolveDurationMultiplier(row?.duration, hoursRow);
      nonTaxable += value * mult;
    }
  }

  return {
    TOTAL_BONUS_TAXABLE: taxable,
    TOTAL_BONUS_NON_TAXABLE: nonTaxable,
  };
}

module.exports = {
  resolveDurationMultiplier,
  computeBonusTotals,
};
