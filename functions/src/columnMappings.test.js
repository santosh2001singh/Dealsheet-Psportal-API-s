const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapJobToBq,
  mapJobSubmittalToBq,
  mapDealSheetHoursDetailsToBq,
  mapDealSheetAdditionalCostsToBq,
  mapAdditionalCostLogRowsForDealSheet,
  mapTravelAllowanceToAdditionalBonus,
  mapTravelAllowanceLogRowsForDealSheet,
  mapDealSheetClientCostsToAdditionalBonus,
  mapClientCostLogRowsForDealSheet,
  computeDerivedPlacementFields,
  mapMspFromClientOfferingRow,
  startDateOnOrAfterUtcMin,
  effectiveMinFilterDate,
  coerceApiFloatNullsToZero,
  mapDealSheetRatesListToBq,
  mapDealSheetUsersToBq,
  computeBqEndDateFromSubmittal,
  isTerminationApiEligiblePlacementStatus,
  extractTerminationReasonValue,
  pickLatestTerminationDetailItem,
  mapTerminationReasonLogRowForDealSheet,
  API_OWNED_COLUMNS,
} = require("./columnMappings");

/** Sample rates with both CA (>8) and default (>40) OT bill_rate_codes */
function sampleRatesWithBothOtCodes() {
  return [
    { bill_rate_code: "PR_GREATER_THAN_FOURTY", rate: 80 },
    { bill_rate_code: "PR_GREATER_THAN_EIGHT", rate: 38.63 },
    { bill_rate_code: "BR_GREATER_THAN_FOURTY", rate: 154 },
    { bill_rate_code: "BR_GREATER_THAN_EIGHT", rate: 110 },
    { bill_rate_code: "PR_REGULAR_PAY_RATE", rate: 25.75 },
    { bill_rate_code: "BR_REGULAR_BILL_RATE", rate: 110 },
  ];
}

/** Mirrors API_FLOAT_COLUMNS_DEFAULT_ZERO for tests */
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
];

const MAY_1_2026_MS = Date.UTC(2026, 4, 1);

test("mapJobSubmittalToBq prefers start/end dates from submittal", () => {
  const submittal = {
    id: 1311759,
    submitted_date: "2025-02-20T15:13:18Z",
    start_date: "2025-03-20",
    end_date: "2025-06-21",
    organization_submittal_status: { submittal_status: "Completed" },
  };
  const job = {
    start_date: "2025-03-10",
    end_date: "2025-06-15",
  };

  const mapped = mapJobSubmittalToBq(submittal, job);

  assert.equal(mapped.START_DATE, "2025-03-20");
  assert.equal(mapped.TENTATIVE_DATE, "2025-06-21");
  assert.equal(mapped.END_DATE, "2025-06-21");
});

test("mapJobSubmittalToBq does not fall back to job start_date when submittal start is blank", () => {
  const submittal = {
    id: 555,
    submitted_date: "2025-02-20T15:13:18Z",
    start_date: "",
    end_date: "",
    organization_submittal_status: { submittal_status: "Active" },
  };
  const job = {
    start_date: "2025-07-01",
    end_date: "2025-10-14",
  };

  const mapped = mapJobSubmittalToBq(submittal, job);

  assert.equal(mapped.START_DATE, null);
  assert.equal(mapped.TENTATIVE_DATE, "2025-10-14");
});

test("mapJobToBq maps job start_date to OFFER_TIME_START_DATE only", () => {
  const mapped = mapJobToBq({ start_date: "2025-07-01", ref_code: "VMS-1" });

  assert.equal(mapped.OFFER_TIME_START_DATE, "2025-07-01");
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, "START_DATE"), false);
});

test("effectiveMinFilterDate uses OFFER_TIME_START_DATE when START_DATE is empty", () => {
  const row = { START_DATE: null, OFFER_TIME_START_DATE: "2026-05-10" };
  assert.equal(startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), MAY_1_2026_MS), true);
});

test("effectiveMinFilterDate prefers START_DATE over OFFER_TIME_START_DATE", () => {
  const row = { START_DATE: "2026-04-30", OFFER_TIME_START_DATE: "2026-05-10" };
  assert.equal(startDateOnOrAfterUtcMin(effectiveMinFilterDate(row), MAY_1_2026_MS), false);
});

test("mapJobSubmittalToBq formats tentative date from mm/dd/yyyy", () => {
  const submittal = {
    id: 777,
    submitted_date: "2025-01-01T00:00:00Z",
    start_date: "2025-01-15",
    end_date: "6/2/2025",
    organization_submittal_status: { submittal_status: "Booked" },
  };

  const mapped = mapJobSubmittalToBq(submittal, null);

  assert.equal(mapped.TENTATIVE_DATE, "2025-06-02");
});

test("computeBqEndDateFromSubmittal: COMPLETED uses submittal end_date", () => {
  const sub = {
    organization_submittal_status: { code: "COMPLETED", submittal_status: "Completed" },
    start_date: "2026-05-17",
    end_date: "2026-05-23",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), "2026-05-23");
});

