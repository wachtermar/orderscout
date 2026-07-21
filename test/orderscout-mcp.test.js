import assert from "node:assert/strict";
import test from "node:test";
import { ORDERSCOUT_MCP_TOOLS, handleOrderScoutMcpMessage, placementEnvironment } from "../src/orderscout-mcp.js";

test("OrderScout MCP exposes direct login, basket, checkout, and guarded order tools", () => {
  const names = new Set(ORDERSCOUT_MCP_TOOLS.map((tool) => tool.name));
  for (const name of ["orderscout_justeat_auth_login", "orderscout_justeat_auth_complete", "orderscout_provider_auth_login", "orderscout_provider_auth_complete", "orderscout_search_begin", "orderscout_candidates", "orderscout_record_external_evidence", "orderscout_select_candidates", "orderscout_confirm_eligibility", "orderscout_prepare_basket", "orderscout_create_basket", "orderscout_checkout_review_task", "orderscout_open_basket", "orderscout_place_order"]) {
    assert.equal(names.has(name), true, `${name} is missing`);
  }
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_login").command({}), ["auth", "login", "justeat", "--agent"]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_complete").command({}), ["auth", "complete", "justeat", "--agent"]);
  assert.equal(names.has("orderscout_provider_browser_session"), false);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_provider_auth_complete").command({ provider: "ubereats" }), ["auth", "complete", "ubereats", "--agent"]);
  assert.match(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_provider_auth_complete").description, /Automatically scan/);
  assert.match(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_accounts_status").description, /Live-verify/);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_open_basket").command({ searchId: "search", offerId: "offer" }), ["basket", "open", "search", "offer", "--no-open", "--agent"]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_create_basket").command({ searchId: "search", offerId: "offer", allergenReviewed: true }), ["basket", "create", "search", "offer", "--allergen-reviewed", "true", "--agent"]);
  assert.equal(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_checkout_review_task").annotations.readOnlyHint, false);
  const placement = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_place_order");
  assert.equal(placement.annotations.destructiveHint, true);
  const search = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_search_begin");
  assert.match(search.description, /directly/i);
  assert.match(search.description, /concurrently/i);
  assert.equal(search.inputSchema.properties.providers, undefined);
  assert.equal(search.inputSchema.properties.shoppingItems.maxItems, 24);
  assert.deepEqual(search.command({ intent: "meal", objective: "value" }), ["search", "begin", "meal", "--agent", "--semantic-mode", "llm", "--objective", "value"]);
  assert.deepEqual(search.command({ intent: "vape liquid", discoveryQueries: ["vape", "estanco"], catalogQueries: ["ice", "liquido"], shoppingItems: [{ intent: "Tappo pod" }] }), [
    "search", "begin", "vape liquid", "--agent", "--semantic-mode", "llm", "--discovery-queries", '["vape","estanco"]', "--catalog-queries", '["ice","liquido"]', "--shopping-items", '[{"intent":"Tappo pod"}]',
  ]);
  assert.deepEqual(search.command({
    intent: "spiciest dinner", externalResearch: "required", externalDimensions: ["spiciness", "outside_rating"],
  }), [
    "search", "begin", "spiciest dinner", "--agent", "--semantic-mode", "llm", "--external-research", "required", "--external-dimensions", '["spiciness","outside_rating"]',
  ]);
  const externalEvidence = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_record_external_evidence");
  assert.match(externalEvidence.description, /cannot change provider availability/i);
  assert.deepEqual(externalEvidence.command({
    searchId: "search", offerIds: ["offer"], evidence: { status: "not_found", query: "q", dimensions: ["spiciness"], identity: { confidence: "low", matchedSignals: [], reason: "No unambiguous source." }, sources: [] },
  }), [
    "search", "evidence", "search", "--offer-ids", '["offer"]', "--json", '{"status":"not_found","query":"q","dimensions":["spiciness"],"identity":{"confidence":"low","matchedSignals":[],"reason":"No unambiguous source."},"sources":[]}', "--agent",
  ]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_candidates").command({
    searchId: "search", provider: "glovo", query: "mint ice", offset: 20, limit: 20,
  }), ["search", "candidates", "search", "--agent", "--offset", "20", "--limit", "20", "--provider", "glovo", "--query", "mint ice"]);
  assert.match(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_select_candidates").description, /model—not static keyword code/i);
  const select = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_select_candidates");
  assert.equal(select.inputSchema.properties.selections.maxItems, 24);
  assert.deepEqual(select.command({
    searchId: "search",
    selections: [{ offerId: "pepper", quantity: 2, forItem: "green-peppers", reason: "Exact product", requestFit: 100, confidence: "high", evidence: ["Named green pepper"] }],
    missingItems: [{ forItem: "coriander", reason: "The complete merchant catalog contained no ground coriander." }],
  }), [
    "search", "select", "search", "--json", '[{"offerId":"pepper","quantity":2,"forItem":"green-peppers","reason":"Exact product","requestFit":100,"confidence":"high","evidence":["Named green pepper"]}]',
    "--missing-items", '[{"forItem":"coriander","reason":"The complete merchant catalog contained no ground coriander."}]', "--agent",
  ]);
  assert.doesNotMatch(search.description, /Browser tasks/i);
});

test("only a fingerprint-confirmed purchase tool receives process-scoped placement gates", () => {
  const base = { PATH: "/test" };
  assert.equal(placementEnvironment("orderscout_place_order", {}, base), base);
  assert.equal(placementEnvironment("orderscout_search_begin", { confirm: "x" }, base), base);
  assert.deepEqual(placementEnvironment("orderscout_place_order", { confirm: "fingerprint" }, base), {
    PATH: "/test",
    ORDERSCOUT_ENABLE_ORDER_PLACEMENT: "1",
    JUSTEAT_ENABLE_ORDER_PLACEMENT: "1",
  });
});

test("OrderScout MCP tool list does not expose implementation commands", async () => {
  const response = await handleOrderScoutMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.result.tools.every((tool) => tool.command === undefined), true);
  assert.equal(response.result.tools.length, ORDERSCOUT_MCP_TOOLS.length);
});
