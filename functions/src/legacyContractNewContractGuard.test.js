const test = require("node:test");
const assert = require("node:assert/strict");

const {
  legacyWindowCoversAnyOwnDate,
  buildLegacyContractLookupKey,
} = require("./bigQueryClient");

/**
 * New-contract guard for the tier-1 legacy CONTRACT_ID lookup.
 *
 * The lookup key is identity-only (candidate + client) and the probe dates of every row sharing
 * that identity are pooled before the window join, so a row can win a window it does not itself
 * touch. On a DEAL row that relabels a genuinely new booking as an old contract and drags the old
 * contract's manual/ops columns along with it (COMMENTS, ST_DT_PUSHBACK_REASON, ...).
 *
 * Rule: candidate + none of the row's OWN dates inside the matched window + DEAL_TYPE=DEAL
 *       -> new contract, drop the match.
 */

/** Matched run-rate row, as the tier-1 SQL hands it to the result loop. */
function hit(windowStart, windowEnd) {
  return {
    CONTRACT_ID: "CHC19805",
    SKU_NUMBER: "H13674",
    __WINDOW_START_DATE: windowStart,
    __WINDOW_END_DATE: windowEnd,
  };
}

test("Juan M Silva: fresh DEAL after the contract closed is NOT covered by its window", () => {
  // DEAL_SHEET_ID 5255548 / PLACEMENT_ID 1464679, start 2026-10-12, tentative end 2027-01-09.
  // CHC19805's run-rate window is 2026-06-07..2026-09-05 — five weeks earlier. The dates that won
  // that window (2026-06-07 / 2026-09-05) belong to placement 1455761, a different segment.
  const spanKey = {
    startDate: "2026-10-12",
    endDate: "",
    tentativeEndDate: "2027-01-09",
  };
  assert.equal(legacyWindowCoversAnyOwnDate(spanKey, hit("2026-06-07", "2026-09-05")), false);
});

test("a row whose START_DATE sits inside the window keeps its match", () => {
  const spanKey = { startDate: "2026-06-07", endDate: "", tentativeEndDate: "2026-09-05" };
  assert.equal(legacyWindowCoversAnyOwnDate(spanKey, hit("2026-06-07", "2026-09-05")), true);
});

test("only TENTATIVE_END_DATE inside the window is enough (BOOKED row has no END_DATE)", () => {
  // The shifted-re-issue case the pooling was written for: START_DATE falls before the window,
  // TENTATIVE_END_DATE lands inside it. Must still match.
  const spanKey = { startDate: "2026-03-15", endDate: "", tentativeEndDate: "2026-06-27" };
  assert.equal(legacyWindowCoversAnyOwnDate(spanKey, hit("2026-03-28", "2026-12-12")), true);
});

test("only END_DATE inside the window is enough", () => {
  const spanKey = { startDate: "2026-03-15", endDate: "2026-03-31", tentativeEndDate: "" };
  assert.equal(legacyWindowCoversAnyOwnDate(spanKey, hit("2026-03-28", "2026-12-12")), true);
});

test("window boundaries are inclusive, matching the SQL BETWEEN", () => {
  assert.equal(
    legacyWindowCoversAnyOwnDate({ startDate: "2026-06-07" }, hit("2026-06-07", "2026-09-05")),
    true
  );
  assert.equal(
    legacyWindowCoversAnyOwnDate({ startDate: "2026-09-05" }, hit("2026-06-07", "2026-09-05")),
    true
  );
  assert.equal(
    legacyWindowCoversAnyOwnDate({ startDate: "2026-09-06" }, hit("2026-06-07", "2026-09-05")),
    false
  );
});

test("absent data is never treated as evidence of a new contract", () => {
  // No window on the match (canada run-rate rows matched on SKU alone) -> do not reject.
  assert.equal(
    legacyWindowCoversAnyOwnDate({ startDate: "2026-10-12" }, { __WINDOW_START_DATE: null, __WINDOW_END_DATE: null }),
    true
  );
  // Row contributed no date at all -> nothing to judge -> do not reject.
  assert.equal(
    legacyWindowCoversAnyOwnDate({ startDate: "", endDate: "", tentativeEndDate: "" }, hit("2026-06-07", "2026-09-05")),
    true
  );
  // Missing hit entirely.
  assert.equal(legacyWindowCoversAnyOwnDate({ startDate: "2026-10-12" }, undefined), true);
});

test("isDealRow gates the guard: DEAL yes, EXTENSION no", () => {
  const base = {
    DEAL_SHEET_ID: 5255548,
    PLACEMENT_ID: 1464679,
    CANDIDATE_ID: 7976807,
    CANDIDATE_EMAIL: "js4346599@gmail.com",
    INTERNAL_JOB_ID: 35519780,
    START_DATE: "2026-10-12",
    TENTATIVE_END_DATE: "2027-01-09",
    FACILITY_NAME: "Parkview Regional Medical Center",
    PARENT_CLIENT_NAME: "Parkview Health",
    CLIENT_ID: 974401,
    NEXUS_PARENT_CLIENT_ID: 2286383,
  };

  assert.equal(buildLegacyContractLookupKey({ ...base, DEAL_TYPE: "DEAL" }).isDealRow, true);
  assert.equal(buildLegacyContractLookupKey({ ...base, DEAL_TYPE: "deal" }).isDealRow, true);
  assert.equal(buildLegacyContractLookupKey({ ...base, DEAL_TYPE: " DEAL " }).isDealRow, true);
  // An EXTENSION legitimately starts after its contract's window closes — never guarded.
  assert.equal(buildLegacyContractLookupKey({ ...base, DEAL_TYPE: "EXTENSION" }).isDealRow, false);
  assert.equal(buildLegacyContractLookupKey({ ...base, DEAL_TYPE: null }).isDealRow, false);
});

test("the guard's span dates come off the row the key was built from", () => {
  const key = buildLegacyContractLookupKey({
    DEAL_TYPE: "DEAL",
    DEAL_SHEET_ID: 5255548,
    CANDIDATE_ID: 7976807,
    CANDIDATE_EMAIL: "js4346599@gmail.com",
    START_DATE: "2026-10-12",
    TENTATIVE_END_DATE: "2027-01-09",
    FACILITY_NAME: "Parkview Regional Medical Center",
    PARENT_CLIENT_NAME: "Parkview Health",
    CLIENT_ID: 974401,
    NEXUS_PARENT_CLIENT_ID: 2286383,
  });
  assert.equal(key.spanKey.startDate, "2026-10-12");
  assert.equal(key.spanKey.tentativeEndDate, "2027-01-09");
  // End to end: this row against CHC19805's window is a new contract.
  assert.equal(legacyWindowCoversAnyOwnDate(key.spanKey, hit("2026-06-07", "2026-09-05")), false);
});
