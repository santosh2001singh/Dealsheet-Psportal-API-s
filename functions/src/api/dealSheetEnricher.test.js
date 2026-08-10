const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFailedIdsByKind,
  collectCandidateApiFailureKinds,
  isEmbeddedClientGeoSufficient,
  embeddedClientOfferingsSkippable,
  registerEmbeddedClientSkips,
  pickEmbeddedClientObj,
} = require("./dealSheetEnricher");
const { pickClientOfferingRowForJob } = require("../columnMappings");

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

// CLIENT_TYPE became manual in Aug 2026, so missing client_setting_type text no longer forces a
// /api/client-offerings/ fetch — embedded MSP alone makes the offerings skippable.
test("embeddedClientOfferingsSkippable true on embedded MSP even without CLIENT_TYPE text", () => {
  const job = { offering: "NURSING" };
  assert.equal(embeddedClientOfferingsSkippable(sampleEmbeddedClient, job), true);
});

test("embeddedClientOfferingsSkippable false when embedded offerings carry no MSP", () => {
  const noMsp = { client_offerings: [{ offering: { name: "NURSING" } }] };
  assert.equal(embeddedClientOfferingsSkippable(noMsp, { offering: "NURSING" }), false);
});

test("registerEmbeddedClientSkips skips both detail and offerings for sample payload", () => {
  const skipDetail = new Set();
  const skipOfferings = new Set();
  registerEmbeddedClientSkips(sampleSubmittal, 1448683, { offering: "NURSING" }, skipDetail, skipOfferings);
  assert.equal(skipDetail.has("1448683"), true);
  assert.equal(skipOfferings.has("1448683"), true);
});

// ---------------------------------------------------------------------------
// Embedded-client reuse: the submittal (STEP 2) and job payloads both carry the
// full client block, so /api/clients/{id}/, /api/clients/{parent}/ and
// /api/client-offerings/ are skipped. Fixtures below are real Nexus responses.
// ---------------------------------------------------------------------------

const { mapClientToBq, mapMspFromClientOfferingRow } = require("../columnMappings");

/** Sanford: parent_client present as {id, name}. */
const sanfordEmbeddedClient = {
  id: 3893832,
  name: "Sanford Broadway Medical Center",
  parent_client: { id: 2286407, name: "Sanford Health" },
  zipcode_data: { zipcode: "58102", city: "Fargo", state_code: "ND" },
  client_offerings: [
    {
      id: 10165560,
      offering_id: "NURSING",
      sub_offering_id: null,
      msp: { id: 263, name: "Medical Solutions" },
      sales_rep: { id: 2959734, name: "Chelsea Waszak", email: "chelsea.w@cynethealth.com" },
    },
  ],
};

/** Mad River: independent facility, parent_client null, CA state. */
const madRiverEmbeddedClient = {
  id: 974664,
  name: "Mad River Community Hospital",
  parent_client: null,
  zipcode_data: { zipcode: "95521", city: "Arcata", state_code: "CA" },
  client_offerings: [
    {
      id: 2876313,
      offering_id: "ALLIED",
      sub_offering_id: "REHAB",
      msp: { id: 313, name: "Medefis" },
    },
  ],
};

test("pickEmbeddedClientObj: uses the submittal's client when the id matches", () => {
  const picked = pickEmbeddedClientObj({ client: sanfordEmbeddedClient }, null, 3893832);
  assert.equal(picked, sanfordEmbeddedClient);
});

test("pickEmbeddedClientObj: falls back to the job's client when the submittal has none", () => {
  const picked = pickEmbeddedClientObj(null, { client: sanfordEmbeddedClient }, 3893832);
  assert.equal(picked, sanfordEmbeddedClient);
});

test("pickEmbeddedClientObj: never maps a different client's payload onto a candidate", () => {
  const picked = pickEmbeddedClientObj({ client: sanfordEmbeddedClient }, null, 974664);
  assert.equal(picked, null);
});

