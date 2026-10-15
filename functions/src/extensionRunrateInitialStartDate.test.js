const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// fetchExtensionRunrateBackfillByPlacementId builds its SQL inline against queryObjects, so the
// rule is pinned on the query text. Live case: Angela Addy (PLACEMENT_ID 1468972, CHC10980) got the
// previous segment's 2026-08-30 instead of the contract's 2023-05-08.
const SRC = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
const fnStart = SRC.indexOf("async function fetchExtensionRunrateBackfillByPlacementId(");
const fnBody = SRC.slice(fnStart, SRC.indexOf("\nasync function ", fnStart + 1));

test("run-rate backfill selects the matched row's INITIAL_START_DATE", () => {
  assert.match(fnBody, /INITIAL_START_DATE AS runrate_initial_start_date/);
});

test("the matched row's INITIAL_START_DATE wins over the SKU / client fallbacks", () => {
  const proposed = fnBody.slice(0, fnBody.indexOf("AS proposed_original_start_date"));
  const coalesce = proposed.slice(proposed.lastIndexOf("COALESCE("));
  const own = coalesce.indexOf("b.runrate_initial_start_date");
  const sku = coalesce.indexOf("s.sku_original_start_date");
  const client = coalesce.indexOf("c.client_original_start_date");
  assert.ok(own > 0 && own < sku && sku < client, coalesce);
});

test("it is only taken when not after the matched row's own START_DATE", () => {
  assert.match(
    fnBody,
    /IF\(b\.runrate_initial_start_date <= b\.runrate_start_date, b\.runrate_initial_start_date, NULL\)/
  );
});
