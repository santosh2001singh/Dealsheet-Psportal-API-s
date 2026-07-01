const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatContractId,
  normalizeContractIdOrNull,
  parseContractIdSeq,
  compareContractIds,
  getContractIdConfigForTable,
  buildSequenceOptionsForTable,
} = require("./contractIdFormat");

test("formatContractId builds prefixed id", () => {
  assert.equal(formatContractId("CHC", 1000), "CHC1000");
  assert.equal(formatContractId("cac", 332), "CAC332");
  assert.equal(formatContractId("LOC", 1), "LOC1");
});

test("normalizeContractIdOrNull accepts valid prefixes only", () => {
  assert.equal(normalizeContractIdOrNull("CHC1000"), "CHC1000");
  assert.equal(normalizeContractIdOrNull("chc1000"), "CHC1000");
  assert.equal(normalizeContractIdOrNull("CAC332"), "CAC332");
  assert.equal(normalizeContractIdOrNull("LOC1000"), "LOC1000");
  assert.equal(normalizeContractIdOrNull("1000"), null);
  assert.equal(normalizeContractIdOrNull("HEA1000"), null);
  assert.equal(normalizeContractIdOrNull(null), null);
});

test("parseContractIdSeq extracts numeric suffix", () => {
  assert.equal(parseContractIdSeq("CHC1000"), 1000);
  assert.equal(parseContractIdSeq("LOC2342"), 2342);
  assert.equal(parseContractIdSeq("invalid"), null);
});

test("compareContractIds orders by numeric suffix not lexicographic", () => {
  assert.ok(compareContractIds("CHC1000", "CHC999") < 0);
  assert.ok(compareContractIds("CHC999", "CHC1000") > 0);
  assert.equal(compareContractIds("CHC1000", "CHC1000"), 0);
});

test("getContractIdConfigForTable returns per-table prefix and start", () => {
  const cfg = getContractIdConfigForTable("cynet_health_deal_sheet");
  assert.equal(cfg.prefix, "CHC");
  assert.equal(cfg.startValue, 1000);
  assert.equal(cfg.docId, "cynet_health_deal_sheet");

  const loc = getContractIdConfigForTable("cynet_locums_deal_sheet");
  assert.equal(loc.prefix, "LOC");
});

test("buildSequenceOptionsForTable includes docId and prefix", () => {
  const opts = buildSequenceOptionsForTable("cynet_health_canada_deal_sheet");
  assert.equal(opts.docId, "cynet_health_canada_deal_sheet");
  assert.equal(opts.prefix, "CAC");
  assert.equal(opts.startValue, 1000);
  assert.ok(typeof opts.collection === "string" && opts.collection.length > 0);
});
