const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("./systemsCeipalMapping");

// PLC-13831 as returned by the CEIPAL report API on 2026-11-18.
const REC = {
  PlacementCode: "PLC-13831", ApplicantId: 445431, Email: "jaylgholson@gmail.com",
  ModifiedOn: "05/12/26 12:43:22", ApplicantName: "James Lance Gholson", MobileNumber: "6153007453",
  WorkAuthorization: "US Citizen", PaylocityID: "", JobCode: "JPC - 241318", JobTitle: "Content Writer",
  ClientJobID: "25-35753", Client: "GlobalLogic", ClientCategory: "System Integrator", JobCategory: "",
  EndClient: "Google", City: "", ZipCode: "42021", PlacementType: "Recurring Revenue",
  PlacementStatus: "Inactive", ProfileStatus: "Project Ended", ActualStartDate: "03/04/26",
  ActualEndDate: "04/13/26", TentativeStartDate: "", ProjectEndDate: "09/16/26", EffectiveDate: "03/04/26",
  SubmittedOn: "07/11/25 11:03:00", NotJoinedReason: "", EndReason: "Terminated - Contract Ended",
  ClientBillRate: "$29", NetBillRate: "$29", PayRateSalary: "$21", PayType: "Hourly",
  OTPayRateHour: "$0.00", OTBillRateHour: "$0.00", LoadedCost: "$23.94", LoadingCost: "",
  TaxTerms: "W2 - Profit Sharing", VMSMSPFee: "", PassThrough: "No", ProfitMargin: 27.586206896551722,
  PaymentTerms: "Net 45", InvoiceFrequency: "Calendar Month", PayrollCycle: "W2 BIWEEKLY", PONumber: "",
  RecruiterSalesExecutive: "Sonal Panwar", RecruiterSalesExecutiveEmailId: "sonal.p@cynetsystems.com",
  SubmittedByRecruiterEmployeeID: "CY1726", RecruitmentManager: "Test Account", TeamLeader: "Test Account",
  AccountManager: "Test Account", AssociateAccountManager: "Test Account", SecondarySalesManager: "Test Account",
  DeliveryHead: "Varun Gupta", DirectorSrDirector: "Avneesh Shukla", OnsiteClientManager: "Ron Bagga",
  OnsiteClientHead: "Test Account", MSP: "GlobalLogic", SKUNumber: "S10214_S10736", PerDiemHour: "$0.00",
  SupplierMobileNumber: "", SupplierEmailId: "", SupplierCompanyName: "NA", State: "Kentucky", CityState: "Kentucky",
};

test("maps the API sample record to the CS_TABLE_RUNRATE columns", () => {
  const r = m.mapCeipalRecordToRow(REC, { todayIso: "2026-11-18" });
  assert.equal(r.PLACEMENT_ID, "PLC-13831");
  assert.equal(r.PLACEMENT_TYPE, "CT");
  assert.equal(r.PLACEMENT_STATUS, "TERMINATED");
  assert.equal(r.START_DATE, "2026-03-04");
  assert.equal(r.END_DATE, "2026-04-13");
  assert.equal(r.TENTATIVE_END_DATE, "2026-09-16");
  assert.equal(r.SUBMISSION_DATE, "2025-07-11 11:03:00");
  assert.equal(r.CANDIDATE_NO, "615-300-7453");
  assert.equal(r.TYPE, "W2");
  assert.equal(r.CLIENT_TYPE, "SI");
  assert.equal(r.INV_CYC_TO_CLT, "Monthly");
  assert.equal(r.CLT_PYMT_TERM, "NET 45");
  assert.equal(r.LOCATION, "KY");
  assert.equal(r.CITY_ZIPCODE, "42021");
  assert.equal(r.PASSTHROUGH, "N");
  assert.equal(r.VISA_STATUS, "U.S. Citizen");
  assert.equal(r.VENDOR_NAME, null, '"NA" supplier is null');
  assert.equal(r.ONSITE_GROUP_HEAD, null, '"Test Account" is null');
  assert.equal(r.DELIVERY_POC, "Avneesh Shukla");
  assert.equal(r.ENTITY, "SYSTEMS");
  assert.equal(r.CURRENCY, "USD");
  assert.equal(r.GP_PERCENTAGE, 27.59);
  assert.equal(r.MARGIN, 8, "MARGIN = CEIPAL Bill - Pay");
  assert.equal(r.CEIPAL_RECRUITER_EMP_NO, "CY1726");
});

test("sheet formulas: FINAL BILL RATE, MARGIN, DELIVERY VALUE, DAYS WORKED", () => {
  const f = m.computeRunrateFormulas({
    type: "W2", payRate: 19.75, perDiem: 0, billRate: 28.67, mspFee: 0.025,
    startDate: "2026-08-17", endDate: "2026-09-25",
  });
  assert.equal(f.FINAL_PAY_RATE, 22.515); // 19.75 x 1.14
  assert.equal(f.FINAL_COST, 24.2925); // + 19.75 x 0.09
  assert.equal(f.FINAL_BILL_RATE, 27.95325); // 28.67 - 28.67 x 0.025
  assert.equal(f.CALCULATED_MARGIN, 3.66075); // FINAL BILL RATE - FINAL COST
  assert.equal(f.NET_MARGIN, f.CALCULATED_MARGIN);
  assert.equal(f.GROSS_MARGIN, 5.43825); // DELIVERY VALUE = FINAL BILL RATE - FINAL PAY RATE
  assert.equal(f.DAYS_WORKED, 39);
});

