const test = require("node:test");
const assert = require("node:assert/strict");

const { mapCandidateToBq, MANUAL_COLUMNS, API_OWNED_COLUMNS } = require("./columnMappings");

// SECONDARY_CELL_PHN replaced the manual SECONDARY_EMAIL column in Aug 2026. It is the candidate's
// secondary cell number, which Nexus exposes as candidate_contact_info[].leap_phone.

const candidate = {
  first_name: "Monyette",
  middle_name: "",
  last_name: "Fitzgerald",
  email: null,
  phone: null,
  org_candidate_status: { code: "ACTIVE" },
  candidate_contact_info: [
    {
      primary_phone: "CELL_PHONE",
      cell_phone: "(443) 953-8206",
      home_phone: null,
      work_phone: null,
      leap_phone: "(443) 953-8206",
      additional_phone: null,
      primary_email: "Monymf30@gmail.com",
      secondary_email: null,
      leap_email: "Monymf30@gmail.com",
    },
  ],
};

test("mapCandidateToBq fills SECONDARY_CELL_PHN from leap_phone", () => {
  const out = mapCandidateToBq(candidate);
  assert.equal(out.SECONDARY_CELL_PHN, "(443) 953-8206");
  assert.equal(out.CELL_PHONE, "(443) 953-8206");
  assert.equal(out.CANDIDATE_EMAIL, "Monymf30@gmail.com");
});

test("SECONDARY_CELL_PHN is kept even when it duplicates CELL_PHONE", () => {
  // leap_phone is frequently the same number as cell_phone; no dedupe is applied.
  const out = mapCandidateToBq(candidate);
  assert.equal(out.SECONDARY_CELL_PHN, out.CELL_PHONE);
});

test("SECONDARY_CELL_PHN differs from CELL_PHONE when leap_phone is a distinct number", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [
      { primary_phone: "CELL_PHONE", cell_phone: "(111) 111-1111", leap_phone: "(222) 222-2222" },
    ],
  });
  assert.equal(out.CELL_PHONE, "(111) 111-1111");
  assert.equal(out.SECONDARY_CELL_PHN, "(222) 222-2222");
});

test("SECONDARY_CELL_PHN is null when leap_phone is missing, blank, or there is no contact row", () => {
  assert.equal(
    mapCandidateToBq({ ...candidate, candidate_contact_info: [{ cell_phone: "(111) 111-1111" }] })
      .SECONDARY_CELL_PHN,
    null
  );
  assert.equal(
    mapCandidateToBq({ ...candidate, candidate_contact_info: [{ leap_phone: "   " }] })
      .SECONDARY_CELL_PHN,
    null
  );
  assert.equal(mapCandidateToBq({ ...candidate, candidate_contact_info: [] }).SECONDARY_CELL_PHN, null);
  assert.equal(mapCandidateToBq({ ...candidate, candidate_contact_info: null }).SECONDARY_CELL_PHN, null);
  assert.equal(mapCandidateToBq(null).SECONDARY_CELL_PHN, null);
});

test("SECONDARY_CELL_PHN falls through to the first contact row that has a leap_phone", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [{ leap_phone: null }, { leap_phone: "(333) 333-3333" }],
  });
  assert.equal(out.SECONDARY_CELL_PHN, "(333) 333-3333");
});

test("SECONDARY_CELL_PHN is API-owned, and the retired SECONDARY_EMAIL is gone", () => {
  assert.ok(API_OWNED_COLUMNS.has("SECONDARY_CELL_PHN"));
  assert.ok(!MANUAL_COLUMNS.has("SECONDARY_CELL_PHN"));
  assert.ok(!MANUAL_COLUMNS.has("SECONDARY_EMAIL"));
  assert.ok(!API_OWNED_COLUMNS.has("SECONDARY_EMAIL"));
});
