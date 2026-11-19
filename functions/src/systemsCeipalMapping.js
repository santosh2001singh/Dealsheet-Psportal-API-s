/**
 * Cynet Systems runrate: maps one record of the CEIPAL "Runrate Tool" report (placements-daily-sync)
 * to a cynet_systems_deal_sheet row, and computes the formula columns.
 *
 * Pure functions only (no I/O), so the whole mapping can be unit-tested and replayed against an
 * export. Column names follow cynetdatabase.cynet_Data.CS_TABLE_RUNRATE so rows line up with
 * all_CS_data_runrate (the copied history).
 *
 * Formula columns, from the Systems runrate Google Sheet:
 *   FINAL BILL RATE  = BILL RATE - BILL RATE x CLIENT MSP FEE
 *   MARGIN (sheet)   = FINAL BILL RATE - FINAL COST     -> stored as CALCULATED_MARGIN (and NET_MARGIN)
 *   DELIVERY VALUE   = FINAL BILL RATE - FINAL PAY RATE -> stored as GROSS_MARGIN (the BQ name)
 *   DAYS WORKED      = END DATE - START DATE (blank while there is no end date)
 * FINAL PAY RATE / FINAL COST were read off the existing BQ data (1342/1343 and 1333/1343 rows):
 *   FINAL PAY RATE   = PAY RATE x (1 + loading) + PER DIEM  (loading 14% W2, 0% C2C/INC)
 *   FINAL COST       = FINAL PAY RATE + PAY RATE x overhead (overhead 9% W2, 7% C2C/INC)
 * Rows of all three CEIPAL businesses are written, told apart by ENTITY: SYSTEMS, HEALTH
 * (LabCorp/Quest, H-SKUs) and CANADA (CAD rates; own FINAL_PAY_RATE / FINAL_COST rule, see
 * computeRunrateFormulas). HEALTH uses the Systems formula: the Health sheet's hours-based formula
 * needs schedule/PO hours CEIPAL does not have.
 * MARGIN itself holds CEIPAL's own margin (Bill - Pay), the way Health's MARGIN holds Nexus's
 * hourly revenue; GP_PERCENTAGE holds CEIPAL's Profit Margin %.
 */

const DEFAULT_RATES = Object.freeze({
  w2Loading: 0.14,
  w2Overhead: 0.09,
  c2cLoading: 0,
  c2cOverhead: 0.07,
  canadaCostFactor: 1.08,
});

/** classifyCeipalRecord result -> ENTITY written on the row. */
const ENTITY_BY_CLASS = Object.freeze({ systems: "SYSTEMS", health: "HEALTH", canada: "CANADA" });

/** CEIPAL placeholders that mean "nobody / nothing". */
const EMPTY_TOKENS = new Set(["", "na", "n/a", "null", "none", "test account", "0000-00-00", "."]);

const STATE_CODES = Object.freeze({
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Puerto Rico": "PR", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  Ontario: "ON", Alberta: "AB", Quebec: "QC", "British Columbia": "BC", Manitoba: "MB",
  Saskatchewan: "SK", "Nova Scotia": "NS", "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL", "Prince Edward Island": "PE",
});

const TAX_TERMS_TO_TYPE = Object.freeze({
  "w2 - profit sharing": "W2",
  "w-2": "W2",
  w2: "W2",
  c2c: "C2C",
  inc: "C2C",
  "full time": "FT",
  "1099": "1099",
  t4: "T4",
});

const CLIENT_CATEGORY_TO_CLIENT_TYPE = Object.freeze({
  msp: "Commercial",
  "system integrator": "SI",
  public: "Government",
  direct: "Direct",
});

const INVOICE_FREQUENCY_TO_CYCLE = Object.freeze({
  "per week": "Weekly",
  "bi-weekly": "Weekly",
  "calendar month": "Monthly",
});

const VISA_STATUS_MAP = Object.freeze({
  "us citizen": "U.S. Citizen",
  citizen: "U.S. Citizen",
  "us authorized": "U.S. Citizen",
  h1b: "H-1B",
  "h1 visa": "H-1B",
  "h-1b": "H-1B",
  "gc ead": "Green Card / EAD",
});

