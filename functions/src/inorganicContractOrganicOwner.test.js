const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchContractOrganicOwnersForInorganicRows,
  dropContractOrganicOwnersFromInorganicRow,
  applyContractOrganicOwnerFilterToInorganicRows,
} = require("./bigQueryClient");

// Live case (Tobin Jacob, PLACEMENT_ID 1465523, CHC22164, Aug 2026): Anup Bhel was the contract's
// recruiter, got promoted to Director, and the new recruiter's live chain logged him as inorganic.
const tobinLogRow = () => ({
  DEAL_SHEET_ID: "5253852",
  PLACEMENT_ID: "1465523",
  RECRUITER_EMAIL_ID: null,
  INORGANIC_RECRUITER: null,
  INORGANIC_RECRUITER_EMP_NO: null,
  INORGANIC_ACCOUNT_MANAGER: "Demi Sharma",
  INORGANIC_ACCOUNT_MANAGER_EMP_NO: "CY1648",
  INORGANIC_ASSOCIATE_GROUP_DIRECTOR: "Anup Bhel",
  INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO: "CY5277",
  INORGANIC_DELIVERY_POC: "Anup Bhel",
  INORGANIC_DELIVERY_POC_EMP_NO: "CY5277",
  INORGANIC_DELIVERY_POC_EMAIL: "anup.b@cynethealth.com",
});

const owners = (empNos, names) => ({ empNos: new Set(empNos), names: new Set(names) });

test("a promoted former recruiter of the contract is not logged inorganic (name-only match)", () => {
  // The run-rate recruiter column carries a name and no emp-no.
  const { row, keep, dropped } = dropContractOrganicOwnersFromInorganicRow(
    tobinLogRow(),
    owners(["CY788"], ["anup bhel", "amy gupta"])
  );
  assert.equal(keep, true);
  assert.equal(dropped, 1);
  assert.equal(row.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, null);
  assert.equal(row.INORGANIC_ASSOCIATE_GROUP_DIRECTOR_EMP_NO, null);
  assert.equal(row.INORGANIC_ACCOUNT_MANAGER, "Demi Sharma");
  // POC was Anup; nobody from ADD up remains, so it clears.
  assert.equal(row.INORGANIC_DELIVERY_POC, null);
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, null);
  assert.equal(row.INORGANIC_DELIVERY_POC_EMAIL, null);
});

test("emp-no match wins even when the name is spelled differently", () => {
  const { row, dropped } = dropContractOrganicOwnersFromInorganicRow(tobinLogRow(), owners(["CY5277"], []));
  assert.equal(dropped, 1);
  assert.equal(row.INORGANIC_ASSOCIATE_GROUP_DIRECTOR, null);
});

test("cluster suffix on the deal-sheet recruiter name still matches", () => {
  const { dropped } = dropContractOrganicOwnersFromInorganicRow(
    tobinLogRow(),
    owners([], ["anup bhel"]) // built from "Anup Bhel (GOV)" by the fetch
  );
  assert.equal(dropped, 1);
});

test("row is dropped when every hierarchy slot was an organic owner", () => {
  const { keep } = dropContractOrganicOwnersFromInorganicRow(
    tobinLogRow(),
    owners(["CY5277", "CY1648"], [])
  );
  assert.equal(keep, false);
});

test("no owners for the row (no CONTRACT_ID) leaves it untouched", () => {
  const input = tobinLogRow();
  const { row, keep, dropped } = dropContractOrganicOwnersFromInorganicRow(input, undefined);
  assert.equal(row, input);
  assert.equal(keep, true);
  assert.equal(dropped, 0);
});

test("POC is re-picked from the remaining senior slot when the old POC is dropped", () => {
  const input = {
    ...tobinLogRow(),
    INORGANIC_VP_SR_VP: "New VP",
    INORGANIC_VP_SR_VP_EMP_NO: "CY9999",
  };
  const { row } = dropContractOrganicOwnersFromInorganicRow(input, owners(["CY5277"], []));
  assert.equal(row.INORGANIC_DELIVERY_POC, "New VP");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMP_NO, "CY9999");
  assert.equal(row.INORGANIC_DELIVERY_POC_EMAIL, null);
});

