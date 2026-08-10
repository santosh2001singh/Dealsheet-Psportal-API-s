const test = require("node:test");
const assert = require("node:assert/strict");

const {
  pickDeliveryPocForRow,
  applyHierarchyNameEmpConsistency,
} = require("./bigQueryClient");

// --- DELIVERY_POC priority: AVP + DELIVERY_DIRECTOR now included ---

test("AVP outranks ACCOUNT_MANAGER for DELIVERY_POC (Batasha-type case)", () => {
  const row = {
    VP: "NA",
    AVP: "Maneet Gupta",
    AVP_EMP_NO: "CY2088",
    ASSOCIATE_DELIVERY_DIRECTOR: null,
    DELIVERY_DIRECTOR: null,
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
    RM: "Sahil Kumar",
    RM_EMP_NO: "CY5069",
    ASSIGNMENT_RECRUITER: "Animesh Ghosh",
    RECRUITER_EMP_NO: "CY5653",
  };
  const picked = pickDeliveryPocForRow(row);
  assert.equal(picked.name, "Maneet Gupta");
  assert.equal(picked.empNo, "CY2088");
});

test("DELIVERY_DIRECTOR wins when VP/AVP/GRP_DIR absent but above ACCOUNT_MANAGER", () => {
  const row = {
    VP: "NA",
    AVP: null,
    ASSOCIATE_DELIVERY_DIRECTOR: null,
    DELIVERY_DIRECTOR: "Deepti Sharma",
    DELIVERY_DIRECTOR_EMP_NO: "CY1166",
    ACCOUNT_MANAGER: "Someone Else",
    ACCOUNT_MANAGER_EMP_NO: "CY9999",
  };
  const picked = pickDeliveryPocForRow(row);
  assert.equal(picked.name, "Deepti Sharma");
  assert.equal(picked.empNo, "CY1166");
});

test("VP still outranks AVP", () => {
  const row = {
    VP: "Top Boss",
    VP_EMP_NO: "CY1",
    AVP: "Maneet Gupta",
    AVP_EMP_NO: "CY2088",
  };
  const picked = pickDeliveryPocForRow(row);
  assert.equal(picked.name, "Top Boss");
});

// --- Name/emp-no consistency: name NA/blank -> emp NA ---

test("name 'NA' with populated emp-no -> emp-no forced to 'NA'", () => {
  const row = {
    TEAM_LEAD: "NA",
    TEAM_LEAD_EMP_NO: "CY1554",
    ACCOUNT_MANAGER: "NA",
    ACCOUNT_MANAGER_EMP_NO: "CY1615",
    ASSOCIATE_DELIVERY_DIRECTOR: "Deepti Sharma",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY1166",
  };
  const out = applyHierarchyNameEmpConsistency(row);
  assert.equal(out.TEAM_LEAD_EMP_NO, "NA");
  assert.equal(out.ACCOUNT_MANAGER_EMP_NO, "NA");
  // present name -> emp-no untouched
  assert.equal(out.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY1166");
});

test("null / blank name also clears emp-no to 'NA'", () => {
  const row = {
    RM: null,
    RM_EMP_NO: "CY5069",
    ATL: "   ",
    ATL_EMP_NO: "CY7",
  };
  const out = applyHierarchyNameEmpConsistency(row);
  assert.equal(out.RM_EMP_NO, "NA");
  assert.equal(out.ATL_EMP_NO, "NA");
});

test("already-consistent row is returned unchanged (same reference)", () => {
  const row = {
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
    RM: "NA",
    RM_EMP_NO: "NA",
    TEAM_LEAD: null,
    TEAM_LEAD_EMP_NO: null,
  };
  const out = applyHierarchyNameEmpConsistency(row);
  assert.equal(out, row);
});

test("DELIVERY_POC pair is also enforced", () => {
  const row = { DELIVERY_POC: "NA", DELIVERY_POC_EMP_NO: "CY1166" };
  const out = applyHierarchyNameEmpConsistency(row);
  assert.equal(out.DELIVERY_POC_EMP_NO, "NA");
});

// --- INORGANIC RESTRICTED DELIVERY_POC (only VP, AVP, DELIVERY_DIRECTOR, GRP_DIR) ---

test("pickInorganicRestrictedDeliveryPocForRow: VP wins when all 4 present", () => {
  const { pickInorganicRestrictedDeliveryPocForRow } = require("./bigQueryClient");
  const row = {
    VP: "Top Boss",
    VP_EMP_NO: "CY1",
    AVP: "Middle Manager",
    AVP_EMP_NO: "CY2088",
    DELIVERY_DIRECTOR: "Deepti Sharma",
    DELIVERY_DIRECTOR_EMP_NO: "CY1166",
    ASSOCIATE_DELIVERY_DIRECTOR: "Group Lead",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY999",
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
    RM: "Sahil Kumar",
    RM_EMP_NO: "CY5069",
  };
  const picked = pickInorganicRestrictedDeliveryPocForRow(row);
  assert.equal(picked.name, "Top Boss");
  assert.equal(picked.empNo, "CY1");
});

test("pickInorganicRestrictedDeliveryPocForRow: AVP picked when VP absent", () => {
  const { pickInorganicRestrictedDeliveryPocForRow } = require("./bigQueryClient");
  const row = {
    VP: null,
    AVP: "Maneet Gupta",
    AVP_EMP_NO: "CY2088",
    DELIVERY_DIRECTOR: "Deepti Sharma",
    DELIVERY_DIRECTOR_EMP_NO: "CY1166",
    ASSOCIATE_DELIVERY_DIRECTOR: null,
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
  };
  const picked = pickInorganicRestrictedDeliveryPocForRow(row);
  assert.equal(picked.name, "Maneet Gupta");
  assert.equal(picked.empNo, "CY2088");
});

test("pickInorganicRestrictedDeliveryPocForRow: ACCOUNT_MANAGER ignored (not in restricted list)", () => {
  const { pickInorganicRestrictedDeliveryPocForRow } = require("./bigQueryClient");
  const row = {
    VP: null,
    AVP: null,
    DELIVERY_DIRECTOR: null,
    ASSOCIATE_DELIVERY_DIRECTOR: null,
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
    RM: "Sahil Kumar",
    RM_EMP_NO: "CY5069",
  };
  const picked = pickInorganicRestrictedDeliveryPocForRow(row);
  assert.equal(picked, null);
});

test("pickInorganicRestrictedDeliveryPocForRow: GRP_DIR picked when VP/AVP/DELIVERY_DIRECTOR absent", () => {
  const { pickInorganicRestrictedDeliveryPocForRow } = require("./bigQueryClient");
  const row = {
    VP: "NA",
    AVP: null,
    DELIVERY_DIRECTOR: null,
    ASSOCIATE_DELIVERY_DIRECTOR: "Deepti Sharma",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY1166",
    ACCOUNT_MANAGER: "Hardik Khurana",
    ACCOUNT_MANAGER_EMP_NO: "CY2121",
  };
  const picked = pickInorganicRestrictedDeliveryPocForRow(row);
  assert.equal(picked.name, "Deepti Sharma");
  assert.equal(picked.empNo, "CY1166");
});
