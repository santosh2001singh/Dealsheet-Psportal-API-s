const test = require("node:test");
const assert = require("node:assert/strict");

const { claimContractId } = require("./contractIdSequence");
const {
  assignNewContractIdForPlacement,
  contractIdOverrideForRow,
  rekeyContractIdLogsForPlacement,
  overrideKey,
} = require("./contractIdOverride");

/** In-memory Firestore: one store keyed by full doc path, enough for transactions and doc refs. */
function createFakeFirestore() {
  const store = new Map();
  const makeDoc = (path) => ({
    path,
    async get() {
      return { exists: store.has(path), data: () => store.get(path) };
    },
    collection: (name) => makeCollection(`${path}/${name}`),
  });
  const makeCollection = (path) => ({ doc: (id) => makeDoc(`${path}/${id}`) });
  return {
    store,
    collection: (name) => makeCollection(name),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(ref) {
          return { exists: store.has(ref.path), data: () => store.get(ref.path) };
        },
        set(ref, data, opts) {
          writes.push([ref.path, opts?.merge ? { ...(store.get(ref.path) || {}), ...data } : data]);
        },
      };
      await fn(tx);
      for (const [path, data] of writes) store.set(path, data);
    },
  };
}

const SEQ = { docId: "cynet_health_deal_sheet", prefix: "CHC", startValue: 1000, collection: "contractIdSequences" };

test("claimContractId mints once and returns the same id on a repeated request", async () => {
  const firestore = createFakeFirestore();
  const claimRef = firestore.collection("claims").doc("a");

  const first = await claimContractId(claimRef, () => ({ who: "x" }), { ...SEQ, firestore, minNextValue: 24164 });
  const second = await claimContractId(claimRef, () => ({ who: "y" }), { ...SEQ, firestore, minNextValue: 24164 });

  assert.deepEqual(first, { contractId: "CHC24164", created: true });
  assert.deepEqual(second, { contractId: "CHC24164", created: false });
  // The repeat consumed nothing: the next mint continues right after the first id.
  const other = await claimContractId(firestore.collection("claims").doc("b"), null, { ...SEQ, firestore });
  assert.equal(other.contractId, "CHC24165");
  assert.equal(firestore.store.get(claimRef.path).who, "x");
});

function assignDeps(overrides = {}) {
  const calls = { repair: [], rekeyDml: [] };
  const deps = {
    firestore: createFakeFirestore(),
    fetchMaxFn: async () => 24163,
    queryObjectsFn: async (sql) => {
      if (sql.includes("INFORMATION_SCHEMA")) {
        return [{ column_name: "PLACEMENT_ID" }, { column_name: "CONTRACT_ID" }];
      }
      return [{ contract_id: "CHC23675", deal_type: "DEAL" }];
    },
    runDmlFn: async (sql) => {
      calls.rekeyDml.push(sql);
      return 1;
    },
    repairFn: async (params) => {
      calls.repair.push(params);
      return { updatedRows: 3 };
    },
    ...overrides,
  };
  return { deps, calls };
}

const JERRY = { tableId: "cynet_health_deal_sheet", dealSheetId: "5275246", placementId: "1470787" };

test("assignNewContractIdForPlacement mints a new id and moves the placement's rows and logs onto it", async () => {
  const { deps, calls } = assignDeps();
  const result = await assignNewContractIdForPlacement({ ...JERRY, requestedBy: "a@b.com" }, deps);

  assert.equal(result.contractId, "CHC24164");
  assert.deepEqual(result.previousContractIds, ["CHC23675"]);
  assert.equal(result.created, true);
  assert.deepEqual(calls.repair, [
    { dealSheetId: "5275246", placementId: "1470787", newContractId: "CHC24164", clearColumns: [] },
  ]);
  assert.equal(calls.rekeyDml.length, 5);
  for (const sql of calls.rekeyDml) {
    assert.match(sql, /SET CONTRACT_ID = 'CHC24164'/);
    assert.match(sql, /CAST\(PLACEMENT_ID AS STRING\) = '1470787'/);
    assert.match(sql, /IN \('CHC23675'\)/);
  }
});

test("assignNewContractIdForPlacement is idempotent: a second approve keeps the first new id", async () => {
  const { deps } = assignDeps();
  const first = await assignNewContractIdForPlacement(JERRY, deps);
  const second = await assignNewContractIdForPlacement(JERRY, deps);
  assert.equal(second.contractId, first.contractId);
  assert.equal(second.created, false);
});

test("assignNewContractIdForPlacement refuses an EXTENSION and an unknown table", async () => {
  const { deps } = assignDeps({
    queryObjectsFn: async () => [{ contract_id: "CHC1", deal_type: "EXTENSION" }],
  });
  await assert.rejects(assignNewContractIdForPlacement(JERRY, deps), { code: "NOT_A_DEAL" });
  await assert.rejects(
    assignNewContractIdForPlacement({ ...JERRY, tableId: "all_CH_data_runrate" }, deps),
    { code: "BAD_REQUEST" }
  );
});

test("assignNewContractIdForPlacement reports a placement that is not in the table", async () => {
  const { deps } = assignDeps({ queryObjectsFn: async () => [] });
  await assert.rejects(assignNewContractIdForPlacement(JERRY, deps), { code: "NOT_FOUND" });
});

test("rekeyContractIdLogsForPlacement skips a table without PLACEMENT_ID and reports a failing one", async () => {
  let call = 0;
  const results = await rekeyContractIdLogsForPlacement(
    { placementId: "1470787", previousContractIds: ["CHC23675"], newContractId: "CHC24164" },
    {
      queryObjectsFn: async () =>
        call++ === 0 ? [{ column_name: "CONTRACT_ID" }] : [{ column_name: "PLACEMENT_ID" }, { column_name: "CONTRACT_ID" }],
      runDmlFn: async () => {
        throw new Error("boom");
      },
    }
  );
  assert.equal(results[0].skipped, "no PLACEMENT_ID/CONTRACT_ID column");
  assert.equal(results[1].error, "boom");
  assert.equal(results.length, 5);
});

test("rekeyContractIdLogsForPlacement does nothing when the id did not change", async () => {
  const results = await rekeyContractIdLogsForPlacement({
    placementId: "1470787",
    previousContractIds: ["CHC24164"],
    newContractId: "CHC24164",
  });
  assert.deepEqual(results, []);
});

test("contractIdOverrideForRow looks a row up by DEAL_SHEET_ID|PLACEMENT_ID", () => {
  const overrides = new Map([[overrideKey(5275246, 1470787), "CHC24164"]]);
  assert.equal(contractIdOverrideForRow({ DEAL_SHEET_ID: "5275246", PLACEMENT_ID: 1470787 }, overrides), "CHC24164");
  assert.equal(contractIdOverrideForRow({ DEAL_SHEET_ID: "5268271", PLACEMENT_ID: 1469058 }, overrides), null);
});
