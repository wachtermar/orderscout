import assert from "node:assert/strict";
import test from "node:test";
import { ORDERSCOUT_MCP_TOOLS, handleOrderScoutMcpMessage, placementEnvironment } from "../src/orderscout-mcp.js";

test("OrderScout MCP exposes direct login, basket, checkout, and guarded order tools", () => {
  const names = new Set(ORDERSCOUT_MCP_TOOLS.map((tool) => tool.name));
  for (const name of ["orderscout_justeat_auth_login", "orderscout_justeat_auth_complete", "orderscout_provider_auth_login", "orderscout_provider_auth_complete", "orderscout_provider_browser_session", "orderscout_search_begin", "orderscout_prepare_basket", "orderscout_create_basket", "orderscout_checkout_review_task", "orderscout_open_basket", "orderscout_place_order"]) {
    assert.equal(names.has(name), true, `${name} is missing`);
  }
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_login").command({}), ["auth", "login", "justeat", "--agent"]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_justeat_auth_complete").command({}), ["auth", "complete", "justeat", "--agent"]);
  assert.deepEqual(ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_provider_browser_session").command({ provider: "ubereats", authenticated: true, addressSelected: true }), ["accounts", "record", "ubereats", "--transport", "browser", "--authenticated", "true", "--address-selected", "true", "--agent"]);
  const placement = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_place_order");
  assert.equal(placement.annotations.destructiveHint, true);
  const search = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_search_begin");
  assert.match(search.description, /directly/i);
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