test("computeBqEndDateFromSubmittal: EARLY_TERM uses submittal end_date", () => {
  const sub = {
    organization_submittal_status: { submittal_status: "Early Term" },
    start_date: "2026-05-18",
    end_date: "2026-05-23",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), "2026-05-23");
});

test("computeBqEndDateFromSubmittal: CANCELLED uses start_date", () => {
  const sub = {
    organization_submittal_status: { code: "CANCELLED" },
    start_date: "2026-03-10",
    end_date: "2026-06-01",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), "2026-03-10");
});

test("computeBqEndDateFromSubmittal: OFFER_REJECTED uses start_date", () => {
  const sub = {
    organization_submittal_status: { code: "OFFER_REJECTED" },
    start_date: "2026-04-01",
    end_date: "2026-07-01",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), "2026-04-01");
});

test("computeBqEndDateFromSubmittal: ACTIVE with past end uses end_date", () => {
  const sub = {
    organization_submittal_status: { code: "ACTIVE" },
    start_date: "2026-01-01",
    end_date: "2020-01-15",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), "2020-01-15");
});

test("computeBqEndDateFromSubmittal: ACTIVE with future end returns null", () => {
  const sub = {
    organization_submittal_status: { code: "ACTIVE" },
    start_date: "2026-01-01",
    end_date: "2099-12-31",
  };
  assert.equal(computeBqEndDateFromSubmittal(sub, null), null);
});

test("computeBqEndDateFromSubmittal: missing submittal falls back to job logic", () => {
  const job = { job_status: "cancelled", start_date: "2026-04-15", end_date: "2026-07-15" };
  assert.equal(computeBqEndDateFromSubmittal(null, job), "2026-04-15");
});

test("computeBqEndDateFromSubmittal: unknown status falls back to job logic", () => {
  const sub = { organization_submittal_status: { code: "UNKNOWN" } };
  const job = { job_status: null };
  assert.equal(computeBqEndDateFromSubmittal(sub, job), null);
});

test("mapJobSubmittalToBq: sets END_DATE for COMPLETED placement (1457578 pattern)", () => {
  const sub = {
    id: 1457578,
    organization_submittal_status: { code: "COMPLETED", submittal_status: "Completed" },
    start_date: "2026-05-17",
    end_date: "2026-05-23",
  };
  const out = mapJobSubmittalToBq(sub, null);
  assert.equal(out.END_DATE, "2026-05-23");
  assert.equal(out.PLACEMENT_STATUS, "ENDED");
});

test("mapDealSheetHoursDetailsToBq maps schedule hours as plain numbers", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    total_assignment_hrs: 540,
    scheduled_hrs_1: 36,
    scheduled_hrs_2: 48,
  });

  assert.equal(mapped.PO_HOURS, 540);
  assert.equal(mapped.SCHEDULE_HOURS_1, 36);
  assert.equal(mapped.SCHEDULE_HOURS_2, 48);
  assert.equal(Object.hasOwn(mapped, "GUARANTEED_HOURS"), false);
  assert.equal(Object.hasOwn(mapped, "NEW_GUARANTEED_HOURS"), false);
});

test("mapDealSheetHoursDetailsToBq maps regular hours from API payload when CA", () => {
  const mapped = mapDealSheetHoursDetailsToBq(
    {
      total_assignment_hrs: 144,
      scheduled_hrs_1: 36,
      scheduled_hrs_2: null,
      regular_hrs_1: 24,
      regular_hrs_2: null,
      deal_sheet: 5170193,
    },
    "CA"
  );

  assert.equal(mapped.SCHEDULE_HOURS_1, 36);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
  assert.equal(mapped.REGULAR_HOURS_1, 24);
  assert.equal(mapped.REGULAR_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq REGULAR_HOURS are 0 when clientState is not CA", () => {
  const mapped = mapDealSheetHoursDetailsToBq(
    {
      total_assignment_hrs: 144,
      scheduled_hrs_1: 36,
      scheduled_hrs_2: 48,
      regular_hrs_1: 24,
      regular_hrs_2: 20,
    },
    "TX"
  );

  assert.equal(mapped.PO_HOURS, 144);
  assert.equal(mapped.SCHEDULE_HOURS_1, 36);
  assert.equal(mapped.SCHEDULE_HOURS_2, 48);
  assert.equal(mapped.REGULAR_HOURS_1, 0);
  assert.equal(mapped.REGULAR_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq normalizes lowercase ca and trims whitespace for hours columns", () => {
  const mapped = mapDealSheetHoursDetailsToBq(
    {
      scheduled_hrs_1: 36,
      regular_hrs_1: 24,
    },
    " ca "
  );

  assert.equal(mapped.REGULAR_HOURS_1, 24);
});

test("mapDealSheetHoursDetailsToBq defaults SCHEDULE_HOURS_2 to 0 when scheduled_hrs_2 missing", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    scheduled_hrs_1: 38,
  });

  assert.equal(mapped.SCHEDULE_HOURS_1, 38);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq preserves zero for scheduled_hrs_2", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    scheduled_hrs_1: 38,
    scheduled_hrs_2: 0,
  });

  assert.equal(mapped.SCHEDULE_HOURS_1, 38);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq preserves zero for scheduled_hrs_1", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    scheduled_hrs_1: 0,
    scheduled_hrs_2: 48,
  });

  assert.equal(mapped.SCHEDULE_HOURS_1, 0);
  assert.equal(mapped.SCHEDULE_HOURS_2, 48);
});

