const test = require("node:test");
const assert = require("node:assert/strict");

const { allocateContractIds, getNextContractId } = require("./contractIdSequence");

function createMockFirestore(initialNextValue) {
  let nextValue = initialNextValue;
  const leafDocRef = {
    id: "mock-seq-doc",
    async get() {
      return {
        exists: nextValue != null,
        data() {
          return { nextValue };
        },
      };
    },
  };
  const sequenceSubcollection = {
    doc() {
      return leafDocRef;
    },
  };
  const workspaceDoc = {
    collection() {
      return sequenceSubcollection;
    },
  };
  return {
    runTransaction(fn) {
      const tx = {
        async get() {
          return {
            exists: nextValue != null,
            data() {
              return { nextValue };
            },
          };
        },
        set(_ref, data) {
          nextValue = data.nextValue;
        },
      };
      return fn(tx);
    },
    collection() {
      return {
        doc() {
          return workspaceDoc;
        },
      };
    },
  };
}

test("allocateContractIds returns prefixed strings from startValue", async () => {
  const firestore = createMockFirestore(null);
  const ids = await allocateContractIds(2, {
    firestore,
    docId: "cynet_health_deal_sheet",
    prefix: "CHC",
    startValue: 1000,
    collection: "contractIdSequences",
  });
  assert.deepEqual(ids, ["CHC1000", "CHC1001"]);
});

test("allocateContractIds continues from stored nextValue", async () => {
  const firestore = createMockFirestore(1005);
  const ids = await allocateContractIds(1, {
    firestore,
    docId: "cynet_locums_deal_sheet",
    prefix: "LOC",
    startValue: 1000,
    collection: "contractIdSequences",
  });
  assert.deepEqual(ids, ["LOC1005"]);
});

test("getNextContractId peeks without consuming", async () => {
  const firestore = createMockFirestore(1010);
  const peek = await getNextContractId({
    firestore,
    docId: "cynet_health_canada_deal_sheet",
    startValue: 1000,
    collection: "contractIdSequences",
  });
  assert.equal(peek, 1010);
});

test("allocateContractIds returns empty for non-positive count", async () => {
  const firestore = createMockFirestore(1000);
  assert.deepEqual(
    await allocateContractIds(0, {
      firestore,
      docId: "cynet_health_deal_sheet",
      prefix: "CHC",
      startValue: 1000,
    }),
    []
  );
});

// Phase 3 (Aug 2026): cynet health restarts at CHC23000. startValue only applies to a sequence doc
// that does not exist yet — an existing doc's stored nextValue always wins. That is exactly why
// changing config alone is not enough after a data reset, and why
// scripts/resetContractIdSequences.js exists. These two tests pin both halves of that rule.
test("a missing sequence doc starts at the configured startValue", async () => {
  const firestore = createMockFirestore(null);
  const ids = await allocateContractIds(2, {
    docId: "cynet_health_deal_sheet",
    prefix: "CHC",
    startValue: 23000,
    firestore,
  });
  assert.deepEqual(ids, ["CHC23000", "CHC23001"]);
});

test("an existing sequence doc ignores startValue and continues from its stored nextValue", async () => {
  // Pre-reset counter still sitting in the CHC1000 range.
  const firestore = createMockFirestore(1042);
  const ids = await allocateContractIds(1, {
    docId: "cynet_health_deal_sheet",
    prefix: "CHC",
    startValue: 23000,
    firestore,
  });
  assert.deepEqual(ids, ["CHC1042"], "stored nextValue wins over startValue — reset the doc to move it");
});
