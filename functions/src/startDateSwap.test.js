const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");
const {
  isStartDateSwapTable,
  readableTableSql,
  readableFqnSql,
  placementStartSqlExpr,
  toInternalStartRow,
  toStoredStartRow,
  toStoredStartRowsForTable,
  storedStartSetSqlForNewInitial,
} = require("./startDateSwap");

const HEALTH = "cynet_health_deal_sheet";
const RUNRATE = config.runrateTableId; // all_CH_data_runrate

/**
 * A row as the pipeline builds it (internal format): EXTENSION_START_DATE mirrors START_DATE on
 * DEAL_TYPE = 'EXTENSION' and is blank otherwise (applyExtensionStartDateForRow).
 */
function internal(row) {
  return {
    PLACEMENT_ID: 1,
    ...row,
    EXTENSION_START_DATE: row.DEAL_TYPE === "EXTENSION" ? row.START_DATE : null,
  };
}

const CASES = {
  extension: internal({ DEAL_TYPE: "EXTENSION", START_DATE: "2025-08-03", INITIAL_START_DATE: "2025-02-03" }),
  firstSegmentExtension: internal({ DEAL_TYPE: "EXTENSION", START_DATE: "2025-02-03", INITIAL_START_DATE: "2025-02-03" }),
  freshDeal: internal({ DEAL_TYPE: "DEAL", START_DATE: "2026-05-04", INITIAL_START_DATE: "2026-05-04" }),
  apr1RebookDeal: internal({ DEAL_TYPE: "DEAL", START_DATE: "2026-04-01", INITIAL_START_DATE: "2026-01-26" }),
  rebookedSlashExtension: internal({ DEAL_TYPE: "REBOOKED / EXTENSION", START_DATE: "2026-03-01", INITIAL_START_DATE: "2025-11-01" }),
  initialAfterStart: internal({ DEAL_TYPE: "EXTENSION", START_DATE: "2026-10-04", INITIAL_START_DATE: "2026-12-25" }),
  dealInitialAfterStart: internal({ DEAL_TYPE: "DEAL", START_DATE: "2026-08-17", INITIAL_START_DATE: "2026-08-18" }),
  noInitial: internal({ DEAL_TYPE: "EXTENSION", START_DATE: "2026-06-17", INITIAL_START_DATE: null }),
};

test("scope: only the Health deal sheet and Health run-rate are swap tables", () => {
  assert.equal(isStartDateSwapTable(HEALTH), true);
  assert.equal(isStartDateSwapTable(RUNRATE), true);
  for (const t of [
    "cynet_health_canada_deal_sheet",
    "cynet_locums_deal_sheet",
    "cynet_health_ended_deal_sheet",
    "all_Health_Canada_data_Runrate",
    "all_locums_runrate",
    "ownership_change_logs",
    "",
    null,
  ]) {
    assert.equal(isStartDateSwapTable(t), false, String(t));
  }
});

test("stored format: START_DATE = original start, EXTENSION_START_DATE = own start", () => {
  const s = (k) => toStoredStartRow(CASES[k]);
  assert.deepEqual(
    [s("extension").START_DATE, s("extension").EXTENSION_START_DATE],
    ["2025-02-03", "2025-08-03"]
  );
  assert.deepEqual(
    [s("firstSegmentExtension").START_DATE, s("firstSegmentExtension").EXTENSION_START_DATE],
    ["2025-02-03", "2025-02-03"]
  );
  // Fresh DEAL: no extension, so EXTENSION_START_DATE stays blank.
  assert.deepEqual([s("freshDeal").START_DATE, s("freshDeal").EXTENSION_START_DATE], ["2026-05-04", null]);
  // Re-booked DEAL (Apr-1): the re-book date is kept in EXTENSION_START_DATE.
  assert.deepEqual(
    [s("apr1RebookDeal").START_DATE, s("apr1RebookDeal").EXTENSION_START_DATE],
    ["2026-01-26", "2026-04-01"]
  );
  assert.deepEqual(
    [s("rebookedSlashExtension").START_DATE, s("rebookedSlashExtension").EXTENSION_START_DATE],
    ["2025-11-01", "2026-03-01"]
  );
});