test("recruiter-only run-rate row keeps its old rule unless that recruiter owned the contract", () => {
  const recruiterOnly = {
    DEAL_SHEET_ID: "1",
    PLACEMENT_ID: "2",
    INORGANIC_RECRUITER: "Someone New",
    INORGANIC_RECRUITER_EMP_NO: "CY1",
  };
  assert.equal(dropContractOrganicOwnersFromInorganicRow(recruiterOnly, owners(["CY2"], [])).keep, true);
  assert.equal(dropContractOrganicOwnersFromInorganicRow(recruiterOnly, owners(["CY1"], [])).keep, false);
});

test("fetch keys owners by CONTRACT_ID across deal sheet and run-rate", async () => {
  const sqls = [];
  const queryFn = async (sql) => {
    sqls.push(sql);
    if (sqls.length === 1) return [{ ds: "5253852", pid: "1465523", contract_id: "CHC22164" }];
    return [
      { contract_id: "CHC22164", ASSIGNMENT_RECRUITER: "Yogesh Tiwari (GOV)", RECRUITER_EMP_NO: "CY4058", VP: "Amy Gupta", VP_EMP_NO: "CY788" },
      { contract_id: "CHC22164", ASSIGNMENT_RECRUITER: "Anup Bhel", RECRUITER_EMP_NO: null, TEAM_LEAD: "NA", TEAM_LEAD_EMP_NO: "NA" },
    ];
  };
  const out = await fetchContractOrganicOwnersForInorganicRows([tobinLogRow()], { domain: "health" }, { queryFn });
  const got = out.get("5253852|1465523");
  assert.ok(got);
  assert.ok(got.names.has("anup bhel"));
  assert.ok(got.names.has("yogesh tiwari"));
  assert.ok(got.empNos.has("CY788"));
  assert.ok(!got.names.has("na"));
  assert.ok(!got.empNos.has("NA"));
  assert.match(sqls[1], /all_CH_data_runrate/);
  assert.match(sqls[1], /cynet_health_deal_sheet/);
  assert.match(sqls[1], /'CHC22164'/);
});

test("fetch returns nothing for a placement with no CONTRACT_ID", async () => {
  let calls = 0;
  const queryFn = async () => {
    calls++;
    return [];
  };
  const out = await fetchContractOrganicOwnersForInorganicRows([tobinLogRow()], {}, { queryFn });
  assert.equal(out.size, 0);
  assert.equal(calls, 1);
});

test("apply filter drops/keeps rows and resolves the re-picked POC email", async () => {
  const withVp = { ...tobinLogRow(), INORGANIC_VP_SR_VP: "New VP", INORGANIC_VP_SR_VP_EMP_NO: "CY9999" };
  const other = { ...tobinLogRow(), DEAL_SHEET_ID: "9", PLACEMENT_ID: "9" };
  const { rows, droppedRows, droppedSlots } = await applyContractOrganicOwnerFilterToInorganicRows(
    [withVp, other],
    {},
    {
      ownersFetchFn: async () =>
        new Map([
          ["5253852|1465523", owners(["CY5277"], [])],
          ["9|9", owners(["CY5277", "CY1648"], [])],
        ]),
      fetchEmailsFn: async (empNos) => {
        assert.deepEqual(empNos, ["CY9999"]);
        return { byEmp: new Map([["CY9999", "new.vp@cynethealth.com"]]) };
      },
    }
  );
  assert.equal(rows.length, 1);
  assert.equal(droppedRows, 1);
  assert.equal(droppedSlots, 3);
  assert.equal(rows[0].INORGANIC_DELIVERY_POC_EMAIL, "new.vp@cynethealth.com");
});