const JOB_CATEGORY_TO_CATEG = Object.freeze({
  "it application": "IT",
  "it infrastructure": "IT",
  it: "IT",
  information: "IT",
  "light industrial": "LI",
  "manufacturing-li": "LI",
  "heavy industrial": "LI",
  industrial: "LI",
  "industrial/manufacturing": "LI",
  "general administration": "Administration",
  "admin-clerical": "Admin/Clerical",
  "admin/clerical": "Admin/Clerical",
  "office/administration": "Admin/Clerical",
});

/** Clients whose placements belong to Cynet Health, not Systems. */
const HEALTH_CLIENTS = new Set(["labcorp", "quest diagnostics", "fortrea health"]);

/** Records that are never real placements. */
const EXCLUDED_PLACEMENT_IDS = new Set(["PLC-16180"]);

// ---------------------------------------------------------------- value parsing

function str(v) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return EMPTY_TOKENS.has(s.toLowerCase()) ? null : s;
}

/** A person's name with CEIPAL's "(Inactive User)" / "(User Deleted)" suffix removed. */
function personName(v) {
  const s = str(v);
  if (s == null) return null;
  return str(s.replace(/\s*\((Inactive User|User Deleted)\)\s*$/i, ""));
}

/** "$1,234.50" / "CAD58" / 27.5 -> number; anything unparseable -> null. */
function money(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/CAD|USD|\$|,|%/gi, "").trim();
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

function isCad(v) {
  return typeof v === "string" && /CAD/i.test(v);
}

