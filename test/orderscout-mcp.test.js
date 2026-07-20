import assert from "node:assert/strict";
import test from "node:test";
import { ORDERSCOUT_MCP_TOOLS, handleOrderScoutMcpMessage, placementEnvironment } from "../src/orderscout-mcp.js";

test("OrderScout MCP exposes direct login, basket, checkout, and guarded order tools", () => {
  const names = new Set(ORDERSCOUT_MCP_TOOLS.map((tool) => tool.name));
  for (const name of ["orderscout_justeat_auth_login", "orderscout_justeat_auth_complete", "orderscout_provider_auth_login", "orderscout_provider_auth_complete", "orderscout_search_begin", "orderscout_confirm_eligibility", "orderscout_prepare_basket", "orderscout_create_basket", "orderscout_checkout_review_task", "orderscout_open_basket", "orderscout_place_order"]) {
    assert.equal(names.has(name), true, `${name} is missing`);
  }
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_login").command({}), ["auth", "login", "justeat", "--agent"]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_complete").command({}), ["auth", "complete", "justeat", "--agent"]);
  assert.equal(names.has("orderscout_provider_browser_session"), false);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_provider_auth_complete").command({ provider: "ubereats" }), ["auth", "complete", "ubereats", "--agent"]);
  assert.match(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_provider_auth_complete").description, /Automatically scan/);
  assert.match(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_accounts_status").description, /Live-verify/);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_open_basket").command({ searchId: "search", offerId: "offer" }), ["basket", "open", "search", "offer", "--no-open", "--agent"]);
  const placement = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_place_order");
  assert.equal(placement.annotations.destructiveHint, true);
  const search = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_search_begin");
  assert.match(search.description, /directly/i);
  assert.match(search.description, /concurrently/i);
  assert.equal(search.inputSchema.properties.providers, undefined);
  assert.deepEqual(search.command({ intent: "meal", objective: "value" }), ["search", "begin", "meal", "--agent", "--objective", "value"]);
  assert.deepEqual(search.command({ intent: "vape liquid", discoveryQueries: ["vape", "estanco"], catalogQueries: ["ice", "liquido"], maxCandidates: 40 }), [
    "search", "begin", "vape liquid", "--agent", "--discovery-queries", '["vape","estanco"]', "--catalog-queries", '["ice","liquido"]', "--top", "40",
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
