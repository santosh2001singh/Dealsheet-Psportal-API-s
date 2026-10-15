const test = require("node:test");
const assert = require("node:assert/strict");

const { applyHealthDefaultEntity, HEALTH_DEFAULT_ENTITY } = require("./bigQueryClient");

// Business rule (Oct 2026): every cynet_health_deal_sheet row carries ENTITY = HEALTH unless the
// baseline, the run-rate row, a parent DEAL or a hand edit already supplied one.
const healthRow = {
  ASSIGNMENT_RECRUITER_EMAIL: "sid.k@cynethealth.com",
  OFFERING: "NURSING",
  CLIENT_STATE: "NC",
};

test("health row with blank ENTITY gets HEALTH", () => {
  for (const blank of [undefined, null, "", "   "]) {
    assert.equal(applyHealthDefaultEntity({ ...healthRow, ENTITY: blank }).ENTITY, HEALTH_DEFAULT_ENTITY);
  }
  assert.equal(HEALTH_DEFAULT_ENTITY, "HEALTH");
});

test("an existing ENTITY is never overwritten", () => {
  assert.equal(applyHealthDefaultEntity({ ...healthRow, ENTITY: "TECH" }).ENTITY, "TECH");
});

test("Canada-province rows are left to the Canada default", () => {
  const row = { ...healthRow, CLIENT_STATE: "ON", ENTITY: null };
  assert.equal(applyHealthDefaultEntity(row).ENTITY, null);
});

test("locums rows (by OFFERING or recruiter domain) are left alone", () => {
  assert.equal(applyHealthDefaultEntity({ ...healthRow, OFFERING: "LOCUMS", ENTITY: null }).ENTITY, null);
  const locums = { ...healthRow, ASSIGNMENT_RECRUITER_EMAIL: "a@cynetlocums.com", ENTITY: null };
  assert.equal(applyHealthDefaultEntity(locums).ENTITY, null);
});

test("null / non-object input passes through", () => {
  assert.equal(applyHealthDefaultEntity(null), null);
  assert.equal(applyHealthDefaultEntity(undefined), undefined);
});
