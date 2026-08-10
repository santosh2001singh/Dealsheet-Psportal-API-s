// Domain-scoped sync (Aug 2026). Each scheduled trigger runs one domain so cynet health can stay
// live while canada / locums are worked on. The filter must agree exactly with the routing used to
// pick a row's destination table — otherwise a domain-scoped run and an unscoped one would write
// different rows to the same table.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SYNC_DOMAINS,
  normalizeSyncDomain,
  resolveActiveDealSheetTableIdForDomain,
  rowMatchesSyncDomain,
  resolveActiveDealSheetTableId,
  ACTIVE_DEAL_SHEET_TABLE_IDS,
  TABLE_CYNET_HEALTH,
  TABLE_CYNET_HEALTH_CANADA,
  TABLE_CYNET_LOCUMS,
} = require("./recruiterDomainTables");

test("every domain maps to a distinct active deal sheet table", () => {
  const tables = SYNC_DOMAINS.map((d) => resolveActiveDealSheetTableIdForDomain(d));
  assert.deepEqual(tables, [TABLE_CYNET_HEALTH, TABLE_CYNET_HEALTH_CANADA, TABLE_CYNET_LOCUMS]);
  assert.equal(new Set(tables).size, ACTIVE_DEAL_SHEET_TABLE_IDS.length);
});

test("normalizeSyncDomain accepts known names case/space-insensitively", () => {
  assert.equal(normalizeSyncDomain("health"), "health");
  assert.equal(normalizeSyncDomain("  CANADA "), "canada");
  assert.equal(normalizeSyncDomain("Locums"), "locums");
});

test("normalizeSyncDomain returns null for empty/unknown (no filter)", () => {
  for (const value of ["", "   ", null, undefined, "usa", "cynet_health_deal_sheet"]) {
    assert.equal(normalizeSyncDomain(value), null);
  }
});

test("a null domain matches every row, so unscoped runs keep legacy behaviour", () => {
  for (const email of [
    "a@cynethealth.com",
    "b@cynethealth.ca",
    "c@cynetlocums.com",
    "d@example.com",
    null,
  ]) {
    assert.equal(rowMatchesSyncDomain(null, email), true);
    assert.equal(rowMatchesSyncDomain("", email), true);
  }
});

test("each domain matches only its own recruiter emails", () => {
  const cases = [
    ["health", "recruiter@cynethealth.com"],
    ["canada", "recruiter@cynethealth.ca"],
    ["locums", "recruiter@cynetlocums.com"],
  ];
  for (const [domain, ownEmail] of cases) {
    assert.equal(rowMatchesSyncDomain(domain, ownEmail), true, `${domain} should match ${ownEmail}`);
    for (const [otherDomain, otherEmail] of cases) {
      if (otherDomain === domain) continue;
      assert.equal(
        rowMatchesSyncDomain(domain, otherEmail),
        false,
        `${domain} must not match ${otherEmail}`
      );
    }
  }
});

// resolveActiveDealSheetTableId falls back to cynet health for unknown/empty emails, so those rows
// belong to the health run. Canada/locums runs must never pick them up.
test("unknown and empty recruiter emails belong to the health domain only", () => {
  for (const email of ["someone@example.com", "", null, undefined]) {
    assert.equal(resolveActiveDealSheetTableId(email), TABLE_CYNET_HEALTH);
    assert.equal(rowMatchesSyncDomain("health", email), true);
    assert.equal(rowMatchesSyncDomain("canada", email), false);
    assert.equal(rowMatchesSyncDomain("locums", email), false);
  }
});

test("the three domain filters partition every row exactly once", () => {
  const emails = [
    "a@cynethealth.com",
    "b@cynethealth.ca",
    "c@cynetlocums.com",
    "d@example.com",
    "",
    null,
  ];
  for (const email of emails) {
    const matched = SYNC_DOMAINS.filter((d) => rowMatchesSyncDomain(d, email));
    assert.equal(matched.length, 1, `${email} matched ${matched.length} domains: ${matched}`);
  }
});

test("the matching domain is the one owning the row's routed table", () => {
  const emails = ["a@cynethealth.com", "b@cynethealth.ca", "c@cynetlocums.com", "d@example.com"];
  for (const email of emails) {
    const domain = SYNC_DOMAINS.find((d) => rowMatchesSyncDomain(d, email));
    assert.equal(resolveActiveDealSheetTableIdForDomain(domain), resolveActiveDealSheetTableId(email));
  }
});