test("C2C uses 0% loading and 7% overhead; no end date -> DAYS_WORKED null", () => {
  const f = m.computeRunrateFormulas({ type: "C2C", payRate: 60, perDiem: 0, billRate: 80, mspFee: 0.05, startDate: "2026-01-05", endDate: null });
  assert.equal(f.FINAL_PAY_RATE, 60);
  assert.equal(f.FINAL_COST, 64.2);
  assert.equal(f.FINAL_BILL_RATE, 76);
  assert.equal(f.DAYS_WORKED, null);
});

test("Full Time rows get no hourly formulas", () => {
  const f = m.computeRunrateFormulas({ type: "FT", payRate: 185000, billRate: 0 });
  assert.equal(f.FINAL_BILL_RATE, null);
  assert.equal(f.CALCULATED_MARGIN, null);
});

test("Canada: ENTITY/CURRENCY, own TYPE, FINAL_PAY_RATE = Loaded Cost, FINAL_COST = x1.08", () => {
  const r = m.mapCeipalRecordToRow(
    { ...REC, ClientBillRate: "CAD58", NetBillRate: "CAD58", PayRateSalary: "CAD40", LoadedCost: "CAD47.84", PerDiemHour: "CAD0.00", TaxTerms: "T4", VMSMSPFee: "", State: "Ontario" },
    { todayIso: "2026-11-18" }
  );
  assert.equal(r.ENTITY, "CANADA");
  assert.equal(r.CURRENCY, "CAD");
  assert.equal(r.TYPE, "T4");
  assert.equal(r.LOCATION, "ON");
  assert.equal(r.FINAL_PAY_RATE, 47.84);
  assert.equal(r.FINAL_COST, 51.6672);
  assert.equal(r.FINAL_BILL_RATE, 58);
});

test("Health rows keep the Systems formula and ENTITY HEALTH", () => {
  const r = m.mapCeipalRecordToRow({ ...REC, Client: "Quest Diagnostics", SKUNumber: "H134224_H14493" });
  assert.equal(r.ENTITY, "HEALTH");
  assert.equal(r.CURRENCY, "USD");
  assert.equal(r.FINAL_PAY_RATE, 23.94);
});

test("classification tells the three businesses apart", () => {
  assert.equal(m.classifyCeipalRecord(REC), "systems");
  assert.equal(m.classifyCeipalRecord({ ...REC, ClientBillRate: "CAD58" }), "canada");
  assert.equal(m.classifyCeipalRecord({ ...REC, Client: "Quest Diagnostics" }), "health");
  assert.equal(m.classifyCeipalRecord({ ...REC, SKUNumber: "H134224_H14493" }), "health");
  assert.equal(m.classifyCeipalRecord({ ...REC, PlacementCode: "PLC-16180" }), "excluded");
});

test("placement status rules", () => {
  const st = (o, s, e) => m.derivePlacementStatus({ ...REC, NotJoinedReason: "", ...o }, s, e, "2026-11-18");
  assert.equal(st({ PlacementStatus: "Active", ProfileStatus: "Placed", EndReason: "" }, "2026-01-05", null), "STARTED/ PLACED");
  assert.equal(st({ PlacementStatus: "Active", ProfileStatus: "Placed", EndReason: "" }, "2026-12-01", null), "ONBOARDING");
  assert.equal(st({ EndReason: "Did Not Start/Back-Out - Candidate Declined Offer" }, "2026-01-05", "2026-01-05"), "DID NOT START");
  // Same-day end with a Termination reason is <30, not DNS.
  assert.equal(st({ EndReason: "Termination - Candidate Resigned" }, "2026-10-26", "2026-10-26"), "TERMINATED<30 DAYS");
  assert.equal(st({ EndReason: "Termination - Contract Ended" }, "2026-08-17", "2026-09-16"), "TERMINATED<30 DAYS");
  assert.equal(st({ EndReason: "Termination - Contract Ended" }, "2026-08-17", "2026-09-25"), "TERMINATED");
});

test("value parsing edge cases", () => {
  assert.equal(m.mspFeeFraction("5% of the Bill rate"), 0.05);
  assert.equal(m.mspFeeFraction("2.11 %"), 0.0211);
  assert.equal(m.mspFeeFraction(""), 0);
  assert.equal(m.money("$185,000"), 185000);
  assert.equal(m.money("CAD47.84"), 47.84);
  assert.equal(m.parseCeipalDate("0000-00-00").date, null);
  assert.equal(m.parseCeipalDate("12/31/69").date, null);
  assert.equal(m.personName("Mayank Ahuja (Inactive User)"), "Mayank Ahuja");
  assert.equal(m.stateCode("New York"), "NY");
  assert.equal(m.mapCeipalRecordToRow({ ...REC, State: "", CityState: "Texas" }).LOCATION, "TX");
});
