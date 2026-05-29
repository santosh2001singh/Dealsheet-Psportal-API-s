const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseJobSubmittalsPageQueryFromUrl,
  resolveNextNexusSubmittalsPageForCheckpoint,
} = require("./syncService");

test("parseJobSubmittalsPageQueryFromUrl reads page from absolute URL", () => {
  const u =
    "http://nexus.example.com/api/job-submittals/?organization_submittal_status_code=X&page=48&per_page=300";
  assert.equal(parseJobSubmittalsPageQueryFromUrl(u), 48);
});

test("parseJobSubmittalsPageQueryFromUrl reads page from relative path", () => {
  assert.equal(
    parseJobSubmittalsPageQueryFromUrl("/api/job-submittals/?page=22&per_page=300"),
    22
  );
});

test("resolveNextNexusSubmittalsPageForCheckpoint prefers next link page over current+1", () => {
  const cur = "http://x/api/job-submittals/?page=21&per_page=300";
  const nxt = "http://x/api/job-submittals/?page=48&per_page=300";
  assert.equal(resolveNextNexusSubmittalsPageForCheckpoint(cur, nxt, true), 48);
});

test("resolveNextNexusSubmittalsPageForCheckpoint falls back to current+1 when next has no page", () => {
  const cur = "http://x/api/job-submittals/?page=10&per_page=300";
  assert.equal(resolveNextNexusSubmittalsPageForCheckpoint(cur, null, true), 11);
});

test("resolveNextNexusSubmittalsPageForCheckpoint returns null when no more pages", () => {
  assert.equal(resolveNextNexusSubmittalsPageForCheckpoint("http://x/api/job-submittals/?page=5", null, false), null);
});
