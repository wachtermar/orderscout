import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { CliError, filterMenu } from "../src/lib.js";
import { errorEnvelope, exitCodeFor, selectOutput, writeOutput } from "../src/output.js";

test("selectOutput supports dotted and multiple paths", () => {
  const value = { restaurant: { name: "Demo" }, categories: [{ name: "Water" }] };
  assert.equal(selectOutput(value, "restaurant.name"), "Demo");
  assert.deepEqual(selectOutput(value, "restaurant.name,categories.name"), {
    "restaurant.name": "Demo",
    "categories.name": ["Water"],
  });
});

test("agent output is compact JSON", () => {
  let contents = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { contents += chunk; callback(); } });
  writeOutput({ ok: true }, { agent: true }, stream);
  assert.equal(contents, '{"ok":true}\n');
});

test("stable error envelopes and exit codes distinguish failures", () => {
  const error = new CliError("Sign in", "AUTH_REQUIRED");
  assert.deepEqual(errorEnvelope(error), { error: { code: "AUTH_REQUIRED", message: "Sign in" } });
  assert.equal(exitCodeFor(error), 3);
  assert.equal(exitCodeFor(new CliError("Slow down", "RATE_LIMITED")), 6);
  assert.equal(exitCodeFor(new CliError("Check order history", "ORDER_STATUS_UNKNOWN")), 7);
});

test("filterMenu finds matching names and descriptions", () => {
  const menu = {
    categories: [{ name: "Drinks", items: [
      { name: "Agua 1.5L", description: "Mineral" },
      { name: "Cola", description: "Refresco" },
    ] }],
  };
  const result = filterMenu(menu, "agua");
  assert.equal(result.matches, 1);
  assert.equal(result.categories[0].items[0].name, "Agua 1.5L");
});
