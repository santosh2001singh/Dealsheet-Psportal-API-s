const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getWorkspaceDocRef,
  getWorkspaceSubcollectionRef,
  getCheckpointRef,
  getContractIdSequenceRef,
} = require("./firestoreWorkspace");

function createPathRecordingFirestore() {
  const segments = [];
  return {
    segments,
    collection(name) {
      segments.push(name);
      return {
        doc(id) {
          segments.push(id);
          return {
            collection(subName) {
              segments.push(subName);
              return {
                doc(docId) {
                  segments.push(docId);
                  return {
                    id: docId,
                    path: segments.join("/"),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test("getWorkspaceDocRef uses workspaces/run-rate-tool", () => {
  const fs = createPathRecordingFirestore();
  getWorkspaceDocRef(fs);
  assert.deepEqual(fs.segments, ["workspaces", "run-rate-tool"]);
});

test("getWorkspaceSubcollectionRef nests under workspace doc", () => {
  const fs = createPathRecordingFirestore();
  getWorkspaceSubcollectionRef("contractIdSequences", fs);
  assert.deepEqual(fs.segments, ["workspaces", "run-rate-tool", "contractIdSequences"]);
});

test("getCheckpointRef resolves full nested path", () => {
  const fs = createPathRecordingFirestore();
  const ref = getCheckpointRef("active-records-default", fs);
  assert.deepEqual(fs.segments, [
    "workspaces",
    "run-rate-tool",
    "dealSheetSyncCheckpoints",
    "active-records-default",
  ]);
  assert.equal(ref.id, "active-records-default");
});

test("getContractIdSequenceRef resolves table doc under workspace", () => {
  const fs = createPathRecordingFirestore();
  const ref = getContractIdSequenceRef("cynet_health_deal_sheet", { firestore: fs });
  assert.deepEqual(fs.segments, [
    "workspaces",
    "run-rate-tool",
    "contractIdSequences",
    "cynet_health_deal_sheet",
  ]);
  assert.equal(ref.id, "cynet_health_deal_sheet");
});

test("getContractIdSequenceRef accepts custom subcollection name", () => {
  const fs = createPathRecordingFirestore();
  getContractIdSequenceRef("cynet_locums_deal_sheet", {
    firestore: fs,
    collection: "customSequences",
  });
  assert.deepEqual(fs.segments, [
    "workspaces",
    "run-rate-tool",
    "customSequences",
    "cynet_locums_deal_sheet",
  ]);
});
