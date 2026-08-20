const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLegacyContractLookupKey,
  normalizeClientIdKeyPart,
} = require("./bigQueryClient");

// Matching a deal row to its run-rate row used to key the client half on FACILITY_NAME +
// PARENT_CLIENT_NAME alone. The two tables spell the same facility differently often enough that
// this silently lost matches: measured on live data (Aug 2026), joining every deal row to
// all_CH_data_runrate on CANDIDATE_ID gives 11,313 candidate/client pairs, of which the name pair
// matches 5,283 and the id pair (CLIENT_ID + NEXUS_PARENT_CLIENT_ID) matches 6,032 — 749 that only
// ids resolve, and ZERO that only names resolve. Ids therefore go first everywhere, with the names
// kept as a fallback because 975 of 21,926 run-rate rows carry neither id.

const BASE_ROW = {
  CANDIDATE_ID: 31721550,
  CANDIDATE_EMAIL: "awilliams1115@bellsouth.net",
  START_DATE: "2026-04-27",
  END_DATE: "2026-06-22",
  TENTATIVE_END_DATE: "2026-07-25",
  FACILITY_NAME: "URMC Strong Memorial Hospital",
  PARENT_CLIENT_NAME: "URMC Strong Memorial Hospital",
  CLIENT_ID: 2588831,
  NEXUS_PARENT_CLIENT_ID: 2588831,
  DEAL_SHEET_ID: 1,
};

test("normalizeClientIdKeyPart renders real ids and blanks everything unusable", () => {
  assert.equal(normalizeClientIdKeyPart(2588831), "2588831");
  assert.equal(normalizeClientIdKeyPart("2588831"), "2588831");
  assert.equal(normalizeClientIdKeyPart(" 2588831 "), "2588831");
  // A blank means "cannot match on id" and pushes the row onto the name fallback.
  assert.equal(normalizeClientIdKeyPart(null), "");
  assert.equal(normalizeClientIdKeyPart(undefined), "");
  assert.equal(normalizeClientIdKeyPart(""), "");
  assert.equal(normalizeClientIdKeyPart("abc"), "");
  // 0 is never a real Nexus client id; treating it as one would join unrelated rows together.
  assert.equal(normalizeClientIdKeyPart(0), "");
});

test("the lookup key carries both the ids and the names", () => {
  const key = buildLegacyContractLookupKey(BASE_ROW);
  assert.equal(key.spanKey.facilityId, "2588831");
  assert.equal(key.spanKey.parentClientId, "2588831");
  // Names stay on the key: the run-rate row on the other side may have no ids at all.
  assert.equal(key.spanKey.facility, "urmc strong memorial hospital");
  assert.equal(key.spanKey.parentClient, "urmc strong memorial hospital");
});

test("ids alone are enough to build a key when both names are missing", () => {
  const key = buildLegacyContractLookupKey({
    ...BASE_ROW,
    FACILITY_NAME: null,
    PARENT_CLIENT_NAME: null,
  });
  assert.ok(key.spanKey, "expected an id-only row to still produce a span key");
  assert.equal(key.spanKey.facilityId, "2588831");
  assert.equal(key.spanKey.facility, "");
});

test("names alone are enough to build a key when both ids are missing", () => {
  const key = buildLegacyContractLookupKey({
    ...BASE_ROW,
    CLIENT_ID: null,
    NEXUS_PARENT_CLIENT_ID: null,
  });
  assert.ok(key.spanKey, "expected a name-only row to still produce a span key");
  assert.equal(key.spanKey.facilityId, "");
  assert.equal(key.spanKey.parentClient, "urmc strong memorial hospital");
});

test("a row with neither ids nor names has no span key to match on", () => {
  const key = buildLegacyContractLookupKey({
    ...BASE_ROW,
    CLIENT_ID: null,
    NEXUS_PARENT_CLIENT_ID: null,
    FACILITY_NAME: null,
    PARENT_CLIENT_NAME: null,
    INTERNAL_JOB_ID: null,
  });
  assert.equal(key, null);
});

test("half an id pair is not an id match and falls back to the names", () => {
  // Only one of the two ids present: the SQL requires BOTH before it takes the id arm, so the key
  // must still carry usable names or there is nothing to match on.
  const key = buildLegacyContractLookupKey({ ...BASE_ROW, NEXUS_PARENT_CLIENT_ID: null });
  assert.ok(key.spanKey);
  assert.equal(key.spanKey.facilityId, "2588831");
  assert.equal(key.spanKey.parentClientId, "");
  assert.equal(key.spanKey.facility, "urmc strong memorial hospital");
});

