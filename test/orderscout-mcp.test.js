import assert from "node:assert/strict";
import test from "node:test";
import { ORDERSCOUT_MCP_TOOLS, handleOrderScoutMcpMessage } from "../src/orderscout-mcp.js";

test("OrderScout MCP exposes direct login, basket, checkout, and guarded order tools", () => {
  const names = new Set(ORDERSCOUT_MCP_TOOLS.map((tool) => tool.name));
  for (const name of ["orderscout_provider_auth_login", "orderscout_provider_auth_complete", "orderscout_search_begin", "orderscout_prepare_basket", "orderscout_create_basket", "orderscout_checkout_review_task", "orderscout_open_basket", "orderscout_place_order"]) {
    assert.equal(names.has(name), true, `${name} is missing`);
  }
  const placement = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_place_order");
  assert.equal(placement.annotations.destructiveHint, true);
  const search = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_search_begin");
  assert.match(search.description, /directly/i);
  assert.doesNotMatch(search.description, /Browser tasks/i);
});

test("OrderScout MCP tool list does not expose implementation commands", async () => {
  const response = await handleOrderScoutMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.result.tools.every((tool) => tool.command === undefined), true);
  assert.equal(response.result.tools.length, ORDERSCOUT_MCP_TOOLS.length);
});