test("mapDealSheetHoursDetailsToBq maps both zeros as numbers", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    scheduled_hrs_1: 0,
    scheduled_hrs_2: 0,
  });

  assert.equal(mapped.SCHEDULE_HOURS_1, 0);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq defaults SCHEDULE_HOURS_1 to 0 when scheduled_hrs_1 missing", () => {
  const mapped = mapDealSheetHoursDetailsToBq({
    scheduled_hrs_2: 40,
  });

  assert.equal(mapped.SCHEDULE_HOURS_1, 0);
  assert.equal(mapped.SCHEDULE_HOURS_2, 40);
});

test("mapDealSheetHoursDetailsToBq defaults to zeros when hoursRow is null", () => {
  const mapped = mapDealSheetHoursDetailsToBq(null);

  assert.equal(mapped.SCHEDULE_HOURS_1, 0);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
  assert.equal(mapped.REGULAR_HOURS_1, 0);
  assert.equal(mapped.REGULAR_HOURS_2, 0);
});

test("mapDealSheetHoursDetailsToBq defaults to zeros when scheduled hours are blank strings", () => {
  const mapped = mapDealSheetHoursDetailsToBq(
    {
      scheduled_hrs_1: "",
      scheduled_hrs_2: "",
      regular_hrs_1: "",
      regular_hrs_2: "",
    },
    "CA"
  );

  assert.equal(mapped.SCHEDULE_HOURS_1, 0);
  assert.equal(mapped.SCHEDULE_HOURS_2, 0);
  assert.equal(mapped.REGULAR_HOURS_1, 0);
  assert.equal(mapped.REGULAR_HOURS_2, 0);
});

test("computeDerivedPlacementFields calculates ENDED placement metrics including DAYS_WORKED", () => {
  const row = {
    PAY_RATE: 50,
    TYPE: "SomeType",
    WEEKLY_PER_DIEM_NON_TAXED: 1000,
    WEEKLY_WALLET_MONEY: 100,
    SCHEDULE_HOURS_1: 40,
    ADDITIONAL_BONUS: 500,
    ORIENTATION_HOURS: 8,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
    BILL_RATE: 100,
    CLIENT_MSP_FEE: 0.1,
    PLACEMENT_TYPE: "CT",
    PARENT_CLIENT_NAME: "Other Client",
    POSITION: "RN",
    OT_RATE: 75,
    CLIENT_OT_RATE: 130,
    PLACEMENT_STATUS: "ENDED",
    START_DATE: "2025-01-01",
    END_DATE: "2025-01-11",
  };

  const out = computeDerivedPlacementFields(row);

  assert.equal(out.W2_PAY_RATE, 79.23);
  assert.equal(out.FINAL_PAY_RATE, 80.23);
  assert.equal(out.FINAL_BILL_RATE, 90);
  assert.equal(out.FINAL_COST, 86.65);
  assert.equal(out.NET_MARGIN, 3.35);
  assert.equal(Object.hasOwn(out, "GROSS_MARGIN"), false);
  assert.equal(out.GM_OT, 29.75);
  assert.equal(out.DAYS_WORKED, 10);
});

test("computeDerivedPlacementFields uses TYPE null branch and Cynet Locum final pay rule", () => {
  const row = {
    PAY_RATE: 50,
    TYPE: null,
    WEEKLY_PER_DIEM_NON_TAXED: 1000,
    WEEKLY_WALLET_MONEY: 100,
    SCHEDULE_HOURS_1: 40,
    ADDITIONAL_BONUS: 500,
    ORIENTATION_HOURS: 8,
    INITIAL_PROJECT_DURATION_IN_WEEKS: 13,
    BILL_RATE: 100,
    CLIENT_MSP_FEE: 10,
    PLACEMENT_TYPE: "CT",
    PARENT_CLIENT_NAME: "Cynet Locum",
    POSITION: "Dentist",
    OT_RATE: 75,
    CLIENT_OT_RATE: 130,
    START_DATE: "2025-01-01",
    END_DATE: "2025-01-11",
  };

  const out = computeDerivedPlacementFields(row);

  assert.equal(out.W2_PAY_RATE, 87.21);
  assert.equal(out.FINAL_PAY_RATE, 87.21);
  assert.equal(out.FINAL_BILL_RATE, 90);
  assert.equal(out.FINAL_COST, 94.19);
  assert.equal(Object.hasOwn(out, "GROSS_MARGIN"), false);
  assert.equal(out.NET_MARGIN, -4.19);
});

test("computeDerivedPlacementFields handles FT and null/zero guardrails", () => {
  const row = {
    PAY_RATE: null,
    TYPE: "X",
    BILL_RATE: 0,
    CLIENT_MSP_FEE: 150,
    PLACEMENT_TYPE: "FT",
    OT_RATE: 0,
    START_DATE: "",
    END_DATE: "",
  };

  const out = computeDerivedPlacementFields(row);

  assert.equal(out.W2_PAY_RATE, null);
  assert.equal(out.FINAL_PAY_RATE, 0);
  assert.equal(out.FINAL_BILL_RATE, null);
  assert.equal(out.FINAL_COST, null);
  assert.equal(out.NET_MARGIN, 0);
  assert.equal(Object.hasOwn(out, "GROSS_MARGIN"), false);
  assert.equal(out.GM_OT, null);
  assert.equal(out.DAYS_WORKED, 0);
});

