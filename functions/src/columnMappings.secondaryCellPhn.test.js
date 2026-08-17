const test = require("node:test");
const assert = require("node:assert/strict");

const { mapCandidateToBq, MANUAL_COLUMNS, API_OWNED_COLUMNS } = require("./columnMappings");

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

test("mapCandidateToBq fills SECONDARY_EMAIL from leap_email when secondary_email is null", () => {
  const out = mapCandidateToBq(candidate);
  assert.equal(out.SECONDARY_EMAIL, "Monymf30@gmail.com");
});

test("SECONDARY_EMAIL prefers secondary_email over leap_email", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [
      {
        primary_email: "primary@example.com",
        secondary_email: "secondary@example.com",
        leap_email: "leap@example.com",
      },
    ],
  });
  assert.equal(out.CANDIDATE_EMAIL, "primary@example.com");
  assert.equal(out.SECONDARY_EMAIL, "secondary@example.com");
});

test("SECONDARY_EMAIL is null when secondary_email and leap_email are both missing", () => {
  assert.equal(
    mapCandidateToBq({
      ...candidate,
      candidate_contact_info: [{ primary_email: "only@example.com" }],
    }).SECONDARY_EMAIL,
    null
  );
  assert.equal(mapCandidateToBq({ ...candidate, candidate_contact_info: [] }).SECONDARY_EMAIL, null);
  assert.equal(mapCandidateToBq(null).SECONDARY_EMAIL, null);
});

test("SECONDARY_CELL_PHN is kept even when it duplicates CELL_PHONE", () => {
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

test("SECONDARY_CELL_PHN prefers leap_phone when leap, work, and home are all set", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [
      {
        cell_phone: "(111) 111-1111",
        leap_phone: "(222) 222-2222",
        work_phone: "(333) 333-3333",
        home_phone: "(444) 444-4444",
      },
    ],
  });
  assert.equal(out.SECONDARY_CELL_PHN, "(222) 222-2222");
});

test("SECONDARY_CELL_PHN falls back to work_phone before home_phone when leap_phone is absent", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [
      {
        cell_phone: "(111) 111-1111",
        leap_phone: null,
        work_phone: "(333) 333-3333",
        home_phone: "(444) 444-4444",
      },
    ],
  });
  assert.equal(out.SECONDARY_CELL_PHN, "(333) 333-3333");
});

test("SECONDARY_CELL_PHN uses home_phone when leap and work are absent", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [{ cell_phone: "(111) 111-1111", home_phone: "(444) 444-4444" }],
  });
  assert.equal(out.SECONDARY_CELL_PHN, "(444) 444-4444");
});

test("SECONDARY_CELL_PHN is null when leap, work, and home are all missing", () => {
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

test("SECONDARY_CELL_PHN falls through to the first contact row that has a secondary phone", () => {
  const out = mapCandidateToBq({
    ...candidate,
    candidate_contact_info: [{ leap_phone: null }, { work_phone: "(333) 333-3333" }],
  });
  assert.equal(out.SECONDARY_CELL_PHN, "(333) 333-3333");
});

test("SECONDARY_EMAIL and SECONDARY_CELL_PHN are API-owned, not manual", () => {
  assert.ok(API_OWNED_COLUMNS.has("SECONDARY_EMAIL"));
  assert.ok(API_OWNED_COLUMNS.has("SECONDARY_CELL_PHN"));
  assert.ok(!MANUAL_COLUMNS.has("SECONDARY_EMAIL"));
  assert.ok(!MANUAL_COLUMNS.has("SECONDARY_CELL_PHN"));
});
