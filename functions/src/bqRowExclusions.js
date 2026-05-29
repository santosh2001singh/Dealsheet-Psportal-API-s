/**
 * Exclude training / dummy / internal test rows from BigQuery inserts.
 * Mirrors legacy SQL filters on deal_sheet / head_count style joins.
 */

function normLower(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

function includesI(haystack, needleLower) {
  return normLower(haystack).includes(needleLower);
}

/**
 * @returns {boolean} true if this row must NOT be inserted into BigQuery
 */
function shouldExcludeRowFromBigQuery(row) {
  if (!row || typeof row !== "object") return false;

  if (includesI(row.ASSIGNMENT_RECRUITER_EMAIL, "csrecruiter@cynethealth.com")) return true;
  if (includesI(row.ASSIGNMENT_RECRUITER, "cs recruiter")) return true;
  if (includesI(row.ASSIGNMENT_RECRUITER, "cynet training")) return true;

  const salesRep = row.CLIENT_SALES_REP;
  if (salesRep != null && String(salesRep).trim() !== "" && includesI(salesRep, "karandeep")) {
    return true;
  }

  if (includesI(row.CANDIDATE_NAME, "dummy 4 dummy")) return true;

  const cn = normLower(row.CANDIDATE_NAME);
  if (cn) {
    const substrings = ["test", "gurdeep", "dummy", "karan", "vishal", "abhishek",];
    for (const sub of substrings) {
      if (cn.includes(sub)) return true;
    }
  }

  return false;
}

module.exports = {
  shouldExcludeRowFromBigQuery,
};
