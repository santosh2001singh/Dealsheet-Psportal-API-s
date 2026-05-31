/**
 * Unit tests for additional-cost log append-on-change helpers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasAdditionalCostLogChange,
  additionalCostLogValueEquals,
  additionalCostLogStringEquals,
  ADDITIONAL_COST_LOG_VALUE_TOLERANCE,
} = require("./syncService");

test("ADDITIONAL_COST_LOG_VALUE_TOLERANCE is 0.01", () => {
  assert.equal(ADDITIONAL_COST_LOG_VALUE_TOLERANCE, 0.01);
});

test("additionalCostLogStringEquals treats null/undefined/empty/whitespace as equal", () => {
  assert.equal(additionalCostLogStringEquals(null, undefined), true);
  assert.equal(additionalCostLogStringEquals("", "   "), true);
  assert.equal(additionalCostLogStringEquals(null, ""), true);
});

test("additionalCostLogStringEquals trims before comparing", () => {
  assert.equal(additionalCostLogStringEquals("BONUS", " BONUS "), true);
  assert.equal(additionalCostLogStringEquals("BONUS", "bonus"), false);
});

test("additionalCostLogValueEquals: zero vs zero is equal", () => {
  assert.equal(additionalCostLogValueEquals(0, 0), true);
  assert.equal(additionalCostLogValueEquals("0.0", 0), true);
  assert.equal(additionalCostLogValueEquals(null, null), true);
});

test("additionalCostLogValueEquals: tolerates 0.01 noise", () => {
  assert.equal(additionalCostLogValueEquals(100.00, 100.005), true);
  assert.equal(additionalCostLogValueEquals(100.00, 100.01), true);
  assert.equal(additionalCostLogValueEquals(100.00, 100.02), false);
});

test("additionalCostLogValueEquals: null vs number is NOT equal", () => {
  assert.equal(additionalCostLogValueEquals(null, 0), false);
  assert.equal(additionalCostLogValueEquals(0, null), false);
});

test("additionalCostLogValueEquals: invalid strings become null", () => {
  assert.equal(additionalCostLogValueEquals("not a number", "also bad"), true);
  assert.equal(additionalCostLogValueEquals("not a number", 0), false);
});

test("hasAdditionalCostLogChange: identical rows -> no change", () => {
  const row = {
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "First check amount: 0\nLast check amount: 0",
  };
  assert.equal(hasAdditionalCostLogChange(row, { ...row }), false);
});

test("hasAdditionalCostLogChange: same row with whitespace differences -> no change", () => {
  const incoming = {
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 100,
    NOTES: "abc",
  };
  const existing = {
    ADDITIONAL_COST_NAME: " Travel Allowances ",
    CATEGORY: "BONUS  ",
    DURATION: "ONE_TIME",
    VALUE: "100.005",
    NOTES: "abc",
  };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), false);
});

test("hasAdditionalCostLogChange: VALUE differs beyond tolerance -> change", () => {
  const existing = {
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 100,
    NOTES: "x",
  };
  const incoming = { ...existing, VALUE: 500 };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), true);
});

test("hasAdditionalCostLogChange: CATEGORY differs -> change", () => {
  const existing = {
    ADDITIONAL_COST_NAME: "X",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "",
  };
  const incoming = { ...existing, CATEGORY: "FEE" };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), true);
});

test("hasAdditionalCostLogChange: DURATION differs -> change", () => {
  const existing = {
    ADDITIONAL_COST_NAME: "X",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "",
  };
  const incoming = { ...existing, DURATION: "WEEKLY" };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), true);
});

test("hasAdditionalCostLogChange: NOTES differ -> change", () => {
  const existing = {
    ADDITIONAL_COST_NAME: "X",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "First check amount: 0\nLast check amount: 0",
  };
  const incoming = { ...existing, NOTES: "First check amount: 50\nLast check amount: 0" };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), true);
});

test("hasAdditionalCostLogChange: ADDITIONAL_COST_NAME differs -> change", () => {
  const existing = {
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "",
  };
  const incoming = { ...existing, ADDITIONAL_COST_NAME: "Extension Bonus" };
  assert.equal(hasAdditionalCostLogChange(incoming, existing), true);
});

test("hasAdditionalCostLogChange: missing existing -> change (treat as first insert)", () => {
  const incoming = {
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "",
  };
  assert.equal(hasAdditionalCostLogChange(incoming, null), true);
  assert.equal(hasAdditionalCostLogChange(incoming, undefined), true);
});

test("hasAdditionalCostLogChange: Shareka Deas zero-travel snapshot is treated as no-change", () => {
  // Mirrors the production duplicate seen in BigQuery (DEAL_SHEET_ID=1354781).
  const snapshot = {
    ADDITIONAL_COST_ID: 521873,
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: 0,
    NOTES: "First check amount: 0\nLast check amount: 0",
  };
  const previous = {
    ADDITIONAL_COST_ID: 521873,
    ADDITIONAL_COST_NAME: "Travel Allowances",
    CATEGORY: "BONUS",
    DURATION: "ONE_TIME",
    VALUE: "0.0",
    NOTES: "First check amount: 0\nLast check amount: 0",
  };
  assert.equal(hasAdditionalCostLogChange(snapshot, previous), false);
});
