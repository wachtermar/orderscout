import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { handleOrderScoutMcpMessage } from "../src/orderscout-mcp.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("package, MCP, and plugin pins stay on one public release", async () => {
  const packageJson = readJson("../package.json");
  const lock = readJson("../package-lock.json");
  const plugin = readJson("../plugins/orderscout/.codex-plugin/plugin.json");
  const mcp = readJson("../plugins/orderscout/.mcp.json");
  const skill = readFileSync(new URL("../plugins/orderscout/skills/order-with-orderscout/SKILL.md", import.meta.url), "utf8");
  const initialized = await handleOrderScoutMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });

  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[""].version, packageJson.version);
  assert.equal(plugin.version.split("+")[0], packageJson.version);
  assert.ok(mcp.mcpServers.orderscout.args.includes(`github:wachtermar/orderscout#v${packageJson.version}`));
  assert.equal(initialized.result.serverInfo.version, packageJson.version);
  assert.ok(skill.includes(`requires \`orderscout_context.version: ${packageJson.version}\``));
  assert.ok(Array.isArray(plugin.interface.defaultPrompt));
  assert.ok(plugin.interface.defaultPrompt.length >= 1 && plugin.interface.defaultPrompt.length <= 3);
  assert.ok(plugin.interface.defaultPrompt.every((prompt) => typeof prompt === "string" && prompt.length <= 128));
});
