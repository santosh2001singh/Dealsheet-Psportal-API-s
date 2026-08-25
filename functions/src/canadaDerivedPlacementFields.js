/**
 * Cynet Health Canada derived placement metrics: T4/T4A pay rate and margins.
 *
 * Rows land in the Canada tables by CLIENT_STATE (a Canadian province), not by recruiter email —
 * see CANADA_PROVINCES / isCanadaProvince below and resolveActiveDealSheetTableIdForRow.
 */

/**
 * ENTITY value for Cynet Health Canada rows when nothing else supplies one.
 *
 * Unlike locums (which stamps its entity on every row unconditionally), Canada treats ENTITY as a
 * fill-if-empty default: a value carried from the matched legacy run-rate row, or hand-edited in
 * BigQuery, always wins. 616 of the 620 rows in all_Health_Canada_data_Runrate already read
 * "CANADA HEALTH", so this only fills the genuine blanks.
 */
const CANADA_DEFAULT_ENTITY = "CANADA HEALTH";

/**
 * Canadian provinces Cynet Health Canada operates in. A row whose CLIENT_STATE is one of these is
 * Canada business.
 */
const CANADA_PROVINCES = Object.freeze({
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  ON: "Ontario",
  QC: "Quebec",
  SK: "Saskatchewan",
});

const CANADA_PROVINCE_CODES = Object.freeze(new Set(Object.keys(CANADA_PROVINCES)));

/** Full province names, lower-cased, for matching Nexus's zipcode_data.state_name. */
const CANADA_PROVINCE_NAMES = Object.freeze(
  new Set(Object.values(CANADA_PROVINCES).map((n) => n.toLowerCase()))
);

/**
 * Employer burden loading applied to the hourly pay rate, per province and payment type.
 *
 * Source: Finance's "2026 burden cost - Cynet Health Canada" table. The T4 figure is the province's
 * Final Loading Cost (CPP + EI + vacation 4% + WSIB/WCB + EHT 1.95% + stat holiday 4%); the T4A
 * figure is its Final Corp Cost. Both are stored as multipliers (1 + rate).
 *
 * t4a === null means Finance marked that province "No business" for T4A. Such a row gets a NULL pay
 * rate rather than an invented multiplier — see computeCanadaT4PayRate.
 *
 * Two deliberate departures from the older sheet formulas, both confirmed with the business:
 *   - AB group: the sheet multiplied PAY_RATE by 1.04 before the 1.1818 loading, but the 4% vacation
 *     is already inside 18.18%, so the extra 1.04 double-counted it (22.91% effective). Dropped.
 *   - NL: the sheet used 1.04 * 1.1672 (21.39% effective) via Finance's "Pay Rate + 4% vacation +
 *     16.72%" note. Finance's stated total is 20.72%, so the flat 1.2072 is used instead.
 */
const CANADA_BURDEN_BY_PROVINCE = Object.freeze({
  ON: { t4: 1.2155, t4a: 1.0337 },
  BC: { t4: 1.2258, t4a: 1.0 },
  NS: { t4: 1.2013, t4a: 1.0195 },
  NL: { t4: 1.2072, t4a: 1.0254 },
  // "No business" for T4A per Finance — T4 only.
  AB: { t4: 1.1818, t4a: null },
  MB: { t4: 1.1818, t4a: null },
  SK: { t4: 1.1818, t4a: null },
  QC: { t4: 1.1818, t4a: null },
  NB: { t4: 1.1818, t4a: null },
});

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

/**
 * True when CLIENT_STATE is one of the nine Canadian provinces Cynet Health Canada operates in.
 * @param {unknown} clientState
 * @returns {boolean}
 */
function isCanadaProvince(clientState) {
  const norm = normClientState(clientState);
  return norm != null && CANADA_PROVINCE_CODES.has(norm);
}

/**
 * Payment type as the burden table keys it: "T4", "T4A", or null when unrecognised.
 *
 * Nexus also spells the non-employee type "T4A/Inc" and "INC"; all collapse to T4A. A blank payment
 * type is treated as T4 (the employee default), matching the sheet's IF(TYPE="T4",...) fallthrough.
 *
 * @param {unknown} value
 * @returns {"T4"|"T4A"|null}
 */
function normPaymentTypeForBurden(value) {
  if (value == null || String(value).trim() === "") return "T4";
  const norm = String(value).trim().toUpperCase().replace(/[\s_]/g, "");
  if (norm === "T4") return "T4";
  if (norm === "T4A" || norm === "INC" || norm === "T4A/INC" || norm === "T4AINC") return "T4A";
  return null;
}

