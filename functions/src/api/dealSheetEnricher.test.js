const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFailedIdsByKind,
  collectCandidateApiFailureKinds,
} = require("./dealSheetEnricher");

test("collectCandidateApiFailureKinds: empty when no API failures recorded", () => {
  const failedIdsByKind = createFailedIdsByKind();
  const dealSheetById = new Map([["5172621", { id: 5172621, recruiter: 474720 }]]);
  const clientById = new Map([["2498414", { id: 2498414 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById,
    hasPreloadedSubmittals: true,
  });

  assert.deepEqual(failedKinds, []);
});

test("collectCandidateApiFailureKinds: flags client failure for that candidate only", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.client.add("2498414");
  const dealSheetById = new Map([["5172621", { id: 5172621, recruiter: 474720 }]]);
  const clientById = new Map();

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById,
    hasPreloadedSubmittals: false,
  });

  assert.equal(failedKinds.includes("client:2498414"), true);
});

test("collectCandidateApiFailureKinds: skips client/clioff check when embedded client shortcut used", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.client.add("2498414");
  failedIdsByKind.clioff.add("2498414");
  const dealSheetById = new Map([["5172621", { id: 5172621 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientFetchIds: new Set(["2498414"]),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById: new Map(),
    hasPreloadedSubmittals: true,
  });

  assert.deepEqual(failedKinds, []);
});

test("collectCandidateApiFailureKinds: flags deal-sheet detail failure", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.ds.add("5172621");

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: null,
    skipClientFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById: new Map(),
    clientById: new Map(),
    hasPreloadedSubmittals: true,
  });

  assert.deepEqual(failedKinds, ["ds:5172621"]);
});

test("collectCandidateApiFailureKinds: flags wave2 user and submittal failures", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.user.add("474720");
  const failedSubmittalKeys = new Set(["35393960:474720:25206782"]);
  const dealSheetById = new Map([["5172621", { id: 5172621, recruiter: 474720 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: null,
    skipClientFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys,
    dealSheetById,
    clientById: new Map(),
    hasPreloadedSubmittals: false,
  });

  assert.equal(failedKinds.includes("user:474720"), true);
  assert.equal(failedKinds.includes("sub:35393960:474720:25206782"), true);
});
