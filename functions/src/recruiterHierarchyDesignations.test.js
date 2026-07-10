const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isCsmHierarchyExcludedTitle,
  resolveCsmLevelsFromChain,
  resolveHierarchyColumnForTitle,
} = require("./recruiterHierarchyDesignations");

test("resolveHierarchyColumnForTitle handles real '<role> - Delivery' title suffixes", () => {
  // The bug: "Vice President - Delivery" (Amy Gupta's actual directory title) didn't match VP_SRVP.
  assert.equal(resolveHierarchyColumnForTitle("Vice President - Delivery"), "VP_SRVP");
  assert.equal(resolveHierarchyColumnForTitle("Vice President"), "VP_SRVP");
  // Associate VP is its own designation now (split out of VP_SRVP).
  assert.equal(resolveHierarchyColumnForTitle("AVP - Delivery"), "AVP");
  assert.equal(resolveHierarchyColumnForTitle("Associate Vice President - Delivery"), "AVP");
  assert.equal(resolveHierarchyColumnForTitle("AVP"), "AVP");
  // Unchanged exact matches still work.
  assert.equal(resolveHierarchyColumnForTitle("Sr. Delivery Manager"), "ACCOUNT_MANAGER");
  assert.equal(resolveHierarchyColumnForTitle("Delivery Director"), "DELIVERY_DIRECTOR");
  assert.equal(resolveHierarchyColumnForTitle("Recruitment Manager"), "RM");
  assert.equal(resolveHierarchyColumnForTitle("Associate Delivery Manager"), "ASSOCIATE_AM");
  // Non-roles still resolve to null (suffix strip must not create false matches).
  assert.equal(resolveHierarchyColumnForTitle("Chief Growth Officer (CGO)"), null);
  assert.equal(resolveHierarchyColumnForTitle("Some Team - Delivery"), null);
  assert.equal(resolveHierarchyColumnForTitle(null), null);
});

test("isCsmHierarchyExcludedTitle matches excluded titles even combined with an abbreviation", () => {
  assert.equal(isCsmHierarchyExcludedTitle("Chief Growth Officer (CGO)"), true);
  assert.equal(isCsmHierarchyExcludedTitle("CO-CEO"), true);
  assert.equal(isCsmHierarchyExcludedTitle("  permanent "), true);
  assert.equal(isCsmHierarchyExcludedTitle("CFO"), true);
  assert.equal(isCsmHierarchyExcludedTitle("AVP Client Relationship & Strategy"), false);
  assert.equal(isCsmHierarchyExcludedTitle(null), false);
  assert.equal(isCsmHierarchyExcludedTitle(""), false);
});

test("resolveCsmLevelsFromChain maps hierarchy_level 1/2/3 to LEVEL_2/3/4_CSM", () => {
  const levels = resolveCsmLevelsFromChain([
    { hierarchy_level: "1", manager_name: "Jodi Stanton", manager_title: "AVP Client Relationship & Strategy" },
    { hierarchy_level: "2", manager_name: "Ron Bagga", manager_title: "Chief Growth Officer (CGO)" },
    { hierarchy_level: "3", manager_name: "Nick Budhiraja", manager_title: "CO-CEO" },
  ]);
  assert.deepEqual(levels, {
    LEVEL_2_CSM: "Jodi Stanton",
    LEVEL_3_CSM: null,
    LEVEL_4_CSM: null,
  });
});

test("resolveCsmLevelsFromChain returns all-null for empty or missing chain", () => {
  assert.deepEqual(resolveCsmLevelsFromChain([]), { LEVEL_2_CSM: null, LEVEL_3_CSM: null, LEVEL_4_CSM: null });
  assert.deepEqual(resolveCsmLevelsFromChain(null), { LEVEL_2_CSM: null, LEVEL_3_CSM: null, LEVEL_4_CSM: null });
});

test("resolveCsmLevelsFromChain ignores hierarchy levels beyond 3", () => {
  const levels = resolveCsmLevelsFromChain([
    { hierarchy_level: "1", manager_name: "A", manager_title: "Delivery Manager" },
    { hierarchy_level: "2", manager_name: "B", manager_title: "Delivery Director" },
    { hierarchy_level: "3", manager_name: "C", manager_title: "AVP - Delivery" },
    { hierarchy_level: "4", manager_name: "D", manager_title: "Some VP" },
  ]);
  assert.deepEqual(levels, { LEVEL_2_CSM: "A", LEVEL_3_CSM: "B", LEVEL_4_CSM: "C" });
});