/**
 * Burden multiplier for a province + payment type, or null when none applies.
 *
 * Returns null when the province is not a Canada province, the payment type is unrecognised, or
 * Finance marked the province "No business" for that payment type.
 *
 * @param {unknown} clientState
 * @param {unknown} paymentType
 * @returns {number|null}
 */
function resolveCanadaBurdenMultiplier(clientState, paymentType) {
  const province = normClientState(clientState);
  if (province == null) return null;
  const burden = CANADA_BURDEN_BY_PROVINCE[province];
  if (!burden) return null;
  const type = normPaymentTypeForBurden(paymentType);
  if (type == null) return null;
  return type === "T4" ? burden.t4 : burden.t4a;
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
 * T4/T4A PAY RATE — the loaded hourly cost of the candidate.
 *
 *   (PAY_RATE + ADDITIONAL_BONUS / (GUARANTEED_HOURS * INITIAL_PROJECT_DURATION)) * burden
 *
 * where burden comes from CANADA_BURDEN_BY_PROVINCE keyed on CLIENT_STATE + PAYMENT_TYPE. NL adds
 * the weekly per-diem spread over 11.25 hours on top; no other province does.
 *
 * INTERNAL and FT placements carry no hourly cost, so they return 0. A province Finance marked
 * "No business" for the row's payment type returns null rather than a guessed multiplier.
 *
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

  // "No business" province/type pairs, unknown provinces and unrecognised payment types all land
  // here: no authorised multiplier exists, so the rate stays blank.
  const burden = resolveCanadaBurdenMultiplier(row?.CLIENT_STATE, row?.PAYMENT_TYPE);
  if (burden == null) return null;

  const bonus = toNumberOrNull(row?.ADDITIONAL_BONUS) ?? 0;
  const bonusTerm = bonus / (guaranteedHours * initialWeeks);
  const loaded = (payRate + bonusTerm) * burden;

  // NL only: weekly non-taxed per diem spread across 11.25 hours.
  if (normClientState(row?.CLIENT_STATE) === "NL") {
    const perDiem = toNumberOrNull(row?.WEEKLY_PER_DIEM_NON_TAXED) ?? 0;
    return round2(loaded + perDiem / 11.25);
  }
  return round2(loaded);
}

/**
 * FINAL BILL RATE = BILL_RATE * (1 - CLIENT_MSP_FEE), for every province.
 *
 * NOTE: the NS sheet's Final Bill Rate carried an extra BC branch (Bill_Rate * 1.04 * (1 - fee)),
 * but the BC sheet's own Final Bill Rate has no such uplift, and AB's explicitly says "AB mein BC ka
 * 4% adjustment apply nahi karna hai". The plain form is used until the business confirms otherwise.
 */
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

/**
 * CALCULATED_MARGIN = FINAL_BILL_RATE - FINAL_COST.
 *
 * The sheet calls this "MARGIN", but MARGIN on the Canada table holds Nexus's own hourly_revenue
 * (see mapDealSheetRevenueDetailsToBq), so the computed figure is stored under CALCULATED_MARGIN.
 * FT placements are 0. Canada has no NET_MARGIN column.
 *
 * @param {Record<string, *>} row
 * @param {number|null} finalBillRate
 * @param {number|null} finalCost
 * @returns {number|null}
 */
function computeCanadaCalculatedMargin(row, finalBillRate, finalCost) {
  if (normPlacementType(row?.PLACEMENT_TYPE) === "FT") return 0;
  if (finalBillRate == null || finalCost == null) return null;
  return round2(finalBillRate - finalCost);
}

/**
 * GROSS_MARGIN = FINAL_BILL_RATE - FINAL_PAY_RATE.
 *
 * FT placements are 0. This is the figure the Canada table previously stored in MARGIN.
 *
 * @param {Record<string, *>} row
 * @param {number|null} finalBillRate
 * @param {number|null} finalPayRate
 * @returns {number|null}
 */