test("computeDerivedPlacementFields DAYS_WORKED status gate", () => {
  const baseDates = { START_DATE: "2025-01-01", END_DATE: "2025-01-11" };

  assert.equal(
    computeDerivedPlacementFields({ ...baseDates, PLACEMENT_STATUS: "STARTED" }).DAYS_WORKED,
    0
  );
  assert.equal(
    computeDerivedPlacementFields({ ...baseDates, PLACEMENT_STATUS: "BOOKED" }).DAYS_WORKED,
    0
  );
  assert.equal(
    computeDerivedPlacementFields({ ...baseDates, PLACEMENT_STATUS: "ENDED<30" }).DAYS_WORKED,
    10
  );
  assert.equal(
    computeDerivedPlacementFields({
      START_DATE: "2025-01-01",
      END_DATE: "2025-01-01",
      PLACEMENT_STATUS: "DID NOT ACCEPT",
    }).DAYS_WORKED,
    0
  );
  assert.equal(
    computeDerivedPlacementFields({ ...baseDates, PLACEMENT_STATUS: null }).DAYS_WORKED,
    0
  );
  assert.equal(
    computeDerivedPlacementFields({ ...baseDates }).DAYS_WORKED,
    0
  );
});

test("mapDealSheetAdditionalCostsToBq sums only BONUS category rows", () => {
  const out = mapDealSheetAdditionalCostsToBq([
    {
      value: 87,
      deal_sheet_cost_data: { deal_sheet_category_id: "REIMBURSEMENT" },
    },
    {
      value: 300,
      deal_sheet_cost_data: { deal_sheet_category_id: "BONUS" },
    },
    {
      value: 375,
      deal_sheet_cost_data: { deal_sheet_category_id: "BONUS" },
    },
  ]);

  assert.equal(out.ADDITIONAL_BONUS, 675);
});

test("mapDealSheetAdditionalCostsToBq returns 0 when no BONUS rows", () => {
  assert.equal(mapDealSheetAdditionalCostsToBq([]).ADDITIONAL_BONUS, 0);
  assert.equal(
    mapDealSheetAdditionalCostsToBq([
      { value: 50, deal_sheet_cost_data: { deal_sheet_category_id: "REIMBURSEMENT" } },
    ]).ADDITIONAL_BONUS,
    0
  );
});

test("mapTravelAllowanceToAdditionalBonus sums total_amount", () => {
  const out = mapTravelAllowanceToAdditionalBonus([
    {
      id: 4346789,
      total_amount: 400,
      first_check_amount: 200,
      last_check_amount: 200,
      deal_sheet: 5208042,
      deal_sheet_travel_allowance_type: "AMOUNT",
    },
  ]);

  assert.equal(out.ADDITIONAL_BONUS, 400);
});

test("mapTravelAllowanceToAdditionalBonus returns 0 when no rows", () => {
  assert.equal(mapTravelAllowanceToAdditionalBonus([]).ADDITIONAL_BONUS, 0);
});

test("mapTravelAllowanceLogRowsForDealSheet maps travel allowance to log row", () => {
  const travelRows = [
    {
      id: 4346789,
      total_amount: 400,
      first_check_amount: 200,
      last_check_amount: 200,
      deal_sheet: 5208042,
      deal_sheet_travel_allowance_type: "AMOUNT",
    },
  ];
  const context = {
    DEAL_SHEET_ID: 5208042,
    PLACEMENT_ID: 1311759,
    CANDIDATE_NAME: "Jane Doe",
    CANDIDATE_EMAIL: "jane@example.com",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@example.com",
    START_DATE: "2026-04-01",
    TENTATIVE_DATE: "2026-06-01",
  };
  const captureTs = "2026-04-23T19:42:26.000Z";

  const logs = mapTravelAllowanceLogRowsForDealSheet(travelRows, context, captureTs);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].DATE_AND_TIME, captureTs);
  assert.equal(logs[0].DEAL_SHEET_ID, 5208042);
  assert.equal(logs[0].PLACEMENT_ID, 1311759);
  assert.equal(logs[0].ADDITIONAL_COST_ID, 4346789);
  assert.equal(logs[0].ADDITIONAL_COST_NAME, "Travel Allowances");
  assert.equal(logs[0].CATEGORY, "BONUS");
  assert.equal(logs[0].DURATION, "ONE_TIME");
  assert.equal(logs[0].VALUE, 400);
  assert.equal(logs[0].NOTES, "First check amount: 200\nLast check amount: 200");
});

test("mapDealSheetClientCostsToAdditionalBonus sums cost", () => {
  const out = mapDealSheetClientCostsToAdditionalBonus([
    {
      id: 84537,
      cost_name: "Pre-Employment Module Bonus",
      cost: 150.0,
      deal_sheet_category: "COST",
      duration: "ONE_TIME",
      deal_sheet: 5191806,
    },
    {
      id: 84538,
      cost_name: "Other Cost",
      cost: 50,
      deal_sheet_category: "COST",
      duration: "ONE_TIME",
    },
  ]);
  assert.equal(out.ADDITIONAL_BONUS, 200);
});

