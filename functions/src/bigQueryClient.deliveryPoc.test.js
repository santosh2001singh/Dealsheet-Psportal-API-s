const test = require("node:test");
const assert = require("node:assert/strict");

const { pickDeliveryPocForRow, applyDeliveryPocForInsertRows } = require("./bigQueryClient");

test("pickDeliveryPocForRow: prefers VP_SRVP when filled", () => {
  const p = pickDeliveryPocForRow({ VP_SRVP: "Amy Gupta", VP_SRVP_EMP_NO: "CY788", ACCOUNT_MANAGER: "Neelesh", ACCOUNT_MANAGER_EMP_NO: "CY1615" });
  assert.equal(p.nameCol, "VP_SRVP");
  assert.equal(p.name, "Amy Gupta");
  assert.equal(p.empNo, "CY788");
  assert.equal(p.isRecruiter, false);
});

test("pickDeliveryPocForRow: skips NA/blank and falls to ACCOUNT_MANAGER", () => {
  const p = pickDeliveryPocForRow({
    VP_SRVP: "NA", VP_SRVP_EMP_NO: null,
    GRP_DIR_ASSOC_GRP_DIR: "", GRP_DIR_ASSOC_GRP_DIR_EMP_NO: null,
    ACCOUNT_MANAGER: "Neelesh Vijay", ACCOUNT_MANAGER_EMP_NO: "CY1615",
    RM: "Alex Smith", RM_EMP_NO: "CY3248",
  });
  assert.equal(p.nameCol, "ACCOUNT_MANAGER");
  assert.equal(p.name, "Neelesh Vijay");
  assert.equal(p.empNo, "CY1615");
});

test("pickDeliveryPocForRow: only RM and ATL filled -> RM (RM is higher priority than ATL)", () => {
  const p = pickDeliveryPocForRow({
    VP_SRVP: "NA", ACCOUNT_MANAGER: "NA", SECONDARY_AM: "NA", ASSOCIATE_AM: "NA",
    RM: "Alex Smith", RM_EMP_NO: "CY3248",
    ATL: "Some Atl", ATL_EMP_NO: "CY9",
  });
  assert.equal(p.nameCol, "RM");
});

test("pickDeliveryPocForRow: all delivery roles blank/NA -> falls back to recruiter", () => {
  const p = pickDeliveryPocForRow({
    VP_SRVP: "NA", ACCOUNT_MANAGER: null, RM: "NA", ATL: "",
    ASSIGNMENT_RECRUITER: "Gurmeet Singh", RECRUITER_EMP_NO: "CY5565",
    ASSIGNMENT_RECRUITER_EMAIL: "gurmeet.s@cynethealth.com",
  });
  assert.equal(p.nameCol, "ASSIGNMENT_RECRUITER");
  assert.equal(p.isRecruiter, true);
  assert.equal(p.empNo, "CY5565");
});

test("pickDeliveryPocForRow: everyone blank -> null", () => {
  assert.equal(pickDeliveryPocForRow({ VP_SRVP: "NA", RM: null, ASSIGNMENT_RECRUITER: "" }), null);
});

test("applyDeliveryPocForInsertRows: fills name/emp/email; recruiter email from row, others from directory", async () => {
  const rows = [
    // VP POC -> email from directory by emp_no
    { PLACEMENT_ID: 1, VP_SRVP: "Amy Gupta", VP_SRVP_EMP_NO: "CY788" },
    // recruiter fallback -> email from ASSIGNMENT_RECRUITER_EMAIL directly
    { PLACEMENT_ID: 2, VP_SRVP: "NA", ASSIGNMENT_RECRUITER: "Gurmeet Singh", RECRUITER_EMP_NO: "CY5565", ASSIGNMENT_RECRUITER_EMAIL: "gurmeet.s@cynethealth.com" },
    // already-set DELIVERY_POC -> frozen, untouched
    { PLACEMENT_ID: 3, DELIVERY_POC: "Frozen Person", DELIVERY_POC_EMP_NO: "CYX", ACCOUNT_MANAGER: "Someone", ACCOUNT_MANAGER_EMP_NO: "CY2" },
  ];

  const fetchEmailsFn = async (empNos, names) => {
    assert.deepEqual(empNos, ["CY788"]); // recruiter (row 2) email not looked up; row 3 frozen
    return { byEmp: new Map([["CY788", "amy.g@cynethealth.com"]]), byName: new Map() };
  };

  const out = await applyDeliveryPocForInsertRows(rows, {}, { fetchEmailsFn });
  assert.equal(out[0].DELIVERY_POC, "Amy Gupta");
  assert.equal(out[0].DELIVERY_POC_EMP_NO, "CY788");
  assert.equal(out[0].DELIVERY_POC_EMAIL, "amy.g@cynethealth.com");

  assert.equal(out[1].DELIVERY_POC, "Gurmeet Singh");
  assert.equal(out[1].DELIVERY_POC_EMP_NO, "CY5565");
  assert.equal(out[1].DELIVERY_POC_EMAIL, "gurmeet.s@cynethealth.com");

  assert.equal(out[2].DELIVERY_POC, "Frozen Person"); // unchanged
});

test("applyDeliveryPocForInsertRows: falls back to name lookup when emp_no missing", async () => {
  const rows = [{ PLACEMENT_ID: 1, VP_SRVP: "Amy Gupta", VP_SRVP_EMP_NO: null }];
  const fetchEmailsFn = async (empNos, names) => {
    assert.deepEqual(empNos, []);
    assert.deepEqual(names, ["Amy Gupta"]);
    return { byEmp: new Map(), byName: new Map([["amy gupta", "amy.g@cynethealth.com"]]) };
  };
  const out = await applyDeliveryPocForInsertRows(rows, {}, { fetchEmailsFn });
  assert.equal(out[0].DELIVERY_POC, "Amy Gupta");
  assert.equal(out[0].DELIVERY_POC_EMP_NO, null);
  assert.equal(out[0].DELIVERY_POC_EMAIL, "amy.g@cynethealth.com");
});
