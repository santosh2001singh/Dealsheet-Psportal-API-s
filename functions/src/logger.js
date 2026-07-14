/**
 * Apps Script–style logging: UTC timestamps, TIMER_START/DONE/FAIL, single-line messages.
 */

function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * @param {string} message
 */
function logLine(message) {
  console.log(`[${utcTimestamp()}] ${message}`);
}

// Detail (per-placement / per-batch insert-pipeline) logging. High-level progress always uses
// logLine; the verbose sub-step summaries use logDetail so a caller processing rows ONE-AT-A-TIME
// (e.g. the update trigger's per-placement loop) can silence the hundreds of near-identical lines
// without touching the main progress logs. Batch callers (insert trigger) leave it on.
let pipelineDetailQuiet = false;
/** @param {boolean} quiet */
function setPipelineDetailQuiet(quiet) {
  pipelineDetailQuiet = quiet === true;
}
/** @param {string} message — suppressed while setPipelineDetailQuiet(true) is active. */
function logDetail(message) {
  if (pipelineDetailQuiet) return;
  console.log(`[${utcTimestamp()}] ${message}`);
}

/**
 * @param {string} message
 * @param {unknown} [err]
 */
function logError(message, err) {
  const suffix =
    err == null
      ? ""
      : typeof err === "string"
        ? ` ${err}`
        : err instanceof Error
          ? ` ${err.message}\n${err.stack || ""}`
          : ` ${String(err)}`;
  console.error(`[${utcTimestamp()}] ${message}${suffix}`);
}

function stringifyError(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return `${e.name}: ${e.message}\n${e.stack || ""}`.trim();
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${totalSec}s (${min}m ${sec}s)`;
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTimingAsync(label, fn) {
  const startMs = Date.now();
  logLine(`TIMER_START ${label}`);
  try {
    const result = await fn();
    const elapsedMs = Date.now() - startMs;
    logLine(`TIMER_DONE ${label} elapsed=${formatDuration(elapsedMs)}`);
    return result;
  } catch (e) {
    const elapsedMs = Date.now() - startMs;
    logLine(`TIMER_FAIL ${label} elapsed=${formatDuration(elapsedMs)} error=${stringifyError(e)}`);
    throw e;
  }
}

module.exports = {
  utcTimestamp,
  logLine,
  logDetail,
  setPipelineDetailQuiet,
  logError,
  stringifyError,
  formatDuration,
  withTimingAsync,
};
