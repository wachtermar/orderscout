import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-comparison-"));
process.env.ORDERSCOUT_CONFIG_DIR = configDirectory;

const { ORDERSCOUT_MCP_TOOLS } = await import("../src/orderscout-mcp.js");
const { quoteSelectedProviderComparison } = await import("../src/orderscout.js");
const { normalizeOffer } = await import("../src/ranking.js");
const { buildLlmSelection, loadSearch, recordComparisonOutcomes, resultsFor, reviewProvider, writeSearch } = await import("../src/searches.js");

const PROVIDERS = ["justeat", "glovo", "ubereats"];

function candidate(provider, index) {
  return normalizeOffer(provider, {
    merchant: { id: `${provider}-merchant`, name: `${provider} merchant`, rating: 4.5, ratingCount: 100 },
    item: { id: `${provider}-item-${index}`, name: `${provider} meal`, unitPrice: 10 + index },
    pricing: { exact: false, fees: { delivery: 2 } },
    available: true,
    source: { planId: `${provider}-plan`, candidateIndex: index, storeId: `${provider}-merchant`, storeUuid: `${provider}-merchant` },
  });
}

function searchWithCandidates(id = "1".repeat(24)) {
  const offers = PROVIDERS.map(candidate);
  return {
    id,
    version: 2,
    intent: "cheapest dinner for two",
    fulfilment: { mode: "now", requestedAt: null, timeZone: "Europe/Madrid" },
    objective: "cheapest",
    semanticMode: "llm",
    queryPlan: { source: "llm-retrieval-plan" },
    shoppingItems: [],
    providers: PROVIDERS,
    providerStatus: Object.fromEntries(PROVIDERS.map((provider) => [provider, { state: "complete", error: null }])),
    orchestration: "concurrent",
    offers,
    selections: [],
    providerReviews: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test.after(async () => rm(configDirectory, { recursive: true, force: true }));

test("a quoted selection cannot win while completed candidate providers are unreviewed", () => {
  const search = searchWithCandidates();
  const selected = buildLlmSelection(search, [{
    offerId: search.offers[0].id, quantity: 1, forItem: "dinner", reason: "Suitable dinner.",
  }]);
  selected.pricing = { ...selected.pricing, exact: true, total: 12 };
  search.offers.push(selected);
  search.providerReviews.justeat = { disposition: "selected", offerId: selected.id, reason: "Suitable dinner." };

  const blocked = resultsFor(search);
  assert.equal(blocked.comparison.winnerReady, false);
  assert.equal(blocked.candidatePool.selectionRequired, true);
  assert.deepEqual(blocked.coverage.unreviewedCandidateProviders, ["glovo", "ubereats"]);

  search.providerReviews.glovo = { disposition: "inspected_no_suitable_match", reason: "No complete dinner." };
  search.providerReviews.ubereats = { disposition: "unavailable", reason: "All suitable meals are unavailable." };
  const reviewed = resultsFor(search);
  assert.equal(reviewed.comparison.winnerReady, true);
  assert.equal(reviewed.candidatePool.selectionRequired, false);
});

test("partial, failed, and pending configured providers block a winner even with no candidates", async () => {
  for (const [index, state] of ["partial", "error", "pending"].entries()) {
    const search = searchWithCandidates(String(index + 3).repeat(24));
    search.offers = search.offers.filter((offer) => offer.provider === "justeat");
    search.providerStatus.glovo = { state, error: state === "error" ? "Provider failed" : null };
    search.providerStatus.ubereats = { state: "complete", error: null };
    const selected = buildLlmSelection(search, [{
      offerId: search.offers[0].id, quantity: 1, forItem: "dinner", reason: "Suitable dinner.",
    }]);
    selected.pricing = { ...selected.pricing, exact: true, total: 12 };
    search.offers.push(selected);
    search.providerReviews.justeat = { disposition: "selected", offerId: selected.id, reason: "Suitable dinner." };

    const result = resultsFor(search);
    assert.equal(result.comparison.winnerReady, false, state);
    assert.deepEqual(result.coverage.unresolvedProviders, ["glovo"]);

    if (state === "partial") {
      await writeSearch(search);
      await assert.rejects(
        () => reviewProvider(search.id, "glovo", "inspected_no_suitable_match", "No suitable candidate in partial results."),
        { code: "PROVIDER_REVIEW_INCOMPLETE" },
      );
    }
  }
});

test("MCP exposes explicit review and enforced comparison quote contracts", () => {
  const review = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_review_provider");
  assert.deepEqual(review.command({
    searchId: "search", provider: "glovo", disposition: "inspected_no_suitable_match", reason: "No suitable candidate",
  }), ["search", "review", "search", "glovo", "--disposition", "inspected_no_suitable_match", "--reason", "No suitable candidate", "--agent"]);

  const comparison = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_quote_comparison");
  assert.deepEqual(comparison.command({ searchId: "search" }), ["comparison", "quote", "search", "--agent"]);
  assert.match(comparison.description, /every provider bundle/i);

  const checkout = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_checkout_review_task");
  assert.match(checkout.description, /Create this one selected provider basket when it does not exist/i);
  assert.deepEqual(checkout.command({ searchId: "search", offerId: "offer", customizations: { item: { group: "choice" } } }), [
    "basket", "checkout", "search", "offer", "--customizations", '{"item":{"group":"choice"}}', "--agent",
  ]);
});

test("comparison quote refuses to skip an unreviewed provider", async () => {
  const search = searchWithCandidates("4".repeat(24));
  const candidateOffer = search.offers[0];
  const selection = buildLlmSelection(search, [{
    offerId: candidateOffer.id, quantity: 1, forItem: "dinner", reason: "Suitable dinner.",
  }]);
  search.offers.push(selection);
  search.providerReviews.justeat = { disposition: "selected", offerId: selection.id, reason: "Suitable dinner." };
  await writeSearch(search);
  await assert.rejects(() => quoteSelectedProviderComparison(search.id, { providerTask: async () => ({}) }), {
    code: "PROVIDER_REVIEW_REQUIRED",
  });
});

test("comparison quote performs no provider writes when retrieval is incomplete or addresses disagree", async () => {
  for (const [id, configure, expectedCode] of [
    ["5".repeat(24), (search) => { search.providerStatus.glovo = { state: "partial", error: null }; }, "PROVIDER_REVIEW_REQUIRED"],
    ["6".repeat(24), (search) => {
      search.providerStatus.justeat.discovery = { deliveryLocation: { latitude: 40.4168, longitude: -3.7038 } };
      search.providerStatus.glovo.discovery = { deliveryLocation: { latitude: 36.5101, longitude: -4.8824 } };
    }, "DELIVERY_LOCATION_MISMATCH"],
  ]) {
    const search = searchWithCandidates(id);
    for (const provider of PROVIDERS) {
      const candidateOffer = search.offers.find((offer) => offer.provider === provider);
      const selection = buildLlmSelection(search, [{
        offerId: candidateOffer.id, quantity: 1, forItem: "dinner", reason: `${provider} suitable dinner.`,
      }]);
      search.offers.push(selection);
      search.providerReviews[provider] = { disposition: "selected", offerId: selection.id, reason: "Suitable dinner." };
    }
    configure(search);
    await writeSearch(search);
    let providerCalls = 0;
    await assert.rejects(() => quoteSelectedProviderComparison(search.id, {
      providerTask: async () => { providerCalls += 1; return {}; },
    }), { code: expectedCode });
    assert.equal(providerCalls, 0);
  }
});

test("comparison quotes providers concurrently, isolates failures, and commits all outcomes together", async () => {
  const search = searchWithCandidates("2".repeat(24));
  for (const provider of PROVIDERS) {
    const candidateOffer = search.offers.find((offer) => offer.provider === provider);
    const selection = buildLlmSelection(search, [{
      offerId: candidateOffer.id, quantity: 1, forItem: "dinner", reason: `${provider} suitable dinner.`,
    }]);
    search.offers.push(selection);
    search.providerReviews[provider] = { disposition: "selected", offerId: selection.id, reason: "Suitable dinner." };
  }
  await writeSearch(search);

  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let allStarted;
  const startedGate = new Promise((resolve) => { allStarted = resolve; });
  const pending = quoteSelectedProviderComparison(search.id, {
    providerTask: async ({ provider, offer }) => {
      started.push(provider);
      if (started.length === PROVIDERS.length) allStarted();
      await gate;
      if (provider === "glovo") {
        const error = new Error("Synthetic Glovo validation failure");
        error.code = "CHECKOUT_REJECTED";
        throw error;
      }
      return {
        status: "quoted",
        basketId: `${provider}-basket`,
        created: true,
        pricing: { currency: "EUR", subtotal: offer.pricing.subtotal, fees: { delivery: 2 }, discount: 0, total: offer.pricing.subtotal + 2, exact: true },
        fulfilment: null,
        fulfillable: true,
        issues: [],
      };
    },
  });
  await startedGate;
  assert.deepEqual(started.sort(), [...PROVIDERS].sort());
  release();

  const result = await pending;
  assert.deepEqual(result.providerOutcomes.map((outcome) => [outcome.provider, outcome.status]), [
    ["justeat", "quoted"], ["glovo", "error"], ["ubereats", "quoted"],
  ]);
  assert.equal(result.comparison.winnerReady, false);
  assert.deepEqual(result.comparison.exactPriceCoverage.missingQuoteProviders, ["glovo"]);

  const persisted = await loadSearch(search.id);
  assert.equal(persisted.comparisonQuotes.justeat.status, "quoted");
  assert.equal(persisted.comparisonQuotes.glovo.error.code, "CHECKOUT_REJECTED");
  assert.equal(persisted.comparisonQuotes.ubereats.status, "quoted");
  const quotedJustEat = persisted.offers.find((offer) => offer.id === search.providerReviews.justeat.offerId);
  assert.equal(quotedJustEat.pricing.exact, true);
  assert.equal(quotedJustEat.lines[0].candidateId, search.offers.find((offer) => offer.provider === "justeat" && !offer.source?.llmSelected).id);
  assert.equal(persisted.offers.find((offer) => offer.id === search.providerReviews.ubereats.offerId).pricing.exact, true);
});

test("a failed re-quote invalidates a previously exact provider total", async () => {
  const search = searchWithCandidates("7".repeat(24));
  const candidateOffer = search.offers.find((offer) => offer.provider === "glovo");
  const selection = buildLlmSelection(search, [{
    offerId: candidateOffer.id, quantity: 1, forItem: "dinner", reason: "Suitable dinner.",
  }]);
  selection.pricing = { ...selection.pricing, subtotal: 11, total: 14, exact: true, missing: [] };
  search.offers.push(selection);
  search.providerReviews = {
    justeat: { disposition: "inspected_no_suitable_match", reason: "No suitable dinner." },
    glovo: { disposition: "selected", offerId: selection.id, reason: "Suitable dinner." },
    ubereats: { disposition: "inspected_no_suitable_match", reason: "No suitable dinner." },
  };
  await writeSearch(search);

  const result = await recordComparisonOutcomes(search.id, [{
    provider: "glovo", offerId: selection.id, status: "error",
    error: { code: "BASKET_CONTENT_MISMATCH", message: "Partial basket" },
  }]);
  const persisted = await loadSearch(search.id);
  const invalidated = persisted.offers.find((offer) => offer.id === selection.id);
  assert.equal(invalidated.pricing.exact, false);
  assert.deepEqual(invalidated.pricing.missing, ["final checkout validation"]);
  assert.deepEqual(result.comparison.exactPriceCoverage.missingQuoteProviders, ["glovo"]);
  assert.equal(result.comparison.winnerReady, false);
});

test("comparison quote preserves Glovo's configured choices for agent review", async () => {
  const search = searchWithCandidates("8".repeat(24));
  const candidateOffer = search.offers.find((offer) => offer.provider === "glovo");
  const selection = buildLlmSelection(search, [{
    offerId: candidateOffer.id, quantity: 1, forItem: "dinner", reason: "Suitable dinner.",
  }]);
  search.offers.push(selection);
  search.providerReviews = {
    justeat: { disposition: "inspected_no_suitable_match", reason: "No suitable dinner." },
    glovo: { disposition: "selected", offerId: selection.id, reason: "Suitable dinner." },
    ubereats: { disposition: "inspected_no_suitable_match", reason: "No suitable dinner." },
  };
  await writeSearch(search);

  const result = await quoteSelectedProviderComparison(search.id, {
    providerTask: async () => ({
      status: "quoted", basketId: "glovo-basket", pricing: { subtotal: 11, total: 14, exact: true, missing: [] },
      fulfilment: { status: "verified" }, fulfillable: true, issues: [],
      customizationReview: [{ itemName: "Dinner", selections: [{ name: "Thai spicy" }] }],
    }),
  });
  const persisted = await loadSearch(search.id);
  assert.deepEqual(result.providerOutcomes[0].customizationReview, [{ itemName: "Dinner", selections: [{ name: "Thai spicy" }] }]);
  assert.deepEqual(persisted.comparisonQuotes.glovo.customizationReview, [{ itemName: "Dinner", selections: [{ name: "Thai spicy" }] }]);
});