test("mapDealSheetClientCostsToAdditionalBonus returns 0 when no rows", () => {
  assert.equal(mapDealSheetClientCostsToAdditionalBonus([]).ADDITIONAL_BONUS, 0);
});

test("mapClientCostLogRowsForDealSheet maps Postman example payload", () => {
  const clientCostRows = [
    {
      id: 84537,
      cost_name: "Pre-Employment Module Bonus",
      cost: 150.0,
      apply_on: "DEAL",
      pay_date: null,
      created_date: "2026-03-26T15:51:19Z",
      modified_date: "2026-03-26T15:51:19Z",
      version: 0,
      deal_sheet: 5191806,
      client_billing_cost_details: 20780,
      duration: "ONE_TIME",
      deal_sheet_category: "COST",
      created_by: 795042,
      modified_by: 795042,
    },
  ];
  const context = {
    DEAL_SHEET_ID: 5191806,
    PLACEMENT_ID: 1311759,
    CANDIDATE_NAME: "Jane Doe",
    CANDIDATE_EMAIL: "jane@example.com",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@example.com",
    START_DATE: "2026-04-01",
    TENTATIVE_DATE: "2026-06-01",
  };
  const captureTs = "2026-04-23T19:42:26.000Z";

  const logs = mapClientCostLogRowsForDealSheet(clientCostRows, context, captureTs);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].DATE_AND_TIME, captureTs);
  assert.equal(logs[0].DEAL_SHEET_ID, 5191806);
  assert.equal(logs[0].PLACEMENT_ID, 1311759);
  assert.equal(logs[0].ADDITIONAL_COST_ID, 84537);
  assert.equal(logs[0].ADDITIONAL_COST_NAME, "Pre-Employment Module Bonus");
  assert.equal(logs[0].CATEGORY, "COST");
  assert.equal(logs[0].DURATION, "ONE_TIME");
  assert.equal(logs[0].VALUE, 150);
  assert.equal(logs[0].NOTES, null);
});

test("ADDITIONAL_BONUS combines BONUS addcost rows and travel allowances", () => {
  const addCostRows = [
    {
      value: 300,
      deal_sheet_cost_data: { deal_sheet_category_id: "BONUS" },
    },
  ];
  const travelRows = [
    {
      id: 4346789,
      total_amount: 400,
      first_check_amount: 200,
      last_check_amount: 200,
    },
  ];

  const addCostBonus = mapDealSheetAdditionalCostsToBq(addCostRows).ADDITIONAL_BONUS;
  const travelBonus = mapTravelAllowanceToAdditionalBonus(travelRows).ADDITIONAL_BONUS;
  const total = (addCostBonus || 0) + (travelBonus || 0);

  assert.equal(addCostBonus, 300);
  assert.equal(travelBonus, 400);
  assert.equal(total, 700);
});

