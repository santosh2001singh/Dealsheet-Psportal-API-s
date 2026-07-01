/**
 * Firestore paths under workspaces/{docId} for deal-sheet sync state.
 *
 * workspaces/run-rate-tool/contractIdSequences/{table_id}
 * workspaces/run-rate-tool/dealSheetSyncCheckpoints/{checkpoint_key}
 */

const admin = require("firebase-admin");
const config = require("./config");

function resolveFirestore(firestore) {
  if (
    firestore &&
    (typeof firestore.runTransaction === "function" || typeof firestore.collection === "function")
  ) {
    return firestore;
  }
  return admin.firestore();
}

/**
 * @param {import('firebase-admin/firestore').Firestore} [firestore]
 * @returns {import('firebase-admin/firestore').DocumentReference}
 */
function getWorkspaceDocRef(firestore) {
  const fs = resolveFirestore(firestore);
  const ws = config.firestoreWorkspace || {};
  const collection =
    typeof ws.collection === "string" && ws.collection.trim() !== ""
      ? ws.collection.trim()
      : "workspaces";
  const docId =
    typeof ws.docId === "string" && ws.docId.trim() !== "" ? ws.docId.trim() : "run-rate-tool";
  return fs.collection(collection).doc(docId);
}

/**
 * @param {string} subcollectionName
 * @param {import('firebase-admin/firestore').Firestore} [firestore]
 * @returns {import('firebase-admin/firestore').CollectionReference}
 */
function getWorkspaceSubcollectionRef(subcollectionName, firestore) {
  const name = subcollectionName == null ? "" : String(subcollectionName).trim();
  if (!name) {
    throw new Error("firestoreWorkspace: subcollection name is required");
  }
  return getWorkspaceDocRef(firestore).collection(name);
}

/**
 * @param {string} checkpointKey
 * @param {import('firebase-admin/firestore').Firestore} [firestore]
 * @returns {import('firebase-admin/firestore').DocumentReference}
 */
function getCheckpointRef(checkpointKey, firestore) {
  const key = checkpointKey == null ? "" : String(checkpointKey).trim();
  if (!key) {
    throw new Error("firestoreWorkspace: checkpoint key is required");
  }
  const collection = config.backfill?.checkpointCollection || "dealSheetSyncCheckpoints";
  return getWorkspaceSubcollectionRef(collection, firestore).doc(key);
}

/**
 * @param {string} docId BigQuery table id
 * @param {object} [options]
 * @param {string} [options.collection] Subcollection name (default contractIdSequences)
 * @param {import('firebase-admin/firestore').Firestore} [options.firestore]
 * @returns {import('firebase-admin/firestore').DocumentReference}
 */
function getContractIdSequenceRef(docId, options = {}) {
  const id = typeof options.docId === "string" ? options.docId.trim() : String(docId || "").trim();
  if (!id) {
    throw new Error("firestoreWorkspace: docId (table id) is required");
  }
  const collection =
    typeof options.collection === "string" && options.collection.trim() !== ""
      ? options.collection.trim()
      : config.contractIdSequence.collection;
  return getWorkspaceSubcollectionRef(collection, options.firestore).doc(id);
}

module.exports = {
  getWorkspaceDocRef,
  getWorkspaceSubcollectionRef,
  getCheckpointRef,
  getContractIdSequenceRef,
  resolveFirestore,
};
