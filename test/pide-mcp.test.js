import assert from "node:assert/strict";
import test from "node:test";
import { PIDE_MCP_TOOLS, handlePideMcpMessage } from "../src/pide-mcp.js";

test("Pide MCP exposes direct login, basket, checkout, and guarded order tools", () => {
  const names = new Set(PIDE_MCP_TOOLS.map((tool) => tool.name));
  for (const name of ["pide_provider_auth_login", "pide_provider_auth_complete", "pide_search_begin", "pide_prepare_basket", "pide_create_basket", "pide_checkout_review_task", "pide_open_basket", "pide_place_order"]) {
    assert.equal(names.has(name), true, `${name} is missing`);
  }
  const placement = PIDE_MCP_TOOLS.find((tool) => tool.name === "pide_place_order");
  assert.equal(placement.annotations.destructiveHint, true);
  const search = PIDE_MCP_TOOLS.find((tool) => tool.name === "pide_search_begin");
  assert.match(search.description, /directly/i);
  assert.doesNotMatch(search.description, /Browser tasks/i);
});

test("Pide MCP tool list does not expose implementation commands", async () => {
  const response = await handlePideMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.result.tools.every((tool) => tool.command === undefined), true);
  assert.equal(response.result.tools.length, PIDE_MCP_TOOLS.length);
});