test("mapAdditionalCostLogRowsForDealSheet maps all line items with context", () => {
  const sampleApiRows = [
    {
      id: 15309762,
      value: 87,
      notes: null,
      deal_sheet_cost_data: {
        name: "Local - QTB Mass Transit  - Weekly",
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
    {
      id: 15309761,
      value: 87,
      deal_sheet_cost_data: {
        name: "Local - QTB Parking - Weekly",
        deal_sheet_category_id: "REIMBURSEMENT",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
    {
      id: 15309760,
      value: 300,
      notes: "First Pay check",
      deal_sheet_cost_data: {
        name: "Extension Bonus",
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "ONE_TIME",
      },
    },
    {
      id: 15309759,
      value: 375,
      deal_sheet_cost_data: {
        name: "Commute Time / Lunch Time - (Discretionary) (Taxable)",
        deal_sheet_category_id: "BONUS",
        deal_sheet_cost_duration_id: "WEEKLY",
      },
    },
  ];
  const context = {
    DEAL_SHEET_ID: 5185115,
    PLACEMENT_ID: 1311759,
    CANDIDATE_NAME: "Jane Doe",
    CANDIDATE_EMAIL: "jane@example.com",
    ASSIGNMENT_RECRUITER_EMAIL: "recruiter@example.com",
    START_DATE: "2026-03-01",
    TENTATIVE_DATE: "2026-06-01",
  };
  const captureTs = "2026-05-19T12:00:00.000Z";

  const logs = mapAdditionalCostLogRowsForDealSheet(sampleApiRows, context, captureTs);

  assert.equal(logs.length, 4);
  assert.equal(logs[0].DATE_AND_TIME, captureTs);
  assert.equal(logs[0].DEAL_SHEET_ID, 5185115);
  assert.equal(logs[0].PLACEMENT_ID, 1311759);
  assert.equal(logs[0].CANDIDATE_EMAIL, "jane@example.com");
  assert.equal(logs[0].ASSIGNMENT_RECRUITER_EMAIL, "recruiter@example.com");
  assert.equal(logs[0].ADDITIONAL_COST_NAME, "Local - QTB Mass Transit  - Weekly");
  assert.equal(logs[0].CATEGORY, "REIMBURSEMENT");
  assert.equal(logs[0].DURATION, "WEEKLY");
  assert.equal(logs[0].VALUE, 87);

  const extension = logs.find((r) => r.ADDITIONAL_COST_ID === 15309760);
  assert.equal(extension.ADDITIONAL_COST_NAME, "Extension Bonus");
  assert.equal(extension.CATEGORY, "BONUS");
  assert.equal(extension.DURATION, "ONE_TIME");
  assert.equal(extension.VALUE, 300);
  assert.equal(extension.NOTES, "First Pay check");

  const commute = logs.find((r) => r.ADDITIONAL_COST_ID === 15309759);
  assert.equal(commute.ADDITIONAL_COST_NAME, "Commute Time / Lunch Time - (Discretionary) (Taxable)");
  assert.equal(commute.CATEGORY, "BONUS");
  assert.equal(commute.DURATION, "WEEKLY");
  assert.equal(commute.VALUE, 375);
});

test("mapMspFromClientOfferingRow maps CLIENT_TYPE from client_setting_type.value", () => {
  const out = mapMspFromClientOfferingRow({
    client_setting_type: { value: "VMS" },
    msp: { id: 240, name: "RightSourcing" },
  });

  assert.equal(out.CLIENT_TYPE, "VMS");
});

test("mapMspFromClientOfferingRow sets CLIENT_TYPE null when client_setting_type missing", () => {
  const out = mapMspFromClientOfferingRow({
    msp: { id: 240, name: "RightSourcing" },
  });

  assert.equal(out.CLIENT_TYPE, null);
});

test("mapMspFromClientOfferingRow trims and nulls empty CLIENT_TYPE", () => {
  const out = mapMspFromClientOfferingRow({
    client_setting_type: { value: "   " },
    msp: { id: 240, name: "RightSourcing" },
  });

  assert.equal(out.CLIENT_TYPE, null);
});

test("startDateOnOrAfterUtcMin false for null, blank, unparseable", () => {
  assert.equal(startDateOnOrAfterUtcMin(null, MAY_1_2026_MS), false);
  assert.equal(startDateOnOrAfterUtcMin("", MAY_1_2026_MS), false);
  assert.equal(startDateOnOrAfterUtcMin("   ", MAY_1_2026_MS), false);
  assert.equal(startDateOnOrAfterUtcMin("not-a-date", MAY_1_2026_MS), false);
});

test("startDateOnOrAfterUtcMin false before 2026-05-01", () => {
  assert.equal(startDateOnOrAfterUtcMin("2026-04-30", MAY_1_2026_MS), false);
});

test("startDateOnOrAfterUtcMin true on and after 2026-05-01", () => {
  assert.equal(startDateOnOrAfterUtcMin("2026-05-01", MAY_1_2026_MS), true);
  assert.equal(startDateOnOrAfterUtcMin("2026-05-02", MAY_1_2026_MS), true);
  assert.equal(startDateOnOrAfterUtcMin("5/1/2026", MAY_1_2026_MS), true);
});

test("coerceApiFloatNullsToZero sets null, undefined, and NaN to 0 on API FLOAT columns", () => {
  for (const key of API_FLOAT_COLUMNS_DEFAULT_ZERO) {
    assert.equal(coerceApiFloatNullsToZero({ [key]: null })[key], 0);
    assert.equal(coerceApiFloatNullsToZero({ [key]: undefined })[key], 0);
    assert.equal(coerceApiFloatNullsToZero({ [key]: NaN })[key], 0);
  }
});

test("mapDealSheetUsersToBq prefers deal-sheet recruiter user over submittal recruiter", () => {
  const dealSheet = { recruiter: 200, sales_rep: 300 };
  const recruiterUser = {
    id: 200,
    first_name: "New",
    last_name: "Recruiter",
    email: "new.recruiter@cynethealth.com",
  };
  const salesRepUser = {
    id: 300,
    first_name: "Sales",
    last_name: "Rep",
    email: "sales@cynethealth.com",
  };
  const submittalRow = {
    recruiter: {
      id: 100,
      first_name: "Old",
      last_name: "Recruiter",
      email: "old.recruiter@cynethealth.com",
    },
  };
  const out = mapDealSheetUsersToBq(dealSheet, recruiterUser, salesRepUser, submittalRow);
  assert.equal(out.RECRUITER_ID, 200);
  assert.equal(out.ASSIGNMENT_RECRUITER, "New Recruiter");
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, "new.recruiter@cynethealth.com");
  assert.equal(out.CLIENT_SALES_REP, "Sales Rep");
  assert.equal(out.ONSITE_AM, "Sales Rep");
});

test("mapDealSheetUsersToBq falls back to submittal recruiter when deal-sheet user missing", () => {
  const dealSheet = { recruiter: null, sales_rep: null };
  const submittalRow = {
    recruiter: {
      id: 100,
      first_name: "Sub",
      last_name: "Recruiter",
      email: "sub.recruiter@cynethealth.com",
    },
  };
  const out = mapDealSheetUsersToBq(dealSheet, null, null, submittalRow);
  assert.equal(out.RECRUITER_ID, 100);
  assert.equal(out.ASSIGNMENT_RECRUITER, "Sub Recruiter");
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, "sub.recruiter@cynethealth.com");
  assert.equal(out.CLIENT_SALES_REP, null);
  assert.equal(out.ONSITE_AM, null);
});

test("mapDealSheetUsersToBq uses deal-sheet recruiter id when both users null", () => {
  const dealSheet = { recruiter: 555, sales_rep: null };
  const out = mapDealSheetUsersToBq(dealSheet, null, null, null);
  assert.equal(out.RECRUITER_ID, 555);
  assert.equal(out.ASSIGNMENT_RECRUITER, null);
  assert.equal(out.ASSIGNMENT_RECRUITER_EMAIL, null);
  assert.equal(out.CLIENT_SALES_REP, null);
  assert.equal(out.ONSITE_AM, null);
});

test("coerceApiFloatNullsToZero preserves finite numbers including 0 and negatives", () => {
  const out = coerceApiFloatNullsToZero({
    PAY_RATE: 50,
    BILL_RATE: 0,
    OT_RATE: -1.5,
  });
  assert.equal(out.PAY_RATE, 50);
  assert.equal(out.BILL_RATE, 0);
  assert.equal(out.OT_RATE, -1.5);
});

test("coerceApiFloatNullsToZero leaves ID INT64 and derived FLOAT fields null", () => {
  const out = coerceApiFloatNullsToZero({
    DEAL_SHEET_ID: null,
    PLACEMENT_ID: null,
    RECRUITER_ID: null,
    MSP_ID: null,
    W2_PAY_RATE: null,
    FINAL_BILL_RATE: null,
    NET_MARGIN: null,
    GM_OT: null,
  });
  assert.equal(out.DEAL_SHEET_ID, null);
  assert.equal(out.PLACEMENT_ID, null);
  assert.equal(out.RECRUITER_ID, null);
  assert.equal(out.MSP_ID, null);
  assert.equal(out.W2_PAY_RATE, null);
  assert.equal(out.FINAL_BILL_RATE, null);
  assert.equal(out.NET_MARGIN, null);
  assert.equal(out.GM_OT, null);
});

test("coerceApiFloatNullsToZero returns non-objects unchanged", () => {
  assert.equal(coerceApiFloatNullsToZero(null), null);
  assert.equal(coerceApiFloatNullsToZero(undefined), undefined);
});

test("mapAdditionalCostLogRowsForDealSheet uses VALUE 0 when API value is null or blank", () => {
  const context = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    CANDIDATE_NAME: null,
    CANDIDATE_EMAIL: null,
    ASSIGNMENT_RECRUITER_EMAIL: null,
    START_DATE: "2026-01-01",
    TENTATIVE_DATE: null,
  };
  const withName = [
    {
      id: null,
      value: null,
      notes: null,
      deal_sheet_cost_data: {
        name: "Named Line",
        deal_sheet_category_id: "OTHER",
      },
    },
  ];
  const logs = mapAdditionalCostLogRowsForDealSheet(withName, context, "2026-05-01T00:00:00.000Z");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].VALUE, 0);

  const blankString = [
    {
      id: 99,
      value: "",
      notes: null,
      deal_sheet_cost_data: null,
    },
  ];
  const logsBlank = mapAdditionalCostLogRowsForDealSheet(blankString, context, "2026-05-01T00:00:00.000Z");
  assert.equal(logsBlank[0].VALUE, 0);
});

