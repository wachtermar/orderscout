import assert from "node:assert/strict";
import test from "node:test";

import { expandProviderDiscoveryQueries, planProviderRetrieval, planRoundRobinQueries } from "../src/retrieval-plan.js";

test("Glovo discovery adds provider-index language aliases without changing catalog semantics", () => {
  assert.deepEqual(
    expandProviderDiscoveryQueries("glovo", ["farmacia", "parafarmacia"]),
    ["farmacia", "parafarmacia", "pharmacy"],
  );
  assert.deepEqual(expandProviderDiscoveryQueries("glovo", ["thai", "healthy"]), [
    "thai", "healthy", "tailandes", "tailandesa", "saludable",
  ]);
  assert.deepEqual(expandProviderDiscoveryQueries("ubereats", ["farmacia"]), ["farmacia"]);
});

test("provider discovery alias expansion remains bounded and deduplicated", () => {
  assert.deepEqual(expandProviderDiscoveryQueries("glovo", ["Farmácia", "pharmacy", "shop"], 4), [
    "Farmácia", "pharmacy", "shop", "parafarmacia",
  ]);
});

test("round-robin planning gives each of 1-12 shopping lines a first query", () => {
  for (let size = 1; size <= 12; size += 1) {
    const shoppingItems = Array.from({ length: size }, (_, index) => ({
      id: `line-${index + 1}`,
      catalogQueries: [`primary ${index + 1}`, `secondary ${index + 1}`],
    }));
    const plan = planRoundRobinQueries({ globalQueries: ["supermercado"], shoppingItems, budget: size });
    assert.deepEqual(plan.queries, shoppingItems.map((item) => item.catalogQueries[0]), `size ${size}`);
    assert.deepEqual(plan.omittedItems, [], `size ${size}`);
    assert.ok(plan.itemCoverage.every((item) => item.plannedQueries.length === 1), `size ${size}`);
    assert.equal(plan.complete, false, `size ${size}`);
  }
});

test("global terms are scheduled once after every line gets a first chance", () => {
  const plan = planRoundRobinQueries({
    globalQueries: ["supermercado", "alimentación"],
    shoppingItems: [
      { id: "milk", catalogQueries: ["leche", "milk"] },
      { id: "eggs", catalogQueries: ["huevos", "eggs"] },
    ],
    budget: 5,
  });
  assert.deepEqual(plan.queries, ["leche", "huevos", "supermercado", "alimentación", "milk"]);
  assert.deepEqual(plan.omittedQueries, [{ query: "eggs", global: false, itemIds: ["eggs"] }]);
  assert.equal(plan.budgetExhausted, true);
});

test("shared global and item terms are normalized, deduplicated, and retain coverage", () => {
  const plan = planRoundRobinQueries({
    globalQueries: [" Farmácia ", "SUPERMERCADO"],
    shoppingItems: [
      { id: "spf", discoveryQueries: ["farmacia", "parafarmacia"] },
      { id: "plasters", discoveryQueries: ["FARMÁCIA", "supermercado"] },
    ],
    queryField: "discoveryQueries",
    budget: 3,
  });
  assert.deepEqual(plan.queries, ["Farmácia", "SUPERMERCADO", "parafarmacia"]);
  assert.deepEqual(plan.entries[0], { query: "Farmácia", global: true, itemIds: ["spf", "plasters"] });
  assert.equal(plan.complete, true);
  assert.equal(plan.budgetExhausted, false);
});

test("an insufficient budget explicitly reports later omitted lines", () => {
  const shoppingItems = Array.from({ length: 12 }, (_, index) => ({
    id: `line-${index + 1}`,
    catalogQueries: [`query ${index + 1}`],
  }));
  const plan = planRoundRobinQueries({ shoppingItems, budget: 8 });
  assert.deepEqual(plan.queries, shoppingItems.slice(0, 8).map((item) => item.catalogQueries[0]));
  assert.deepEqual(plan.omittedItems, ["line-9", "line-10", "line-11", "line-12"]);
  assert.deepEqual(plan.itemCoverage.slice(8).map((item) => item.status), ["omitted", "omitted", "omitted", "omitted"]);
  assert.equal(plan.complete, false);
  assert.equal(plan.budgetExhausted, true);
});

test("items with no query vocabulary are visible instead of silently disappearing", () => {
  const plan = planRoundRobinQueries({
    shoppingItems: [
      { id: "defined", catalogQueries: ["agua"] },
      { id: "missing" },
    ],
    budget: 8,
  });
  assert.deepEqual(plan.omittedItems, ["missing"]);
  assert.equal(plan.itemCoverage[1].status, "no_queries");
  assert.equal(plan.complete, false);
  assert.equal(plan.budgetExhausted, false);
});

test("planner output is deterministic and does not mutate its inputs", () => {
  const input = {
    globalQueries: ["vape", "estanco"],
    shoppingItems: [
      { id: "pod", catalogQueries: ["Tappo", "cartucho"] },
      { id: "liquid", catalogQueries: ["líquido", "mentol"] },
    ],
    budget: 5,
  };
  const snapshot = structuredClone(input);
  assert.deepEqual(planRoundRobinQueries(input), planRoundRobinQueries(input));
  assert.deepEqual(input, snapshot);
});

test("provider plans keep independent discovery and catalog budgets", () => {
  const plan = planProviderRetrieval({
    discoveryQueries: ["vape"],
    catalogQueries: ["Lost Mary"],
    shoppingItems: [
      { id: "pod", discoveryQueries: ["estanco"], catalogQueries: ["Tappo", "cartucho"] },
      { id: "liquid", discoveryQueries: ["vaper"], catalogQueries: ["líquido", "mentol"] },
    ],
    discoveryBudget: 3,
    catalogBudget: 4,
  });
  assert.deepEqual(plan.discovery.queries, ["estanco", "vaper", "vape"]);
  assert.deepEqual(plan.catalog.queries, ["Tappo", "líquido", "Lost Mary", "cartucho"]);
  assert.deepEqual(plan.catalog.omittedQueries, [{ query: "mentol", global: false, itemIds: ["liquid"] }]);
  assert.equal(plan.complete, false);
  assert.deepEqual(plan.omittedItems, []);
});

test("query budgets are validated", () => {
  assert.throws(() => planRoundRobinQueries({ budget: -1 }), RangeError);
  assert.throws(() => planRoundRobinQueries({ budget: 1.5 }), RangeError);
  assert.throws(() => planRoundRobinQueries({ shoppingItems: null }), TypeError);
});
