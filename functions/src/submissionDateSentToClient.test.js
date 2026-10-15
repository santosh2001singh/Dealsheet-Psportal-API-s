const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveSubmissionDateFromSubmittalNotes,
  resolveSubmissionDateForPlacementRow,
  API_OWNED_COLUMNS,
} = require("./columnMappings");
const { applySubmissionDateFreeze, EXTENSION_PARENT_DEAL_INHERIT_COLUMNS } = require("./bigQueryClient");

const note = (code, created) => ({
  org_submittal_status: { code },
  created_date: created,
  modified_date: created,
});

// PLACEMENT_ID 1468833 (Oct 2026): submitted_date 20:33:37 is AWAITING_APPROVAL; the deal was sent
// to the client at 20:36:58. Notes arrive newest first, as the job-submittal-notes API returns them.
const NOTES_1468833 = [
  note("BOOKED", "2026-09-10T21:18:57Z"),
  note("OFFERED", "2026-09-10T21:17:20Z"),
  note("CLIENT_OFFERED", "2026-09-10T21:16:38Z"),
  note("SENT_TO_CLIENT", "2026-09-10T20:36:58Z"),
  note("APPROVED_BY_SALES_REP", "2026-09-10T20:36:54Z"),
  note("AWAITING_APPROVAL", "2026-09-10T20:36:50Z"),
];
const SUBMITTED_1468833 = "2026-09-10T20:33:37Z";

test("first SENT_TO_CLIENT note is the submission date", () => {
  assert.equal(resolveSubmissionDateFromSubmittalNotes(NOTES_1468833), "2026-09-10T20:36:58Z");
});

test("re-sent to client: the EARLIEST Sent to Client wins", () => {
  const notes = [note("SENT_TO_CLIENT", "2026-09-12T10:00:00Z"), ...NOTES_1468833];
  assert.equal(resolveSubmissionDateFromSubmittalNotes(notes), "2026-09-10T20:36:58Z");
});

test("SENT_TO_CLIENT uses created_date, not a later modified_date", () => {
  const edited = { ...note("SENT_TO_CLIENT", "2026-09-10T20:36:58Z"), modified_date: "2026-09-20T00:00:00Z" };
  assert.equal(resolveSubmissionDateFromSubmittalNotes([edited]), "2026-09-10T20:36:58Z");
});

test("DEAL -> first Sent to Client, not submitted_date", () => {
  assert.equal(resolveSubmissionDateForPlacementRow("DEAL", NOTES_1468833), "2026-09-10T20:36:58Z");
});

test("DEAL never sent to client (direct offer) -> null, submitted_date is NOT a fallback", () => {
  const notes = [note("OFFERED", "2026-09-10T21:17:20Z"), note("BOOKED", "2026-09-10T21:18:57Z")];
  assert.equal(resolveSubmissionDateForPlacementRow("DEAL", notes, SUBMITTED_1468833), null);
  assert.equal(resolveSubmissionDateForPlacementRow("DEAL", [], SUBMITTED_1468833), null);
});

test("EXTENSION -> null so the contract's DEAL date is inherited (even with its own notes)", () => {
  assert.equal(resolveSubmissionDateForPlacementRow("EXTENSION", NOTES_1468833), null);
  assert.equal(resolveSubmissionDateForPlacementRow("REBOOKED / EXTENSION", []), null);
});

test("freeze: stored SUBMISSION_DATE wins over the incoming value", () => {
  const baseline = { SUBMISSION_DATE: { value: "2026-09-10T20:36:58Z" } };
  const { row, frozen } = applySubmissionDateFreeze({ SUBMISSION_DATE: null, DEAL_TYPE: "EXTENSION" }, baseline);
  assert.equal(frozen, true);
  assert.deepEqual(row.SUBMISSION_DATE, baseline.SUBMISSION_DATE);

  const deal = applySubmissionDateFreeze({ SUBMISSION_DATE: "2026-09-11T00:00:00Z" }, baseline);
  assert.deepEqual(deal.row.SUBMISSION_DATE, baseline.SUBMISSION_DATE);
});

test("freeze: empty baseline keeps the incoming value", () => {
  const { row, frozen } = applySubmissionDateFreeze(
    { SUBMISSION_DATE: "2026-09-10T20:36:58Z" },
    { SUBMISSION_DATE: null }
  );
  assert.equal(frozen, false);
  assert.equal(row.SUBMISSION_DATE, "2026-09-10T20:36:58Z");
});

test("SUBMISSION_DATE is frozen, not API-owned, and inherited from the parent DEAL", () => {
  assert.equal(API_OWNED_COLUMNS.has("SUBMISSION_DATE"), false);
  assert.ok(EXTENSION_PARENT_DEAL_INHERIT_COLUMNS.includes("SUBMISSION_DATE"));
});
