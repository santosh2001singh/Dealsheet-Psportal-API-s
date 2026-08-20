const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// A duplicate name in any column list that gets spread into a SQL SELECT is FATAL, not cosmetic:
// the name lands twice in the projection and BigQuery rejects the whole query when a later clause
// references it. Live outage (Aug 18 2026): ACC_DIR_OR_VERT_HEAD was listed twice in
// EXTENSION_PARENT_DEAL_INHERIT_COLUMNS, so the `deals` CTE in
// fetchExtensionParentDealInheritByPlacementId projected it twice and every insert batch died with
//   Name ACC_DIR_OR_VERT_HEAD is ambiguous inside d at [107:13]
// which stalled the entire sync (TIMER_FAIL, checkpoint reason=error_paused, hasMore=yes).
//
// These lists are read straight out of the source text rather than imported, so a list that is not
// exported is still covered.

const SOURCE = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");

/** Pull a `const NAME = [ "A", "B", ... ];` literal out of the source as a string array. */
function readColumnListLiteral(name) {
  const match = SOURCE.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `expected to find a ${name} array literal in bigQueryClient.js`);
  return [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
}

// Every list whose entries are spread into a SQL SELECT / projection.
const SQL_SPREAD_COLUMN_LISTS = [
  "EXTENSION_PARENT_DEAL_INHERIT_COLUMNS",
  "EXTENSION_RUNRATE_HIERARCHY_COLUMNS",
  "EXTENSION_RUNRATE_MANUAL_COLUMNS",
  "ACTIVE_DEAL_SHEET_UNION_BASE_COLUMNS",
  "ACTIVE_CHANGE_SCAN_COLUMNS",
];

for (const listName of SQL_SPREAD_COLUMN_LISTS) {
  test(`${listName} has no duplicate columns`, () => {
    const cols = readColumnListLiteral(listName);
    assert.ok(cols.length > 0, `expected ${listName} to be non-empty`);

    const seen = new Set();
    const duplicates = [];
    for (const col of cols) {
      if (seen.has(col)) duplicates.push(col);
      seen.add(col);
    }
    assert.deepEqual(
      duplicates,
      [],
      `${listName} lists ${duplicates.join(", ")} more than once — this breaks every SQL ` +
        `statement that spreads it (see the header of this file)`
    );
  });
}

test("ACC_DIR_OR_VERT_HEAD specifically appears once in the parent-deal inherit list", () => {
  // The exact regression from the Aug 18 2026 outage, pinned by name.
  const cols = readColumnListLiteral("EXTENSION_PARENT_DEAL_INHERIT_COLUMNS");
  assert.equal(cols.filter((c) => c === "ACC_DIR_OR_VERT_HEAD").length, 1);
});
