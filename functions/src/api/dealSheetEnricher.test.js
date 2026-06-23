const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFailedIdsByKind,
  collectCandidateApiFailureKinds,
  isEmbeddedClientGeoSufficient,
  embeddedClientOfferingsSkippable,
  registerEmbeddedClientSkips,
} = require("./dealSheetEnricher");

const sampleEmbeddedClient = {
  id: 1448683,
  name: "Union Hospital Clinton",
  parent_client: { id: 2542959, name: "Union Health - ML" },
  zipcode_data: {
    zipcode: "47842",
    city: "Clinton",
    state_code: "IN",
  },
  client_offerings: [
    {
      offering_id: "NURSING",
      msp: { id: 263, name: "Medical Solutions" },
    },
  ],
};

const sampleSubmittal = { client: sampleEmbeddedClient };

test("collectCandidateApiFailureKinds: empty when no API failures recorded", () => {
  const failedIdsByKind = createFailedIdsByKind();
  const dealSheetById = new Map([["5172621", { id: 5172621, recruiter: 474720 }]]);
  const clientById = new Map([["2498414", { id: 2498414 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientDetailFetchIds: new Set(),
    skipClientOfferingsFetchIds: new Set(),
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
    skipClientDetailFetchIds: new Set(),
    skipClientOfferingsFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById,
    hasPreloadedSubmittals: false,
  });

  assert.equal(failedKinds.includes("client:2498414"), true);
});

test("collectCandidateApiFailureKinds: skips client and clioff when both embedded shortcuts used", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.client.add("2498414");
  failedIdsByKind.clioff.add("2498414");
  const dealSheetById = new Map([["5172621", { id: 5172621 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientDetailFetchIds: new Set(["2498414"]),
    skipClientOfferingsFetchIds: new Set(["2498414"]),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById: new Map(),
    hasPreloadedSubmittals: true,
  });

  assert.deepEqual(failedKinds, []);
});

test("collectCandidateApiFailureKinds: flags clioff when only client detail skipped", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.clioff.add("2498414");
  const dealSheetById = new Map([["5172621", { id: 5172621 }]]);

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: "2498414",
    skipClientDetailFetchIds: new Set(["2498414"]),
    skipClientOfferingsFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys: new Set(),
    dealSheetById,
    clientById: new Map(),
    hasPreloadedSubmittals: true,
  });

  assert.equal(failedKinds.includes("clioff:2498414"), true);
  assert.equal(failedKinds.includes("client:2498414"), false);
});

test("collectCandidateApiFailureKinds: flags deal-sheet detail failure", () => {
  const failedIdsByKind = createFailedIdsByKind();
  failedIdsByKind.ds.add("5172621");

  const failedKinds = collectCandidateApiFailureKinds({
    dealSheetId: "5172621",
    jobId: "35393960",
    candId: "25206782",
    clientId: null,
    skipClientDetailFetchIds: new Set(),
    skipClientOfferingsFetchIds: new Set(),
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
    skipClientDetailFetchIds: new Set(),
    skipClientOfferingsFetchIds: new Set(),
    failedIdsByKind,
    failedSubmittalKeys,
    dealSheetById,
    clientById: new Map(),
    hasPreloadedSubmittals: false,
  });

  assert.equal(failedKinds.includes("user:474720"), true);
  assert.equal(failedKinds.includes("sub:35393960:474720:25206782"), true);
});

test("isEmbeddedClientGeoSufficient true for sample embedded submittal client", () => {
  assert.equal(isEmbeddedClientGeoSufficient(sampleEmbeddedClient), true);
});

test("embeddedClientOfferingsSkippable false without CLIENT_TYPE text on picked offering", () => {
  const job = { offering: "NURSING" };
  assert.equal(embeddedClientOfferingsSkippable(sampleEmbeddedClient, job), false);
});

test("registerEmbeddedClientSkips skips detail but not offerings for sample payload", () => {
  const skipDetail = new Set();
  const skipOfferings = new Set();
  registerEmbeddedClientSkips(sampleSubmittal, 1448683, { offering: "NURSING" }, skipDetail, skipOfferings);
  assert.equal(skipDetail.has("1448683"), true);
  assert.equal(skipOfferings.has("1448683"), false);
});
