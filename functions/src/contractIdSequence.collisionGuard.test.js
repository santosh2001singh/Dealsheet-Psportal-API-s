/**
 * Two ways the CONTRACT_ID sequence handed the same number to unrelated candidates (Aug 2026).
 *
 * Live damage: CHC23000..CHC23033 — a contiguous 34-id block starting exactly at the configured
 * startValue (23000) — each id sitting on two different candidates in cynet_health_deal_sheet.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { allocateContractIds } = require("./contractIdSequence");

/**
 * @param {number|null} initialNextValue stored counter (null = doc absent)
 * @param {object} [opts] persistWrites=false drops commits; retries>1 re-runs the tx callback
 */
function createMockFirestore(initialNextValue, opts = {}) {
  const persistWrites = opts.persistWrites !== false;
  const retries = Number(opts.retries) || 1;
  let nextValue = initialNextValue;
  let callbackRuns = 0;
  const leafDocRef = {
    id: "mock-seq-doc",
    async get() {
      return { exists: nextValue != null, data: () => ({ nextValue }) };
    },
  };
  return {
    async runTransaction(fn) {
      let pending = null;
      for (let i = 0; i < retries; i++) {
        pending = null;
        callbackRuns++;
        await fn({
          async get() {
            return { exists: nextValue != null, data: () => ({ nextValue }) };
          },
          set(_ref, data) {
            pending = data.nextValue;
          },
        });
      }
      if (persistWrites && pending != null) nextValue = pending;
    },
    collection() {
      return { doc: () => ({ collection: () => ({ doc: () => leafDocRef }) }) };
    },
    stored: () => nextValue,
    callbackRuns: () => callbackRuns,
  };
}

const BASE = { docId: "cynet_health_deal_sheet", prefix: "CHC", startValue: 23000 };

test("a retried transaction returns exactly `count` ids, not one set per attempt", async () => {
  // Firestore re-runs the callback on contention. The allocated array used to live outside it and
  // was only pushed to, so every abandoned attempt's ids came back too — and two concurrent callers
  // each walked away believing they owned the same numbers.
  const firestore = createMockFirestore(null, { retries: 3 });
  const ids = await allocateContractIds(3, { ...BASE, firestore });

  assert.equal(firestore.callbackRuns(), 3, "mock should have retried");
  assert.equal(ids.length, 3, `expected 3 ids, got ${ids.length}: ${ids.join(",")}`);
  assert.deepEqual(ids, ["CHC23000", "CHC23001", "CHC23002"]);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

test("minNextValueFn floors a counter that reads below what the table already issued", async () => {
  // The exact live failure: the counter doc is absent (or stale), so the sequence would restart at
  // startValue and re-issue CHC23000.. — which is already live in BigQuery up to CHC23033.
  const firestore = createMockFirestore(null);
  const ids = await allocateContractIds(2, {
    ...BASE,
    firestore,
    minNextValueFn: async () => 23034, // max in table (23033) + 1
  });

  assert.deepEqual(ids, ["CHC23034", "CHC23035"]);
  assert.equal(firestore.stored(), 23036, "counter must advance past the floor");
});

test("the floor never drags a healthy counter backwards", async () => {
  const firestore = createMockFirestore(30000);
  const ids = await allocateContractIds(1, {
    ...BASE,
    firestore,
    minNextValueFn: async () => 23034,
  });

  assert.deepEqual(ids, ["CHC30000"], "stored counter is ahead of the floor and must win");
});

test("a failing floor lookup still mints from the stored counter", async () => {
  const firestore = createMockFirestore(23100);
  const ids = await allocateContractIds(1, {
    ...BASE,
    firestore,
    minNextValueFn: async () => {
      throw new Error("bigquery unavailable");
    },
  });

  assert.deepEqual(ids, ["CHC23100"], "lookup failure must not block minting");
});

test("two runs cannot re-issue one block when the floor tracks the table", async () => {
  // Reproduces the live shape end to end: writes never persist, so without a floor both runs mint
  // CHC23000..CHC23033. With the floor following the table, run 2 moves past run 1.
  let issuedMax = null;
  const floorFn = async () => (issuedMax == null ? null : issuedMax + 1);

  const firestore = createMockFirestore(null, { persistWrites: false });
  const run1 = await allocateContractIds(34, { ...BASE, firestore, minNextValueFn: floorFn });
  issuedMax = 23000 + 33; // run 1's ids are now live in BigQuery

  const run2 = await allocateContractIds(34, { ...BASE, firestore, minNextValueFn: floorFn });

  const overlap = run1.filter((id) => run2.includes(id));
  assert.equal(overlap.length, 0, `runs overlapped on ${overlap.length} ids: ${overlap.slice(0, 5).join(",")}`);
  assert.equal(run2[0], "CHC23034");
});
