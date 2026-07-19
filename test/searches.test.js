import assert from "node:assert/strict";
import test from "node:test";
import { providerDiverseOffers, runConcurrentProviderTasks } from "../src/orderscout.js";
import { applyIntent, providerRoutes, resultsFor } from "../src/searches.js";
import { defaultAccounts, publicAccountStatus } from "../src/providers.js";
import { normalizeOffer, parseObjective, rankOffers } from "../src/ranking.js";

test("provider tasks start concurrently and preserve provider-labelled outcomes", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runConcurrentProviderTasks(["justeat", "glovo", "ubereats"], async (provider) => {
    started.push(provider);
    await gate;
    return [`${provider}-offer`];
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["glovo", "justeat", "ubereats"]);
  release();
  const outcomes = await pending;
  assert.deepEqual(outcomes.map((outcome) => outcome.provider), ["justeat", "glovo", "ubereats"]);
  assert.deepEqual(outcomes.map((outcome) => outcome.value[0]), ["justeat-offer", "glovo-offer", "ubereats-offer"]);
});

test("compact agent results retain the best offer from every matched provider", () => {
  const offers = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `j${index}`, provider: "justeat", available: true, ranking: { score: 100 - index } })),
    { id: "g", provider: "glovo", available: true, ranking: { score: 1 } },
    { id: "u", provider: "ubereats", available: false, ranking: { score: -1 } },
  ];
  const compact = providerDiverseOffers(offers, 20);
  assert.equal(compact.length, 20);
  assert.deepEqual([...new Set(compact.map((offer) => offer.provider))].sort(), ["glovo", "justeat", "ubereats"]);
});

test("search results prove coverage and never silently omit a failed provider", () => {
  const result = resultsFor({
    id: "a".repeat(24), intent: "comida", objective: "value", orchestration: "concurrent",
    providers: ["justeat", "glovo", "ubereats"], offers: [], createdAt: "now", updatedAt: "now",
    providerStatus: {
      justeat: { state: "complete", error: null },
      glovo: { state: "error", error: "expired" },
      ubereats: { state: "complete", error: null },
    },
  });
  assert.equal(result.coverage.allConfiguredAttempted, true);
  assert.equal(result.coverage.allConfiguredCompleted, false);
  assert.deepEqual(result.coverage.failedProviders, ["glovo"]);
  assert.match(result.warnings.join(" "), /not silently omitted/);
});

test("taste-focused requests use the quality objective", () => {
  assert.equal(parseObjective("healthy but very tasty"), "best");
});

test("a recorded Work browser session never replaces direct CLI provider routing", () => {
  const accounts = defaultAccounts();
  accounts.providers.ubereats.authenticated = true;
  accounts.providers.ubereats.transport = "browser";
  accounts.providers.ubereats.addressSelected = true;
  const uber = publicAccountStatus(accounts).providers.find((provider) => provider.id === "ubereats");
  assert.equal(uber.transport, "browser");
  assert.equal(uber.addressSelected, true);
  assert.equal(uber.authenticated, true);
  assert.deepEqual(providerRoutes(["justeat", "glovo", "ubereats"], accounts), {
    apiProviders: ["justeat", "glovo", "ubereats"],
    browserProviders: [],
  });
});

test("water intent computes packs and excludes sparkling water and soft drinks", () => {
  const offers = applyIntent([
    { item: { name: "Font Vella Agua 6 x 1.5 L", unitPrice: 4.45 }, pricing: { currency: "EUR" } },
    { item: { name: "Agua con gas 6 x 1 L", unitPrice: 3.5 }, pricing: { currency: "EUR" } },
    { item: { name: "Aquarius 1.5 L", unitPrice: 2.1 }, pricing: { currency: "EUR" } },
  ], "20 litros de agua sin gas");

  assert.equal(offers.length, 1);
  assert.equal(offers[0].quantity, 3);
  assert.equal(offers[0].package.packCount, 6);
  assert.equal(offers[0].suppliedLiters, 27);
  assert.equal(offers[0].pricing.subtotal, 13.35);
});

