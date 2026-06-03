const { logLine } = require("./logger");
const { startDateOnOrAfterUtcMin } = require("./columnMappings");

/** Offer-rejected (`dealSheetSyncOfferRejected`) only: ended rows must have TENTATIVE_DATE on or after this day (UTC). */
const OFFER_REJECTED_MIN_TENTATIVE_DATE_MS = Date.UTC(2026, 4, 1); // 2026-05-01 UTC

/** Placement statuses allowed into BigQuery for `dealSheetSyncOfferRejected` (before TENTATIVE_DATE filter). */
function filterOfferRejectedEndedPlacementStatuses(rows) {
  return rows.filter((row) => {
    const status = String(row?.PLACEMENT_STATUS || "").trim().toUpperCase();
    return (
      status === "DID NOT START" ||
      status === "ENDED" ||
      status === "ENDED<30" ||
      status === "DID NOT ACCEPT"
    );
  });
}

function filterOfferRejectedRowsByMinTentativeDate(rows) {
  return rows.filter((row) =>
    startDateOnOrAfterUtcMin(row?.TENTATIVE_DATE, OFFER_REJECTED_MIN_TENTATIVE_DATE_MS)
  );
}

/** Logs per-batch transform stages for `dealSheetSyncOfferRejected` (filter in Cloud Logging: `[offer-rejected-transform]`). */
function transformOfferRejectedEndedRowsForBigQuery(rows) {
  const n = rows?.length ?? 0;
  logLine(`[offer-rejected-transform] enriched_in=${n}`);
  const afterStatus = filterOfferRejectedEndedPlacementStatuses(rows);
  logLine(
    `[offer-rejected-transform] after_placement_status_filter=${afterStatus.length} (allowed=DID NOT START,ENDED,ENDED<30,DID NOT ACCEPT)`
  );
  const afterDate = filterOfferRejectedRowsByMinTentativeDate(afterStatus);
  logLine(
    `[offer-rejected-transform] after_tentative_date_filter=${afterDate.length} (TENTATIVE_DATE>=2026-05-01 UTC)`
  );
  return afterDate;
}

module.exports = {
  OFFER_REJECTED_MIN_TENTATIVE_DATE_MS,
  filterOfferRejectedEndedPlacementStatuses,
  filterOfferRejectedRowsByMinTentativeDate,
  transformOfferRejectedEndedRowsForBigQuery,
};