function computeCanadaGrossMargin(row, finalBillRate, finalPayRate) {
  if (normPlacementType(row?.PLACEMENT_TYPE) === "FT") return 0;
  if (finalBillRate == null || finalPayRate == null) return null;
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

  return {
    T4_PAY_RATE: t4PayRate,
    FINAL_PAY_RATE: finalPayRate,
    FINAL_BILL_RATE: finalBillRate,
    FINAL_COST: finalCost,
    // Sheet "MARGIN" — bill minus cost. Stored here because MARGIN itself holds Nexus hourly_revenue.
    CALCULATED_MARGIN: computeCanadaCalculatedMargin(row, finalBillRate, finalCost),
    GROSS_MARGIN: computeCanadaGrossMargin(row, finalBillRate, finalPayRate),
    GM_OT: computeGmOt(row),
    DAYS_WORKED: computeDaysWorked(row),
  };
  // MARGIN is deliberately absent: it carries Nexus's hourly_revenue straight from the API, so the
  // derived step must not overwrite it. NET_MARGIN does not exist on the Canada tables.
}


/**
 * True when a row is Cynet Health Canada business.
 *
 * CLIENT_STATE (a Canadian province) is the authority, since it says where the work is and therefore
 * which legal entity bills it. The @cynethealth.ca recruiter domain is no longer sufficient on its
 * own: that desk also places US work, which belongs in the health tables.
 *
 * @param {Record<string, *>|null|undefined} row
 * @returns {boolean}
 */
function isCanadaDealSheetRow(row) {
  return isCanadaProvince(row?.CLIENT_STATE);
}

/**
 * Columns Canada deal sheets do not use (stripped on insert; skipped on append compare).
 *
 * These are NOT columns of the canada tables — see sql/migrate_canada_deal_sheet_schema.sql. Writing
 * any of them would fail the insert, so they are removed from every Canada row on the way out.
 *
 * CALCULATED_MARGIN and GROSS_MARGIN are deliberately absent from this set as of Aug 2026: both are
 * now real Canada columns (CALCULATED_MARGIN carries the old MARGIN bill-minus-pay figure).
 */
