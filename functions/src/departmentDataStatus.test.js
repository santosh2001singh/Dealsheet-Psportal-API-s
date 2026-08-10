const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isActiveStatus,
  normalizeNameKey,
  fetchDepartmentEmployeesByNames,
  resolveActiveOrManager,
} = require("./departmentDataStatus");

// Helper: build a byName Map (as fetchDepartmentEmployeesByNames would) from flat entries.
function buildByName(entries) {
  const byName = new Map();
  for (const e of entries) {
    const key = normalizeNameKey(e.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }
  return byName;
}

test("isActiveStatus is case/space-insensitive and false for null/Inactive", () => {
  assert.equal(isActiveStatus("Active"), true);
  assert.equal(isActiveStatus(" active "), true);
  assert.equal(isActiveStatus("ACTIVE"), true);
  assert.equal(isActiveStatus("Inactive"), false);
  assert.equal(isActiveStatus(""), false);
  assert.equal(isActiveStatus(null), false);
});

test("active person is kept at the runrate-provided column with emp-no", () => {
  const byName = buildByName([
    { name: "Sonam Chaudhary", empNo: "CY100", designation: "Associate Account Manager", status: "Active", immediateManager: "Deepti" },
  ]);
  const res = resolveActiveOrManager("Sonam Chaudhary", "ASSOCIATE_AM", byName);
  assert.deepEqual(res, { name: "Sonam Chaudhary", empNo: "CY100", column: "ASSOCIATE_AM" });
});

test("inactive person is replaced by the first active IMMEDIATE_MANAGER, remapped by designation", () => {
  const byName = buildByName([
    { name: "Neelesh Vijay", empNo: "CY1615", designation: "Recruitment Manager", status: "Inactive", immediateManager: "Deepti" },
    { name: "Deepti", empNo: "CY200", designation: "Director - Delivery", status: "Active", immediateManager: "Amy" },
  ]);
  const res = resolveActiveOrManager("Neelesh Vijay", "RM", byName);
  // Director - Delivery maps to DELIVERY_DIRECTOR, not the original RM slot.
  assert.deepEqual(res, { name: "Deepti", empNo: "CY200", column: "DELIVERY_DIRECTOR" });
});

test("walks multiple inactive managers until an active one is found", () => {
  const byName = buildByName([
    { name: "A", empNo: "1", designation: "Recruitment Manager", status: "Inactive", immediateManager: "B" },
    { name: "B", empNo: "2", designation: "Delivery Manager", status: "Inactive", immediateManager: "C" },
    { name: "C", empNo: "3", designation: "Vice President - Delivery", status: "Active", immediateManager: null },
  ]);
  const res = resolveActiveOrManager("A", "RM", byName);
  assert.deepEqual(res, { name: "C", empNo: "3", column: "VP" });
});

test("entire manager chain inactive/unknown -> NA (null)", () => {
  const byName = buildByName([
    { name: "A", empNo: "1", designation: "Recruitment Manager", status: "Inactive", immediateManager: "Ghost" },
  ]);
  assert.equal(resolveActiveOrManager("A", "RM", byName), null);
});

test("not found in Department_Data -> kept as-is at expected column (unverified), emp-no null", () => {
  const byName = buildByName([]);
  const res = resolveActiveOrManager("Unknown Person", "TEAM_LEAD", byName);
  assert.deepEqual(res, { name: "Unknown Person", empNo: null, column: "TEAM_LEAD" });
});

test("blank / NA name -> null", () => {
  const byName = buildByName([]);
  assert.equal(resolveActiveOrManager("", "RM", byName), null);
  assert.equal(resolveActiveOrManager("NA", "RM", byName), null);
  assert.equal(resolveActiveOrManager(null, "RM", byName), null);
});

test("name+designation disambiguation picks the row matching the expected column", () => {
  const byName = buildByName([
    { name: "Same Name", empNo: "AM1", designation: "Account Manager", status: "Active", immediateManager: null },
    { name: "Same Name", empNo: "RM1", designation: "Recruitment Manager", status: "Active", immediateManager: null },
  ]);
  const asRm = resolveActiveOrManager("Same Name", "RM", byName);
  assert.equal(asRm.empNo, "RM1");
  const asAm = resolveActiveOrManager("Same Name", "ACCOUNT_MANAGER", byName);
  assert.equal(asAm.empNo, "AM1");
});

test("active person: output name prefers GOES_BY_NAME over EMPLOYEE_NAME", () => {
  const byName = buildByName([
    {
      name: "Amrita Gupta",
      goesByName: "Amy Gupta",
      empNo: "CY788",
      designation: "Vice President - Delivery",
      status: "ACTIVE",
      immediateManager: "Ron Bagga",
    },
  ]);
  // Runrate provides the goes-by form; lookup key in this test is EMPLOYEE_NAME (buildByName keys by name),
  // so resolve by "Amrita Gupta" to reach the entry and assert the OUTPUT name is the goes-by form.
  const res = resolveActiveOrManager("Amrita Gupta", "VP", byName);
  assert.deepEqual(res, { name: "Amy Gupta", empNo: "CY788", column: "VP" });
});

test("resolved active manager output name prefers GOES_BY_NAME", () => {
  const byName = buildByName([
    { name: "Neelesh Vijay", goesByName: "Neelesh", empNo: "CY1615", designation: "Recruitment Manager", status: "Inactive", immediateManager: "Amrita Gupta" },
    { name: "Amrita Gupta", goesByName: "Amy Gupta", empNo: "CY788", designation: "Vice President - Delivery", status: "ACTIVE", immediateManager: null },
  ]);
  const res = resolveActiveOrManager("Neelesh Vijay", "RM", byName);
  assert.deepEqual(res, { name: "Amy Gupta", empNo: "CY788", column: "VP" });
});

test("fetchDepartmentEmployeesByNames keys ONLY by GOES_BY_NAME", async () => {
  const fakeQuery = async () => [
    {
      EMPLOYEE_NO: "CY1",
      EMPLOYEE_NAME: "Sonam Chaudhary",
      GOES_BY_NAME: "Sonam",
      DESIGNATION: "Associate Account Manager",
      IMMEDIATE_MANAGER: "Deepti",
      STATUS: "Active",
    },
  ];
  const byName = await fetchDepartmentEmployeesByNames(["Sonam"], { queryFn: fakeQuery });
  // Keyed by GOES_BY_NAME only; the full EMPLOYEE_NAME is NOT a lookup key anymore.
  assert.equal(byName.get("sonam")[0].empNo, "CY1");
  assert.equal(byName.get("sonam")[0].name, "Sonam Chaudhary");
  assert.equal(byName.get("sonam")[0].goesByName, "Sonam");
  assert.equal(byName.has("sonam chaudhary"), false);
});

test("fetchDepartmentEmployeesByNames requires deps.queryFn", async () => {
  await assert.rejects(() => fetchDepartmentEmployeesByNames(["x"]), /requires deps.queryFn/);
});
