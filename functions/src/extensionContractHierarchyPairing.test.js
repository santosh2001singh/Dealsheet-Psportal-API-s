const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { applyLegacyContractIdentityToDealRows } = require("./contractIdResolver");
const {
  legacyCarryColumns,
  legacyExtensionHierarchyColumns,
  legacyDealManualColumns,
} = require("./bigQueryClient");

/**
 * An EXTENSION row must take its CONTRACT_ID and its HIERARCHY off the SAME matched run-rate row.
 *
 * The run-rate window match is the only tier that knows which of a candidate's contracts a row
 * belongs to; the tiers after it match on candidate+client identity alone. While the window match
 * carried CONTRACT_ID / SKU / manual ops columns but NOT the hierarchy, the two halves came off
 * different contracts:
 *
 *   run-rate row A  CHC19540  2026-01-18..2026-03-31  ASSOCIATE_DELIVERY_DIRECTOR = Aniket Ahuja
 *   run-rate row B  CHC22685  2026-08-27..2026-11-21  ASSOCIATE_DELIVERY_DIRECTOR = Jasmeet Singh
 *
 * The extension (CANDIDATE_ID 22101746, PLACEMENT_ID 1462717, START 2026-08-27) matched row B on the
 * window and landed with CHC22685 + SKU ONB6947 from it — then took Aniket Ahuja off row A via the
 * prior-extension tier, because its hierarchy columns were still empty.
 */

const HEALTH_RUNRATE = "all_CH_data_runrate";

function extensionRow(overrides = {}) {
  return {
    DEAL_TYPE: "EXTENSION",
    PLACEMENT_STATUS: "BOOKED",
    DEAL_SHEET_ID: 5240515,
    PLACEMENT_ID: 1462717,
    CANDIDATE_ID: 22101746,
    INTERNAL_JOB_ID: 35500311,
    CANDIDATE_EMAIL: "genealvarez3@hotmail.com",
    START_DATE: "2026-08-27",
    TENTATIVE_END_DATE: "2026-10-24",
    FACILITY_NAME: "Memorial Hospital - Bakersfield",
    PARENT_CLIENT_NAME: "CommonSpirit Health",
    CONTRACT_ID: null,
    SKU_NUMBER: null,
    ...overrides,
  };
}

/** The run-rate row the window match picks — contract CHC22685, its own hierarchy. */
function matchedRowBIdentity(overrides = {}) {
  return {
    CONTRACT_ID: "CHC22685",
    SKU_NUMBER: "ONB6947",
    INITIAL_START_DATE: null,
    ASSOCIATE_DELIVERY_DIRECTOR: "Jasmeet Singh",
    ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO: "CY5379",
    ENTITY: "HEALTH",
    ...overrides,
  };
}

function fetchStub(entries, spy) {
  return async (rows, options) => {
    if (spy) spy.push({ rowCount: rows.length, options });
    return new Map(entries);
  };
}

test("legacyExtensionHierarchyColumns pairs every name with its _EMP_NO", () => {
  const cols = legacyExtensionHierarchyColumns(HEALTH_RUNRATE);
  for (const name of ["TEAM_LEAD", "ATL", "ACCOUNT_MANAGER", "ASSOCIATE_DELIVERY_DIRECTOR", "VP"]) {
    assert.ok(cols.includes(name), `${name} must be carried`);
    assert.ok(cols.includes(`${name}_EMP_NO`), `${name}_EMP_NO must ride along with its name`);
  }
});

test("legacyExtensionHierarchyColumns drops a column the run-rate table does not have", () => {
  // Canada has no AVP role, so naming it would fail the SELECT with "Unrecognized name: AVP".
  const canada = legacyExtensionHierarchyColumns("all_Health_Canada_data_Runrate");
  assert.ok(!canada.includes("AVP"));
  assert.ok(!canada.includes("AVP_EMP_NO"));
  assert.ok(canada.includes("VP"));
});

test("legacyCarryColumns adds hierarchy only when asked", () => {
  const manual = legacyCarryColumns(HEALTH_RUNRATE, false);
  assert.deepEqual(manual, legacyDealManualColumns(HEALTH_RUNRATE));
  assert.ok(!manual.includes("ASSOCIATE_DELIVERY_DIRECTOR"));

  const withHierarchy = legacyCarryColumns(HEALTH_RUNRATE, true);
  assert.ok(withHierarchy.includes("ASSOCIATE_DELIVERY_DIRECTOR"));
  assert.ok(withHierarchy.includes("ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO"));
  // The manual columns are still all there, in front.
  for (const col of manual) assert.ok(withHierarchy.includes(col), `${col} must survive`);
  // No column is carried twice — SECONDARY_RECRUITER* sits in the manual list already.
  assert.equal(new Set(withHierarchy).size, withHierarchy.length);
});

