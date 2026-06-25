/**
 * Column Mappings
 * Transform Nexus API data to BigQuery schema
 */

const { normalizeNexusResourceId } = require("./nexusClient");
const {
  isCynetHealthCanadaRecruiter,
  computeCanadaDerivedPlacementFields,
} = require("./canadaDerivedPlacementFields");

/**
 * Convert value to number or null
 */
function toNumberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Add two numbers, treating null as 0
 */
function addNumbersOrNull(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

/**
 * Trim contact value
 */
function trimContactValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * US state_code -> REGION mapping
 */
function mapUsStateCodeToRegion(stateCode) {
  if (stateCode == null || String(stateCode).trim() === "") return "Pacific West";
  const s = String(stateCode).trim().toUpperCase();
  
  const northEast = { VT: 1, ME: 1, NH: 1, NY: 1, MA: 1, CT: 1, RI: 1, NJ: 1 };
  const midAtlantic = { DE: 1, PA: 1, MD: 1, DC: 1, VA: 1, WV: 1 };
  const southEast = { NC: 1, SC: 1, GA: 1, FL: 1, TN: 1, MS: 1, AL: 1 };
  const midWest = { IN: 1, OH: 1, MI: 1, WI: 1, MN: 1, KY: 1, MO: 1, IA: 1, IL: 1, ND: 1, SD: 1, NE: 1, KS: 1 };
  const southWest = { AZ: 1, NM: 1, TX: 1, OK: 1, AR: 1, LA: 1 };
  
  if (northEast[s]) return "North East";
  if (midAtlantic[s]) return "Mid Atlantic";
  if (southEast[s]) return "South East";
  if (midWest[s]) return "Mid West";
  if (southWest[s]) return "South West";
  return "Pacific West";
}

/**
 * Map client data to BigQuery schema
 */
function mapClientToBq(client, parentClientName) {
  if (!client) return {};
  const zd = client.zipcode_data;
  const zip = (zd?.zipcode ?? "").toString().trim();
  const city = (zd?.city ?? "").toString().trim();
  
  let cityZipcode = null;
  if (zip && city) cityZipcode = `${zip} ${city}`;
  else if (zip) cityZipcode = zip;
  else if (city) cityZipcode = city;
  
  const stateCode = (zd?.state_code ?? "").toString().trim() || null;
  const region = mapUsStateCodeToRegion(stateCode);
  const facilityName =
    client.name == null || String(client.name).trim() === ""
      ? null
      : String(client.name).trim();
  const parentFromApi =
    parentClientName != null && String(parentClientName).trim() !== ""
      ? String(parentClientName).trim()
      : null;
  const parentName = parentFromApi ?? facilityName;
  
  const rawParent = client?.parent_client;
  const rawParentId =
    rawParent != null && typeof rawParent === "object" && rawParent.id != null
      ? rawParent.id
      : rawParent;
  const parentIdNum = rawParentId == null || rawParentId === "" ? null : Number(rawParentId);
  const nexusParentClientId = parentIdNum != null && Number.isFinite(parentIdNum) ? Math.trunc(parentIdNum) : null;
  
  return {
    END_CLIENT_DEPT_FACILITY: client.name ?? null,
    CITY_ZIPCODE: cityZipcode,
    CLIENT_STATE: stateCode,
    REGION: region,
    NEXUS_PARENT_CLIENT_ID: nexusParentClientId,
    PARENT_CLIENT_NAME: parentName,
  };
}

/**
 * Map deal sheet candidate to BigQuery schema
 */
function resolveDealSheetStatusForBq(item, options = {}) {
  const persistFromCandidate = options.persistDealSheetStatusFromCandidate === true;
  if (!persistFromCandidate) return "FINAL";

  const raw = item?.deal_sheet_status_code ?? item?.deal_sheet_status ?? "";
  const key = String(raw).trim().toUpperCase();
  if (key === "VERBAL") return "VERBAL";
  if (key === "FINAL") return "FINAL";
  return "FINAL";
}

function mapDealSheetCandidateToBq(item, options = {}) {
  function truncId(str) {
    if (str == null || str === "") return null;
    const n = Number(str);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  const dsStr = normalizeNexusResourceId(item?.deal_sheet);
  const jobStr = normalizeNexusResourceId(item?.job);
  const candStr = normalizeNexusResourceId(item?.candidate);
  const cliStr = normalizeNexusResourceId(item?.client);
  const dealSheetStatus = resolveDealSheetStatusForBq(item, options);
  return {
    DEAL_SHEET_ID: truncId(dsStr),
    DEAL_SHEET_STATUS: dealSheetStatus,
    NEXUS_INTERNAL_JOB_ID: truncId(jobStr),
    CANDIDATE_NEXUS_ID: truncId(candStr),
    CLIENT_ID: truncId(cliStr),
  };
}

/**
 * Get VMS display value from deal sheet
 */
function dealSheetVmsDisplayValue(dealSheet) {
  const v = dealSheet?.vms;
  if (v != null && typeof v === "object" && v.value != null) {
    const s = String(v.value).trim();
    return s || null;
  }
  return null;
}

/**
 * Map deal sheet detail to BigQuery schema
 */
function mapDealSheetDetailToBq(dealSheet) {
  const lodging = toNumberOrNull(dealSheet?.lodging_amount);
  const meal = toNumberOrNull(dealSheet?.meal_amount);
  const vmsFee = toNumberOrNull(dealSheet?.vms_fee);

  return {
    DEAL_SHEET_ID: dealSheet?.id ?? null,
    WEEKLY_PER_DIEM_NON_TAXED: addNumbersOrNull(lodging, meal),
    DEAL_TYPE: dealSheet?.type ?? null,
    GP_PERCENTAGE: toNumberOrNull(dealSheet?.gross_margin_percentage),
    CLIENT_MSP_FEE: vmsFee == null ? null : vmsFee / 100,
    ORIENTATION_HOURS: toNumberOrNull(dealSheet?.non_billable_orientation_hrs),
    INITIAL_PROJECT_DURATION_IN_WEEKS: toNumberOrNull(dealSheet?.job_duration),
    VMS: dealSheetVmsDisplayValue(dealSheet),
  };
}

/**
 * Map user to full name
 */
function mapUserToFullName(user) {
  const first = (user?.first_name ?? "").toString().trim();
  const middle = (user?.middle_name ?? "").toString().trim();
  const last = (user?.last_name ?? "").toString().trim();
  return [first, middle, last].filter(Boolean).join(" ") || null;
}

/**
 * Convert id-like value to integer or null
 */
function toIntOrNull(value) {
  const n = value == null || value === "" ? null : Number(value);
  return n != null && Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Normalize recruiter object from job submittal payload
 */
function normalizeRecruiterFromSubmittal(submittalRow) {
  const raw = submittalRow?.recruiter;
  if (raw == null) return null;
  if (typeof raw === "object") {
    return {
      id: toIntOrNull(raw.id),
      first_name: raw.first_name ?? null,
      middle_name: raw.middle_name ?? null,
      last_name: raw.last_name ?? null,
      email: raw.email ?? null,
    };
  }
  return { id: toIntOrNull(raw), first_name: null, middle_name: null, last_name: null, email: null };
}

/**
 * Primary phone field mapping
 */
const PRIMARY_PHONE_FIELD = {
  CELL_PHONE: "cell_phone",
  HOME_PHONE: "home_phone",
  WORK_PHONE: "work_phone",
  LEAP_PHONE: "leap_phone",
  ADDITIONAL_PHONE: "additional_phone",
};

/**
 * Get primary phone from contact row
 */
function primaryPhoneFromContactRow(info) {
  if (!info || typeof info !== "object") return null;
  const key = (info.primary_phone ?? "").toString().trim().toUpperCase();
  const field = PRIMARY_PHONE_FIELD[key];
  if (field) {
    const v = trimContactValue(info[field]);
    if (v) return v;
  }
  return (
    trimContactValue(info.cell_phone) ??
    trimContactValue(info.home_phone) ??
    trimContactValue(info.work_phone) ??
    trimContactValue(info.leap_phone) ??
    trimContactValue(info.additional_phone) ??
    null
  );
}

/**
 * Get candidate email from contact info
 */
function candidateEmailFromContactInfo(candidate) {
  const rows = candidate?.candidate_contact_info;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const e = trimContactValue(row?.primary_email);
    if (e) return e;
  }
  return null;
}

/**
 * Get candidate phone from contact info
 */
function candidatePhoneFromContactInfo(candidate) {
  const rows = candidate?.candidate_contact_info;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const p = primaryPhoneFromContactRow(row);
    if (p) return p;
  }
  return null;
}

/**
 * Map candidate to BigQuery schema
 */
function mapCandidateToBq(candidate) {
  const first = (candidate?.first_name ?? "").toString().trim();
  const middle = (candidate?.middle_name ?? "").toString().trim();
  const last = (candidate?.last_name ?? "").toString().trim();
  const name = [first, middle, last].filter(Boolean).join(" ") || null;
  const statusCode = candidate?.org_candidate_status?.code ?? null;
  
  return {
    CANDIDATE_NAME: name,
    CANDIDATE_STATUS: statusCode,
    CANDIDATE_EMAIL: candidateEmailFromContactInfo(candidate) ?? trimContactValue(candidate?.email),
    PHONE_NUMBER: candidatePhoneFromContactInfo(candidate) ?? trimContactValue(candidate?.phone),
  };
}

/**
 * Map candidate-candidate-types to BigQuery schema
 */
function mapCandidateCandidateTypesToBq(rows) {
  if (!rows || !rows.length) return {};
  const ct = rows[0]?.candidate_type;
  const val = ct?.value;
  if (val == null || String(val).trim() === "") return {};
  return { PROVIDER_TYPE: String(val).trim() };
}

/**
 * Map deal sheet users to BigQuery schema
 */
function mapDealSheetUsersToBq(dealSheet, recruiterUser, salesRepUser, submittalRow) {
  const recruiterFromSubmittal = normalizeRecruiterFromSubmittal(submittalRow);
  const recruiterIdFromDealSheet = toIntOrNull(dealSheet?.recruiter);
  const recruiterObj = recruiterUser ?? recruiterFromSubmittal;
  const salesRepIdFromSubmittal = toIntOrNull(submittalRow?.sales_rep);
  return {
    RECRUITER_ID: recruiterIdFromDealSheet ?? recruiterFromSubmittal?.id ?? null,
    ASSIGNMENT_RECRUITER: mapUserToFullName(recruiterObj),
    ASSIGNMENT_RECRUITER_EMAIL: recruiterObj?.email ?? null,
    CLIENT_SALES_REP: mapUserToFullName(salesRepUser),
    CLIENT_SALES_REP_ID:
      toIntOrNull(dealSheet?.sales_rep) ?? salesRepIdFromSubmittal ?? null,
    ONSITE_AM: mapUserToFullName(salesRepUser),
    ONSITE_AM_EMAIL: salesRepUser?.email ?? null,
  };
}

/**
 * JOB_TYPE -> PLACEMENT_TYPE mapping
 */
function mapJobPlacementTypeFromJobType(job) {
  const jt = (job?.job_type ?? "").toString().trim().toUpperCase();
  if (jt === "PERMANENT" || jt === "PERM") return "FT";
  if (jt === "LOCAL" || jt === "LOCUM" || jt === "TRAVEL") return "CT";
  return null;
}

/**
 * Parse date string to UTC milliseconds
 */
function parseDateStringForDiff(value) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

/**
 * True when value parses to a calendar date on or after minUtcMs (UTC midnight comparison).
 */
function startDateOnOrAfterUtcMin(value, minUtcMs) {
  const ms = parseDateStringForDiff(value);
  return ms != null && ms >= minUtcMs;
}

/**
 * Date used for min-start-date filters: submittal START_DATE, else job OFFER_TIME_START_DATE.
 */
function effectiveMinFilterDate(row) {
  const s = row?.START_DATE;
  if (s != null && String(s).trim() !== "") return s;
  return row?.OFFER_TIME_START_DATE ?? null;
}

/**
 * Pad number to 2 digits
 */
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/**
 * Format date string for BigQuery DATE fields
 */
function formatDateStringForBq(value) {
  const ms = parseDateStringForDiff(value);
  if (ms == null) return null;
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

/**
 * Get start of today in UTC milliseconds
 */
function startOfTodayMs() {
  const now = new Date();
  const ymd = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
  return parseDateStringForDiff(ymd);
}

/**
 * Resolve job status string from job object
 */
function resolveJobStatusString(job) {
  if (!job) return null;
  let js = job.job_status;
  if (js == null && job.org_job_status != null && typeof job.org_job_status === "object") {
    js = job.org_job_status.code ?? job.org_job_status.value ?? null;
  }
  if (js == null) return null;
  if (typeof js === "string") return js.trim() || null;
  if (typeof js === "object") {
    const v = js.value ?? js.code ?? js.name ?? null;
    if (v != null) return String(v).trim() || null;
  }
  return null;
}

/**
 * Compute BigQuery END_DATE from job
 */
function computeBqEndDateFromJob(job) {
  if (!job) return null;
  const statusRaw = resolveJobStatusString(job);
  const statusKey = statusRaw == null ? "" : String(statusRaw).trim();
  const norm = statusKey.toLowerCase();
  const isActive = norm === "active";
  const isBooked = norm === "booked";
  const isCancelled = norm === "cancelled" || norm === "canceled";

  const endStr = job.end_date ?? null;
  const startStr = job.start_date ?? null;
  const endMs = parseDateStringForDiff(endStr);
  const todayMs = startOfTodayMs();

  if ((isActive || isBooked) && endMs != null && todayMs != null && endMs <= todayMs) {
    return formatDateStringForBq(endStr);
  }
  if (!isActive && !isBooked && !isCancelled && statusKey !== "") {
    return formatDateStringForBq(endStr);
  }
  if (isCancelled) {
    return formatDateStringForBq(startStr);
  }
  return null;
}

/**
 * Get tentative date from job
 */
function tentativeDateFromJob(job) {
  const raw = job?.end_date ?? null;
  if (raw == null) return null;
  const iso = formatDateStringForBq(raw);
  if (iso != null) return iso;
  const t = String(raw).trim();
  return t === "" ? null : t;
}

/**
 * Map job to BigQuery schema
 */
function mapJobToBq(job) {
  return {
    VMS_JOB_ID: job?.ref_code ?? null,
    BILL_RATE: toNumberOrNull(job?.bill_rate),
    OFFER_TIME_START_DATE: formatDateStringForBq(job?.start_date) ?? null,
    TENTATIVE_DATE: job ? tentativeDateFromJob(job) : null,
    END_DATE: computeBqEndDateFromJob(job),
    OFFERING: job?.offering ?? null,
    JOB_TYPE: job?.job_type ?? null,
    PLACEMENT_TYPE: mapJobPlacementTypeFromJobType(job),
  };
}

/**
 * Normalize offering key for matching
 */
function normalizeOfferingKeyForMatch(v) {
  if (v == null || String(v).trim() === "") return "";
  return String(v).trim().toUpperCase();
}

function offeringKeyFromClientOfferingRow(row) {
  return normalizeOfferingKeyForMatch(row?.offering ?? row?.offering_id);
}

function subOfferingKeyFromClientOfferingRow(row) {
  return normalizeOfferingKeyForMatch(row?.sub_offering ?? row?.sub_offering_id);
}

/**
 * Pick client offering row for job
 */
function pickClientOfferingRowForJob(items, job) {
  if (!items || !items.length) return null;
  const jo = normalizeOfferingKeyForMatch(job?.offering);
  const js = normalizeOfferingKeyForMatch(job?.sub_offering);
  if (!jo) return items[0];

  for (const r of items) {
    if (offeringKeyFromClientOfferingRow(r) !== jo) continue;
    if (subOfferingKeyFromClientOfferingRow(r) === js) return r;
  }
  for (const r of items) {
    if (offeringKeyFromClientOfferingRow(r) === jo) return r;
  }
  return items[0];
}

function clientOfferingHasClientTypeText(row) {
  if (!row || typeof row !== "object") return false;
  const cst = row.client_setting_type;
  return cst != null
    && typeof cst === "object"
    && cst.value != null
    && String(cst.value).trim() !== "";
}

/**
 * Prefer embedded submittal client offerings; merge CLIENT_TYPE from API list when missing.
 */
function resolveClientOfferingForEnrich(submittalRow, clientOfferingsFromApi, job) {
  const embeddedClient = submittalRow?.client;
  const embeddedItems = Array.isArray(embeddedClient?.client_offerings)
    ? embeddedClient.client_offerings
    : [];
  const apiItems = Array.isArray(clientOfferingsFromApi) ? clientOfferingsFromApi : [];

  let picked = embeddedItems.length > 0
    ? pickClientOfferingRowForJob(embeddedItems, job)
    : null;

  if (picked && clientOfferingHasClientTypeText(picked)) {
    return picked;
  }

  if (picked && apiItems.length > 0) {
    const apiPicked = pickClientOfferingRowForJob(apiItems, job);
    if (apiPicked && clientOfferingHasClientTypeText(apiPicked)) {
      return { ...picked, client_setting_type: apiPicked.client_setting_type };
    }
  }

  if (!picked && apiItems.length > 0) {
    return pickClientOfferingRowForJob(apiItems, job);
  }

  return picked;
}

/**
 * Map MSP from client offering row
 */
function mapMspFromClientOfferingRow(row) {
  if (!row || typeof row !== "object") return {};

  const cst = row.client_setting_type;
  const clientType =
    cst != null && typeof cst === "object" && cst.value != null
      ? String(cst.value).trim() || null
      : cst != null && typeof cst !== "object"
        ? String(cst).trim() || null
        : null;

  const msp = row.msp;
  if (!msp || typeof msp !== "object") {
    return { CLIENT_TYPE: clientType };
  }
  const mid = msp.id;
  const n = mid == null || mid === "" ? null : Number(mid);
  const name = msp.name != null ? String(msp.name).trim() || null : null;
  
  return {
    MSP_ID: n != null && Number.isFinite(n) ? Math.trunc(n) : null,
    MSP_NAME: name,
    LINE_OF_BUSINESS: name,
    CLIENT_TYPE: clientType,
  };
}

/**
 * Map job profession/specialty from job
 */
function mapJobProfessionSpecialtyFromJob(job) {
  if (!job) return {};
  const p = job.profession;
  const s = job.specialty;
  const profName = p != null && typeof p === "object" && p.name != null
    ? String(p.name).trim() || null : null;
  const specName = s != null && typeof s === "object" && s.name != null
    ? String(s.name).trim() || null : null;
  return {
    CATEGORIZATION_OF_POSITION: profName,
    CATEGORIZATION_OF_POSITION_ID: toIntOrNull(p?.id),
    POSITION: specName,
    POSITION_ID: toIntOrNull(s?.id),
  };
}

/**
 * Map deal sheet hours details to BigQuery schema.
 * SCHEDULE_HOURS_1 / SCHEDULE_HOURS_2 default to 0 when source value is null/blank
 * so BigQuery always stores a number (not NULL).
 * REGULAR_HOURS_* are populated only when clientState is CA;
 * all other states (and blank/null state) get 0 for those two columns.
 */
function mapDealSheetHoursDetailsToBq(hoursRow, clientState) {
  const stateNorm =
    clientState == null || String(clientState).trim() === ""
      ? null
      : String(clientState).trim().toUpperCase();
  const isCa = stateNorm === "CA";

  if (!hoursRow) {
    return {
      SCHEDULE_HOURS_1: 0,
      SCHEDULE_HOURS_2: 0,
      REGULAR_HOURS_1: 0,
      REGULAR_HOURS_2: 0,
    };
  }
  return {
    PO_HOURS: toNumberOrNull(hoursRow.total_assignment_hrs),
    SCHEDULE_HOURS_1: toNumberOrNull(hoursRow.scheduled_hrs_1) ?? 0,
    SCHEDULE_HOURS_2: toNumberOrNull(hoursRow.scheduled_hrs_2) ?? 0,
    REGULAR_HOURS_1: isCa ? (toNumberOrNull(hoursRow.regular_hrs_1) ?? 0) : 0,
    REGULAR_HOURS_2: isCa ? (toNumberOrNull(hoursRow.regular_hrs_2) ?? 0) : 0,
  };
}

/**
 * Map deal sheet revenue details to BigQuery schema
 */
function mapDealSheetRevenueDetailsToBq(revenueRow) {
  if (!revenueRow) return {};
  const grossMargin = toNumberOrNull(revenueRow.hourly_revenue);
  return {
    GP_PERCENTAGE: toNumberOrNull(revenueRow.gross_margin_percentage),
    GROSS_MARGIN: grossMargin,
  };
}

/**
 * Map deal sheet additional costs to BigQuery schema (BONUS category only).
 */
function mapDealSheetAdditionalCostsToBq(rows) {
  if (!rows || !rows.length) return { ADDITIONAL_BONUS: 0 };
  let sum = 0;
  for (const row of rows) {
    const category = row?.deal_sheet_cost_data?.deal_sheet_category_id;
    if (category !== "BONUS") continue;
    const v = toNumberOrNull(row?.value);
    if (v != null) sum += v;
  }
  return { ADDITIONAL_BONUS: sum };
}

/**
 * Build one audit log row per Nexus additional-cost line item (all categories).
 */
function mapAdditionalCostLogRowsForDealSheet(addCostRows, contextRow, captureTimestamp) {
  if (!addCostRows || !addCostRows.length) return [];
  const ts = captureTimestamp != null ? captureTimestamp : new Date().toISOString();
  const dealSheetId = toIntOrNull(contextRow?.DEAL_SHEET_ID);
  const placementId = toIntOrNull(contextRow?.PLACEMENT_ID);
  const startDate = formatDateStringForBq(contextRow?.START_DATE) ?? (
    contextRow?.START_DATE == null || String(contextRow.START_DATE).trim() === ""
      ? null
      : String(contextRow.START_DATE).trim()
  );
  const tentativeDate = formatDateStringForBq(contextRow?.TENTATIVE_DATE) ?? (
    contextRow?.TENTATIVE_DATE == null || String(contextRow.TENTATIVE_DATE).trim() === ""
      ? null
      : String(contextRow.TENTATIVE_DATE).trim()
  );
  const candidateName = contextRow?.CANDIDATE_NAME ?? null;
  const candidateEmail = contextRow?.CANDIDATE_EMAIL ?? null;
  const recruiterEmail = contextRow?.ASSIGNMENT_RECRUITER_EMAIL ?? null;

  const out = [];
  for (const item of addCostRows) {
    const costData = item?.deal_sheet_cost_data;
    const lineId = toIntOrNull(item?.id);
    const nameRaw = costData?.name;
    const name = nameRaw == null ? null : String(nameRaw).trim() || null;
    if (lineId == null && name == null && toNumberOrNull(item?.value) == null) continue;

    out.push({
      DATE_AND_TIME: ts,
      DEAL_SHEET_ID: dealSheetId,
      PLACEMENT_ID: placementId,
      CANDIDATE_NAME: candidateName,
      CANDIDATE_EMAIL: candidateEmail,
      ASSIGNMENT_RECRUITER_EMAIL: recruiterEmail,
      START_DATE: startDate,
      TENTATIVE_DATE: tentativeDate,
      ADDITIONAL_COST_ID: lineId,
      ADDITIONAL_COST_NAME: name,
      CATEGORY:
        costData?.deal_sheet_category_id == null
          ? null
          : String(costData.deal_sheet_category_id).trim() || null,
      DURATION:
        costData?.deal_sheet_cost_duration_id == null
          ? null
          : String(costData.deal_sheet_cost_duration_id).trim() || null,
      VALUE: toNumberOrNull(item?.value) ?? 0,
      NOTES: item?.notes == null ? null : String(item.notes).trim() || null,
    });
  }
  return out;
}

/**
 * Sum travel allowance total_amount into ADDITIONAL_BONUS (BONUS category).
 */
function mapTravelAllowanceToAdditionalBonus(rows) {
  if (!rows || !rows.length) return { ADDITIONAL_BONUS: 0 };
  let sum = 0;
  for (const row of rows) {
    const v = toNumberOrNull(row?.total_amount);
    if (v != null) sum += v;
  }
  return { ADDITIONAL_BONUS: sum };
}

/**
 * Build one audit log row per deal-sheet travel allowance (synthetic BONUS line item).
 */
function mapTravelAllowanceLogRowsForDealSheet(travelRows, contextRow, captureTimestamp) {
  if (!travelRows || !travelRows.length) return [];
  const ts = captureTimestamp != null ? captureTimestamp : new Date().toISOString();
  const dealSheetId = toIntOrNull(contextRow?.DEAL_SHEET_ID);
  const placementId = toIntOrNull(contextRow?.PLACEMENT_ID);
  const startDate = formatDateStringForBq(contextRow?.START_DATE) ?? (
    contextRow?.START_DATE == null || String(contextRow.START_DATE).trim() === ""
      ? null
      : String(contextRow.START_DATE).trim()
  );
  const tentativeDate = formatDateStringForBq(contextRow?.TENTATIVE_DATE) ?? (
    contextRow?.TENTATIVE_DATE == null || String(contextRow.TENTATIVE_DATE).trim() === ""
      ? null
      : String(contextRow.TENTATIVE_DATE).trim()
  );
  const candidateName = contextRow?.CANDIDATE_NAME ?? null;
  const candidateEmail = contextRow?.CANDIDATE_EMAIL ?? null;
  const recruiterEmail = contextRow?.ASSIGNMENT_RECRUITER_EMAIL ?? null;

  const out = [];
  for (const item of travelRows) {
    const lineId = toIntOrNull(item?.id);
    const value = toNumberOrNull(item?.total_amount) ?? 0;
    if (lineId == null && value === 0) continue;
    const first = toNumberOrNull(item?.first_check_amount);
    const last = toNumberOrNull(item?.last_check_amount);
    const notes =
      `First check amount: ${first == null ? "0" : first}\n` +
      `Last check amount: ${last == null ? "0" : last}`;

    out.push({
      DATE_AND_TIME: ts,
      DEAL_SHEET_ID: dealSheetId,
      PLACEMENT_ID: placementId,
      CANDIDATE_NAME: candidateName,
      CANDIDATE_EMAIL: candidateEmail,
      ASSIGNMENT_RECRUITER_EMAIL: recruiterEmail,
      START_DATE: startDate,
      TENTATIVE_DATE: tentativeDate,
      ADDITIONAL_COST_ID: lineId,
      ADDITIONAL_COST_NAME: "Travel Allowances",
      CATEGORY: "BONUS",
      DURATION: "ONE_TIME",
      VALUE: value,
      NOTES: notes,
    });
  }
  return out;
}

/**
 * Sum deal-sheet client costs into ADDITIONAL_BONUS (flat cost field, no duration multiplier).
 */
function mapDealSheetClientCostsToAdditionalBonus(rows) {
  if (!rows || !rows.length) return { ADDITIONAL_BONUS: 0 };
  let sum = 0;
  for (const row of rows) {
    const v = toNumberOrNull(row?.cost);
    if (v != null) sum += v;
  }
  return { ADDITIONAL_BONUS: sum };
}

/**
 * Build one audit log row per Nexus deal-sheet client cost (flat schema).
 */
function mapClientCostLogRowsForDealSheet(clientCostRows, contextRow, captureTimestamp) {
  if (!clientCostRows || !clientCostRows.length) return [];
  const ts = captureTimestamp != null ? captureTimestamp : new Date().toISOString();
  const dealSheetId = toIntOrNull(contextRow?.DEAL_SHEET_ID);
  const placementId = toIntOrNull(contextRow?.PLACEMENT_ID);
  const startDate = formatDateStringForBq(contextRow?.START_DATE) ?? (
    contextRow?.START_DATE == null || String(contextRow.START_DATE).trim() === ""
      ? null
      : String(contextRow.START_DATE).trim()
  );
  const tentativeDate = formatDateStringForBq(contextRow?.TENTATIVE_DATE) ?? (
    contextRow?.TENTATIVE_DATE == null || String(contextRow.TENTATIVE_DATE).trim() === ""
      ? null
      : String(contextRow.TENTATIVE_DATE).trim()
  );
  const candidateName = contextRow?.CANDIDATE_NAME ?? null;
  const candidateEmail = contextRow?.CANDIDATE_EMAIL ?? null;
  const recruiterEmail = contextRow?.ASSIGNMENT_RECRUITER_EMAIL ?? null;

  const out = [];
  for (const item of clientCostRows) {
    const lineId = toIntOrNull(item?.id);
    const nameRaw = item?.cost_name;
    const name = nameRaw == null ? null : String(nameRaw).trim() || null;
    if (lineId == null && name == null && toNumberOrNull(item?.cost) == null) continue;

    out.push({
      DATE_AND_TIME: ts,
      DEAL_SHEET_ID: dealSheetId,
      PLACEMENT_ID: placementId,
      CANDIDATE_NAME: candidateName,
      CANDIDATE_EMAIL: candidateEmail,
      ASSIGNMENT_RECRUITER_EMAIL: recruiterEmail,
      START_DATE: startDate,
      TENTATIVE_DATE: tentativeDate,
      ADDITIONAL_COST_ID: lineId,
      ADDITIONAL_COST_NAME: name,
      CATEGORY:
        item?.deal_sheet_category == null
          ? null
          : String(item.deal_sheet_category).trim() || null,
      DURATION:
        item?.duration == null ? null : String(item.duration).trim() || null,
      VALUE: toNumberOrNull(item?.cost) ?? 0,
      NOTES: null,
    });
  }
  return out;
}

/**
 * Parse Nexus binary flag to boolean
 */
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

/**
 * Canada tax type from Nexus deal sheet ten_ninty_nine_checked.
 * true (1099) -> T4A; false/null -> T4.
 */
function mapCanadaTypeFromTenNintyNine(dealSheet) {
  const is1099 = nexusBinaryFlagToBoolean(dealSheet?.ten_ninty_nine_checked);
  return is1099 ? "T4A" : "T4";
}

/**
 * Map deal sheet rate change to BigQuery schema
 */
function mapDealSheetRateChangeToBq(items, jobId) {
  if (jobId == null || String(jobId).trim() === "") return { RATE_CHANGE: null };
  const jid = String(jobId);
  if (!items || !items.length) return { RATE_CHANGE: "NO" };
  let row = null;
  for (const item of items) {
    if (String(item?.job) === jid) {
      row = item;
      break;
    }
  }
  if (!row) return { RATE_CHANGE: "NO" };
  return { RATE_CHANGE: nexusBinaryFlagToBoolean(row.is_rate_change) ? "YES" : "NO" };
}

/**
 * Map submittal status to placement status
 */
function mapSubmittalStatusToPlacementStatus(rawStatus) {
  if (rawStatus == null || String(rawStatus).trim() === "") return null;
  const s = String(rawStatus).trim();
  const key = s.toLowerCase();
  if (key === "offer rejected") return "DID NOT ACCEPT";
  if (key === "completed") return "ENDED";
  if (key === "active") return "STARTED";
  if (key === "perm starts") return "STARTED";
  if (key === "cancelled" || key === "canceled") return "DID NOT START";
  if (key === "booked") return "BOOKED";
  return s;
}

/**
 * Map organization_submittal_status.code to placement status
 */
function mapSubmittalCodeToPlacementStatus(rawCode, fallbackLabel = null) {
  if (rawCode == null || String(rawCode).trim() === "") {
    return mapSubmittalStatusToPlacementStatus(fallbackLabel);
  }
  const code = String(rawCode).trim().toUpperCase();
  if (code === "OFFER_REJECTED") return "DID NOT ACCEPT";
  if (code === "COMPLETED") return "ENDED";
  if (code === "ACTIVE" || code === "PERM_STARTS") return "STARTED";
  if (code === "CANCELLED" || code === "CANCELED") return "DID NOT START";
  if (code === "BOOKED") return "BOOKED";
  return mapSubmittalStatusToPlacementStatus(fallbackLabel != null ? fallbackLabel : code);
}

/**
 * Calculate date diff in days
 */
function dateDiffDaysEndMinusStart(startStr, endStr) {
  const startMs = parseDateStringForDiff(startStr);
  const endMs = parseDateStringForDiff(endStr);
  if (startMs == null || endMs == null) return null;
  return Math.floor((endMs - startMs) / 86400000);
}

/**
 * Round numeric value to 2 decimals
 */
function round2(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * SAFE_DIVIDE behavior (BigQuery-like)
 */
function safeDivide(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * Normalize CLIENT_MSP_FEE to fraction [0..1]
 */
function normalizeMspFeeFraction(value) {
  const fee = toNumberOrNull(value);
  if (fee == null) return 0;
  let out = fee;
  if (out > 1) out = out / 100;
  if (out < 0) out = 0;
  if (out > 1) out = 1;
  return out;
}

/**
 * Sum terms where any null term yields null
 */
function sumOrNull(values) {
  let total = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}

/** Placement statuses for which DAYS_WORKED = END_DATE - START_DATE is computed. */
const DAYS_WORKED_ELIGIBLE_STATUSES = new Set([
  "ENDED",
  "ENDED<30",
  "DID NOT START",
  "DID NOT ACCEPT",
]);

/**
 * Compute derived placement metrics for active sync rows
 */
function computeDerivedPlacementFields(row) {
  if (isCynetHealthCanadaRecruiter(row?.ASSIGNMENT_RECRUITER_EMAIL)) {
    return computeCanadaDerivedPlacementFields(row);
  }

  const payRate = toNumberOrNull(row?.PAY_RATE);
  const typeVal = row?.TYPE == null ? null : String(row.TYPE).trim();
  const weeklyPerDiem = toNumberOrNull(row?.WEEKLY_PER_DIEM_NON_TAXED) ?? 0;
  const weeklyWalletMoney = toNumberOrNull(row?.WEEKLY_WALLET_MONEY) ?? 0;
  const scheduleHours1 = toNumberOrNull(row?.SCHEDULE_HOURS_1) ?? 0;
  const additionalBonus = toNumberOrNull(row?.ADDITIONAL_BONUS) ?? 0;
  const orientationHours = toNumberOrNull(row?.ORIENTATION_HOURS) ?? 0;
  const initialWeeks = toNumberOrNull(row?.INITIAL_PROJECT_DURATION_IN_WEEKS) ?? 0;
  const billRate = toNumberOrNull(row?.BILL_RATE);
  const placementType = row?.PLACEMENT_TYPE == null ? "" : String(row.PLACEMENT_TYPE).trim().toUpperCase();
  const parentClientName = row?.PARENT_CLIENT_NAME == null ? "" : String(row.PARENT_CLIENT_NAME).trim();
  const otRate = toNumberOrNull(row?.OT_RATE);
  const clientOtRate = toNumberOrNull(row?.CLIENT_OT_RATE);
  const mspFeeFraction = normalizeMspFeeFraction(row?.CLIENT_MSP_FEE);

  let w2PayRate = null;
  if (payRate == null) {
    w2PayRate = null;
  } else if (!typeVal) {
    const ghBase = scheduleHours1 === 0 ? 40 : scheduleHours1;
    const spanBase = scheduleHours1 === 0 || initialWeeks === 0 ? 40 * 13 : scheduleHours1 * initialWeeks;
    const perDiemTerm = safeDivide(weeklyPerDiem + (weeklyWalletMoney * 1.14), ghBase);
    const bonusTerm = safeDivide(additionalBonus * 1.14, spanBase);
    const orientationPayTerm = safeDivide(orientationHours * (payRate * 1.14), spanBase);
    const orientationPerDiemTerm = scheduleHours1 === 0 || initialWeeks === 0
      ? safeDivide(
        orientationHours * (safeDivide(weeklyPerDiem, 40) ?? 0),
        (40 * 13) - 40
      )
      : safeDivide(
        orientationHours * (safeDivide(weeklyPerDiem, scheduleHours1 === 0 ? 1 : scheduleHours1) ?? 0),
        (scheduleHours1 * initialWeeks) - orientationHours
      );
    const sum = sumOrNull([
      payRate * 1.14,
      perDiemTerm,
      bonusTerm,
      orientationPayTerm,
      orientationPerDiemTerm,
    ]);
    w2PayRate = round2(sum);
  } else {
    const ghBase = scheduleHours1 === 0 ? 40 : scheduleHours1;
    const spanBase = scheduleHours1 === 0 || initialWeeks === 0 ? 40 * 13 : scheduleHours1 * initialWeeks;
    const sum = sumOrNull([
      payRate,
      safeDivide(weeklyPerDiem + weeklyWalletMoney, ghBase),
      safeDivide(additionalBonus, spanBase),
      safeDivide(orientationHours * payRate, spanBase),
    ]);
    w2PayRate = round2(sum);
  }

  let finalPayRate;
  if (w2PayRate == null || payRate == null) finalPayRate = round2(0);
  else if (parentClientName === "Cynet Locum") finalPayRate = round2(w2PayRate);
  else finalPayRate = round2(w2PayRate + 1);

  let finalBillRate = null;
  if (billRate != null && billRate !== 0) {
    finalBillRate = round2(billRate * (1 - mspFeeFraction));
  }

  let finalCost = null;
  if (finalPayRate != null && finalPayRate !== 0) {
    finalCost = round2(finalPayRate * 1.08);
  }

  let netMargin = null;
  if (placementType === "FT") netMargin = 0;
  else if (finalBillRate == null || finalBillRate === 0) netMargin = null;
  else if (finalPayRate == null || finalPayRate === 0) netMargin = null;
  else netMargin = round2(finalBillRate - round2(finalPayRate * 1.08));

  let gmOt = null;
  if (otRate == null || otRate === 0) gmOt = null;
  else if (clientOtRate != null && (otRate * clientOtRate) !== 0) {
    gmOt = round2((clientOtRate * (1 - mspFeeFraction)) - ((otRate * 1.15) + 1));
  }

  let daysWorked = 0;
  const statusRaw = row?.PLACEMENT_STATUS == null
    ? ""
    : String(row.PLACEMENT_STATUS).trim().toUpperCase();
  if (DAYS_WORKED_ELIGIBLE_STATUSES.has(statusRaw)) {
    const endDateRaw = row?.END_DATE == null ? "" : String(row.END_DATE).trim();
    const startDateRaw = row?.START_DATE == null ? "" : String(row.START_DATE).trim();
    if (endDateRaw && startDateRaw) {
      const diff = dateDiffDaysEndMinusStart(startDateRaw, endDateRaw);
      daysWorked = diff == null ? 0 : diff;
    }
  }

  return {
    W2_PAY_RATE: w2PayRate,
    FINAL_PAY_RATE: finalPayRate,
    FINAL_BILL_RATE: finalBillRate,
    FINAL_COST: finalCost,
    NET_MARGIN: netMargin,
    GM_OT: gmOt,
    DAYS_WORKED: daysWorked,
  };
}

/**
 * Map early term placement status
 */
function mapEarlyTermPlacementStatus(submittalRow, jobObj) {
  const startStr = submittalRow?.start_date ?? jobObj?.start_date ?? null;
  const endStr = submittalRow?.end_date ?? jobObj?.end_date ?? null;
  const days = dateDiffDaysEndMinusStart(startStr, endStr);
  if (days == null) return null;
  if (days < 30) return "ENDED<30";
  return "ENDED";
}

/**
 * Compute END_DATE from submittal status + dates.
 * Submittal organization_submittal_status is reliable; job.job_status is often null.
 * Falls back to computeBqEndDateFromJob when submittal status is unknown.
 */
function computeBqEndDateFromSubmittal(submittalRow, jobObj) {
  if (!submittalRow) return computeBqEndDateFromJob(jobObj);

  const orgStatus = submittalRow.organization_submittal_status;
  const codeRaw = orgStatus?.code;
  const labelRaw = orgStatus?.submittal_status;
  const code = codeRaw == null ? "" : String(codeRaw).trim().toUpperCase();
  const label = labelRaw == null ? "" : String(labelRaw).trim().toLowerCase();

  const isEnded =
    code === "COMPLETED" ||
    code === "EARLY_TERM" ||
    label === "completed" ||
    label === "early term";
  const isCancelled =
    code === "CANCELLED" ||
    code === "CANCELED" ||
    code === "OFFER_REJECTED" ||
    label === "cancelled" ||
    label === "canceled" ||
    label === "offer rejected";
  const isActiveBooked =
    code === "ACTIVE" ||
    code === "PERM_STARTS" ||
    code === "BOOKED" ||
    label === "active" ||
    label === "perm starts" ||
    label === "booked";

  const endRaw = submittalRow?.end_date ?? jobObj?.end_date ?? null;
  const startRaw = submittalRow?.start_date ?? jobObj?.start_date ?? null;

  if (isEnded) return formatDateStringForBq(endRaw);
  if (isCancelled) return formatDateStringForBq(startRaw);
  if (isActiveBooked) {
    const endMs = parseDateStringForDiff(endRaw);
    const todayMs = startOfTodayMs();
    if (endMs != null && todayMs != null && endMs <= todayMs) {
      return formatDateStringForBq(endRaw);
    }
    return null;
  }

  return computeBqEndDateFromJob(jobObj);
}

/**
 * Resolve placement status from submittal
 */
function resolvePlacementStatusFromSubmittal(submittalRow, jobObj) {
  const jobStatusRaw = submittalRow?.organization_submittal_status?.submittal_status ?? null;
  if (jobStatusRaw == null || String(jobStatusRaw).trim() === "") return null;
  const key = String(jobStatusRaw).trim().toLowerCase();
  if (key === "early term") {
    const early = mapEarlyTermPlacementStatus(submittalRow, jobObj);
    if (early != null) return early;
    return String(jobStatusRaw).trim();
  }
  return mapSubmittalStatusToPlacementStatus(jobStatusRaw);
}

/**
 * Map job submittal to BigQuery schema
 */
function mapJobSubmittalToBq(submittalRow, jobObj) {
  if (!submittalRow) return {};
  function firstNonEmptyDate(...values) {
    for (const value of values) {
      if (value == null) continue;
      const s = String(value).trim();
      if (s !== "") return s;
    }
    return null;
  }
  const id = submittalRow.id;
  const n = id == null || id === "" ? null : Number(id);
  const submitted = submittalRow.submitted_date;
  const submittedStr = submitted == null || String(submitted).trim() === ""
    ? null : String(submitted).trim();
  const startRaw =
    submittalRow?.start_date == null || String(submittalRow.start_date).trim() === ""
      ? null
      : String(submittalRow.start_date).trim();
  const startDate = startRaw;
  const tentativeRaw = firstNonEmptyDate(submittalRow?.end_date, jobObj?.end_date);
  const tentativeDate = formatDateStringForBq(tentativeRaw) ?? (
    tentativeRaw == null || String(tentativeRaw).trim() === ""
      ? null
      : String(tentativeRaw).trim()
  );
  return {
    PLACEMENT_ID: n != null && Number.isFinite(n) ? Math.trunc(n) : null,
    SUBMISSION_DATE: submittedStr,
    PLACEMENT_STATUS: resolvePlacementStatusFromSubmittal(submittalRow, jobObj || null),
    START_DATE: startDate,
    TENTATIVE_DATE: tentativeDate,
    END_DATE: computeBqEndDateFromSubmittal(submittalRow, jobObj || null),
  };
}

/**
 * Map deal sheet rates list to BigQuery schema.
 * CA state uses PR_GREATER_THAN_EIGHT / BR_GREATER_THAN_EIGHT for OT rates;
 * all other states use PR_GREATER_THAN_FOURTY / BR_GREATER_THAN_FOURTY.
 */
function mapDealSheetRatesListToBq(rateRows, clientState) {
  if (!rateRows || !rateRows.length) return {};
  const byCode = {};
  for (const r of rateRows) {
    const code = r?.bill_rate_code;
    if (code == null || String(code).trim() === "") continue;
    const key = String(code);
    if (byCode[key] === undefined) byCode[key] = toNumberOrNull(r?.rate);
  }

  function pick(code) {
    const v = byCode[code];
    return v === undefined ? null : v;
  }

  const stateNorm = clientState == null || String(clientState).trim() === ""
    ? null
    : String(clientState).trim().toUpperCase();
  const isCa = stateNorm === "CA";
  const otCode = isCa ? "PR_GREATER_THAN_EIGHT" : "PR_GREATER_THAN_FOURTY";
  const clientOtCode = isCa ? "BR_GREATER_THAN_EIGHT" : "BR_GREATER_THAN_FOURTY";

  return {
    CLIENT_HOLIDAY_RATE: pick("BR_HOLIDAY_RATE"),
    OT_RATE: pick(otCode),
    PAY_RATE: pick("PR_REGULAR_PAY_RATE"),
    HOLIDAY_RATE: pick("PR_HOLIDAY_RATE"),
    ON_CALL_RATE: pick("PR_ON_CALL_RATE"),
    CLIENT_OT_RATE: pick(clientOtCode),
    CLIENT_ON_CALL_RATE: pick("BR_ON_CALL_RATE"),
    BILL_RATE: pick("BR_REGULAR_BILL_RATE"),
    CALL_BACK_RATE: pick("PR_CALL_BACK_RATE"),
    CLIENT_CALL_BACK_RATE: pick("BR_CALL_BACK_RATE"),
  };
}

/**
 * FLOAT64 columns sourced from Nexus that should store 0 in BigQuery when API value is null/blank.
 * Applied after computeDerivedPlacementFields so derived metrics still see null for missing inputs.
 */
const API_FLOAT_COLUMNS_DEFAULT_ZERO = [
  "BILL_RATE",
  "PAY_RATE",
  "OT_RATE",
  "HOLIDAY_RATE",
  "ON_CALL_RATE",
  "CALL_BACK_RATE",
  "CLIENT_OT_RATE",
  "CLIENT_HOLIDAY_RATE",
  "CLIENT_ON_CALL_RATE",
  "CLIENT_CALL_BACK_RATE",
  "CLIENT_MSP_FEE",
  "WEEKLY_PER_DIEM_NON_TAXED",
  "ORIENTATION_HOURS",
  "INITIAL_PROJECT_DURATION_IN_WEEKS",
  "GP_PERCENTAGE",
  "GROSS_MARGIN",
  "PO_HOURS",
  "TOTAL_BONUS_TAXABLE",
  "TOTAL_BONUS_NON_TAXABLE",
  "FIRST_WEEK_HOURS",
  "SECOND_WEEK_HOURS",
];

function coerceApiFloatNullsToZero(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const key of API_FLOAT_COLUMNS_DEFAULT_ZERO) {
    const v = out[key];
    if (v == null || (typeof v === "number" && !Number.isFinite(v))) {
      out[key] = 0;
    }
  }
  return out;
}

/** Placement statuses eligible for cancellation/termination detail API lookup. */
const TERMINATION_API_ELIGIBLE_PLACEMENT_STATUSES = new Set([
  "ENDED",
  "ENDED<30",
  "DID NOT START",
  "DID NOT ACCEPT",
  "CANCELLED",
  "CANCELED",
]);

function normalizePlacementStatusKeyForTermination(status) {
  if (status == null) return "";
  return String(status).trim().toUpperCase().replace(/\s+/g, " ");
}

/** Uppercase trimmed placement status key (e.g. DID NOT START). */
function normalizePlacementStatusKey(status) {
  return normalizePlacementStatusKeyForTermination(status);
}

function isDidNotStartPlacementStatus(status) {
  return normalizePlacementStatusKey(status) === "DID NOT START";
}

/**
 * TENTATIVE_DATE for enriched row: null when placement is DID NOT START.
 * @param {string|null|undefined} placementStatus
 * @param {string|null|undefined} tentativeDate
 * @returns {string|null}
 */
function resolveTentativeDateForPlacementRow(placementStatus, tentativeDate) {
  if (isDidNotStartPlacementStatus(placementStatus)) return null;
  if (tentativeDate == null) return null;
  const s = String(tentativeDate).trim();
  return s === "" ? null : tentativeDate;
}

function isTerminationApiEligiblePlacementStatus(status) {
  const key = normalizePlacementStatusKeyForTermination(status);
  return key !== "" && TERMINATION_API_ELIGIBLE_PLACEMENT_STATUSES.has(key);
}

function submittalNoteStatusCode(note) {
  const code = note?.org_submittal_status?.code;
  return code == null ? "" : String(code).trim().toUpperCase();
}

function submittalNoteTimestampMs(note) {
  const raw = note?.modified_date ?? note?.created_date;
  if (raw == null || String(raw).trim() === "") return Number.POSITIVE_INFINITY;
  const ms = Date.parse(String(raw).trim());
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Earliest BOOKED job-submittal-note modified_date for NEW_HIRE_DATE.
 * @param {object[]} notes
 * @returns {string|null}
 */
function resolveNewHireDateFromSubmittalNotes(notes) {
  if (!notes || notes.length === 0) return null;
  let earliestMs = Number.POSITIVE_INFINITY;
  let earliestRaw = null;
  for (const note of notes) {
    if (submittalNoteStatusCode(note) !== "BOOKED") continue;
    const ms = submittalNoteTimestampMs(note);
    if (ms < earliestMs) {
      earliestMs = ms;
      const raw = note?.modified_date ?? note?.created_date;
      earliestRaw = raw == null ? null : String(raw).trim() || null;
    }
  }
  return earliestRaw;
}

/**
 * NEW_HIRE_DATE from submittal notes for DEAL rows only; EXTENSION always null.
 * @param {string|null|undefined} dealType
 * @param {object[]} notes
 * @returns {string|null}
 */
function resolveNewHireDateForDealRow(dealType, notes) {
  const key = dealType == null ? "" : String(dealType).trim().toUpperCase();
  if (key !== "DEAL") return null;
  return resolveNewHireDateFromSubmittalNotes(notes);
}

/**
 * Pick display VALUE from cancellation/termination API item (priority order).
 */
function extractTerminationReasonValue(apiItem) {
  if (!apiItem || typeof apiItem !== "object") return null;
  const cr = apiItem.cancellation_reason;
  if (cr?.value != null && String(cr.value).trim() !== "") return String(cr.value).trim();
  const et = apiItem.early_term_reason;
  if (et?.value != null && String(et.value).trim() !== "") return String(et.value).trim();
  const ctr = apiItem.cancellation_termination_reason;
  if (ctr != null && typeof ctr === "object" && ctr.value != null && String(ctr.value).trim() !== "") {
    return String(ctr.value).trim();
  }
  if (typeof ctr === "string" && ctr.trim() !== "") return ctr.trim();
  return null;
}

function pickLatestTerminationDetailItem(items) {
  if (!items || items.length === 0) return null;
  if (items.length === 1) return items[0];
  const sorted = [...items].sort((a, b) => {
    const ma = Date.parse(a?.modified_date || a?.created_date || 0);
    const mb = Date.parse(b?.modified_date || b?.created_date || 0);
    return (Number.isFinite(mb) ? mb : 0) - (Number.isFinite(ma) ? ma : 0);
  });
  return sorted[0] ?? null;
}

/**
 * Build one termination-reason log row from Nexus cancellation/termination API item.
 */
function mapTerminationReasonLogRowForDealSheet(apiItem, contextRow, captureTimestamp) {
  if (!apiItem || typeof apiItem !== "object") return null;
  const detailId = toIntOrNull(apiItem.id);
  if (detailId == null) return null;
  const ts = captureTimestamp != null ? captureTimestamp : new Date().toISOString();
  const value = extractTerminationReasonValue(apiItem);
  const cancelledBy = apiItem.cancelled_by == null ? null : String(apiItem.cancelled_by).trim() || null;
  const notes = apiItem.notes == null ? null : String(apiItem.notes).trim() || null;
  const terminationType =
    apiItem.termination_type == null ? null : String(apiItem.termination_type).trim() || null;
  const dnrAt = apiItem.dnr_at == null ? null : String(apiItem.dnr_at).trim() || null;
  if (value == null && cancelledBy == null && notes == null && terminationType == null && dnrAt == null) {
    return null;
  }
  return {
    DATE_AND_TIME: ts,
    DEAL_SHEET_ID: toIntOrNull(contextRow?.DEAL_SHEET_ID),
    PLACEMENT_ID: toIntOrNull(contextRow?.PLACEMENT_ID),
    CONTRACT_ID: toIntOrNull(contextRow?.CONTRACT_ID),
    TERMINATION_DETAIL_ID: detailId,
    CANCELLED_BY: cancelledBy,
    NOTES: notes,
    VALUE: value,
    TERMINATION_TYPE: terminationType,
    DNR_AT: dnrAt,
  };
}

/**
 * Columns owned by the Nexus enrichment pipeline (updated from API on append).
 * Manual fields are listed explicitly in MANUAL_COLUMNS.
 */
const API_OWNED_COLUMNS = new Set([
  "END_CLIENT_DEPT_FACILITY",
  "CITY_ZIPCODE",
  "CLIENT_STATE",
  "REGION",
  "NEXUS_PARENT_CLIENT_ID",
  "PARENT_CLIENT_NAME",
  "DEAL_SHEET_ID",
  "DEAL_SHEET_STATUS",
  "NEXUS_INTERNAL_JOB_ID",
  "CANDIDATE_NEXUS_ID",
  "CLIENT_ID",
  "WEEKLY_PER_DIEM_NON_TAXED",
  "DEAL_TYPE",
  "GP_PERCENTAGE",
  "CLIENT_MSP_FEE",
  "ORIENTATION_HOURS",
  "INITIAL_PROJECT_DURATION_IN_WEEKS",
  "VMS",
  "CANDIDATE_NAME",
  "CANDIDATE_STATUS",
  "CANDIDATE_EMAIL",
  "PHONE_NUMBER",
  "PROVIDER_TYPE",
  "RECRUITER_ID",
  "ASSIGNMENT_RECRUITER",
  "ASSIGNMENT_RECRUITER_EMAIL",
  "CLIENT_SALES_REP",
  "CLIENT_SALES_REP_ID",
  "ONSITE_AM",
  "ONSITE_AM_EMAIL",
  "VMS_JOB_ID",
  "START_DATE",
  "OFFER_TIME_START_DATE",
  "END_DATE",
  "OFFERING",
  "JOB_TYPE",
  "PLACEMENT_TYPE",
  "PLACEMENT_ID",
  "SUBMISSION_DATE",
  "PLACEMENT_STATUS",
  "TERMINATION_REASON",
  "MSP_ID",
  "MSP_NAME",
  "LINE_OF_BUSINESS",
  "CLIENT_TYPE",
  "CATEGORIZATION_OF_POSITION",
  "CATEGORIZATION_OF_POSITION_ID",
  "POSITION",
  "POSITION_ID",
  "PO_HOURS",
  "SCHEDULE_HOURS_1",
  "SCHEDULE_HOURS_2",
  "REGULAR_HOURS_1",
  "REGULAR_HOURS_2",
  "GROSS_MARGIN",
  "ADDITIONAL_BONUS",
  "RATE_CHANGE",
  "BILL_RATE",
  "PAY_RATE",
  "OT_RATE",
  "HOLIDAY_RATE",
  "ON_CALL_RATE",
  "CLIENT_HOLIDAY_RATE",
  "CLIENT_OT_RATE",
  "CLIENT_ON_CALL_RATE",
  "CALL_BACK_RATE",
  "CLIENT_CALL_BACK_RATE",
  "W2_PAY_RATE",
  "T4_PAY_RATE",
  "FINAL_PAY_RATE",
  "FINAL_BILL_RATE",
  "FINAL_COST",
  "NET_MARGIN",
  "GM_OT",
  "DAYS_WORKED",
  "W2_PAY_RATE_NEW",
  "FINAL_PAY_RATE_NEW",
  "FINAL_COST_NEW",
  "FINAL_BILL_RATE_NEW",
  "NEW_MARGIN",
  "TOTAL_BONUS_TAXABLE",
  "TOTAL_BONUS_NON_TAXABLE",
  "FIRST_WEEK_HOURS",
  "SECOND_WEEK_HOURS",
  "CONTRACT_ID",
]);
Object.freeze(API_OWNED_COLUMNS);

/**
 * Columns written by the insert pipeline itself (never carried forward from baseline).
 * `ID` is generated per insert, `DATE_AND_TIME` is set at insert time,
 * `IS_REJECTED` is reset by applyIsRejectedResetForChangedUpdate,
 * `MOVE_RUNRATE` is gated by applyMoveRunrateAppendOverride,
 * `TENTATIVE_DATE` is cleared when PLACEMENT_STATUS is DID NOT START; otherwise frozen by
 * applyTentativeDateFreeze (release on START_DATE change),
 * `NEW_HIRE_DATE` is set from job-submittal-notes (earliest BOOKED modified_date) for DEAL rows when baseline is empty;
 * EXTENSION rows are not set from API on enrich; once baseline has a value it is frozen on update-append (DEAL or EXTENSION)
 * unless `NEW_HIRE_DATE_FREEZE_ENABLED=false` (one-time migration to rewrite legacy insert-time stamps).
 */
const SYSTEM_CONTROLLED_COLUMNS = new Set([
  "ID",
  "DATE_AND_TIME",
  "IS_REJECTED",
  "MOVE_RUNRATE",
  "TENTATIVE_DATE",
  "NEW_HIRE_DATE",
]);
Object.freeze(SYSTEM_CONTROLLED_COLUMNS);

/**
 * Manual BigQuery-edited columns (see sql/create_domain_deal_sheet_tables.sql).
 * Carried forward from baseline on update-append; never overwritten by Nexus enrich.
 */
const MANUAL_COLUMNS = new Set([
  "ACC_DIR_OR_VERT_HEAD",
  "AGENCY_SWITCH",
  "ASSOCIATE_AM",
  "ASSOCIATE_AM_EMP_NO",
  "ASSOCIATE_JUNIOR_CSM",
  "ASSOCIATE_SALES_PERSON",
  "ACCOUNT_MANAGER",
  "ACCOUNT_MANAGER_EMP_NO",
  "ATL",
  "ATL_EMP_NO",
  "BACKOUT_OR_TERMINATION",
  "BGC_AGENCY_NAME",
  "BGC_AMOUNT1",
  "BGC_AMOUNT2",
  "BGC_AMOUNT3",
  "BGC_CATEGORY1",
  "BGC_CATEGORY2",
  "BGC_CATEGORY3",
  "BGC_TOTAL_BGV_COST",
  "BOOKING_DATE",
  "CAND_PYMT_TERMS",
  "CLIENT_CREATED_DATE",
  "CLIENT_NAME_IN_CONREP",
  "CLIENT_OWNER",
  "CLIENT_RECRUITER",
  "CLIENT_START_DATE",
  "CLT_PYMT_TERM",
  "COMMENTS",
  "CREDENTIALING_LEAD",
  "CREDENTIALING_SPECIALIST",
  "DELIVERY_DIRECTOR",
  "DELIVERY_DIRECTOR_EMP_NO",
  "DELIVERY_POC",
  "DIRECTOR_CLIENT_PARTNERSHIP",
  "DIVERSITY_STATUS",
  "DT_RATE",
  "CLIENT_DT_RATE",
  "EDIT_DATE",
  "EDITED_BY",
  "EFFECTIVE_DATE",
  "ENTITY",
  "EXTENSION_DATE",
  "FINAL_INVOICE_PENDING",
  "FIFTYTWO_TENURE_CANDIDATE_STATUS",
  "FIFTYTWO_TENURE_RTO_LASTDATE",
  "GROUP_DIRECTOR",
  "GRP_DIR_ASSOC_GRP_DIR",
  "GRP_DIR_ASSOC_GRP_DIR_EMP_NO",
  "HOURLY_GP",
  "INV_CYC_TO_CLT",
  "LEVEL_2_CSM",
  "LEVEL_3_CSM",
  "LEVEL_4_CSM",
  "IS_DELETED",
  "ONB_CAND_DOB",
  "ONB_E_VERIFY",
  "ONB_I9_RECIEVED",
  "ONB_SUPP_DOC1",
  "ONB_SUPP_DOC1_EXP_DT",
  "ONB_SUPP_DOC2",
  "ONB_SUPP_DOC2_EXP_DT",
  "ONSITE_CLIENT_OWNER",
  "ONSITE_OWNER",
  "ONSITE_VP_AVP",
  "ORIGINAL_START_DATE",
  "PAYLOCITY_ID",
  "PO_RECEIVED",
  "PRIMARY_SALES_PERSON",
  "RECRUITER_CLUSTER",
  "RECRUITMENT_MENTOR",
  "REJECTION_REASON",
  "RM",
  "RM_EMP_NO",
  "SECONDARY_AM",
  "SECONDARY_AM_EMP_NO",
  "SECONDARY_EMAIL",
  "SECONDARY_RECRUITER",
  "SECONDARY_RECRUITER_EMP_NO",
  "SECONDARY_SALES_PERSON",
  "SKU_NUMBER",
  "ST_DT_PUSHBACK_REASON",
  "TEAM_LEAD",
  "TEAM_LEAD_EMP_NO",
  "TYPE",
  "UPDATED_AT",
  "VP_SRVP",
  "VP_SRVP_EMP_NO",
  "WEEKLY_WALLET_MONEY",
]);
Object.freeze(MANUAL_COLUMNS);

module.exports = {
  toNumberOrNull,
  addNumbersOrNull,
  trimContactValue,
  mapUsStateCodeToRegion,
  mapClientToBq,
  mapDealSheetCandidateToBq,
  mapDealSheetDetailToBq,
  mapUserToFullName,
  mapCandidateToBq,
  mapCandidateCandidateTypesToBq,
  mapDealSheetUsersToBq,
  mapJobToBq,
  pickClientOfferingRowForJob,
  clientOfferingHasClientTypeText,
  resolveClientOfferingForEnrich,
  mapMspFromClientOfferingRow,
  mapJobProfessionSpecialtyFromJob,
  mapDealSheetHoursDetailsToBq,
  mapDealSheetRevenueDetailsToBq,
  mapDealSheetAdditionalCostsToBq,
  mapAdditionalCostLogRowsForDealSheet,
  mapTravelAllowanceToAdditionalBonus,
  mapTravelAllowanceLogRowsForDealSheet,
  mapDealSheetClientCostsToAdditionalBonus,
  mapClientCostLogRowsForDealSheet,
  mapDealSheetRateChangeToBq,
  mapJobSubmittalToBq,
  computeBqEndDateFromSubmittal,
  mapDealSheetRatesListToBq,
  mapCanadaTypeFromTenNintyNine,
  nexusBinaryFlagToBoolean,
  mapSubmittalCodeToPlacementStatus,
  computeDerivedPlacementFields,
  startDateOnOrAfterUtcMin,
  effectiveMinFilterDate,
  coerceApiFloatNullsToZero,
  isTerminationApiEligiblePlacementStatus,
  normalizePlacementStatusKey,
  isDidNotStartPlacementStatus,
  resolveTentativeDateForPlacementRow,
  resolveNewHireDateFromSubmittalNotes,
  resolveNewHireDateForDealRow,
  extractTerminationReasonValue,
  pickLatestTerminationDetailItem,
  mapTerminationReasonLogRowForDealSheet,
  API_OWNED_COLUMNS,
  SYSTEM_CONTROLLED_COLUMNS,
  MANUAL_COLUMNS,
};
