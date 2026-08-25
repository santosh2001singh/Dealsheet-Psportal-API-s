const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  submittalClientStateCode,
  submittalClientStateName,
  submittalClientCountryCode,
  submittalMayBeCanada,
} = require("./canadaDerivedPlacementFields");

/**
 * Nexus's /api/job-submittals/ takes no state parameter, so a canada run used to enrich EVERY
 * submittal (~11 API calls each) and only discard the non-canada ones afterwards. On live data just
 * ~5% of submittals are canadian, so ~95% of that fan-out was wasted — and the volume is what
 * tripped the edge rate limit into HTML 403s.
 *
 * The province is already on the submittal at client.zipcode_data.state_code — the same field
 * CLIENT_STATE is derived from — so the decision can be made before any enrich call.
 */

/** A job-submittal shaped like the real list response. */
function submittal(stateCode, stateName, countryCode) {
  return {
    job: 123,
    candidate: 456,
    client: {
      name: "Some Hospital",
      zipcode_data:
        stateCode === undefined && stateName === undefined && countryCode === undefined
          ? undefined
          : { state_code: stateCode, state_name: stateName, iso_country_code: countryCode },
    },
  };
}

// --------------------------------------------------------------------------
// Reading the province off the raw submittal
// --------------------------------------------------------------------------

test("the state code is read straight off the submittal", () => {
  assert.equal(submittalClientStateCode(submittal("BC")), "BC");
  assert.equal(submittalClientStateCode(submittal("ON")), "ON");
});

test("the state code is normalised", () => {
  assert.equal(submittalClientStateCode(submittal("bc")), "BC");
  assert.equal(submittalClientStateCode(submittal("  ns  ")), "NS");
});

test("a missing state resolves to null, never a guess", () => {
  assert.equal(submittalClientStateCode(submittal(undefined)), null);
  assert.equal(submittalClientStateCode(submittal(null)), null);
  assert.equal(submittalClientStateCode(submittal("")), null);
  assert.equal(submittalClientStateCode({}), null);
  assert.equal(submittalClientStateCode(null), null);
});

// --------------------------------------------------------------------------
// The keep/drop decision
// --------------------------------------------------------------------------

test("all nine canadian provinces are kept", () => {
  for (const p of ["AB", "BC", "MB", "NB", "NL", "NS", "ON", "QC", "SK"]) {
    assert.equal(submittalMayBeCanada(submittal(p)), true, p);
  }
});

test("US states are dropped before any enrich call", () => {
  for (const s of ["NY", "NC", "FL", "IL", "TX", "CA", "AZ", "AK"]) {
    assert.equal(submittalMayBeCanada(submittal(s)), false, s);
  }
});

test("CA is treated as California, not Canada", () => {
  // The country is "CA" too, but state_code CA is California — dropping this distinction would pull
  // every californian placement into the canada run.
  assert.equal(submittalMayBeCanada(submittal("CA")), false);
});

test("a submittal with no resolvable state is KEPT", () => {
  // Dropping it would silently lose a row if Nexus ever omits zipcode_data. The post-enrich domain
  // filter still catches it, so keeping is the safe direction.
  assert.equal(submittalMayBeCanada(submittal(undefined)), true);
  assert.equal(submittalMayBeCanada(submittal(null)), true);
  assert.equal(submittalMayBeCanada(submittal("")), true);
  assert.equal(submittalMayBeCanada({}), true);
});

// --------------------------------------------------------------------------
// Wiring: canada only, and before enrich
// --------------------------------------------------------------------------

const SRC = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");

test("the pre-filter applies to canada only", () => {
  assert.ok(
    SRC.includes('syncDomain === "canada" ? submittalItems.filter(submittalMayBeCanada) : submittalItems'),
    "health and locums must receive the unfiltered submittal list"
  );
});

test("the filter runs BEFORE job ids are collected for enrich", () => {
  const filterAt = SRC.indexOf("const submittalsForDomain =");
  const loopAt = SRC.indexOf("for (const row of submittalsForDomain)");
  assert.ok(filterAt > 0 && loopAt > filterAt, "filter must precede the enrich fan-out");
  // And the loop must iterate the FILTERED list, not the raw one.
  assert.ok(
    !SRC.includes("for (const row of submittalItems) {"),
    "the enrich loop must not iterate the unfiltered list"
  );
});

test("the post-enrich domain filter is still in place as a safety net", () => {
  assert.ok(SRC.includes("rowMatchesSyncDomainForRow(syncDomain, row)"));
});

// --------------------------------------------------------------------------
// Three independent signals
//
// zipcode_data carries state_code ("BC"), state_name ("British Columbia") and iso_country_code
// ("CA"). All three were present on 1200/1200 live submittals and never disagreed, so any one is
// enough — taking them together means one missing field cannot silently drop a canadian placement.
// --------------------------------------------------------------------------

test("the full province name is read off the submittal", () => {
  assert.equal(submittalClientStateName(submittal("BC", "British Columbia")), "British Columbia");
  assert.equal(submittalClientStateName(submittal("BC", "  Ontario  ")), "Ontario");
  assert.equal(submittalClientStateName(submittal("BC", "")), null);
  assert.equal(submittalClientStateName({}), null);
});

test("the ISO country is read and normalised", () => {
  assert.equal(submittalClientCountryCode(submittal("BC", "British Columbia", "ca")), "CA");
  assert.equal(submittalClientCountryCode(submittal("NY", "New York", "US")), "US");
  assert.equal(submittalClientCountryCode({}), null);
});

test("the province NAME alone is enough to keep a submittal", () => {
  for (const n of ["British Columbia", "Ontario", "Quebec", "Newfoundland and Labrador"]) {
    assert.equal(submittalMayBeCanada(submittal(null, n, null)), true, n);
  }
});

test("the province name match is case-insensitive", () => {
  assert.equal(submittalMayBeCanada(submittal(null, "british columbia", null)), true);
  assert.equal(submittalMayBeCanada(submittal(null, "  ONTARIO  ", null)), true);
});

test("the country code alone is enough to keep a submittal", () => {
  assert.equal(submittalMayBeCanada(submittal(null, null, "CA")), true);
});

test("state_code CA is California, but country CA is Canada", () => {
  // The single most dangerous confusion here: reading the country off state_code would pull every
  // californian placement into the canada run.
  assert.equal(submittalMayBeCanada(submittal("CA", "California", "US")), false);
  assert.equal(submittalMayBeCanada(submittal(null, null, "CA")), true);
});

test("a US submittal is dropped even with all three fields present", () => {
  assert.equal(submittalMayBeCanada(submittal("NY", "New York", "US")), false);
  assert.equal(submittalMayBeCanada(submittal("TX", "Texas", "US")), false);
});

test("one canadian signal outweighs missing siblings", () => {
  // Any single field identifying canada keeps the row, so partial data never loses a placement.
  assert.equal(submittalMayBeCanada(submittal("NS", null, null)), true);
  assert.equal(submittalMayBeCanada(submittal(null, "Nova Scotia", null)), true);
  assert.equal(submittalMayBeCanada(submittal(null, null, "CA")), true);
});
