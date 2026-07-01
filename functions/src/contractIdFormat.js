/**
 * Prefixed CONTRACT_ID formatting and validation (CHC/CAC/LOC + sequence).
 */

const config = require("./config");

const CONTRACT_ID_PATTERN = /^(CHC|CAC|LOC)(\d+)$/;

const DEFAULT_START_VALUE = parseInt(process.env.CONTRACT_ID_START_VALUE || "1000", 10);

/**
 * @param {unknown} tableId
 * @returns {{ prefix: string, startValue: number, docId: string }|null}
 */
function getContractIdConfigForTable(tableId) {
  const key = tableId == null ? "" : String(tableId).trim();
  if (!key) return null;
  const entry = config.contractIdByTable?.[key];
  if (!entry || typeof entry.prefix !== "string" || entry.prefix.trim() === "") {
    return null;
  }
  const startRaw = entry.startValue ?? DEFAULT_START_VALUE;
  const startValue = Number(startRaw);
  return {
    prefix: entry.prefix.trim().toUpperCase(),
    startValue: Number.isFinite(startValue) ? Math.trunc(startValue) : DEFAULT_START_VALUE,
    docId: key,
  };
}

/**
 * @param {string} prefix
 * @param {number} seq
 * @returns {string}
 */
function formatContractId(prefix, seq) {
  const p = String(prefix || "").trim().toUpperCase();
  const n = Number(seq);
  if (!p || !Number.isFinite(n)) return "";
  return `${p}${Math.trunc(n)}`;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeContractIdOrNull(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim().toUpperCase();
  if (!s) return null;
  return CONTRACT_ID_PATTERN.test(s) ? s : null;
}

/**
 * Parse numeric suffix from a prefixed contract id.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseContractIdSeq(value) {
  const normalized = normalizeContractIdOrNull(value);
  if (!normalized) return null;
  const match = normalized.match(CONTRACT_ID_PATTERN);
  if (!match) return null;
  const n = Number(match[2]);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Compare contract ids by numeric suffix (same prefix assumed in-batch).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} negative if a > b (for descending sort)
 */
function compareContractIds(a, b) {
  const seqA = parseContractIdSeq(a);
  const seqB = parseContractIdSeq(b);
  if (seqA != null && seqB != null && seqA !== seqB) {
    return seqB - seqA;
  }
  const sa = normalizeContractIdOrNull(a) ?? "";
  const sb = normalizeContractIdOrNull(b) ?? "";
  return sb.localeCompare(sa);
}

/**
 * Build Firestore sequence options for a BigQuery table id.
 * @param {unknown} tableId
 * @returns {object|null}
 */
function buildSequenceOptionsForTable(tableId) {
  const cfg = getContractIdConfigForTable(tableId);
  if (!cfg) return null;
  return {
    docId: cfg.docId,
    prefix: cfg.prefix,
    startValue: cfg.startValue,
    collection: config.contractIdSequence.collection,
  };
}

module.exports = {
  CONTRACT_ID_PATTERN,
  getContractIdConfigForTable,
  formatContractId,
  normalizeContractIdOrNull,
  parseContractIdSeq,
  compareContractIds,
  buildSequenceOptionsForTable,
};
