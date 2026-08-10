#!/usr/bin/env node
/**
 * Reset the Firestore-backed CONTRACT_ID sequences to their configured startValue.
 *
 * WHY THIS EXISTS: allocateContractIds only falls back to config's `startValue` when the sequence
 * doc does NOT exist. Once a doc is there, its stored `nextValue` always wins — so changing
 * config.contractIdByTable alone does nothing to a live sequence. After a data reset, run this so
 * cynet health actually starts at CHC23000 instead of continuing the pre-reset CHC1000 range.
 *
 * Docs live at workspaces/run-rate-tool/contractIdSequences/{table_id}.
 *
 * Usage (from functions/):
 *   node scripts/resetContractIdSequences.js --dry-run              # show current vs target
 *   node scripts/resetContractIdSequences.js --table cynet_health_deal_sheet
 *   node scripts/resetContractIdSequences.js --all
 *   node scripts/resetContractIdSequences.js --all --value 23000    # explicit override
 *
 * Requires the same credentials the functions use (GOOGLE_APPLICATION_CREDENTIALS or an
 * authenticated gcloud ADC session with access to the project's Firestore).
 */

const admin = require("firebase-admin");
const config = require("../src/config");
const { getContractIdSequenceRef } = require("../src/firestoreWorkspace");

function parseArgs(argv) {
  const out = { tables: [], dryRun: false, all: false, value: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--table") out.tables.push(String(argv[++i] || "").trim());
    else if (arg === "--value") out.value = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      out.help = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const configured = Object.keys(config.contractIdByTable || {});

  if (args.help || (!args.all && args.tables.length === 0)) {
    console.log("Reset CONTRACT_ID sequences.\n");
    console.log("  --all                 every configured table");
    console.log("  --table <table_id>    one table (repeatable)");
    console.log("  --value <n>           override the configured startValue");
    console.log("  --dry-run             report only, write nothing\n");
    console.log(`Configured tables: ${configured.join(", ")}`);
    process.exitCode = args.help ? 0 : 1;
    return;
  }

  const targets = args.all ? configured : args.tables;
  const unknown = targets.filter((t) => !configured.includes(t));
  if (unknown.length > 0) {
    console.error(`Not a configured deal sheet table: ${unknown.join(", ")}`);
    console.error(`Configured tables: ${configured.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!admin.apps.length) admin.initializeApp();

  if (args.value != null && !Number.isFinite(args.value)) {
    console.error("--value must be a number");
    process.exitCode = 1;
    return;
  }

  console.log(
    `project=${config.projectId} workspace=${config.firestoreWorkspace?.docId || "run-rate-tool"} collection=${config.contractIdSequence.collection}`
  );
  console.log(args.dryRun ? "MODE: dry run (no writes)\n" : "MODE: WRITE\n");

  for (const tableId of targets) {
    const cfg = config.contractIdByTable[tableId];
    const target = args.value != null ? Math.trunc(args.value) : cfg.startValue;
    const ref = getContractIdSequenceRef(tableId);
    const snap = await ref.get();
    const current = snap.exists ? snap.data()?.nextValue : null;

    const currentLabel =
      current == null ? "(no doc — next allocation would already use startValue)" : `${cfg.prefix}${current}`;
    console.log(`${tableId}`);
    console.log(`  current nextValue: ${current ?? "none"}   ${currentLabel}`);
    console.log(`  target  nextValue: ${target}   ${cfg.prefix}${target}`);

    if (args.dryRun) {
      console.log("  -> skipped (dry run)\n");
      continue;
    }

    await ref.set(
      { nextValue: target, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    console.log(`  -> written; next allocation is ${cfg.prefix}${target}\n`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