test("pickEmbeddedClientObj: rejects an embedded client with no geo (API fallback wins)", () => {
  const trimmed = { id: 3893832, name: "Sanford Broadway Medical Center" };
  assert.equal(pickEmbeddedClientObj({ client: trimmed }, null, 3893832), null);
});

test("embedded client maps identically to the /api/clients/ payload (Sanford)", () => {
  const mapped = mapClientToBq(sanfordEmbeddedClient, "Sanford Health");
  assert.deepEqual(mapped, {
    FACILITY_NAME: "Sanford Broadway Medical Center",
    CITY_ZIPCODE: "58102 Fargo",
    CLIENT_STATE: "ND",
    REGION: "Mid West",
    NEXUS_PARENT_CLIENT_ID: 2286407,
    PARENT_CLIENT_NAME: "Sanford Health",
  });
});

test("parent_client null: both parent columns fall back to the client's own name and id", () => {
  const mapped = mapClientToBq(madRiverEmbeddedClient, null);
  assert.equal(mapped.PARENT_CLIENT_NAME, "Mad River Community Hospital");
  assert.equal(mapped.NEXUS_PARENT_CLIENT_ID, 974664);
  assert.equal(mapped.CLIENT_STATE, "CA");
  assert.equal(mapped.REGION, "Pacific West");
});

test("parent_client present: the real parent id wins over the client's own id", () => {
  const mapped = mapClientToBq(sanfordEmbeddedClient, "Sanford Health");
  assert.equal(mapped.NEXUS_PARENT_CLIENT_ID, 2286407);
  assert.notEqual(mapped.NEXUS_PARENT_CLIENT_ID, 3893832);
});

test("parent_client as a bare scalar id still maps to that id, not the client's own", () => {
  const scalarParent = { ...madRiverEmbeddedClient, id: 974664, parent_client: 2286407 };
  assert.equal(mapClientToBq(scalarParent, null).NEXUS_PARENT_CLIENT_ID, 2286407);
});

test("parent_client null with an unusable client id leaves the parent id null", () => {
  const noId = { ...madRiverEmbeddedClient, id: null };
  assert.equal(mapClientToBq(noId, null).NEXUS_PARENT_CLIENT_ID, null);
});

test("registerEmbeddedClientSkips: skips both client and offerings for Sanford", () => {
  const skipDetail = new Set();
  const skipOfferings = new Set();
  registerEmbeddedClientSkips(
    { client: sanfordEmbeddedClient }, 3893832, null, skipDetail, skipOfferings
  );
  assert.equal(skipDetail.has("3893832"), true);
  assert.equal(skipOfferings.has("3893832"), true);
});

test("registerEmbeddedClientSkips: skips via the job payload when no submittal is present", () => {
  const skipDetail = new Set();
  const skipOfferings = new Set();
  registerEmbeddedClientSkips(
    null, 974664, { client: madRiverEmbeddedClient }, skipDetail, skipOfferings
  );
  assert.equal(skipDetail.has("974664"), true);
  assert.equal(skipOfferings.has("974664"), true);
});

test("registerEmbeddedClientSkips: offerings without msp still fetch /api/client-offerings/", () => {
  const noMsp = {
    ...sanfordEmbeddedClient,
    client_offerings: [{ offering_id: "NURSING", msp: null }],
  };
  const skipDetail = new Set();
  const skipOfferings = new Set();
  registerEmbeddedClientSkips({ client: noMsp }, 3893832, null, skipDetail, skipOfferings);
  assert.equal(skipDetail.has("3893832"), true, "geo is still sufficient");
  assert.equal(skipOfferings.has("3893832"), false, "msp missing -> offerings must be fetched");
});

test("embedded offerings resolve MSP without /api/client-offerings/ (sub_offering match)", () => {
  const row = pickClientOfferingRowForJob(
    madRiverEmbeddedClient.client_offerings,
    { offering: "ALLIED", sub_offering: "REHAB" }
  );
  assert.deepEqual(mapMspFromClientOfferingRow(row), {
    MSP_ID: 313,
    MSP_NAME: "Medefis",
    LINE_OF_BUSINESS: "Medefis",
  });
});
