/**
 * Submittal billing overtime label (OVERTIME column) from /api/billing-overtimes/{id}/.
 *
 * The lookup list is tiny and static (13 rows: "After 8 Hours", "After 40 Hours", "Never", ...), so
 * each id is fetched once per process and kept. Only a submittal that carries an overtime id is
 * looked up; a null id never hits the API.
 *
 * The label is informational only: the formula switch reads OVERTIME_ID, so a failed lookup leaves
 * OVERTIME null (and is retried on the next call) instead of skipping the row.
 */

const config = require("./config");
const { logLine } = require("./logger");
const { nexusGetJsonWithRetry } = require("./nexusClient");
const { normalizeOvertimeId } = require("./w2PayRateNew");

/** id -> Promise<string|null> */
const labelById = new Map();

/**
 * @param {*} overtimeId submittal `overtime`
 * @param {string} accessToken
 * @returns {Promise<string|null>}
 */
async function getBillingOvertimeLabel(overtimeId, accessToken) {
  const id = normalizeOvertimeId(overtimeId);
  if (id == null) return null;
  if (!labelById.has(id)) {
    const url = `${config.nexus.baseUrl}/api/billing-overtimes/${id}/`;
    const pending = nexusGetJsonWithRetry(url, accessToken)
      .then((json) => {
        const value = json?.value == null ? "" : String(json.value).trim();
        return value === "" ? null : value;
      })
      .catch((err) => {
        labelById.delete(id);
        logLine(`[billing overtime] lookup failed id=${id}: ${String(err?.message || err).slice(0, 180)}`);
        return null;
      });
    labelById.set(id, pending);
  }
  return labelById.get(id);
}

module.exports = { getBillingOvertimeLabel };
