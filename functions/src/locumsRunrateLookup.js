/**
 * Cynet Locums run-rate lookup — its own two tiers, deliberately separate from the shared one.
 *
 * The shared lookup (fetchLegacyContractIdentityForDealRows in bigQueryClient.js) keys on
 * candidate + facility + parent client + a date-window overlap, falling back to
 * CANDIDATE_ID + INTERNAL_JOB_ID. Neither fits Locums:
 *
 *   * all_locums_runrate carries NO client ids at all — CLIENT_ID and NEXUS_PARENT_CLIENT_ID are
 *     null on all 913 rows — so the id half of the shared span key can never form.
 *   * Its facility names are written differently on the two sides ("HCA Florida Gulf Coast Hospital
 *     - HP" against "Gulf Coast Regional Medical Center"), so the name half misses too.
 *
 * Measured on live data (446 distinct deals / 913 run-rate rows), the two tiers below are what
 * actually match:
 *
 *   Tier 1  candidate (CANDIDATE_ID or CANDIDATE_EMAIL) + START_DATE      378 deals
 *   Tier 2  candidate (CANDIDATE_ID or CANDIDATE_EMAIL) + VMS_JOB_ID      +31 deals
 *   ───────────────────────────────────────────────────────────────────────────────
 *                                                                         409 / 446  (91.7%)
 *
 * Tier 2 exists because the locums desk books one candidate onto several short assignments at once,
 * so a START_DATE that slipped a few days leaves the row unmatched even though the JOB is the same.
 *
 * The candidate half is mandatory in BOTH tiers. VMS_JOB_ID identifies the job POSTING, not the
 * placement: matching on it alone put 32 of 50 hits on a different candidate (Allen Nau's deal
 * landing on Rani Kumar's run-rate row). Either identifier satisfies it — some rows carry only one.
 *
 * Rows that match neither tier are left exactly as Nexus supplied them; nothing is carried, and no
 * column is blanked.
 */

/**
 * A VMS_JOB_ID as a match-key string, or "" when absent.
 *
 * The run-rate side prefixes some ids with the MSP — "AHSA/65803", "ASHA/64314",
 * "HealthTrust/ 968157" (note the space) — while the deal sheet carries the bare id. Everything up
 * to and including the first "/" is dropped so the two sides compare equal; an id with no "/" is
 * left alone. Upper-cased because some are alphanumeric ("A-LOHMC-260827-88516").
 */
function normalizeVmsJobIdKeyPart(value) {
  if (value == null) return "";
  return String(value).replace(/^[^/]*\/\s*/, "").trim().toUpperCase();
}

/** START_DATE as YYYY-MM-DD, or "" when absent or unparseable. */
function normalizeDateKeyPart(value) {
  const s = value == null ? "" : String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** CANDIDATE_ID as a match-key string, or "" when absent. */
function normalizeCandidateIdKeyPart(value) {
  if (value == null) return "";
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n !== 0 ? String(Math.trunc(n)) : "";
}

/**
 * Lookup key for one Locums deal row.
 *
 * @param {Record<string, *>|null|undefined} row
 * @returns {{rowKey: string, dateKey: string|null, vmsKey: string|null,
 *            candidateId: string, email: string, startDate: string, vmsJobId: string}|null}
 */
function buildLocumsContractLookupKey(row) {
  if (!row || typeof row !== "object") return null;

  const candidateId = normalizeCandidateIdKeyPart(row.CANDIDATE_ID);
  const email = row.CANDIDATE_EMAIL == null ? "" : String(row.CANDIDATE_EMAIL).trim().toLowerCase();
  // Either identifier satisfies the candidate half; without both there is nothing safe to match on.
  if (candidateId === "" && email === "") return null;

  const startDate = normalizeDateKeyPart(row.START_DATE);
  const vmsJobId = normalizeVmsJobIdKeyPart(row.VMS_JOB_ID);

  const dateKey = startDate !== "" ? `${candidateId}|${email}|${startDate}` : null;
  const vmsKey = vmsJobId !== "" ? `${candidateId}|${email}|${vmsJobId}` : null;
  if (!dateKey && !vmsKey) return null;

  const rowKey =
    row.DEAL_SHEET_ID != null && String(row.DEAL_SHEET_ID).trim() !== ""
      ? `ds:${String(row.DEAL_SHEET_ID).trim()}`
      : row.PLACEMENT_ID != null && String(row.PLACEMENT_ID).trim() !== ""
        ? `pl:${String(row.PLACEMENT_ID).trim()}`
        : `k:${dateKey ?? vmsKey}`;

  return { rowKey, dateKey, vmsKey, candidateId, email, startDate, vmsJobId };
}

module.exports = {
  buildLocumsContractLookupKey,
  normalizeVmsJobIdKeyPart,
};