test("stored format: a bad or missing INITIAL_START_DATE leaves START_DATE alone", () => {
  const ext = toStoredStartRow(CASES.initialAfterStart);
  assert.deepEqual([ext.START_DATE, ext.EXTENSION_START_DATE], ["2026-10-04", "2026-10-04"]);
  const deal = toStoredStartRow(CASES.dealInitialAfterStart);
  assert.deepEqual([deal.START_DATE, deal.EXTENSION_START_DATE], ["2026-08-17", null]);
  const none = toStoredStartRow(CASES.noInitial);
  assert.deepEqual([none.START_DATE, none.EXTENSION_START_DATE], ["2026-06-17", "2026-06-17"]);
});

test("INITIAL_START_DATE, EXTENSION_DATE and every other column pass through untouched", () => {
  const row = {
    ...CASES.extension,
    EXTENSION_DATE: "2025-07-20T10:00:00Z",
    CONTRACT_ID: "CHC1",
    END_DATE: "2025-11-01",
  };
  const stored = toStoredStartRow(row);
  for (const col of ["INITIAL_START_DATE", "EXTENSION_DATE", "CONTRACT_ID", "END_DATE", "DEAL_TYPE", "PLACEMENT_ID"]) {
    assert.equal(stored[col], row[col], col);
  }
});

test("round trip: what the pipeline wrote is exactly what it reads back (no fake versions)", () => {
  for (const [name, row] of Object.entries(CASES)) {
    const back = toInternalStartRow(toStoredStartRow(row));
    assert.deepEqual(back, row, name);
  }
});

test("read shim is a no-op on rows still in the old format", () => {
  for (const [name, row] of Object.entries(CASES)) {
    if (row.DEAL_TYPE === "REBOOKED / EXTENSION") continue; // pipeline leaves EXT blank there anyway
    assert.deepEqual(toInternalStartRow(row), row, name);
  }
});

test("read shim leaves data-team run-rate rows (no PLACEMENT_ID) exactly as stored", () => {
  const dataTeam = {
    PLACEMENT_ID: null,
    START_DATE: "2024-10-16",
    INITIAL_START_DATE: "2024-10-16",
    EXTENSION_START_DATE: "2025-01-12",
  };
  assert.deepEqual(toInternalStartRow(dataTeam), dataTeam);
});

test("BigQuery {value} wrappers are read like plain dates", () => {
  const row = {
    PLACEMENT_ID: 5,
    DEAL_TYPE: "EXTENSION",
    START_DATE: { value: "2025-08-03" },
    INITIAL_START_DATE: { value: "2025-02-03" },
    EXTENSION_START_DATE: { value: "2025-08-03" },
  };
  const stored = toStoredStartRow(row);
  assert.deepEqual(stored.INITIAL_START_DATE, { value: "2025-02-03" });
  assert.equal(stored.START_DATE, "2025-02-03");
  assert.equal(stored.EXTENSION_START_DATE, "2025-08-03");
});

test("batch conversion only for swap tables, and only while writes are enabled", () => {
  const rows = [CASES.extension];
  assert.equal(toStoredStartRowsForTable(rows, HEALTH)[0].START_DATE, "2025-02-03");
  assert.equal(toStoredStartRowsForTable(rows, RUNRATE)[0].START_DATE, "2025-02-03");
  for (const t of ["cynet_health_canada_deal_sheet", "cynet_locums_deal_sheet", "cynet_health_ended_deal_sheet", "ch_rate_change_logs"]) {
    assert.equal(toStoredStartRowsForTable(rows, t), rows, t);
  }
  const prev = config.startDateSwapWriteEnabled;
  try {
    config.startDateSwapWriteEnabled = false;
    assert.equal(toStoredStartRowsForTable(rows, HEALTH), rows);
  } finally {
    config.startDateSwapWriteEnabled = prev;
  }
});

test("rows without a START_DATE (log tables, partial rows) are returned as-is", () => {
  const logRow = { PLACEMENT_ID: 1, CONTRACT_ID: "CHC1", OLD_RATE: 10 };
  assert.equal(toStoredStartRow(logRow), logRow);
});

