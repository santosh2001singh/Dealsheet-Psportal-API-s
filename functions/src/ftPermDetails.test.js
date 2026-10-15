const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapDealSheetPermDetailsToBq,
  applyFtPaymentTerms,
  isFtPlacementRow,
} = require("./columnMappings");

// Business rule (Oct 2026): FT rows take BILL_RATE / FINAL_BILL_RATE from
// /api/deal-sheet-perm-details/ gross_margin_dollar, and both payment-terms columns are "FT".

test("perm details gross_margin_dollar becomes BILL_RATE", () => {
  // Deal sheet 5256515 (Ivonne Andrade, CHC23057).
  assert.deepEqual(
    mapDealSheetPermDetailsToBq({ gross_margin_dollar: 11467.87, final_salary: 95565.6 }),
    { BILL_RATE: 11467.87 }
  );
  assert.deepEqual(mapDealSheetPermDetailsToBq({ gross_margin_dollar: "1200.456" }), { BILL_RATE: 1200.46 });
});

test("no perm row or no amount leaves BILL_RATE to the rates API", () => {
  assert.deepEqual(mapDealSheetPermDetailsToBq(null), {});
  assert.deepEqual(mapDealSheetPermDetailsToBq({ gross_margin_dollar: null }), {});
});

test("FT row gets FT payment terms, overriding a carried value", () => {
  const out = applyFtPaymentTerms({
    PLACEMENT_TYPE: "FT",
    CANDIDATE_PAYMENT_TERMS: "Weekly",
    INVOICE_CYCLE_TO_CLIENT: null,
  });
  assert.equal(out.CANDIDATE_PAYMENT_TERMS, "FT");
  assert.equal(out.INVOICE_CYCLE_TO_CLIENT, "FT");
});

test("non-FT rows keep their payment terms", () => {
  const row = { PLACEMENT_TYPE: "CT", CANDIDATE_PAYMENT_TERMS: "Weekly", INVOICE_CYCLE_TO_CLIENT: "Bi-weekly" };
  assert.equal(applyFtPaymentTerms(row), row);
  assert.equal(isFtPlacementRow({ PLACEMENT_TYPE: " ft " }), true);
  assert.equal(isFtPlacementRow({ PLACEMENT_TYPE: null }), false);
});
