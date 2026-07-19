import assert from "node:assert/strict";
import test from "node:test";
import { MCP_TOOLS, buildCliArgs, handleMcpMessage } from "../src/mcp.js";

test("MCP tool names are unique and expose safety annotations", () => {
  assert.equal(new Set(MCP_TOOLS.map((tool) => tool.name)).size, MCP_TOOLS.length);
  assert.ok(MCP_TOOLS.every((tool) => typeof tool.annotations?.readOnlyHint === "boolean"));
  assert.equal(MCP_TOOLS.find((tool) => tool.name === "justeat_place_order").annotations.destructiveHint, true);
});

test("MCP argument mapping preserves explicit mutation flags", () => {
  assert.deepEqual(buildCliArgs("justeat_create_basket", {
    planId: "12345678-abcd",
    candidate: 2,
    modifiers: { drinks: ["water"] },
  }), [
    "order", "prepare", "12345678-abcd", "--create", "--candidate", "2",
    "--modifiers", '{"drinks":["water"]}', "--agent",
  ]);
  assert.deepEqual(buildCliArgs("justeat_place_order", {
    planId: "12345678-abcd",
    confirmationFingerprint: "abc123",
  }), ["order", "place", "12345678-abcd", "--confirm", "abc123", "--agent"]);
});

test("MCP initialize and tools/list negotiate a usable server", async () => {
  const initialized = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(initialized.result.serverInfo.name, "justeat-es");
  const listed = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, MCP_TOOLS.length);
  assert.ok(!("command" in listed.result.tools[0]));
});

test("MCP context tool executes the real CLI and returns structured content", async () => {
  const response = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "justeat_context", arguments: {} },
  });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.name, "justeat-es-cli");
});
