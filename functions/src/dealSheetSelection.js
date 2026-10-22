/**
 * One deal sheet per placement.
 *
 * Nexus can hold several deal sheets for the same job + candidate (= the same submittal / PLACEMENT_ID).
 * Placement 1465579 (Amy Freeman, job 35523230) has 5253880 (PRIMARY, FINAL) and 5253886 (SECONDARY,
 * VERBAL, parent_deal_sheet 5253880), created six minutes apart on 2026-08-05. Both arrived in the same
 * insert batch — the reject-existing check only sees rows already in BigQuery — so both were inserted,
 * and the update trigger then refreshed each DEAL_SHEET_ID separately, appending rows for both forever.
 *
 * The deal sheet that represents a placement is chosen with three checks, in order:
 *   1. type PRIMARY (Nexus /api/deal-sheet-candidates/ `type`; SECONDARY sheets hang off a parent)
 *   2. deal sheet status FINAL
 *   3. newest created_date
 * Ties after that fall to the higher deal sheet id, so the pick is deterministic.
 *
 * The PRIMARY check has to come first: on placement 1448637 both sheets are VERBAL and the PRIMARY one
 * (5171341) is the OLDER one, so status + created date alone would pick the SECONDARY.
 */

const { normalizeNexusResourceId } = require("./nexusClient");

function normalizeKey(value) {
  return String(value ?? "").trim().toUpperCase();
}

/** Same semantics as syncService's dealSheetCandidateEffectiveStatusKey: the code wins over the label. */
function dealSheetCandidateStatusKey(row) {
  return normalizeKey(row?.deal_sheet_status_code ?? row?.deal_sheet_status ?? "");
}

function createdDateMs(row) {
  const ms = Date.parse(String(row?.created_date ?? ""));
  return Number.isFinite(ms) ? ms : -Infinity;
}

function dealSheetIdNumber(row) {
  const n = Number(normalizeNexusResourceId(row?.deal_sheet));
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Sort comparator for deal-sheet-candidate rows: negative when `a` is the better pick.
 * @param {Record<string, *>} a
 * @param {Record<string, *>} b
 */
function compareDealSheetCandidatePriority(a, b) {
  const aPrimary = normalizeKey(a?.type) === "PRIMARY" ? 1 : 0;
  const bPrimary = normalizeKey(b?.type) === "PRIMARY" ? 1 : 0;
  if (aPrimary !== bPrimary) return bPrimary - aPrimary;

  const aFinal = dealSheetCandidateStatusKey(a) === "FINAL" ? 1 : 0;
  const bFinal = dealSheetCandidateStatusKey(b) === "FINAL" ? 1 : 0;
  if (aFinal !== bFinal) return bFinal - aFinal;

  const aCreated = createdDateMs(a);
  const bCreated = createdDateMs(b);
  if (aCreated !== bCreated) return bCreated > aCreated ? 1 : -1;

  const aId = dealSheetIdNumber(a);
  const bId = dealSheetIdNumber(b);
  if (aId !== bId) return bId > aId ? 1 : -1;
  return 0;
}

/**
 * @param {Array<Record<string, *>>} rows - deal-sheet-candidate rows competing for one placement
 * @returns {Record<string, *>|null}
 */
function pickPreferredDealSheetCandidate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort(compareDealSheetCandidatePriority)[0];
}

/**
 * Keep one deal-sheet-candidate row per job + candidate. Rows without a job, candidate or deal sheet
 * are passed through untouched. Input order is preserved for the kept rows.
 *
 * @param {Array<Record<string, *>>} rows
 * @returns {{ kept: Array<Record<string, *>>, dropped: Array<{ row: Record<string, *>, winner: Record<string, *> }> }}
 */
function selectOneDealSheetPerJobCandidate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const row of list) {
    const jobK = normalizeNexusResourceId(row?.job);
    const candK = normalizeNexusResourceId(row?.candidate);
    const dsK = normalizeNexusResourceId(row?.deal_sheet);
    if (!jobK || !candK || !dsK) continue;
    const key = `${jobK}:${candK}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const winnerByKey = new Map();
  for (const [key, groupRows] of groups) {
    winnerByKey.set(key, pickPreferredDealSheetCandidate(groupRows));
  }

  const kept = [];
  const dropped = [];
  for (const row of list) {
    const jobK = normalizeNexusResourceId(row?.job);
    const candK = normalizeNexusResourceId(row?.candidate);
    const dsK = normalizeNexusResourceId(row?.deal_sheet);
    if (!jobK || !candK || !dsK) {
      kept.push(row);
      continue;
    }
    const winner = winnerByKey.get(`${jobK}:${candK}`);
    if (winner === row) kept.push(row);
    else dropped.push({ row, winner });
  }
  return { kept, dropped };
}

/**
 * Update-trigger check: among the deal sheets BigQuery already stores for one placement, is
 * `dealSheetId` the one to keep refreshing?
 *
 * Only the stored deal sheets compete — the update path refreshes rows that exist, it never switches a
 * placement onto a deal sheet BigQuery has not seen. A stored deal sheet Nexus no longer lists for this
 * job + candidate cannot win while another stored one is still listed.
 *
 * @param {object} args
 * @param {Array<Record<string, *>>} args.candidateRows - /api/deal-sheet-candidates/ rows for the job
 * @param {unknown} args.candidateId
 * @param {unknown} args.dealSheetId - the deal sheet this refresh was asked for
 * @param {Iterable<unknown>} args.storedDealSheetIds - every DEAL_SHEET_ID stored for the placement
 * @returns {{ selected: boolean, winnerDealSheetId: string|null }}
 */
function resolveStoredDealSheetSelection({ candidateRows, candidateId, dealSheetId, storedDealSheetIds }) {
  const target = normalizeNexusResourceId(dealSheetId);
  const cand = normalizeNexusResourceId(candidateId);
  const stored = new Set();
  for (const id of storedDealSheetIds || []) {
    const k = normalizeNexusResourceId(id);
    if (k) stored.add(String(k));
  }
  if (!target || !cand || stored.size < 2) return { selected: true, winnerDealSheetId: null };

  const competing = (Array.isArray(candidateRows) ? candidateRows : []).filter((row) => {
    const ds = normalizeNexusResourceId(row?.deal_sheet);
    return normalizeNexusResourceId(row?.candidate) === cand && ds != null && stored.has(String(ds));
  });
  const winner = pickPreferredDealSheetCandidate(competing);
  const winnerDealSheetId = winner ? String(normalizeNexusResourceId(winner.deal_sheet)) : null;
  if (!winnerDealSheetId) return { selected: true, winnerDealSheetId: null };
  return { selected: winnerDealSheetId === String(target), winnerDealSheetId };
}

module.exports = {
  compareDealSheetCandidatePriority,
  pickPreferredDealSheetCandidate,
  selectOneDealSheetPerJobCandidate,
  resolveStoredDealSheetSelection,
};
