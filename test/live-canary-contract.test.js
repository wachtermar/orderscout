import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("../scripts/live-canary.mjs", import.meta.url), "utf8");
const scenarios = JSON.parse(readFileSync(new URL("./fixtures/live-scenarios.json", import.meta.url), "utf8"));

test("live canary spans human delivery verticals without an order-submit path", () => {
  assert.equal(scenarios.length, 12);
  const text = scenarios.map(({ id, request }) => `${id} ${request}`).join(" ").toLowerCase();
  for (const term of ["dinner", "water", "breakfast", "groceries", "pharmacy", "nappies", "charger", "cat", "bouquet", "six people"]) {
    assert.match(text, new RegExp(term));
  }
  assert.doesNotMatch(script, /["']order["']\s*,\s*["']place["']/);
  assert.match(script, /ORDERSCOUT_LIVE_DRAFTS/);
  assert.match(script, /comparison["']\s*,\s*["']quote/);
  assert.match(script, /provider\.state === "complete" && !provider\.partial/);
});

test("every live scenario preserves independent shopping lines and bounded provider queries", () => {
  for (const scenario of scenarios) {
    assert.ok(scenario.id && scenario.request && scenario.objective, scenario.id);
    assert.ok(scenario.shoppingItems.length >= 1 && scenario.shoppingItems.length <= 12, scenario.id);
    assert.ok(scenario.discoveryQueries.length >= 1 && scenario.discoveryQueries.length <= 8, scenario.id);
    assert.ok(scenario.catalogQueries.length >= 1 && scenario.catalogQueries.length <= 8, scenario.id);
    assert.equal(new Set(scenario.shoppingItems.map(({ id }) => id)).size, scenario.shoppingItems.length, scenario.id);
  }
});
