const test = require("node:test");
const assert = require("node:assert/strict");

const {
  allocateContractIdsForInsertableRows,
  pickDealContractIdFromBatch,
} = require("./contractIdResolver");

test("allocateContractIdsForInsertableRows assigns CHC id to DEAL row", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      CANDIDATE_NEXUS_ID: 1,
      CLIENT_ID: 2,
      CANDIDATE_EMAIL: "a@example.com",
      PHONE_NUMBER: "555",
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_deal_sheet",
    allocateContractIdsFn: async () => ["CHC1000"],
  });

  assert.equal(rows[0].CONTRACT_ID, "CHC1000");
});

test("allocateContractIdsForInsertableRows propagates id to EXTENSION in same batch", async () => {
  const rows = [
    {
      DEAL_TYPE: "DEAL",
      CANDIDATE_NEXUS_ID: 10,
      CLIENT_ID: 20,
      CANDIDATE_EMAIL: "b@example.com",
      PHONE_NUMBER: "111",
    },
    {
      DEAL_TYPE: "EXTENSION",
      CANDIDATE_NEXUS_ID: 10,
      CLIENT_ID: 20,
      CANDIDATE_EMAIL: "b@example.com",
      PHONE_NUMBER: "111",
    },
  ];

  await allocateContractIdsForInsertableRows(rows, {
    tableId: "cynet_health_canada_deal_sheet",
    allocateContractIdsFn: async () => ["CAC1000"],
  });

  assert.equal(rows[0].CONTRACT_ID, "CAC1000");
  assert.equal(rows[1].CONTRACT_ID, "CAC1000");
});

test("allocateContractIdsForInsertableRows skips when tableId missing", async () => {
  const rows = [{ DEAL_TYPE: "DEAL", CONTRACT_ID: null }];
  let called = false;
  await allocateContractIdsForInsertableRows(rows, {
    allocateContractIdsFn: async () => {
      called = true;
      return ["CHC1000"];
    },
  });
  assert.equal(called, false);
  assert.equal(rows[0].CONTRACT_ID, null);
});

test("pickDealContractIdFromBatch prefers higher sequence on same start date", () => {
  const picked = pickDealContractIdFromBatch(
    [
      { contractId: "CHC999", startDateMs: 1000 },
      { contractId: "CHC1000", startDateMs: 1000 },
    ],
    null
  );
  assert.equal(picked, "CHC1000");
});