test("mapAdditionalCostLogRowsForDealSheet skips row with no id, name, or value", () => {
  const context = {
    DEAL_SHEET_ID: 1,
    PLACEMENT_ID: 2,
    CANDIDATE_NAME: null,
    CANDIDATE_EMAIL: null,
    ASSIGNMENT_RECRUITER_EMAIL: null,
    START_DATE: null,
    TENTATIVE_DATE: null,
  };
  const empty = [
    {
      id: null,
      value: null,
      notes: null,
      deal_sheet_cost_data: null,
    },
  ];
  assert.equal(mapAdditionalCostLogRowsForDealSheet(empty, context, "2026-05-01T00:00:00.000Z").length, 0);
});

test("mapDealSheetRatesListToBq uses EIGHT OT codes for CA state", () => {
  const rows = sampleRatesWithBothOtCodes();
  const out = mapDealSheetRatesListToBq(rows, "CA");
  assert.equal(out.OT_RATE, 38.63);
  assert.equal(out.CLIENT_OT_RATE, 110);
});

test("mapDealSheetRatesListToBq normalizes lowercase ca to CA OT codes", () => {
  const rows = sampleRatesWithBothOtCodes();
  const out = mapDealSheetRatesListToBq(rows, "ca");
  assert.equal(out.OT_RATE, 38.63);
  assert.equal(out.CLIENT_OT_RATE, 110);
});

test("mapDealSheetRatesListToBq uses FOURTY OT codes for non-CA states", () => {
  const rows = sampleRatesWithBothOtCodes();
  for (const state of ["TX", null, "", "   "]) {
    const out = mapDealSheetRatesListToBq(rows, state);
    assert.equal(out.OT_RATE, 80, `OT_RATE for state ${String(state)}`);
    assert.equal(out.CLIENT_OT_RATE, 154, `CLIENT_OT_RATE for state ${String(state)}`);
  }
});