/** First number in a free-text fee ("3%", "2.11 %", "5% of the Bill rate") as a fraction. */
function mspFeeFraction(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? round(v / 100, 4) : 0;
  const m = String(v).replace(/\$/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? round(Number(m[1]) / 100, 4) : 0;
}

function round(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * CEIPAL "MM/DD/YY" (optionally with " HH:MM:SS") -> { date: "YYYY-MM-DD", dateTime: "YYYY-MM-DD HH:MM:SS" }.
 * "0000-00-00", blanks and nonsense years (CEIPAL emits "12/31/69" for an unset date) -> nulls.
 */
function parseCeipalDate(v) {
  const s = str(v);
  if (s == null) return { date: null, dateTime: null };
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  let y;
  let mo;
  let d;
  let hh = "00";
  let mi = "00";
  let ss = "00";
  if (m) {
    [, mo, d, y] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    if (m[4] != null) {
      hh = m[4].padStart(2, "0");
      mi = m[5];
      ss = m[6] ?? "00";
    }
  } else {
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return { date: null, dateTime: null };
    [, y, mo, d] = m;
    y = Number(y);
    if (m[4] != null) {
      hh = m[4];
      mi = m[5];
      ss = m[6] ?? "00";
    }
  }
  if (y < 1990 || y > 2050) return { date: null, dateTime: null };
  const date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { date: null, dateTime: null };
  return { date, dateTime: `${date} ${hh}:${mi}:${ss}` };
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

function formatPhone(v) {
  const s = str(v);
  if (s == null) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith("1"))) {
    const d = digits.slice(-10);
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return s;
}

function stateCode(v) {
  const s = str(v);
  if (s == null) return null;
  if (STATE_CODES[s]) return STATE_CODES[s];
  if (/^[A-Z]{2}$/.test(s)) return s;
  const hit = Object.keys(STATE_CODES).find((k) => k.toLowerCase() === s.toLowerCase());
  return hit ? STATE_CODES[hit] : null;
}

function mapLookup(map, v) {
  const s = str(v);
  if (s == null) return null;
  return map[s.toLowerCase()] ?? s;
}

// ---------------------------------------------------------------- classification

/**
 * Which business a CEIPAL record belongs to. Only "systems" rows go to cynet_systems_deal_sheet;
 * Health (LabCorp/Quest, H-SKUs) and Canada (CAD rates) have their own tables.
 */
function classifyCeipalRecord(rec) {
  const code = str(rec?.PlacementCode);
  if (!code) return "invalid";
  if (EXCLUDED_PLACEMENT_IDS.has(code)) return "excluded";
  if ([rec.ClientBillRate, rec.PayRateSalary, rec.NetBillRate].some(isCad)) return "canada";
  const sku = str(rec.SKUNumber);
  const client = (str(rec.Client) || "").toLowerCase();
  if ((sku && /^H\d/i.test(sku)) || HEALTH_CLIENTS.has(client)) return "health";
  return "systems";
}

const DNS_REASON_RE = /did not start|back[- ]?out|\bdns\b|no show|declin/i;

/**
 * CS_TABLE_RUNRATE PLACEMENT_STATUS from CEIPAL's two status fields plus the dates/reasons.
 *
 * DID NOT START is decided by the reason, never by the dates: a "Termination - ..." row whose end
 * date equals its start date is TERMINATED<30 DAYS in the runrate sheet, not DNS. The End Reason
 * wins over a stale Not Joined Reason left on the same placement. TERMINATED<30 DAYS includes
 * exactly 30 days (08/17 -> 09/16 is <30 in the sheet).
 * Replayed against the 2026-11-17 export: 873/901 rows agree with CS_TABLE_RUNRATE before this rule,
 * the remaining gaps are rows the sheet never updated (still STARTED after CEIPAL ended them).
 */
function derivePlacementStatus(rec, startDate, endDate, todayIso) {
  const placementStatus = (str(rec.PlacementStatus) || "").toLowerCase();
  const profileStatus = (str(rec.ProfileStatus) || "").toLowerCase();
  const endReason = str(rec.EndReason);
  const dns = endReason
    ? DNS_REASON_RE.test(endReason)
    : DNS_REASON_RE.test(str(rec.NotJoinedReason) || "") || profileStatus === "not joined";

  const ended = profileStatus === "project ended" || placementStatus === "inactive";
  if (ended || dns) {
    if (dns) return "DID NOT START";
    const days = daysBetween(startDate, endDate);
    if (days != null && days <= 30) return "TERMINATED<30 DAYS";
    return "TERMINATED";
  }
  if (startDate && todayIso && startDate > todayIso) return "ONBOARDING";
  return "STARTED/ PLACED";
}

// ---------------------------------------------------------------- formulas

/**
 * The runrate sheet's formula columns. Returns nulls for Full Time (one-time revenue) rows, which
 * carry a salary / invoice amount rather than hourly rates.
 */
function computeRunrateFormulas(
  { type, payRate, perDiem, billRate, mspFee, startDate, endDate, entity = "SYSTEMS", loadedCost = null },
  rates = DEFAULT_RATES
) {
  const days = daysBetween(startDate, endDate);
  const empty = {
    FINAL_PAY_RATE: null,
    FINAL_COST: null,
    FINAL_BILL_RATE: null,
    NET_MARGIN: null,
    GROSS_MARGIN: null,
    CALCULATED_MARGIN: null,
    DAYS_WORKED: days,
  };
  if (type === "FT" || payRate == null || billRate == null) return empty;

  const w2 = type === "W2";
  const loading = w2 ? rates.w2Loading : rates.c2cLoading;
  const overhead = w2 ? rates.w2Overhead : rates.c2cOverhead;
  const pd = perDiem ?? 0;

  let finalPayRate;
  let finalCost;
  if (entity === "CANADA") {
    // Canada (cynet_Data.Cynet_Canada): the loading is per province, and CEIPAL's Loaded Cost already
    // carries it (59/61 rows equal FINAL_PAY_RATE); FINAL_COST = FINAL_PAY_RATE x 1.08 (155/155 rows).
    finalPayRate = (loadedCost != null && loadedCost > 0 ? loadedCost : payRate) + pd;
    finalCost = finalPayRate * rates.canadaCostFactor;
  } else {
    finalPayRate = payRate * (1 + loading) + pd;
    finalCost = finalPayRate + payRate * overhead;
  }
  const finalBillRate = billRate - billRate * (mspFee ?? 0);
  const calculatedMargin = finalBillRate - finalCost;

  return {
    FINAL_PAY_RATE: round(finalPayRate, 6),
    FINAL_COST: round(finalCost, 6),
    FINAL_BILL_RATE: round(finalBillRate, 6),
    NET_MARGIN: round(calculatedMargin, 6),
    GROSS_MARGIN: round(finalBillRate - finalPayRate, 6), // sheet "DELIVERY VALUE"
    CALCULATED_MARGIN: round(calculatedMargin, 6), // sheet "MARGIN"
    DAYS_WORKED: days,
  };
}

// ---------------------------------------------------------------- record -> row

/**
 * Map one CEIPAL report record to a cynet_systems_deal_sheet row (CEIPAL-owned columns only).
 * Hierarchy, manual and system columns are filled by the sync, not here.
 *
 * @param {object} rec       one element of the report's records array
 * @param {object} [opts]    { todayIso: "YYYY-MM-DD", rates }
 */
function mapCeipalRecordToRow(rec, opts = {}) {
  const todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);
  const rates = opts.rates ?? DEFAULT_RATES;

  const start = parseCeipalDate(rec.ActualStartDate).date;
  const end = parseCeipalDate(rec.ActualEndDate).date;
  const entity = ENTITY_BY_CLASS[classifyCeipalRecord(rec)] ?? "SYSTEMS";
  const placementType = str(rec.PlacementType);
  const ft = /one time/i.test(placementType || "");
  // Canada keeps its own tax terms (T4 / INC), as cynet_Data.Cynet_Canada does.
  const type = ft
    ? "FT"
    : entity === "CANADA" && str(rec.TaxTerms)
      ? str(rec.TaxTerms).toUpperCase()
      : mapLookup(TAX_TERMS_TO_TYPE, rec.TaxTerms);
  const payRate = money(rec.PayRateSalary);
  const billRate = money(rec.ClientBillRate);
  const perDiem = money(rec.PerDiemHour);
  const mspFee = mspFeeFraction(rec.VMSMSPFee);
  const category = mapLookup(JOB_CATEGORY_TO_CATEG, rec.JobCategory);
  const city = str(rec.City);
  const zip = str(rec.ZipCode);
  const zipNorm = zip && /^\d{4}$/.test(zip) ? zip.padStart(5, "0") : zip;
  const profitMargin = money(rec.ProfitMargin);

  const formulas = computeRunrateFormulas(
    { type, payRate, perDiem, billRate, mspFee, startDate: start, endDate: end, entity, loadedCost: money(rec.LoadedCost) },
    rates
  );

  return {
    PLACEMENT_ID: str(rec.PlacementCode),
    CEIPAL_APPLICANT_ID: rec.ApplicantId == null || rec.ApplicantId === "" ? null : Number(rec.ApplicantId) || null,
    PLACEMENT_TYPE: ft ? "FT" : placementType ? "CT" : null,
    PLACEMENT_STATUS: derivePlacementStatus(rec, start, end, todayIso),
    CEIPAL_PLACEMENT_STATUS: str(rec.PlacementStatus),
    CEIPAL_PROFILE_STATUS: str(rec.ProfileStatus),
    START_DATE: start,
    END_DATE: end,
    TENTATIVE_END_DATE: parseCeipalDate(rec.ProjectEndDate).date,
    TENTATIVE_START_DATE: parseCeipalDate(rec.TentativeStartDate).date,
    EFFECTIVE_DATE: parseCeipalDate(rec.EffectiveDate).date,
    SUBMISSION_DATE: parseCeipalDate(rec.SubmittedOn).dateTime,
    CEIPAL_MODIFIED_ON: parseCeipalDate(rec.ModifiedOn).dateTime,
    CANDIDATE_NAME: str(rec.ApplicantName),
    EMAIL_ID: str(rec.Email) ? str(rec.Email).toLowerCase() : null,
    CANDIDATE_NO: formatPhone(rec.MobileNumber),
    RECRUITER: personName(rec.RecruiterSalesExecutive),
    RECRUITER_EMAIL_ID: str(rec.RecruiterSalesExecutiveEmailId)
      ? str(rec.RecruiterSalesExecutiveEmailId).toLowerCase()
      : null,
    CEIPAL_RECRUITER_EMP_NO: str(rec.SubmittedByRecruiterEmployeeID),
    SKU_NUMBER: str(rec.SKUNumber),
    PAYLOCITY_ID: str(rec.PaylocityID),
    JOB_CODE: str(rec.JobCode),
    CLIENT_JOB_ID: str(rec.ClientJobID),
    PAY_TYPE: str(rec.PayType),
    INV_CYC_TO_CLT: mapLookup(INVOICE_FREQUENCY_TO_CYCLE, rec.InvoiceFrequency),
    CLT_PYMT_TERM: (() => {
      const t = str(rec.PaymentTerms);
      return t ? `NET ${t.replace(/net\s*/i, "").trim()}`.toUpperCase() : null;
    })(),
    VENDOR_INV_CYC_PAYMT_TERMS: str(rec.PayrollCycle) ? str(rec.PayrollCycle).toUpperCase() : null,
    POSITION: str(rec.JobTitle),
    MSP: str(rec.MSP),
    CLIENT: str(rec.Client),
    JOBDIVA_CLIENT_NAME: str(rec.Client),
    END_CLIENT_OR_FACILITY: str(rec.EndClient),
    CLIENT_TYPE: mapLookup(CLIENT_CATEGORY_TO_CLIENT_TYPE, rec.ClientCategory),
    TYPE: type,
    CITY_ZIPCODE: city && zipNorm ? `${city}, ${zipNorm}` : city || zipNorm || null,
    LOCATION: stateCode(rec.State) || stateCode(rec.CityState),
    PO_NUMBER: str(rec.PONumber),
    PAY_RATE: payRate,
    PER_DIEM_HOURLY: perDiem,
    BILL_RATE: billRate,
    CLIENT_MSP_FEE: mspFee,
    OT_RATE: money(rec.OTPayRateHour),
    CLIENT_OT_RATE: money(rec.OTBillRateHour),
    LOADING_COST_PERCENT: money(rec.LoadingCost),
    VENDOR_NAME: str(rec.SupplierCompanyName ?? rec.SupplierName),
    VENDOR_EMAIL: str(rec.SupplierEmailId),
    VENDOR_PHN_NO: str(rec.SupplierMobileNumber),
    PASSTHROUGH: str(rec.PassThrough) ? str(rec.PassThrough).charAt(0).toUpperCase() : null,
    VISA_STATUS: mapLookup(VISA_STATUS_MAP, rec.WorkAuthorization),
    GROUP_HEAD: personName(rec.DeliveryHead),
    GROUP_DIRECTOR: personName(rec.DirectorSrDirector),
    ONSITE_MANAGER: personName(rec.OnsiteClientManager),
    ONSITE_GROUP_HEAD: personName(rec.OnsiteClientHead),
    DELIVERY_POC: personName(rec.DirectorSrDirector) || personName(rec.AccountManager),
    BO_OR_END_REASON: str(rec.EndReason) || str(rec.NotJoinedReason),
    CATEG_OF_POS: category,
    PLACEMENT_INDUSTRY: category === "IT" ? "IT" : category === "LI" ? "LI" : category ? "Non-IT" : null,
    ENTITY: entity,
    CURRENCY: entity === "CANADA" || isCad(rec.ClientBillRate) ? "CAD" : "USD",
    // CEIPAL's own margin (Bill - Pay), the Health MARGIN convention; GP_PERCENTAGE = Profit Margin%.
    MARGIN: type === "FT" || payRate == null || billRate == null ? null : round(billRate - payRate, 6),
    GP_PERCENTAGE: profitMargin == null ? null : round(profitMargin, 2),
    // CEIPAL's own hierarchy, kept as the fallback when the Google Workspace chain has no match.
    __CEIPAL_HIERARCHY: {
      ACCOUNT_MANAGER: personName(rec.AccountManager),
      ASSOCIATE_AM: personName(rec.AssociateAccountManager),
      RM: personName(rec.RecruitmentManager),
      TEAM_LEAD: personName(rec.TeamLeader),
      ATL: personName(rec.SecondarySalesManager),
    },
    ...formulas,
  };
}

module.exports = {
  DEFAULT_RATES,
  ENTITY_BY_CLASS,
  STATE_CODES,
  EXCLUDED_PLACEMENT_IDS,
  str,
  personName,
  money,
  mspFeeFraction,
  parseCeipalDate,
  daysBetween,
  formatPhone,
  stateCode,
  classifyCeipalRecord,
  derivePlacementStatus,
  computeRunrateFormulas,
  mapCeipalRecordToRow,
};