test("readableTableSql: shim subquery for swap tables, plain table for everything else", () => {
  assert.equal(readableTableSql("p", "d", "cynet_locums_deal_sheet"), "`p.d.cynet_locums_deal_sheet`");
  assert.equal(readableTableSql("p", "d", "cynet_health_ended_deal_sheet"), "`p.d.cynet_health_ended_deal_sheet`");
  const sql = readableTableSql("p", "d", HEALTH);
  assert.match(sql, /^\(SELECT \* REPLACE \(/);
  assert.match(sql, /FROM `p\.d\.cynet_health_deal_sheet`\)$/);
  assert.ok(sql.includes(`${placementStartSqlExpr()} AS START_DATE`));
  assert.ok(sql.includes("AS EXTENSION_START_DATE"));
  assert.equal(readableFqnSql("`p.d.cynet_health_deal_sheet`"), sql);
  assert.equal(readableFqnSql("`p.d.other`"), "`p.d.other`");
});

test("placement start SQL keeps data-team rows on their own START_DATE", () => {
  assert.equal(
    placementStartSqlExpr("r"),
    "IF(r.PLACEMENT_ID IS NULL, r.START_DATE, COALESCE(r.EXTENSION_START_DATE, r.START_DATE))"
  );
});

test("DML SET for a new original start keeps the own start in EXTENSION_START_DATE", () => {
  const parts = storedStartSetSqlForNewInitial("s.INITIAL_START_DATE", "d");
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^START_DATE = IF\(/);
  assert.match(parts[1], /^EXTENSION_START_DATE = IF\(/);
  assert.ok(parts.every((p) => p.includes("COALESCE(d.EXTENSION_START_DATE, d.START_DATE)")));
});

test("guard: SELECTs in bigQueryClient never read a deal sheet / run-rate table without the shim", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  // A raw `FROM \`${config.projectId}...\`` would hand the pipeline the stored START_DATE (the
  // original start) where it expects the placement's own start. Use readableTableSql() instead.
  // UPDATE / DELETE / MERGE targets and INFORMATION_SCHEMA are the only raw references allowed.
  const offenders = src
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /(FROM|JOIN)\s+\\`\$\{config\.projectId\}/.test(line))
    .filter(({ line }) => !/INFORMATION_SCHEMA/.test(line))
    .filter(({ line }) => !/DELETE FROM/.test(line))
    .filter(({ line }) => !/\$\{(source|target)\./.test(line)); // active->ended cleanup + ownership logs: id matching only
  assert.deepEqual(offenders.map((o) => `${o.n}: ${o.line.trim()}`), []);
});

test("log rows: START_DATE = original start, EXTENSION_START_DATE = own start", () => {
  const { storedStartFieldsForLog } = require("./startDateSwap");
  assert.deepEqual(storedStartFieldsForLog(CASES.extension), {
    START_DATE: "2025-02-03",
    EXTENSION_START_DATE: "2025-08-03",
  });
  assert.deepEqual(storedStartFieldsForLog(CASES.freshDeal), { START_DATE: "2026-05-04", EXTENSION_START_DATE: null });
  assert.deepEqual(storedStartFieldsForLog(CASES.apr1RebookDeal), {
    START_DATE: "2026-01-26",
    EXTENSION_START_DATE: "2026-04-01",
  });
  assert.deepEqual(storedStartFieldsForLog({}), { START_DATE: null, EXTENSION_START_DATE: null });
});

test("rate change log row takes the stored-format dates from its deal row", () => {
  const { buildRateChangeLogRow } = require("./syncService");
  const row = buildRateChangeLogRow({ ...CASES.extension, CONTRACT_ID: "CHC1" }, null);
  assert.equal(row.START_DATE, "2025-02-03");
  assert.equal(row.EXTENSION_START_DATE, "2025-08-03");
});

test("additional cost log rows take their dates from the FINAL deal row (INITIAL_START_DATE settled)", () => {
  const { applyLogStartDatesFromFinalRows } = require("./syncService");
  // Cut at enrich time: own start only, INITIAL_START_DATE not known yet.
  const logRows = [{ DEAL_SHEET_ID: 7, PLACEMENT_ID: 1, ADDITIONAL_COST_ID: 9, START_DATE: "2025-08-03" }];
  const finalRows = [{ ...CASES.extension, DEAL_SHEET_ID: 7, PLACEMENT_ID: 1 }];
  const [r] = applyLogStartDatesFromFinalRows(logRows, finalRows);
  assert.equal(r.START_DATE, "2025-02-03");
  assert.equal(r.EXTENSION_START_DATE, "2025-08-03");
  assert.equal(r.ADDITIONAL_COST_ID, 9);
});
