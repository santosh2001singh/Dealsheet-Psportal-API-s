/**
 * Firestore-backed monotonic CONTRACT_ID sequence.
 */

const admin = require("firebase-admin");
const config = require("./config");

function getFirestore(options = {}) {
  if (options.firestore && typeof options.firestore.runTransaction === "function") {
    return options.firestore;
  }
  return admin.firestore();
}

function getSequenceRef(options = {}) {
  const collection =
    typeof options.collection === "string" && options.collection.trim() !== ""
      ? options.collection.trim()
      : config.contractIdSequence.collection;
  const docId =
    typeof options.docId === "string" && options.docId.trim() !== ""
      ? options.docId.trim()
      : config.contractIdSequence.docId;
  return getFirestore(options).collection(collection).doc(docId);
}

function resolveStartValue(options = {}) {
  const raw = options.startValue ?? config.contractIdSequence.startValue;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 100000;
}

/**
 * Peek next value without consuming (for tests/debug).
 * @param {object} [options]
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
 * @param {number} count
 * @param {object} [options]
 * @returns {Promise<number[]>}
 */
async function allocateContractIds(count, options = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return [];

  const ref = getSequenceRef(options);
  const startValue = resolveStartValue(options);
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
      allocated.push(nextValue + i);
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