const CANADA_EXCLUDED_API_OWNED_COLUMNS = new Set([
  // US pay-rate family — Canada uses T4_PAY_RATE
  "W2_PAY_RATE",
  "W2_PAY_RATE_NEW",
  "FINAL_PAY_RATE_NEW",
  "FINAL_COST_NEW",
  "FINAL_BILL_RATE_NEW",
  // Canada does not use net margin (bill - cost)
  "NET_MARGIN",
  // Hours / bonus family not tracked in Canada
  "FIRST_WEEK_HOURS",
  "SECOND_WEEK_HOURS",
  "TOTAL_BONUS_TAXABLE",
  "TOTAL_BONUS_NON_TAXABLE",
  "REGULAR_HOURS_1",
  "REGULAR_HOURS_2",
  "SCHEDULE_HOURS_2",
  "BILLABLE_ORIENTATION_HRS",
  "BILLABLE_ORIENTATION",
  // Hierarchy / cluster / client-ownership columns dropped from the canada tables (Aug 2026)
  "EXT_PENDING_ID",
  "AVP",
  "AVP_EMP_NO",
  "CLIENT_OWNER",
  "ONSITE_CLIENT_OWNER",
  "CLIENT_NAME_IN_CONREP",
  "CLIENT_CLUSTER_REGION",
  "RECRUITER_CLUSTER_REGION",
  "CLUSTER_TYPE",
  "HOURLY_GP",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
  "AGENCY_SWITCH",
  "ONSITE_OWNER",
  "DIRECTOR_CLIENT_PARTNERSHIP",
  "ASSOCIATE_JUNIOR_CSM",
  "ONSITE_VP_AVP",
  "ASSOCIATE_SALES_PERSON",
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
 * Fill ENTITY with the Canada default when the row has none.
 *
 * Runs after the legacy run-rate carry-forward and after manual-column carry-forward, so an existing
 * value — from either source — is never overwritten. Only applies to Canada rows.
 *
 * @param {Record<string, *>|null|undefined} row
 * @returns {Record<string, *>|null|undefined} the same row, ENTITY filled when it was blank
 */
function applyCanadaDefaultEntity(row) {
  if (!row || typeof row !== "object") return row;
  if (!isCanadaDealSheetRow(row)) return row;
  const current = row.ENTITY;
  const isBlank = current == null || String(current).trim() === "";
  if (!isBlank) return row;
  return { ...row, ENTITY: CANADA_DEFAULT_ENTITY };
}

/**
 * Canada deal sheet rows use T4_PAY_RATE only — never stream W2_PAY_RATE or US NEW-rate family to BigQuery.
 * @param {Record<string, *>|null|undefined} row
 * @returns {Record<string, *>|null|undefined}
 */
function sanitizeCanadaDealSheetRow(row) {
  if (!row || typeof row !== "object") return row;
  if (!isCanadaDealSheetRow(row)) return row;
  const out = { ...row };
  for (const key of CANADA_EXCLUDED_API_OWNED_COLUMNS) {
    delete out[key];
  }
  return out;
}


/**
 * CLIENT_STATE for a raw Nexus job-submittal, read straight off the list response.
 *
 * The submittal already embeds the client, and `client.zipcode_data.state_code` is the SAME field
 * mapClientToBq derives CLIENT_STATE from — so the province is knowable before any enrich call is
 * made. Measured on live data: present on 300/300 submittals.
 *
 * @param {Record<string, *>|null|undefined} submittal
 * @returns {string|null} upper-cased state code, or null when the response has none
 */
function submittalClientStateCode(submittal) {
  const raw = submittal?.client?.zipcode_data?.state_code;
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  return s === "" ? null : s;
}

/**
 * Full province name for a raw job-submittal (zipcode_data.state_name), or null.
 * @param {Record<string, *>|null|undefined} submittal
 * @returns {string|null}
 */
function submittalClientStateName(submittal) {
  const raw = submittal?.client?.zipcode_data?.state_name;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/**
 * ISO country for a raw job-submittal (zipcode_data.iso_country_code), or null.
 * @param {Record<string, *>|null|undefined} submittal
 * @returns {string|null}
 */
function submittalClientCountryCode(submittal) {
  const raw = submittal?.client?.zipcode_data?.iso_country_code;
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  return s === "" ? null : s;
}

/**
 * True when a raw job-submittal should be enriched for the CANADA domain.
 *
 * Nexus's job-submittals endpoint takes no state parameter, so a canada run used to enrich every
 * submittal (~11 API calls each) and discard the non-canada ones only afterwards, at
 * rowMatchesSyncDomainForRow. On live data only ~5% of submittals are canadian, so ~95% of that
 * fan-out was wasted — and the volume is what tripped the edge rate limit into HTML 403s.
 *
 * Deciding here instead skips those calls entirely.
 *
 * Three independent signals are accepted, any one of which is enough:
 *   1. state_code       — "BC"                     (the field CLIENT_STATE is derived from)
 *   2. state_name       — "British Columbia"       (more explicit; unambiguous across 49 live names)
 *   3. iso_country_code — "CA"                     (the country itself)
 *
 * All three were present on 1200/1200 live submittals and never disagreed, so any one alone would
 * do; taking them together means a single missing field cannot silently drop a canadian placement.
 *
 * NOTE state_code "CA" is CALIFORNIA, not Canada — only iso_country_code carries the country. That
 * is why the country check reads a different field rather than reusing the province code.
 *
 * A submittal with NONE of the three resolvable is KEPT on purpose: dropping it would silently lose
 * a row if Nexus ever omits zipcode_data. The post-enrich domain filter still catches it.
 *
 * @param {Record<string, *>|null|undefined} submittal
 * @returns {boolean}
 */
function submittalMayBeCanada(submittal) {
  const code = submittalClientStateCode(submittal);
  if (code != null && CANADA_PROVINCE_CODES.has(code)) return true;

  const name = submittalClientStateName(submittal);
  if (name != null && CANADA_PROVINCE_NAMES.has(name.toLowerCase())) return true;

  const country = submittalClientCountryCode(submittal);
  if (country === "CA") return true;

  // Nothing identified it at all -> keep, so a missing field never silently drops a row.
  if (code == null && name == null && country == null) return true;

  return false;
}

module.exports = {
  isCynetHealthCanadaRecruiter,
  submittalClientStateCode,
  submittalClientStateName,
  submittalClientCountryCode,
  submittalMayBeCanada,
  CANADA_PROVINCE_NAMES,
  CANADA_DEFAULT_ENTITY,
  applyCanadaDefaultEntity,
  isCanadaProvince,
  isCanadaDealSheetRow,
  CANADA_PROVINCES,
  CANADA_PROVINCE_CODES,
  CANADA_BURDEN_BY_PROVINCE,
  normPaymentTypeForBurden,
  resolveCanadaBurdenMultiplier,
  CANADA_EXCLUDED_API_OWNED_COLUMNS,
  pickCanadaDealSheetHoursPart,
  computeCanadaT4PayRate,
  computeCanadaCalculatedMargin,
  computeCanadaGrossMargin,
  computeCanadaDerivedPlacementFields,
  sanitizeCanadaDealSheetRow,
};
