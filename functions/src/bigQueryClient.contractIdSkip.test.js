const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("insertEnrichedDealSheetBatch: skip_contract_id clears CONTRACT_ID and skips allocator", () => {
  const source = fs.readFileSync(path.join(__dirname, "bigQueryClient.js"), "utf8");
  assert.equal(source.includes("options.skip_contract_id === true"), true);
  assert.equal(
    source.includes("CONTRACT_ID: null"),
    true,
  );
  assert.equal(
    source.includes("skip_contract_id: CONTRACT_ID cleared for insert"),
    true
  );
  const skipBlockStart = source.indexOf("if (options.skip_contract_id === true)");
  assert.ok(skipBlockStart >= 0);
  const elseAllocator = source.indexOf(
    "allocateContractIdsForInsertableRows(rowsToInsert)",
    skipBlockStart
  );
  assert.ok(elseAllocator > skipBlockStart, "allocator should be in else branch after skip_contract_id guard");
});

test("dealSheetEnricher skips resolveContractIds when skip_contract_id", () => {
  const source = fs.readFileSync(path.join(__dirname, "api", "dealSheetEnricher.js"), "utf8");
  assert.equal(source.includes("if (!options.skip_contract_id)"), true);
  assert.equal(source.includes("CONTRACT_ID resolution skipped"), true);
});

test("syncService derives skipContractId from use_ended_domain_routing or param", () => {
  const source = fs.readFileSync(path.join(__dirname, "syncService.js"), "utf8");
  assert.equal(
    source.includes(
      "const skipContractId = params.skip_contract_id === true || useEndedDomainRouting;"
    ),
    true
  );
  assert.equal(source.includes("skip_contract_id: skipContractId"), true);
  assert.equal(source.includes("skipContractId=${skipContractId"), true);
});
