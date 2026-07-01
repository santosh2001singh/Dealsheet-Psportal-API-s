/**
 * Firestore-backed monotonic CONTRACT_ID sequence (per-table doc + prefixed output).
 */

const admin = require("firebase-admin");
const { formatContractId } = require("./contractIdFormat");
const { getContractIdSequenceRef } = require("./firestoreWorkspace");

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
  const prefix =
    typeof options.prefix === "string" && options.prefix.trim() !== ""
      ? options.prefix.trim().toUpperCase()
      : "";
  const allocated = [];

  const firestore = getFirestore(options);
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let nextValue = startValue;
    if (snap.exists) {
      const stored = Number(snap.data()?.nextValue);
      if (Number.isFinite(stored)) nextValue = Math.trunc(stored);
    }
    for (let i = 0; i < n; i++) {
      const seq = nextValue + i;
      allocated.push(prefix ? formatContractId(prefix, seq) : seq);
    }
    tx.set(
      ref,
      {
        nextValue: nextValue + n,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  });

  return allocated;
}

module.exports = {
  allocateContractIds,
  getNextContractId,
  getSequenceRef,
  resolveStartValue,
};
