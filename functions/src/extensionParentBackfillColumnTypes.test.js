const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildExtensionParentBackfillSql,
  DATE_LIKE_COLUMNS,
} = require("./extensionParentBackfill");
const { EXTENSION_PARENT_DEAL_INHERIT_COLUMNS } = require("./bigQueryClient");

// Regression guard for the Sep 2026 outage: fillIfEmptySql / isBlankSql wrap a column in
// IFNULL(col, '') unless it is in DATE_LIKE_COLUMNS, and BigQuery rejects that on a non-STRING
// column ("No matching signature for function IFNULL / Argument types: FLOAT64, STRING"). That
// error aborts the whole multi-statement script, so ONE unlisted numeric column silently disabled
// the entire parent-DEAL repair pass — 23 EXTENSION rows kept a null hierarchy until it was found
// by hand. These tests read the real table DDL so a newly added column of the wrong type fails here
// instead of in production.

const DDL = fs.readFileSync(
  path.join(__dirname, "..", "..", "sql", "create_domain_deal_sheet_tables.sql"),
  "utf8"
);

/** Column -> declared BigQuery type, parsed from the health CREATE TABLE block. */
function declaredTypes() {
  const types = new Map();
  for (const line of DDL.split("\n")) {
    const m = line.match(/^\s{2}([A-Z0-9_]+)\s+(STRING|FLOAT64|INT64|BOOL|DATE|TIMESTAMP|DATETIME|NUMERIC)\s*,?\s*$/);
    if (m && !types.has(m[1])) types.set(m[1], m[2]);
  }
  return types;
}

test("the DDL parse actually found the columns (guard against a silent no-op)", () => {
  const types = declaredTypes();
  assert.ok(types.size > 50, `parsed only ${types.size} columns`);
  assert.equal(types.get("WEEKLY_WALLET_MONEY"), "FLOAT64");
  assert.equal(types.get("COMMENTS"), "STRING");
});

test("every non-STRING inherited column is registered in DATE_LIKE_COLUMNS", () => {
  const types = declaredTypes();
  const cols = [...EXTENSION_PARENT_DEAL_INHERIT_COLUMNS, "INITIAL_START_DATE"];
  const unregistered = cols.filter((col) => {
    const t = types.get(col);
    if (t == null || t === "STRING") return false;
    return !DATE_LIKE_COLUMNS.has(col);
  });
  assert.deepEqual(
    unregistered,
    [],
    `non-STRING columns missing from DATE_LIKE_COLUMNS (they would abort the pass): ${unregistered.join(", ")}`
  );
});

test("the FLOAT64 columns that caused the outage are registered", () => {
  for (const col of [
    "WEEKLY_WALLET_MONEY",
    "BGC_AMOUNT1",
    "BGC_AMOUNT2",
    "BGC_AMOUNT3",
    "BGC_TOTAL_BGV_COST",
  ]) {
    assert.ok(DATE_LIKE_COLUMNS.has(col), col);
  }
});

test("no non-STRING column is wrapped in IFNULL(.., '') in the generated SQL", () => {
  const types = declaredTypes();
  const { sql } = buildExtensionParentBackfillSql({ projectId: "p", datasetId: "d" });
  const offenders = [];
  for (const [col, t] of types) {
    if (t === "STRING") continue;
    for (const alias of ["d", "s"]) {
      if (sql.includes(`IFNULL(${alias}.${col}, '')`)) offenders.push(`${alias}.${col}:${t}`);
    }
  }
  assert.deepEqual(offenders, [], `type-mismatched IFNULL in SQL: ${offenders.join(", ")}`);
});

test("AVP rides along with the other hierarchy roles", () => {
  // AVP was the one hierarchy role missing from the shared inherit list (5 of the 23 rows had one).
  assert.ok(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("AVP"));
  assert.ok(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("AVP_EMP_NO"));
  const { sql } = buildExtensionParentBackfillSql({ projectId: "p", datasetId: "d" });
  assert.ok(/\bAVP\b/.test(sql));
  assert.ok(/AVP_EMP_NO/.test(sql));
});

test("every hierarchy role name has its _EMP_NO companion in the inherit list", () => {
  const roles = ["TEAM_LEAD", "ATL", "RM", "ACCOUNT_MANAGER", "SECONDARY_AM", "ASSOCIATE_AM",
    "ASSOCIATE_DELIVERY_DIRECTOR", "DELIVERY_DIRECTOR", "AVP", "VP"];
  for (const role of roles) {
    assert.ok(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes(role), role);
    assert.ok(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes(`${role}_EMP_NO`), `${role}_EMP_NO`);
  }
});