test("rows differing only by client id get distinct keys", () => {
  // The ids are part of the key string on both sides of the SQL round trip. If they were left out,
  // two rows with identical names but different clients would collide and one would take the
  // other's CONTRACT_ID.
  const a = buildLegacyContractLookupKey({ ...BASE_ROW, DEAL_SHEET_ID: null, PLACEMENT_ID: null });
  const b = buildLegacyContractLookupKey({
    ...BASE_ROW,
    DEAL_SHEET_ID: null,
    PLACEMENT_ID: null,
    CLIENT_ID: 7777777,
    NEXUS_PARENT_CLIENT_ID: 7777777,
  });
  assert.notEqual(a.rowKey, b.rowKey);
});

// ---------------------------------------------------------------------------------------------
// Contract identity stability: one contract must resolve to ONE id, and a placement that already
// has an id must keep it.
// ---------------------------------------------------------------------------------------------

const { applyContractIdCarryForward } = require("./bigQueryClient");

test("two placement rows of one contract share a span key despite different dates", () => {
  // The deal sheet is append-only: one contract owns several placement-level rows and each carries
  // its OWN dates. When the dates were part of the key these two built DIFFERENT keys, the SQL
  // PARTITION BY split them into two windows, and each resolved its own CONTRACT_ID — one contract,
  // two ids. Identity alone (candidate + client) has to be what the key is made of.
  const a = buildLegacyContractLookupKey({
    ...BASE_ROW,
    DEAL_SHEET_ID: null,
    PLACEMENT_ID: null,
    START_DATE: "2026-01-12",
    END_DATE: "2026-01-31",
    TENTATIVE_END_DATE: "2026-04-04",
  });
  const b = buildLegacyContractLookupKey({
    ...BASE_ROW,
    DEAL_SHEET_ID: null,
    PLACEMENT_ID: null,
    START_DATE: "2026-01-05",
    END_DATE: null,
    TENTATIVE_END_DATE: "2026-04-04",
  });
  assert.equal(a.rowKey, b.rowKey);
});

test("a different client still splits the key even when the dates match", () => {
  // The flip side: collapsing on identity must not collapse ACROSS clients.
  const a = buildLegacyContractLookupKey({ ...BASE_ROW, DEAL_SHEET_ID: null, PLACEMENT_ID: null });
  const b = buildLegacyContractLookupKey({
    ...BASE_ROW,
    DEAL_SHEET_ID: null,
    PLACEMENT_ID: null,
    CLIENT_ID: 9999999,
    NEXUS_PARENT_CLIENT_ID: 9999999,
  });
  assert.notEqual(a.rowKey, b.rowKey);
});

test("applyContractIdCarryForward keeps the baseline id on an update-append", () => {
  // Live regression (DEAL_SHEET_ID 5139885 / PLACEMENT_ID 1441464, Aug 2026): the same placement was
  // appended with CHC20908 on 08-17 and CHC20892 on 08-18, every business field identical. A
  // placement's contract identity is set once and is immutable after that.
  const out = applyContractIdCarryForward(
    { CONTRACT_ID: null, BILL_RATE: "113.1" },
    { CONTRACT_ID: "CHC20908" }
  );
  assert.equal(out.row.CONTRACT_ID, "CHC20908");
  assert.equal(out.carried, true);
});

test("applyContractIdCarryForward overrides a re-derived id that drifted", () => {
  // The allocator re-matching against a run-rate table that has since changed is exactly how the
  // drift happened; the baseline still wins.
  const out = applyContractIdCarryForward(
    { CONTRACT_ID: "CHC20892" },
    { CONTRACT_ID: "CHC20908" }
  );
  assert.equal(out.row.CONTRACT_ID, "CHC20908");
  assert.equal(out.carried, true);
});

test("applyContractIdCarryForward is a no-op when the ids already agree", () => {
  const incoming = { CONTRACT_ID: "CHC20908" };
  const out = applyContractIdCarryForward(incoming, { CONTRACT_ID: "CHC20908" });
  assert.equal(out.carried, false);
  assert.equal(out.row, incoming, "expected the row to pass through untouched");
});

test("applyContractIdCarryForward leaves the row to the allocator when the baseline has no id", () => {
  const incoming = { CONTRACT_ID: null };
  const out = applyContractIdCarryForward(incoming, { CONTRACT_ID: null });
  assert.equal(out.carried, false);
  assert.equal(out.row.CONTRACT_ID, null);
});

test("applyContractIdCarryForward is a no-op on a first insert (no baseline)", () => {
  const incoming = { CONTRACT_ID: null };
  const out = applyContractIdCarryForward(incoming, null);
  assert.equal(out.carried, false);
  assert.equal(out.row, incoming);
});
