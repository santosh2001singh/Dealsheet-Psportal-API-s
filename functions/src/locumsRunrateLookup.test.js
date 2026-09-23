const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildLocumsContractLookupKey,
  normalizeVmsJobIdKeyPart,
} = require("./locumsRunrateLookup");
const { buildLegacyContractLookupKey } = require("./bigQueryClient");

/**
 * Cynet Locums matches its run-rate table on its OWN two tiers:
 *   1. candidate (CANDIDATE_ID or CANDIDATE_EMAIL) + START_DATE
 *   2. candidate (CANDIDATE_ID or CANDIDATE_EMAIL) + VMS_JOB_ID
 *
 * Separate from the shared span/nexus lookup on purpose — all_locums_runrate carries no client ids
 * at all, so the shared span key can never form there. These assertions pin both the shape of the
 * locums key and the fact that the shared one is left untouched.
 */

const CAND = 31402650;
const EMAIL = "sejalphagirl17@gmail.com";

function locumsRow(overrides = {}) {
  return {
    DEAL_SHEET_ID: 5018058,
    CANDIDATE_ID: CAND,
    CANDIDATE_EMAIL: EMAIL,
    START_DATE: "2026-04-18",
    VMS_JOB_ID: "947224",
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tier 1 — candidate + START_DATE
// --------------------------------------------------------------------------

test("a candidate + START_DATE row yields a dateKey", () => {
  assert.equal(buildLocumsContractLookupKey(locumsRow()).dateKey, `${CAND}|${EMAIL}|2026-04-18`);
});

test("a timestamp START_DATE is reduced to the date", () => {
  const k = buildLocumsContractLookupKey(locumsRow({ START_DATE: "2026-04-18 00:00:00 UTC" }));
  assert.equal(k.dateKey, `${CAND}|${EMAIL}|2026-04-18`);
});

test("no START_DATE means no dateKey, but VMS still keys the row", () => {
  const k = buildLocumsContractLookupKey(locumsRow({ START_DATE: null }));
  assert.equal(k.dateKey, null);
  assert.equal(k.vmsKey, `${CAND}|${EMAIL}|947224`);
});

// --------------------------------------------------------------------------
// Tier 2 — candidate + VMS_JOB_ID, incl. the MSP prefix the run-rate side carries
// --------------------------------------------------------------------------

test("an MSP prefix is stripped so both sides compare equal", () => {
  for (const prefixed of ["AHSA/65803", "ASHA/65803", "HealthTrust/65803", "HealthTrust/ 65803"]) {
    assert.equal(normalizeVmsJobIdKeyPart(prefixed), "65803", prefixed);
  }
  assert.equal(normalizeVmsJobIdKeyPart("65803"), "65803");
});

test("an id with no slash is left alone, and case does not matter", () => {
  assert.equal(normalizeVmsJobIdKeyPart("a-lohmc-260827-88516"), "A-LOHMC-260827-88516");
});

test("no VMS_JOB_ID means no vmsKey, but START_DATE still keys the row", () => {
  const k = buildLocumsContractLookupKey(locumsRow({ VMS_JOB_ID: null }));
  assert.equal(k.vmsKey, null);
  assert.ok(k.dateKey);
});

// --------------------------------------------------------------------------
// The candidate half is mandatory in BOTH tiers — the safety property of the whole lookup.
// --------------------------------------------------------------------------

test("a row with NEITHER candidate identifier forms no key at all", () => {
  assert.equal(
    buildLocumsContractLookupKey({
      DEAL_SHEET_ID: 1,
      START_DATE: "2026-04-18",
      VMS_JOB_ID: "947224",
    }),
    null
  );
});

test("either identifier alone satisfies the candidate half", () => {
  const idOnly = buildLocumsContractLookupKey(locumsRow({ CANDIDATE_EMAIL: null }));
  assert.equal(idOnly.dateKey, `${CAND}||2026-04-18`);
  const emailOnly = buildLocumsContractLookupKey(locumsRow({ CANDIDATE_ID: null }));
  assert.equal(emailOnly.dateKey, `|${EMAIL}|2026-04-18`);
});

test("two candidates on the SAME posting get different vmsKeys", () => {
  // The live failure this must never reproduce: Allen Nau's deal matching Rani Kumar's run-rate row.
  const a = buildLocumsContractLookupKey(locumsRow({ CANDIDATE_ID: 111, CANDIDATE_EMAIL: "a@x.com" }));
  const b = buildLocumsContractLookupKey(locumsRow({ CANDIDATE_ID: 222, CANDIDATE_EMAIL: "b@x.com" }));
  assert.notEqual(a.vmsKey, b.vmsKey);
});

test("a row with neither a date nor a VMS id forms no key", () => {
  assert.equal(
    buildLocumsContractLookupKey({ DEAL_SHEET_ID: 1, CANDIDATE_ID: CAND }),
    null
  );
});

// --------------------------------------------------------------------------
// Separation: the shared lookup is untouched, and locums never reaches it.
// --------------------------------------------------------------------------

const BQ_SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
const RESOLVER_SRC = fs.readFileSync(path.join(__dirname, "contractIdResolver.js"), "utf8");

test("the shared key builder knows nothing about VMS_JOB_ID", () => {
  const shared = buildLegacyContractLookupKey({
    DEAL_SHEET_ID: 1,
    CANDIDATE_ID: 111,
    CANDIDATE_EMAIL: "a@cynethealth.com",
    INTERNAL_JOB_ID: 99,
    VMS_JOB_ID: "947224",
  });
  assert.equal(shared.vmsKey, undefined, "the shared key must not gain a vms half");
  assert.equal(shared.nexusKey, "111|99", "its own tiers are unchanged");
  assert.ok(shared.spanKey === null || typeof shared.spanKey === "object");
});

test("the shared lookup still reports exactly its two tiers", () => {
  assert.ok(BQ_SRC.includes("(spanKey=${spanHits} nexusKey=${nexusHits})"));
  assert.ok(!BQ_SRC.includes("vmsKey=${vmsHits}"), "no third tier was bolted onto the shared path");
});

test("the resolver sends only the locums tables to the locums lookup", () => {
  assert.ok(
    RESOLVER_SRC.includes(
      "const useLocumsLookup = tableId === TABLE_CYNET_LOCUMS || tableId === TABLE_ENDED_CYNET_LOCUMS;"
    )
  );
  assert.ok(
    RESOLVER_SRC.includes(
      "useLocumsLookup ? fetchLocumsRunrateIdentityForDealRows : fetchLegacyContractIdentityForDealRows"
    ),
    "every other domain keeps the shared lookup"
  );
});

test("the locums lookup tries START_DATE before VMS_JOB_ID", () => {
  // Tier 1 must win a tie: only rows it could not place are probed on VMS.
  assert.ok(BQ_SRC.includes("!(key.dateKey && byDateKey.has(key.dateKey))"));
  assert.ok(BQ_SRC.includes("const tier2 = tier1 ? null : key.vmsKey ? byVmsKey.get(key.vmsKey) : null;"));
});
