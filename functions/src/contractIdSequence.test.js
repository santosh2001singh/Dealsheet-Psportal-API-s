const test = require("node:test");
const assert = require("node:assert/strict");

const mockState = {
  nextValue: null,
  writes: [],
};

function createMockFirestore() {
  const docRef = {
    get: async () => ({
      exists: mockState.nextValue != null,
      data: () => (mockState.nextValue != null ? { nextValue: mockState.nextValue } : {}),
    }),
    set: async (data, opts) => {
      mockState.writes.push({ data, opts });
      if (data.nextValue != null) mockState.nextValue = data.nextValue;
    },
  };
  return {
    collection: () => ({
      doc: () => docRef,
    }),
    runTransaction: async (fn) => {
      const tx = {
        get: async (ref) => ref.get(),
        set: async (ref, data, opts) => ref.set(data, opts),
      };
      return fn(tx);
    },
  };
}

const { allocateContractIds, resolveStartValue } = require("./contractIdSequence");

test("resolveStartValue defaults to 100000", () => {
  assert.equal(resolveStartValue({}), 100000);
  assert.equal(resolveStartValue({ startValue: 200000 }), 200000);
});

test("allocateContractIds returns empty array for count 0", async () => {
  mockState.nextValue = null;
  mockState.writes = [];
  const result = await allocateContractIds(0, {
    startValue: 100000,
    firestore: createMockFirestore(),
  });
  assert.deepEqual(result, []);
  assert.equal(mockState.writes.length, 0);
});

test("allocateContractIds first batch starts at 100000", async () => {
  mockState.nextValue = null;
  mockState.writes = [];
  const firestore = createMockFirestore();
  const result = await allocateContractIds(3, { startValue: 100000, firestore });
  assert.deepEqual(result, [100000, 100001, 100002]);
  assert.equal(mockState.nextValue, 100003);
});

test("allocateContractIds continues from stored nextValue", async () => {
  mockState.nextValue = 100003;
  mockState.writes = [];
  const firestore = createMockFirestore();
  const result = await allocateContractIds(2, { startValue: 100000, firestore });
  assert.deepEqual(result, [100003, 100004]);
  assert.equal(mockState.nextValue, 100005);
});
