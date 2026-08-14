const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLoadJobPayload } = require("./bigQueryClient");

// insertAll switched from the streaming API (tabledata.insertAll) to a load job so that the
// post-insert backfills (DELIVERY_POC, EXT_OR_REHIRE_BY_RMG, cluster/region) stop failing with
// "would affect rows in the streaming buffer". These cover the row shaping that feeds the load job.

function parseNdjson(buffer) {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

test("payload is newline-delimited JSON, one line per row, no trailing newline", () => {
  const { buffer } = buildLoadJobPayload([
    { DEAL_SHEET_ID: 1, LAST_UPDATED: "2026-08-13T00:00:00Z" },
    { DEAL_SHEET_ID: 2, LAST_UPDATED: "2026-08-13T00:00:00Z" },
  ]);
  const text = buffer.toString("utf8");
  assert.equal(text.split("\n").length, 2);
  assert.ok(!text.endsWith("\n"));
  assert.deepEqual(
    parseNdjson(buffer).map((r) => r.DEAL_SHEET_ID),
    [1, 2]
  );
});

test("existing LAST_UPDATED is preserved; a blank one is stamped", () => {
  const { jsonRows } = buildLoadJobPayload([
    { DEAL_SHEET_ID: 1, LAST_UPDATED: "2020-01-01T00:00:00Z" },
    { DEAL_SHEET_ID: 2, LAST_UPDATED: "   " },
    { DEAL_SHEET_ID: 3 },
  ]);
  assert.equal(jsonRows[0].LAST_UPDATED, "2020-01-01T00:00:00Z");
  for (const i of [1, 2]) {
    assert.match(jsonRows[i].LAST_UPDATED, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("pipeline-internal fields are stripped and never reach the payload", () => {
  const { jsonRows } = buildLoadJobPayload([
    {
      DEAL_SHEET_ID: 1,
      _rn: 1,
      rn: 2,
      _src: "x",
      _src_table: "y",
      _INSERT_ID: "key-1",
      __PREV_RECRUITER_EMP_NO: "E1",
      KEEP_ME: "yes",
    },
  ]);
  const row = jsonRows[0];
  for (const k of ["_rn", "rn", "_src", "_src_table", "_INSERT_ID", "__PREV_RECRUITER_EMP_NO"]) {
    assert.ok(!(k in row), `${k} should be stripped`);
  }
  assert.equal(row.KEEP_ME, "yes");
  assert.equal(row.DEAL_SHEET_ID, 1);
});

test("BigQuery {value} wrappers and Dates are unwrapped to JSON primitives", () => {
  const { jsonRows } = buildLoadJobPayload([
    {
      DEAL_SHEET_ID: 1,
      START_DATE: { value: "2026-08-13" },
      CREATED: new Date("2026-08-13T10:00:00Z"),
    },
  ]);
  assert.equal(jsonRows[0].START_DATE, "2026-08-13");
  assert.equal(jsonRows[0].CREATED, "2026-08-13T10:00:00.000Z");
});

test("undefined becomes null so the field is explicit in NDJSON", () => {
  const { buffer } = buildLoadJobPayload([{ DEAL_SHEET_ID: 1, MAYBE: undefined, REAL_NULL: null }]);
  const row = parseNdjson(buffer)[0];
  assert.equal(row.REAL_NULL, null);
  assert.ok(!("MAYBE" in row) || row.MAYBE === null);
});

test("multiple rows may share a DEAL_SHEET_ID -- append-on-change must not be deduped here", () => {
  // The old streaming path keyed insertId on DEAL_SHEET_ID. Load jobs have no such dedupe, which is
  // what this pipeline actually wants: it appends a new row per change for the same deal sheet.
  const { jsonRows } = buildLoadJobPayload([
    { DEAL_SHEET_ID: 42, BILL_RATE: 100 },
    { DEAL_SHEET_ID: 42, BILL_RATE: 120 },
  ]);
  assert.equal(jsonRows.length, 2);
  assert.deepEqual(jsonRows.map((r) => r.BILL_RATE), [100, 120]);
});

test("empty input produces an empty payload", () => {
  const { jsonRows, buffer } = buildLoadJobPayload([]);
  assert.deepEqual(jsonRows, []);
  assert.equal(buffer.toString("utf8"), "");
});

test("strings with newlines/quotes stay intact through NDJSON round-trip", () => {
  const { buffer } = buildLoadJobPayload([
    { DEAL_SHEET_ID: 1, COMMENTS: 'line one\nline "two"\tend' },
  ]);
  const rows = parseNdjson(buffer);
  assert.equal(rows.length, 1, "an embedded newline must not split into two NDJSON lines");
  assert.equal(rows[0].COMMENTS, 'line one\nline "two"\tend');
});
