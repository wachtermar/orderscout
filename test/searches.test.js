import assert from "node:assert/strict";
import test from "node:test";
import { checkoutFulfilment, providerDiverseOffers, runConcurrentProviderTasks } from "../src/orderscout.js";
import {
  applyIntent, buildLlmSelection, candidatePageForSearch, providerRoutes, resultsFor, semanticInputsForSearch,
} from "../src/searches.js";
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

test("checkout-verified fulfilment overrides stale search and basket state", () => {
  const verified = { status: "verified", selectedWindow: { from: "10:00", to: "10:30" } };
  const unverified = { status: "unverified", selectedWindow: null };
  assert.deepEqual(checkoutFulfilment({ fulfilment: verified }, {
    fulfilment: unverified, basket: { fulfilment: unverified },
  }), verified);
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

test("coverage distinguishes currently available matches from unavailable catalog matches", () => {
  const base = {
    pricing: { exact: false, total: 10 }, merchant: { rating: 4, ratingCount: 20 },
    signals: { health: 0, taste: 0, relevance: 100, preference: 0 },
  };
  const result = resultsFor({
    id: "b".repeat(24), intent: "toothpaste", objective: "value", orchestration: "concurrent",
    providers: ["justeat", "ubereats"], createdAt: "now", updatedAt: "now",
    offers: [
      { ...base, id: "available", provider: "justeat", available: true },
      { ...base, id: "closed", provider: "ubereats", available: false },
    ],
    providerStatus: {
      justeat: { state: "complete", error: null }, ubereats: { state: "complete", error: null },
    },
  });
  assert.deepEqual(result.coverage.matchedProviders, ["justeat", "ubereats"]);
  assert.deepEqual(result.coverage.availableProviders, ["justeat"]);
  assert.deepEqual(result.coverage.unavailableOnlyProviders, ["ubereats"]);
});

test("LLM-mode retrieval never requires one product to satisfy every shopping line", () => {
  const candidates = [
    normalizeOffer("glovo", {
      merchant: { id: "vape-shop", name: "Vape Shop" },
      item: { id: "tappo", name: "Cartucho Lost Mary Tappo Pineapple Ice 20mg", unitPrice: 4.95 },
      pricing: {}, source: { storeId: "vape-shop", storeProductId: "tappo" },
    }),
    normalizeOffer("glovo", {
      merchant: { id: "vape-shop", name: "Vape Shop" },
      item: { id: "liquid", name: "Líquido Babel Boreal 10ml 3mg", description: "Mint ice", unitPrice: 4.95 },
      pricing: {}, source: { storeId: "vape-shop", storeProductId: "liquid" },
    }),
  ];
  const search = {
    id: "c".repeat(24), semanticMode: "llm",
    intent: "Lost Mary Tappo pods and bottled ice liquid that is not too sweet",
    objective: "value", providers: ["glovo"], offers: candidates,
    providerStatus: { glovo: { state: "complete", error: null } }, createdAt: "now", updatedAt: "now",
  };
  assert.equal(semanticInputsForSearch(search, candidates).length, 2);
  assert.equal(candidatePageForSearch(search, { query: "lost mary tappo" }).total, 1);
  assert.equal(candidatePageForSearch(search, { query: "mint ice" }).total, 1);
  const beforeSelection = resultsFor(search);
  assert.equal(beforeSelection.candidatePool.total, 2);
  assert.equal(beforeSelection.candidatePool.selectionRequired, true);
  assert.equal(beforeSelection.comparison.offers.length, 0);

  const selection = buildLlmSelection(search, [
    { offerId: candidates[0].id, quantity: 1, forItem: "Mary's Tappo pod", reason: "It is explicitly a Lost Mary Tappo cartridge." },
    { offerId: candidates[1].id, quantity: 1, forItem: "less-sweet ice liquid", reason: "It is bottled liquid described as mint ice rather than a sweet fruit profile." },
  ]);
  assert.equal(selection.lines.length, 2);
  assert.equal(selection.source.llmSelected, true);
  assert.equal(selection.pricing.subtotal, 9.9);
  assert.equal(selection.composition.kind, "llm-shopping-list");
});

test("LLM selection rejects candidates that cannot share one merchant basket", () => {
  const offers = ["one", "two"].map((id) => normalizeOffer("glovo", {
    merchant: { id, name: id }, item: { id, name: id, unitPrice: 1 }, pricing: {}, source: { storeId: id },
  }));
  assert.throws(() => buildLlmSelection({ semanticMode: "llm", offers }, [
    { offerId: offers[0].id, forItem: "a", reason: "a" },
    { offerId: offers[1].id, forItem: "b", reason: "b" },
  ]), { code: "SELECTION_BASKET_CONFLICT" });
});

test("taste-focused requests use the quality objective", () => {
  assert.equal(parseObjective("healthy but very tasty"), "best");
  assert.equal(parseObjective("best-rated healthy breakfast"), "best");
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

test("generic product intent filters noisy provider results before normalization", () => {
  const offers = applyIntent([
    { merchant: { name: "Restaurant" }, item: { name: "Plain rice", unitPrice: 3 }, pricing: {} },
    { merchant: { name: "Cafe" }, item: { name: "Lipton Ice Tea", unitPrice: 2 }, pricing: {} },
    { merchant: { name: "Market" }, item: { name: "Leche liquida entera", unitPrice: 1.5 }, pricing: {} },
    { merchant: { name: "DELIGO" }, item: { name: "Vape Lost Mary Triple Mango (1000)", unitPrice: 8 }, pricing: {} },
    { merchant: { name: "DELIGO" }, item: { name: "Vape Lost Mary Peach Ice (1000)", unitPrice: 8 }, pricing: {} },
    { merchant: { name: "Vape shop" }, item: { name: "Líquido para vaper Mango 10ml", unitPrice: 6 }, pricing: {} },
    { merchant: { name: "Vape shop" }, item: { name: "Vape liquid Peach Ice 10ml", unitPrice: 7 }, pricing: {} },
  ], "I need some vape liquid, preferably something with ice");
  assert.deepEqual(offers.map((offer) => offer.item.name), [
    "Líquido para vaper Mango 10ml", "Vape liquid Peach Ice 10ml",
  ]);
  assert.equal(offers[0].signals.preference, 0);
  assert.equal(offers[1].signals.preference, 100);
});

test("product preference outranks otherwise equivalent relevant products", () => {
  const base = {
    provider: "ubereats", available: true, etaMinutes: 20,
    merchant: { rating: 4.5, ratingCount: 100 }, pricing: { exact: false, total: 8 },
  };
  const result = rankOffers([
    { ...base, id: "mango", signals: { relevance: 100, preference: 0, health: 0, taste: 0 } },
    { ...base, id: "ice", signals: { relevance: 100, preference: 100, health: 0, taste: 0 } },
  ], "vape liquid preferably ice", "value");
  assert.equal(result.offers[0].id, "ice");
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

test("breakfast intent excludes lunch dishes and composes distinct breakfast mains", () => {
  const offers = applyIntent([
    { provider: "glovo", merchant: { id: "cafe", name: "Healthy Brunch", rating: 4.8 }, item: { id: "toast", name: "Tostada integral de aguacate y huevo", unitPrice: 9 }, pricing: { currency: "EUR" }, source: { storeId: "cafe", productId: "toast" } },
    { provider: "glovo", merchant: { id: "cafe", name: "Healthy Brunch", rating: 4.8 }, item: { id: "oats", name: "Bowl de avena, fruta y yogur", unitPrice: 8 }, pricing: { currency: "EUR" }, source: { storeId: "cafe", productId: "oats" } },
    { provider: "glovo", merchant: { id: "cafe", name: "Healthy Brunch", rating: 4.8 }, item: { id: "chicken", name: "Pollo a la plancha con verduras", unitPrice: 12 }, pricing: { currency: "EUR" }, source: { storeId: "cafe", productId: "chicken" } },
    { provider: "glovo", merchant: { id: "market", name: "Supermarket", rating: 4.9 }, item: { id: "raw-eggs", name: "Pack 12 huevos frescos de gallina", unitPrice: 4 }, pricing: { currency: "EUR" }, source: { storeId: "market", productId: "raw-eggs" } },
    { provider: "glovo", merchant: { id: "books", name: "Books", rating: 5 }, item: { id: "toy", name: "Juego Playmobil del huevo", unitPrice: 6 }, pricing: { currency: "EUR" }, source: { storeId: "books", productId: "toy" } },
    { provider: "glovo", merchant: { id: "chinese", name: "Jardín Chino", rating: 5 }, item: { id: "prawns", name: "Huevos revueltos con gambas", unitPrice: 7 }, pricing: { currency: "EUR" }, source: { storeId: "chinese", productId: "prawns" } },
    { provider: "glovo", merchant: { id: "cafe", name: "Healthy Brunch", rating: 4.8 }, item: { id: "jam", name: "Tostada de mantequilla y mermelada", unitPrice: 4 }, pricing: { currency: "EUR" }, source: { storeId: "cafe", productId: "jam" } },
    { provider: "glovo", merchant: { id: "acai-shop", name: "Açaí Shop", rating: 4.9 }, item: { id: "pulp", name: "Pulpa de açaí natural pack 400 g", unitPrice: 8 }, pricing: { currency: "EUR" }, source: { storeId: "acai-shop", productId: "pulp" } },
    { provider: "justeat", merchant: { id: "indian", name: "Masala", rating: 4.9 }, item: { id: "curry", name: "Rogan Josh Vegetables", description: "Cooked with homemade yoghurt", unitPrice: 9 }, pricing: { currency: "EUR" }, source: { storeId: "indian", productId: "curry" } },
  ], "best-rated healthy breakfast for 2 tomorrow at 10am under €30");
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].lines.map((line) => line.item.id).sort(), ["oats", "toast"]);
});

test("best-rated requests prioritize the strongest rating after eligibility", () => {
  const base = { available: true, pricing: { exact: false, total: 20 }, fulfilment: { status: "unverified" } };
  const result = rankOffers([
    { ...base, id: "healthier", provider: "glovo", merchant: { rating: 4.8, ratingCount: null }, signals: { health: 60, taste: 96 } },
    { ...base, id: "higher-rated", provider: "ubereats", merchant: { rating: 4.9, ratingCount: null }, signals: { health: 12, taste: 98 } },
  ], "best-rated healthy breakfast", "best");
  assert.equal(result.offers[0].id, "higher-rated");
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

test("a scheduled winner requires both an exact total and verified requested time", () => {
  const base = { available: true, etaMinutes: 20, signals: { health: 20, taste: 90 }, merchant: { rating: 4.8, ratingCount: 100 } };
  const result = rankOffers([
    { ...base, id: "verified", provider: "glovo", pricing: { exact: true, total: 25 }, fulfilment: { status: "verified" } },
    { ...base, id: "unverified", provider: "ubereats", pricing: { exact: true, total: 20 }, fulfilment: { status: "unverified" } },
  ], "healthy breakfast tomorrow at 10am under €30", "best");
  assert.equal(result.winnerReady, false);
  assert.deepEqual(result.exactPriceCoverage.missingQuoteProviders, ["ubereats"]);
  assert.match(result.offers.find((offer) => offer.id === "unverified").ranking.badges.join(" "), /requested time not verified/);
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