test("mapDealSheetRatesListToBq without clientState uses FOURTY OT codes (legacy)", () => {
  const rows = sampleRatesWithBothOtCodes();
  const out = mapDealSheetRatesListToBq(rows);
  assert.equal(out.OT_RATE, 80);
  assert.equal(out.CLIENT_OT_RATE, 154);
});

test("mapDealSheetRatesListToBq CA returns null OT rates when EIGHT codes missing", () => {
  const rowsOnlyForty = [
    { bill_rate_code: "PR_GREATER_THAN_FOURTY", rate: 80 },
    { bill_rate_code: "BR_GREATER_THAN_FOURTY", rate: 154 },
  ];
  const out = mapDealSheetRatesListToBq(rowsOnlyForty, "CA");
  assert.equal(out.OT_RATE, null);
  assert.equal(out.CLIENT_OT_RATE, null);
});

test("mapDealSheetRatesListToBq leaves non-OT rates unchanged by state", () => {
  const rows = sampleRatesWithBothOtCodes();
  const ca = mapDealSheetRatesListToBq(rows, "CA");
  const tx = mapDealSheetRatesListToBq(rows, "TX");
  assert.equal(ca.PAY_RATE, 25.75);
  assert.equal(tx.PAY_RATE, 25.75);
  assert.equal(ca.BILL_RATE, 110);
  assert.equal(tx.BILL_RATE, 110);
});

test("isTerminationApiEligiblePlacementStatus allows ended/cancelled family only", () => {
  assert.equal(isTerminationApiEligiblePlacementStatus("ENDED<30"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("ended<30"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("DID NOT START"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("DID NOT ACCEPT"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("CANCELLED"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("CANCELED"), true);
  assert.equal(isTerminationApiEligiblePlacementStatus("STARTED"), false);
  assert.equal(isTerminationApiEligiblePlacementStatus("ENDED"), false);
});

test("extractTerminationReasonValue prefers cancellation_reason.value", () => {
  const item = {
    cancellation_reason: { value: "Other" },
    early_term_reason: { value: "Other Job Opportunity" },
  };
  assert.equal(extractTerminationReasonValue(item), "Other");
});

test("extractTerminationReasonValue uses early_term_reason when cancellation absent", () => {
  const item = {
    early_term_reason: { value: "Other Job Opportunity" },
    cancellation_reason: null,
  };
  assert.equal(extractTerminationReasonValue(item), "Other Job Opportunity");
});

test("mapTerminationReasonLogRowForDealSheet maps cancellation sample fields", () => {
  const apiItem = {
    id: 76581,
    cancelled_by: "CLIENT",
    notes: "client cancelled, changed shift last min\n",
    cancellation_reason: { value: "Other" },
    termination_type: null,
    dnr_at: null,
  };
  const context = {
    DEAL_SHEET_ID: 5210448,
    PLACEMENT_ID: 1454975,
    CONTRACT_ID: 100015,
  };
  const out = mapTerminationReasonLogRowForDealSheet(apiItem, context, "2026-06-03T10:00:00.000Z");
  assert.equal(out.PLACEMENT_ID, 1454975);
  assert.equal(out.CONTRACT_ID, 100015);
  assert.equal(out.TERMINATION_DETAIL_ID, 76581);
  assert.equal(out.CANCELLED_BY, "CLIENT");
  assert.equal(out.VALUE, "Other");
  assert.equal(out.NOTES, "client cancelled, changed shift last min");
});

test("mapTerminationReasonLogRowForDealSheet maps early_term sample fields", () => {
  const apiItem = {
    id: 76543,
    cancelled_by: null,
    notes: "Voluntary Cancel without notice",
    early_term_reason: { value: "Other Job Opportunity" },
    termination_type: "VOLUNTARY",
    dnr_at: "AT_CLIENT_ONLY",
  };
  const context = { DEAL_SHEET_ID: 1, PLACEMENT_ID: 1457532, CONTRACT_ID: 100020 };
  const out = mapTerminationReasonLogRowForDealSheet(apiItem, context, "2026-06-03T10:00:00.000Z");
  assert.equal(out.VALUE, "Other Job Opportunity");
  assert.equal(out.TERMINATION_TYPE, "VOLUNTARY");
  assert.equal(out.DNR_AT, "AT_CLIENT_ONLY");
});

test("pickLatestTerminationDetailItem chooses newest modified_date", () => {
  const items = [
    { id: 1, modified_date: "2026-05-01T00:00:00Z", cancellation_reason: { value: "Old" } },
    { id: 2, modified_date: "2026-06-01T00:00:00Z", cancellation_reason: { value: "New" } },
  ];
  const latest = pickLatestTerminationDetailItem(items);
  assert.equal(latest.id, 2);
  assert.equal(extractTerminationReasonValue(latest), "New");
});

test("TERMINATION_REASON is API-owned on deal sheet", () => {
  assert.equal(API_OWNED_COLUMNS.has("TERMINATION_REASON"), true);
});