test("meal intent applies party size, total budget, and health signals", () => {
  const offers = applyIntent([
    { merchant: { id: "poke", name: "Poke", rating: 4.8 }, item: { id: "salmon", name: "Poke de salmón y verduras", unitPrice: 13 }, pricing: { currency: "EUR" }, source: { storeId: "poke", productId: "salmon" } },
    { merchant: { id: "poke", name: "Poke", rating: 4.8 }, item: { id: "tuna", name: "Poke de atún y quinoa", unitPrice: 12.5 }, pricing: { currency: "EUR" }, source: { storeId: "poke", productId: "tuna" } },
    { merchant: { name: "Pizza", rating: 4.9 }, item: { name: "Pizza frita", unitPrice: 9 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Chicken", rating: 4.9 }, item: { name: "Filete de pollo empanado", unitPrice: 4 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Soup", rating: 4.9 }, item: { name: "Sopa de pollo", unitPrice: 5 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Grill", rating: 4.9 }, item: { name: "Grilled chicken with chips", unitPrice: 9 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Premium", rating: 5 }, item: { name: "Ensalada de pollo", unitPrice: 16 }, pricing: { currency: "EUR" } },
  ], "healthy tasty meal for two under €30");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].quantity, 1);
  assert.equal(offers[0].servesPeople, 2);
  assert.equal(offers[0].composition.kind, "distinct-dishes");
  assert.deepEqual(offers[0].lines.map((line) => line.item.name).sort(), ["Poke de atún y quinoa", "Poke de salmón y verduras"].sort());
  assert.equal(offers[0].pricing.subtotal, 25.5);
  assert.equal(offers[0].pricing.total, 29.5);
  assert.ok(offers[0].signals.health > 0);
  assert.equal(offers[0].signals.taste, 96);
});

test("exact totals over a hard budget are disqualified and comparison covers every matching provider", () => {
  const base = {
    available: true, etaMinutes: 20, signals: { health: 20, taste: 80 }, merchant: { rating: 4.8, ratingCount: 100 },
  };
  const result = rankOffers([
    { ...base, id: "over", provider: "ubereats", pricing: { exact: true, total: 36 } },
    { ...base, id: "within", provider: "justeat", pricing: { exact: true, total: 28 } },
    { ...base, id: "same-provider", provider: "justeat", pricing: { exact: true, total: 29 } },
    { ...base, id: "unquoted-provider", provider: "glovo", pricing: { exact: false, total: 27 } },
  ], "healthy meal for two under 30 euros", "best");
  assert.equal(result.offers.at(-1).id, "over");
  assert.equal(result.offers.at(-1).ranking.overBudget, true);
  assert.equal(result.exactPriceComparison, false);
  assert.deepEqual(result.exactPriceCoverage.missingQuoteProviders, ["glovo"]);
});

test("listed deals and membership eligibility survive normalization and affect value badges", () => {
  const offer = normalizeOffer("ubereats", {
    merchant: { id: "store", name: "Deal Store", rating: 4.7, ratingCount: 200 },
    item: { id: "meal", name: "Discounted meal", unitPrice: 7 },
    pricing: { originalSubtotal: 10, subtotal: 7, itemSavings: 3, fees: { delivery: 0 }, exact: false },
    promotion: { types: ["DISCOUNTED_ITEM", "FREE_DELIVERY"], descriptions: ["30% off"], eligible: true, savings: 3 },
    membershipEligible: true,
    available: true,
  }, { membership: { name: "Uber One", active: true } });
  const ranked = rankOffers([offer], "best deal", "value").offers[0];
  assert.equal(ranked.pricing.originalSubtotal, 10);
  assert.equal(ranked.pricing.itemSavings, 3);
  assert.equal(ranked.promotion.descriptions[0], "30% off");
  assert.equal(ranked.membership.eligible, true);
  assert.match(ranked.ranking.badges.join(" "), /listed item deal saves €3.00/);
  assert.match(ranked.ranking.badges.join(" "), /free delivery/);
  assert.match(ranked.ranking.badges.join(" "), /Uber One eligible/);
});