test("an EXTENSION takes hierarchy off the same run-rate row as its CONTRACT_ID", async () => {
  const row = extensionRow();
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    includeHierarchy: true,
    fetchLegacyContractIdentityFn: fetchStub([["ds:5240515", matchedRowBIdentity()]]),
  });

  assert.equal(row.CONTRACT_ID, "CHC22685");
  assert.equal(row.SKU_NUMBER, "ONB6947");
  // The whole point: hierarchy comes from the contract that was matched, not left for a later tier.
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "Jasmeet Singh");
  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR_EMP_NO, "CY5379");
});

test("a DEAL row never takes hierarchy from run-rate (directory chain owns it)", async () => {
  const row = extensionRow({ DEAL_TYPE: "DEAL", CONTRACT_ID: null });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    // No includeHierarchy — the DEAL call site does not pass it.
    fetchLegacyContractIdentityFn: fetchStub([["ds:5240515", matchedRowBIdentity()]]),
  });

  assert.equal(row.CONTRACT_ID, "CHC22685");
  assert.equal(row.ENTITY, "HEALTH", "manual ops columns still come across");
  assert.equal(
    row.ASSOCIATE_DELIVERY_DIRECTOR,
    undefined,
    "hierarchy must stay for applyDealRecruiterHierarchyForInsertRows"
  );
});

test("hierarchy is fill-if-empty — a value already on the row wins", async () => {
  const row = extensionRow({ ASSOCIATE_DELIVERY_DIRECTOR: "Hand Edited Name" });
  await applyLegacyContractIdentityToDealRows([row], {
    tableId: "cynet_health_deal_sheet",
    includeHierarchy: true,
    fetchLegacyContractIdentityFn: fetchStub([["ds:5240515", matchedRowBIdentity()]]),
  });

  assert.equal(row.ASSOCIATE_DELIVERY_DIRECTOR, "Hand Edited Name");
});

test("the includeHierarchy flag reaches the BigQuery lookup so the SELECT projects the columns", async () => {
  const spy = [];
  await applyLegacyContractIdentityToDealRows([extensionRow()], {
    tableId: "cynet_health_deal_sheet",
    includeHierarchy: true,
    fetchLegacyContractIdentityFn: fetchStub([], spy),
  });

  assert.equal(spy.length, 1);
  assert.equal(spy[0].options.includeHierarchy, true);
});

test("EXTENSION rows are the call site that opts in; DEAL rows are not", () => {
  const src = fs.readFileSync(path.join(__dirname, "contractIdResolver.js"), "utf8");
  const extensionCall = src.slice(src.indexOf("if (pendingExtensionRows.length > 0) {"));
  assert.ok(
    extensionCall.slice(0, 400).includes("includeHierarchy: true"),
    "the EXTENSION call must ask for hierarchy"
  );
  const dealCall = src.slice(
    src.indexOf("await applyLegacyContractIdentityToDealRows(pendingDealRows,")
  );
  assert.ok(
    !dealCall.slice(0, 200).includes("includeHierarchy"),
    "the DEAL call must not ask for hierarchy"
  );
});

/**
 * Guard 2: the prior-extension tier must not pull detail off a row of a DIFFERENT contract once the
 * window match has already resolved this row's contract. Matching on candidate+client identity alone
 * cannot tell the candidate's contracts apart, and the START_DATE guard only rejects LATER rows — so
 * the previous contract sailed straight through it.
 */
test("the prior-extension query carries the row's resolved CONTRACT_ID and guards on it", () => {
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

  assert.ok(
    src.includes("AS resolved_contract_id)"),
    "the match struct must carry the row's already-resolved CONTRACT_ID"
  );

  const guard = "AND (ext.resolved_contract_id = '' OR p.CONTRACT_ID = ext.resolved_contract_id)";
  const occurrences = src.split(guard).length - 1;
  assert.equal(
    occurrences,
    2,
    "both the date/SKU join and the hierarchy join must carry the contract guard"
  );
});
