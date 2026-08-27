/**
 * Firestore-backed monotonic CONTRACT_ID sequence (per-table doc + prefixed output).
 */

const admin = require("firebase-admin");
const { formatContractId } = require("./contractIdFormat");
const { getContractIdSequenceRef } = require("./firestoreWorkspace");
const { logDetail } = require("./logger");

const DEFAULT_START_VALUE = parseInt(process.env.CONTRACT_ID_START_VALUE || "1000", 10);

function getFirestore(options = {}) {
  if (options.firestore && typeof options.firestore.runTransaction === "function") {
    return options.firestore;
  }
  return admin.firestore();
}

function getSequenceRef(options = {}) {
  const docId = typeof options.docId === "string" ? options.docId.trim() : "";
  if (!docId) {
    throw new Error("contractIdSequence: docId (table id) is required");
  }
  return getContractIdSequenceRef(docId, options);
}

function resolveStartValue(options = {}) {
  const raw = options.startValue ?? DEFAULT_START_VALUE;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : DEFAULT_START_VALUE;
}

/**
 * Peek next sequence value without consuming (for tests/debug).
 * @param {object} options
 * @returns {Promise<number>}
 */
async function getNextContractId(options = {}) {
  const ref = getSequenceRef(options);
  const startValue = resolveStartValue(options);
  const snap = await ref.get();
  if (!snap.exists) return startValue;
  const data = snap.data() || {};
  const next = Number(data.nextValue);
  return Number.isFinite(next) ? Math.trunc(next) : startValue;
}

/**
 * Allocate `count` sequential CONTRACT_ID values atomically.
 * When `options.prefix` is set, returns formatted strings (e.g. CHC1000).
 * @param {number} count
 * @param {object} options
 * @param {string} options.docId BigQuery table id (Firestore doc id)
 * @param {string} [options.prefix] CHC | CAC | LOC
 * @param {number} [options.startValue]
 * @returns {Promise<string[]|number[]>}
 */
async function allocateContractIds(count, options = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return [];

  const ref = getSequenceRef(options);
  const startValue = resolveStartValue(options);
  // Floor the counter at what the destination table has already issued. The Firestore doc is the
  // only thing that stops two runs minting the same number, so whenever it reads BELOW reality —
  // never created, deleted, restored from an older snapshot, or written by a run whose commit was
  // rolled back — the sequence restarts at startValue and re-issues a block that is already live.
  // That is exactly what produced CHC23000..CHC23033 twice over (34 ids, each on two unrelated
  // candidates, Aug 2026). A floor makes the stored value an optimisation rather than the sole
  // source of truth: if it is stale the table's own maximum carries the sequence forward.
  //
  // Advisory by design — a lookup failure must not block minting, so it falls back to the stored
  // value and logs. Pass minNextValueFn (or minNextValue) to enable it; without one the behaviour
  // is unchanged.
  let flooredFrom = null;
  let minNextValue = null;
  if (typeof options.minNextValueFn === "function") {
    try {
      const resolved = await options.minNextValueFn();
      const asNum = Number(resolved);
      if (Number.isFinite(asNum)) minNextValue = Math.trunc(asNum);
    } catch (err) {
      logDetail(
        `[contractIdSequence] min-next-value lookup failed (using stored counter): ${String(err?.message || err).slice(0, 200)}`
      );
    }
  } else if (options.minNextValue != null) {
    const asNum = Number(options.minNextValue);
    if (Number.isFinite(asNum)) minNextValue = Math.trunc(asNum);
  }
  const prefix =
    typeof options.prefix === "string" && options.prefix.trim() !== ""
      ? options.prefix.trim().toUpperCase()
      : "";
  const firestore = getFirestore(options);
  // Built fresh INSIDE the transaction and only read after it commits. Firestore re-runs this
  // callback on contention, so an array declared outside and pushed to kept the ids from every
  // abandoned attempt as well — one call for 3 ids returned 6, and two callers then walked away
  // holding the same numbers.
  let allocated = [];
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let nextValue = startValue;
    if (snap.exists) {
      const stored = Number(snap.data()?.nextValue);
      if (Number.isFinite(stored)) nextValue = Math.trunc(stored);
    }
    if (minNextValue != null && minNextValue > nextValue) {
      flooredFrom = nextValue;
      nextValue = minNextValue;
    }
    // Reassigned, not appended to, so a retry discards the previous attempt's ids.
    const attempt = [];
    for (let i = 0; i < n; i++) {
      const seq = nextValue + i;
      attempt.push(prefix ? formatContractId(prefix, seq) : seq);
    }
    tx.set(
      ref,
      {
        nextValue: nextValue + n,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    allocated = attempt;
  });

  if (flooredFrom != null) {
    logDetail(
      `[contractIdSequence] counter was BEHIND the table and got floored: doc=${options.docId || "?"} stored=${flooredFrom} floored_to=${minNextValue} count=${n} — the sequence doc is stale or was not persisting; check Firestore write permissions on workspaces/*/contractIdSequences`
    );
  }

  return allocated;
}

module.exports = {
  allocateContractIds,
  getNextContractId,
  getSequenceRef,
  resolveStartValue,
};
