const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeTsForCompare } = require("./extensionDateBackfill");
const { resolveExtensionDateForExtensionRow } = require("./columnMappings");

test("normalizeTsForCompare normalizes Z and wrapper objects to ISO", () => {
  assert.equal(normalizeTsForCompare("2026-07-29T14:15:54Z"), "2026-07-29T14:15:54.000Z");
  assert.equal(normalizeTsForCompare({ value: "2026-07-29T14:15:54.000Z" }), "2026-07-29T14:15:54.000Z");
  assert.equal(normalizeTsForCompare(null), "");
  assert.equal(normalizeTsForCompare(""), "");
});

test("backfill source: earliest BOOKED note wins for EXTENSION_DATE", () => {
  const notes = [
    {
      org_submittal_status: { code: "BOOKED" },
      created_date: "2026-07-29T14:15:54Z",
      modified_date: "2026-07-29T14:15:54Z",
    },
    {
      org_submittal_status: { code: "OFFERED" },
      created_date: "2026-07-21T19:18:04Z",
      modified_date: "2026-07-21T19:18:04Z",
    },
  ];
  const fromNotes = resolveExtensionDateForExtensionRow("EXTENSION", notes);
  assert.equal(normalizeTsForCompare(fromNotes), "2026-07-29T14:15:54.000Z");
});
