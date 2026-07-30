const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveExtensionInorganicLogRows } = require("./bigQueryClient");
const { normalizeNameKey } = require("./departmentDataStatus");

function buildByName(entries) {
  const byName = new Map();
  for (const e of entries) {
    const key = normalizeNameKey(e.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }
  return byName;
}

const EXT_ROW = {
  PLACEMENT_ID: "P1",
  DEAL_SHEET_ID: "D1",
  CANDIDATE_NAME: "Veda",
  CANDIDATE_NEXUS_ID: "N1",
  PLACEMENT_STATUS: "ACTIVE",
  SKU_NUMBER: "H13614",
  DEAL_TYPE: "EXTENSION",
};

test("Veda/H13614: both runrate inorganic people (Sonam + Amy) land in the log row", async () => {
  const rows = await resolveExtensionInorganicLogRows([EXT_ROW], {}, {
    runrateFetchFn: async () =>
      new Map([["P1", { INORGANIC_ASSOCIATE_AM: "Sonam Chaudhary", INORGANIC_VP_SR_VP: "Amy" }]]),
    departmentFetchFn: async () =>
      buildByName([
        { name: "Sonam Chaudhary", empNo: "CY100", designation: "Associate Account Manager", status: "Active", immediateManager: "Amy" },
        { name: "Amy", empNo: "CY200", designation: "Vice President - Delivery", status: "Active", immediateManager: null },
      ]),
    fetchEmailsFn: async () => ({ byEmp: new Map([["CY200", "amy@cynethealth.com"]]) }),
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.PLACEMENT_ID, "P1");
  assert.equal(row.DEAL_SHEET_ID, "D1");
  assert.equal(row.INORGANIC_ASSOCIATE_AM, "Sonam Chaudhary");
  assert.equal(row.INORGANIC_ASSOCIATE_AM_EMP_NO, "CY100");
  assert.equal(row.INORGANIC_VP_SR_VP, "Amy");
  assert.equal(row.INORGANIC_VP_SR_VP_EMP_NO, "CY200");
  // DELIVERY_POC = highest-seniority present (VP over Associate AM).
  assert.equal(row.INORGANIC_DELIVERY_POC, "Amy");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, "CY200");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMAIL, "amy@cynethealth.com");
});

test("inactive inorganic person is remapped to the first active manager's designation column", async () => {
  const rows = await resolveExtensionInorganicLogRows([EXT_ROW], {}, {
    runrateFetchFn: async () => new Map([["P1", { INORGANIC_RM: "Neelesh Vijay" }]]),
    departmentFetchFn: async () =>
      buildByName([
        { name: "Neelesh Vijay", empNo: "CY1615", designation: "Recruitment Manager", status: "Inactive", immediateManager: "Deepti" },
        { name: "Deepti", empNo: "CY300", designation: "Director - Delivery", status: "Active", immediateManager: null },
      ]),
    fetchEmailsFn: async () => ({ byEmp: new Map() }),
  });

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.INORGANIC_RM, undefined);
  assert.equal(row.INORGANIC_DELIVERY_DIRECTOR, "Deepti");
  assert.equal(row.INORGANIC_DELIVERY_DIRECTOR_EMP_NO, "CY300");
});

test("placement with no active resolvable inorganic person produces no log row", async () => {
  const rows = await resolveExtensionInorganicLogRows([EXT_ROW], {}, {
    runrateFetchFn: async () => new Map([["P1", { INORGANIC_RM: "Ghost" }]]),
    departmentFetchFn: async () =>
      buildByName([
        { name: "Ghost", empNo: "G1", designation: "Recruitment Manager", status: "Inactive", immediateManager: "Nobody" },
      ]),
    fetchEmailsFn: async () => ({ byEmp: new Map() }),
  });
  assert.equal(rows.length, 0);
});

test("no runrate inorganic match -> no rows", async () => {
  const rows = await resolveExtensionInorganicLogRows([EXT_ROW], {}, {
    runrateFetchFn: async () => new Map(),
    departmentFetchFn: async () => new Map(),
    fetchEmailsFn: async () => ({ byEmp: new Map() }),
  });
  assert.equal(rows.length, 0);
});

test("inactive recruiter identity slot is dropped (NA)", async () => {
  const rows = await resolveExtensionInorganicLogRows([EXT_ROW], {}, {
    runrateFetchFn: async () =>
      new Map([["P1", { INORGANIC_RECRUITER: "Old Rec", INORGANIC_ASSOCIATE_AM: "Sonam Chaudhary" }]]),
    departmentFetchFn: async () =>
      buildByName([
        { name: "Old Rec", empNo: "R1", designation: "Recruiter", status: "Inactive", immediateManager: null },
        { name: "Sonam Chaudhary", empNo: "CY100", designation: "Associate Account Manager", status: "Active", immediateManager: null },
      ]),
    fetchEmailsFn: async () => ({ byEmp: new Map() }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].INORGANIC_RECRUITER, undefined);
  assert.equal(rows[0].INORGANIC_ASSOCIATE_AM, "Sonam Chaudhary");
});
