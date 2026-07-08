const test = require("node:test");
const assert = require("node:assert/strict");

const { isOfferRejectedSubmittalRow } = require("./syncService");

test("isOfferRejectedSubmittalRow: true on code OFFER_REJECTED", () => {
  assert.equal(
    isOfferRejectedSubmittalRow({ organization_submittal_status: { code: "OFFER_REJECTED", submittal_status: "Offer Rejected" } }),
    true
  );
});

test("isOfferRejectedSubmittalRow: true on label 'Offer Rejected' even without code", () => {
  assert.equal(
    isOfferRejectedSubmittalRow({ organization_submittal_status: { submittal_status: "Offer Rejected" } }),
    true
  );
  assert.equal(isOfferRejectedSubmittalRow({ submittal_status: "offer rejected" }), true);
});

test("isOfferRejectedSubmittalRow: false for other statuses", () => {
  assert.equal(isOfferRejectedSubmittalRow({ organization_submittal_status: { code: "BOOKED", submittal_status: "Booked" } }), false);
  assert.equal(isOfferRejectedSubmittalRow({ organization_submittal_status: { code: "ACTIVE" } }), false);
  assert.equal(isOfferRejectedSubmittalRow(null), false);
  assert.equal(isOfferRejectedSubmittalRow({}), false);
});
