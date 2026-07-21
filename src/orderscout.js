#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openSystemUrl } from "./auth.js";
import { offersForFulfilment, storesForFulfilment } from "./availability.js";
import { beginBrowserLogin, importChromeSession, loadBrowserSession, logoutBrowserSession } from "./browser-session.js";
import {
  createGlovoBasket, glovoAddresses, glovoBaskets, glovoCheckoutUrl, glovoMe, glovoMenu, glovoMenuOffers, glovoStoreCatalog, placeGlovoOrder, quoteGlovoBasket, searchGlovo,
} from "./glovo.js";
import { CliError, parseArgs, resolveLocation } from "./lib.js";
import { errorEnvelope, exitCodeFor, writeOutput } from "./output.js";
import { PROVIDERS, configureAccounts, loadAccounts, parseProviderList, publicAccountStatus, recordProviderStatus } from "./providers.js";
import { assertProviderAvailable, clearProviderCooldown, recordProviderRateLimit } from "./provider-cooldown.js";
import {
  confirmEligibility, ingestOffers, loadSearch, recordBasket, recordComparisonOutcomes, recordExternalEvidence, recordProviderError, recordQuote, resultsFor,
  reviewProvider, searchCandidates, searchResults, selectCandidates, startSearch,
} from "./searches.js";
import { runOrderScoutMcpServer } from "./orderscout-mcp.js";
import {
  createUberEatsBasket, expandUberEatsCatalogs, placeUberEatsOrder, quoteUberEatsBasket, searchUberEats, summarizeUberEatsCarts,
  uberEatsBasketHandoff, uberEatsCarts, uberEatsDraftDeliveryLocation, uberEatsMe, uberEatsMenu,
} from "./ubereats.js";
import { parseIntent, productIntentSpec, providerSearchQueries } from "./recommend.js";
import { expandProviderDiscoveryQueries, planProviderRetrieval } from "./retrieval-plan.js";

const execFileAsync = promisify(execFile);
const JUSTEAT_CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const MAX_GLOVO_DISCOVERED_STORES = 120;

const HELP = `orderscout — compare Just Eat, Glovo, and Uber Eats in Spain

Usage:
  orderscout context
  orderscout auth login|complete|status|logout <provider> [--profile auto]
  orderscout accounts status [--cached]
  orderscout accounts set --providers justeat,glovo,ubereats [--accounts JSON] [--memberships JSON]
  orderscout accounts record <provider> --authenticated true [--membership true] [--transport api|browser] [--address-selected true]
  orderscout recommend <what you want> [--at location] [--objective cheapest|fastest|best|value]
    [--discovery-queries JSON-array] [--catalog-queries JSON-array] [--top 1..100]
    [--external-research not_needed|required|unavailable] [--external-dimensions JSON-array]
  orderscout search begin <what you want> [the same flags]
  orderscout search ingest <search-id> <provider> --json '[normalized offers]'
  orderscout search error <search-id> <provider> --message text
  orderscout search candidates <search-id> [--offset 0] [--limit 50] [--provider glovo] [--merchant-id id]
  orderscout search evidence <search-id> --offer-ids '["candidate-id"]' --json '{structured evidence}'
  orderscout search select <search-id> --json '[{"offerId":"...","quantity":1,"forItem":"...","reason":"..."}]'
  orderscout search review <search-id> <provider> --disposition inspected_no_suitable_match|unavailable --reason text
  orderscout search results <search-id>
  orderscout eligibility confirm <search-id> <offer-id> --confirmed true
  orderscout quote record <search-id> <offer-id> --json '{"subtotal":10,"fees":{"delivery":2},"total":12}'
  orderscout basket prepare|create|checkout|open <search-id> <offer-id>
  orderscout comparison quote <search-id> [--customizations JSON]
  orderscout order place <search-id> <offer-id> [--confirm fingerprint]
  orderscout offer open <search-id> <offer-id>
  orderscout justeat <existing justeat command...>
  orderscout mcp

All three providers use direct HTTP adapters. Glovo and Uber Eats login opens the official site in native
Chrome and automatically finds the signed-in profile, importing only that provider's domain cookies after sign-in;
Playwright is not used. Search, menu, basket, and checkout operations run directly through each provider adapter.
Glovo search discovers merchants before querying relevant shop catalogs. Restricted baskets require explicit user
eligibility confirmation. No search or quote places an order.
`;

function jsonFlag(flags, key, fallback = undefined) {
  if (flags[key] === undefined) return fallback;
  try { return JSON.parse(String(flags[key])); }
  catch { throw new CliError(`--${key} must be valid JSON`); }
}

function booleanFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  if (flags[key] === true || flags[key] === "true" || flags[key] === "1") return true;
  if (flags[key] === false || flags[key] === "false" || flags[key] === "0") return false;
  throw new CliError(`--${key} must be true or false`);
}

function stringArrayFlag(flags, key) {
  const value = jsonFlag(flags, key, []);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CliError(`--${key} must be a JSON array of strings`, "INVALID_QUERY_PLAN");
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].slice(0, 8);
}

function shoppingItemsFlag(flags) {
  const value = jsonFlag(flags, "shopping-items", []);
  if (!Array.isArray(value) || value.length > 12) throw new CliError("--shopping-items must be a JSON array with at most 12 items", "INVALID_SHOPPING_ITEMS");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || typeof item.intent !== "string" || !item.intent.trim()) {
      throw new CliError(`Shopping item ${index + 1} requires a non-empty intent`, "INVALID_SHOPPING_ITEMS");
    }
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new CliError(`Shopping item ${index + 1} quantity must be 1..99`, "INVALID_SHOPPING_ITEMS");
    const queries = (key) => {
      const values = item[key] ?? [];
      if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string")) throw new CliError(`Shopping item ${index + 1} ${key} must be strings`, "INVALID_SHOPPING_ITEMS");
      return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))].slice(0, 8);
    };
    return {
      id: String(item.id ?? `item-${index + 1}`),
      label: String(item.label ?? item.intent).trim(),
      intent: item.intent.trim(),
      quantity,
      discoveryQueries: queries("discoveryQueries"),
      catalogQueries: queries("catalogQueries"),
    };
  });
}

function mergedQueries(primary, fallback, limit = 8) {
  return [...new Set([...(primary ?? []), ...(fallback ?? [])]
    .map((entry) => String(entry ?? "").trim()).filter(Boolean))].slice(0, limit);
}

export function uberEatsRetrievalQueries(flags = {}, fallbackQueries = []) {
  const discoveryQueries = flags.retrievalPlan?.discovery?.queries?.length
    ? flags.retrievalPlan.discovery.queries
    : mergedQueries(flags.discoveryQueries, fallbackQueries, 24);
  const catalogQueries = flags.retrievalPlan?.catalog?.queries?.length
    ? flags.retrievalPlan.catalog.queries
    : mergedQueries(flags.catalogQueries, fallbackQueries, 24);
  const shoppingItems = Array.isArray(flags.shoppingItems) ? flags.shoppingItems : [];
  const representativeQueries = [
    ...shoppingItems.map((item) => item.discoveryQueries?.[0]),
    ...shoppingItems.map((item) => item.catalogQueries?.[0]),
  ];
  const maximumQueries = shoppingItems.length
    ? Math.min(14, Math.max(4, shoppingItems.length + 2))
    : 6;
  const queries = mergedQueries(representativeQueries, [...discoveryQueries, ...catalogQueries], maximumQueries);
  const vocabulary = mergedQueries([
    ...discoveryQueries,
    ...catalogQueries,
    ...shoppingItems.flatMap((item) => item.discoveryQueries ?? []),
    ...shoppingItems.flatMap((item) => item.catalogQueries ?? []),
  ], [], 96);
  return {
    queries,
    discoveryQueries,
    catalogQueries,
    maximumQueries,
    omittedQueries: vocabulary.filter((query) => !queries.includes(query)).length,
  };
}

export function assertAllergenReview(search, flags) {
  const intent = search.parsedIntent ?? parseIntent(search.intent);
  if (intent.allergyMentioned && booleanFlag(flags, "allergen-reviewed") !== true) {
    throw new CliError("This request mentions an allergy; verify directly with the merchant before basket work", "ALLERGEN_REVIEW_REQUIRED");
  }
}

async function settleConcurrent(values, concurrency, mapper) {
  const outcomes = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      try { outcomes[index] = { status: "fulfilled", value: await mapper(values[index], index) }; }
      catch (reason) { outcomes[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return outcomes;
}

async function runLegacyJustEat(args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [JUSTEAT_CLI, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch (error) {
    const parsed = parseChildError(error);
    if (allowFailure) return { error: parsed };
    throw new CliError(parsed.message ?? "Just Eat adapter failed", parsed.code ?? "JUSTEAT_ADAPTER_FAILED", parsed.details);
  }
}

function parseChildError(error) {
  try { return JSON.parse(String(error.stderr).trim()).error ?? { message: error.message }; }
  catch { return { code: "JUSTEAT_ADAPTER_FAILED", message: error.message }; }
}

export function justEatLineModifierSelections(offer, customizations) {
  if (!customizations || typeof customizations !== "object" || Array.isArray(customizations)) return null;
  const lines = offer.lines?.length
    ? offer.lines
    : [{ item: offer.item, source: offer.source }];
  const result = {};
  for (const [index, line] of lines.entries()) {
    const candidateIndex = line.source?.candidateIndex;
    if (!Number.isInteger(candidateIndex)) continue;
    const keyed = customizations[String(candidateIndex)]
      ?? customizations[line.item?.id]
      ?? customizations[String(index)];
    const selections = keyed ?? (lines.length === 1 ? customizations : null);
    if (selections && typeof selections === "object" && !Array.isArray(selections)) {
      result[candidateIndex] = selections;
    }
  }
  return Object.keys(result).length ? result : null;
}

function justEatOffers(result) {
  return (result.candidates ?? []).map((candidate, index) => ({
    provider: "justeat",
    merchant: {
      id: candidate.restaurant?.id,
      name: candidate.restaurant?.name,
      rating: candidate.restaurant?.rating,
      ratingCount: candidate.restaurant?.ratingCount,
    },
    item: {
      id: candidate.item?.variationId ?? candidate.item?.id,
      name: candidate.item?.name,
      description: candidate.item?.description,
      category: candidate.item?.category,
      unitPrice: candidate.item?.unitPrice,
    },
    quantity: candidate.quantity,
    package: candidate.package,
    suppliedLiters: candidate.suppliedLiters,
    etaMinutes: candidate.restaurant?.etaMinutes,
    available: candidate.restaurant?.open || candidate.restaurant?.preorder,
    pricing: {
      currency: candidate.item?.currency ?? "EUR",
      subtotal: candidate.itemTotal,
      total: candidate.estimatedDeliveredTotal,
      exact: false,
    },
    promotion: candidate.restaurant?.deals?.length ? {
      types: ["MERCHANT_DEAL"],
      descriptions: candidate.restaurant.deals,
      eligible: true,
      applied: false,
      savings: 0,
      source: "justeat-search-card",
    } : null,
    signals: {
      health: candidate.ranking?.healthScore,
      taste: candidate.ranking?.tasteScore,
      relevance: candidate.ranking?.relevanceScore,
      preference: candidate.ranking?.preferenceScore,
      matchedCore: candidate.ranking?.matchedCore,
      matchedPreference: candidate.ranking?.matchedPreference,
    },
    url: candidate.restaurant?.slug ? `https://www.just-eat.es/restaurants-${candidate.restaurant.slug}/menu` : null,
    source: { planId: result.planId, candidateIndex: index, addressIndex: result.location?.addressIndex ?? 0, adapter: "justeat-api" },
  }));
}

function justEatPricing(result) {
  const quote = result?.quote?.quote ?? result?.quote ?? result;
  const cents = (value) => Number.isFinite(Number(value)) ? Number(value) / 100 : null;
  return {
    currency: quote?.currency ?? "EUR",
    subtotal: cents(quote?.subtotalCents),
    fees: {
      delivery: cents(quote?.deliveryFeeCents),
      service: cents(quote?.serviceFeeCents),
      smallOrder: null,
      bag: cents(quote?.bagFeeCents),
      other: null,
    },
    discount: cents(quote?.discountCents) ?? 0,
    total: Number.isFinite(Number(quote?.total)) ? Number(quote.total) : cents(quote?.totalCents),
    exact: Number.isFinite(Number(quote?.total)) || Number.isFinite(Number(quote?.totalCents)),
  };
}

async function saveCheckoutResult(searchId, offerId, result, pricing) {
  if (pricing?.exact && Number.isFinite(Number(pricing.total))) await recordQuote(searchId, offerId, {
    ...pricing, ...(result.fulfilment ? { fulfilment: result.fulfilment } : {}),
  });
  const current = await searchResults(searchId);
  const quotedOffer = current.comparison.offers.find((offer) => offer.id === offerId) ?? null;
  const { quote, ...summary } = result;
  return {
    ...summary,
    pricing,
    review: result.provider === "justeat" ? {
      fulfillable: quote?.quote?.isFulfillable ?? quote?.isFulfillable ?? null,
      issues: quote?.quote?.issues ?? quote?.issues ?? [],
      paymentMethods: quote?.quote?.paymentMethods ?? quote?.paymentMethods ?? [],
    } : null,
    comparison: {
      exactPriceComparison: current.comparison.exactPriceComparison,
      exactPriceCoverage: current.comparison.exactPriceCoverage,
      quotedOffer,
      warnings: current.warnings,
    },
  };
}

export function checkoutFulfilment(quoted, offer) {
  return quoted?.fulfilment ?? offer?.basket?.fulfilment ?? offer?.fulfilment ?? null;
}

function selectedComparisonOffers(search) {
  const selected = search.offers.filter((offer) => offer.source?.llmSelected === true);
  const reviews = search.providerReviews;
  if (reviews !== undefined) {
    return search.providers.flatMap((provider) => {
      const review = reviews?.[provider];
      if (review?.disposition !== "selected") return [];
      const offer = selected.find((entry) => entry.id === review.offerId && entry.provider === provider);
      return offer ? [offer] : [];
    });
  }
  const latest = new Map();
  for (const offer of selected) latest.set(offer.provider, offer);
  return search.providers.map((provider) => latest.get(provider)).filter(Boolean);
}

async function createBasketForOffer(search, offer, options = {}) {
  if (offer.provider === "glovo") {
    const result = await createGlovoBasket(offer, { customizations: options.customizations });
    const id = result.basket?.basketId ?? result.basket?.id;
    if (!id) throw new CliError("Glovo created a basket without returning its ID", "BASKET_PROTOCOL_ERROR");
    return { provider: "glovo", id: String(id), creation: result };
  }
  if (offer.provider === "ubereats") {
    const result = await createUberEatsBasket(offer, {
      customizations: options.customizations,
      scheduledAt: search.fulfilment?.requestedAt,
      timeZone: search.fulfilment?.timeZone,
    });
    const draft = result.draftOrder;
    const id = draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid;
    if (!id) throw new CliError("Uber Eats created a draft without returning its ID", "BASKET_PROTOCOL_ERROR");
    return { provider: "ubereats", id: String(id), creation: result };
  }
  const source = offer.source;
  if (!source?.planId || !Number.isInteger(source.candidateIndex)) {
    throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
  }
  const args = ["order", "prepare", source.planId, "--candidate", String(source.candidateIndex), "--agent"];
  if (offer.lines?.length) {
    args.push("--lines", JSON.stringify(offer.lines.map((line) => ({
      candidateIndex: line.source?.candidateIndex,
      quantity: line.quantity ?? 1,
    }))));
  } else args.push("--quantity", String(offer.quantity ?? 1));
  const lineModifiers = justEatLineModifierSelections(offer, options.customizations);
  if (lineModifiers) args.push("--line-modifiers", JSON.stringify(lineModifiers));
  args.push("--create");
  const result = await runLegacyJustEat(args);
  const id = result?.basketId;
  if (!id) throw new CliError("Just Eat created a basket without returning its ID", "BASKET_PROTOCOL_ERROR");
  const configuration = await runLegacyJustEat([
    "order", "configure", source.planId,
    "--address-index", String(source.addressIndex ?? 0),
    ...(search.fulfilment?.requestedAt ? ["--scheduled", search.fulfilment.requestedAt] : []),
    "--apply", "--agent",
  ], { allowFailure: true });
  if (configuration?.error) {
    throw new CliError(configuration.error.message ?? "Just Eat checkout configuration failed", configuration.error.code ?? "CHECKOUT_CONFIGURATION_FAILED", configuration.error.details);
  }
  const fulfilment = configuration?.selectedWindow ? {
    requestedAt: search.fulfilment.requestedAt,
    timeZone: search.fulfilment.timeZone,
    status: "verified",
    selectedWindow: configuration.selectedWindow,
    source: "justeat-availabletimes",
  } : null;
  return { provider: "justeat", id: String(id), fulfilment, creation: { result, configuration } };
}

function quoteReview(provider, quoted, pricing) {
  let fulfillable = null;
  let issues = [];
  if (provider === "justeat") {
    const value = quoted.quote?.quote ?? quoted.quote ?? quoted;
    fulfillable = value?.isFulfillable ?? null;
    issues = value?.issues ?? [];
  } else if (provider === "glovo") {
    fulfillable = quoted.quote?.isFulfillable ?? quoted.quote?.fulfillable ?? null;
    issues = quoted.quote?.issues ?? quoted.quote?.validationErrors ?? [];
  } else {
    fulfillable = quoted.quote?.isFulfillable ?? null;
    issues = quoted.quote?.validationErrors ?? quoted.quote?.issues ?? [];
  }
  const blocked = fulfillable === false || issues.length > 0;
  return {
    fulfillable,
    issues,
    pricing: blocked && pricing?.exact ? { ...pricing, exact: false, missing: ["blocking checkout validation"] } : pricing,
  };
}

async function quoteBasketForOffer(search, offer, basket) {
  if (!basket?.id) throw new CliError("Create this basket before requesting checkout", "BASKET_REQUIRED");
  if (offer.provider === "glovo") {
    const quoted = await quoteGlovoBasket(basket.id, {
      scheduledAt: search.fulfilment?.requestedAt,
      timeZone: search.fulfilment?.timeZone,
      expectedLines: offer.lines?.length
        ? offer.lines
        : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }],
    });
    const fulfilment = checkoutFulfilment(quoted, { ...offer, basket });
    return { quoted: { ...quoted, fulfilment }, ...quoteReview("glovo", quoted, quoted.pricing), fulfilment };
  }
  if (offer.provider === "ubereats") {
    const quoted = await quoteUberEatsBasket(basket.id, {
      scheduledAt: search.fulfilment?.requestedAt,
      timeZone: search.fulfilment?.timeZone,
      expectedLines: offer.lines?.length
        ? offer.lines
        : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }],
    });
    const fulfilment = checkoutFulfilment(quoted, { ...offer, basket });
    return { quoted: { ...quoted, fulfilment }, ...quoteReview("ubereats", quoted, quoted.pricing), fulfilment };
  }
  const response = await runLegacyJustEat(["order", "quote", offer.source.planId, "--agent"]);
  if (response?.basketId && String(response.basketId) !== String(basket.id)) {
    throw new CliError("Just Eat returned a quote for a different basket", "BASKET_MISMATCH", {
      expectedBasketId: String(basket.id), returnedBasketId: String(response.basketId),
    });
  }
  const quoted = {
    provider: "justeat", offerId: offer.id, quote: response,
    remoteBasketVerification: response.remoteBasketVerification ?? null,
    fulfilment: basket.fulfilment ?? offer.fulfilment, submitted: false,
  };
  const pricing = justEatPricing(quoted);
  return { quoted, ...quoteReview("justeat", quoted, pricing), fulfilment: quoted.fulfilment };
}

export async function quoteSelectedProviderComparison(searchId, options = {}) {
  const search = await loadSearch(searchId);
  assertAllergenReview(search, { "allergen-reviewed": options.allergenReviewed === true ? "true" : undefined });
  const readiness = resultsFor(search);
  if (readiness?.coverage?.unresolvedProviders?.length) {
    throw new CliError(
      `Every provider must complete retrieval and review before quoting: ${readiness.coverage.unresolvedProviders.join(", ")}`,
      "PROVIDER_REVIEW_REQUIRED",
    );
  }
  if (readiness?.coverage?.deliveryLocation?.status === "mismatch") {
    throw new CliError(
      "Provider delivery locations do not match; fix the saved addresses before creating comparison baskets",
      "DELIVERY_LOCATION_MISMATCH",
      readiness.coverage.deliveryLocation,
    );
  }
  const offers = selectedComparisonOffers(search);
  if (!offers.length) throw new CliError("Select one provider bundle before requesting a comparison quote", "SELECTION_REQUIRED");
  const byProvider = new Map(offers.map((offer) => [offer.provider, offer]));
  const rawOutcomes = await runConcurrentProviderTasks([...byProvider.keys()], async (provider) => {
    const offer = byProvider.get(provider);
    const customizations = options.customizations?.[offer.id] ?? options.customizations?.[provider];
    if (options.providerTask) {
      return {
        provider,
        offerId: offer.id,
        ...await options.providerTask({ provider, offer, search, customizations }),
      };
    }
    const basket = offer.basket?.id
      ? { ...offer.basket, provider }
      : await createBasketForOffer(search, offer, { customizations });
    const review = await quoteBasketForOffer(search, offer, basket);
    const exact = Boolean(review.pricing?.exact && Number.isFinite(Number(review.pricing?.total)));
    return {
      provider,
      offerId: offer.id,
      status: exact ? "quoted" : "provisional",
      basketId: basket.id,
      basketCreatedAt: offer.basket?.createdAt ?? new Date().toISOString(),
      created: !offer.basket?.id,
      pricing: review.pricing,
      fulfilment: review.fulfilment,
      fulfillable: review.fulfillable,
      issues: review.issues,
      customizationReview: basket.creation?.customizationReview ?? null,
    };
  });
  const providerOutcomes = rawOutcomes.map((outcome) => {
    if (!outcome.error) return outcome.value;
    return {
      provider: outcome.provider,
      offerId: byProvider.get(outcome.provider)?.id ?? null,
      status: "error",
      error: {
        code: outcome.error.code ?? "QUOTE_FAILED",
        message: outcome.error.message,
        ...(outcome.error.details ? { details: outcome.error.details } : {}),
      },
    };
  });
  const results = await recordComparisonOutcomes(searchId, providerOutcomes);
  return {
    searchId,
    providerOutcomes,
    comparison: results.comparison,
    coverage: results.coverage,
    candidatePool: results.candidatePool,
    warnings: results.warnings,
    submitted: false,
  };
}

export function providerDiverseOffers(offers, limit) {
  const anchors = [];
  for (const provider of Object.keys(PROVIDERS)) {
    const matches = offers.filter((offer) => offer.provider === provider);
    const anchor = matches.find((offer) => offer.available && !offer.ranking?.overBudget) ?? matches[0];
    if (anchor) anchors.push(anchor);
  }
  const selected = new Map(anchors.map((offer) => [offer.id, offer]));
  for (const offer of offers) {
    if (selected.size >= Math.max(limit, anchors.length)) break;
    selected.set(offer.id, offer);
  }
  const positions = new Map(offers.map((offer, index) => [offer.id, index]));
  return [...selected.values()].sort((left, right) => positions.get(left.id) - positions.get(right.id));
}

export function completedSearchResponse(started, finalResults) {
  return {
    ...started,
    search: finalResults.search,
    results: finalResults,
  };
}

function compactSearchResult(result, flags) {
  const limit = Number(flags.top ?? (flags.agent ? 20 : 0));
  if (!Number.isInteger(limit) || limit <= 0 || !result?.comparison?.offers) return result;
  return {
    ...result,
    comparison: { ...result.comparison, offers: providerDiverseOffers(result.comparison.offers, limit) },
  };
}

async function collectJustEat(intent, flags) {
  const args = ["recommend", intent, "--agent"];
  const parsed = parseIntent(intent);
  if (flags.semanticMode === "llm") {
    args.push("--candidate-mode", "llm", "--limit", String(flags.limit ?? 5_000));
    if (flags.stores === undefined) args.push("--stores", "200");
    if (flags.shoppingItems?.length) args.push("--shopping-items", JSON.stringify(flags.shoppingItems));
  }
  if (parsed.deliveryTime === "scheduled") args.push("--include-closed");
  if (flags.semanticMode !== "llm" && parsed.occasion === "breakfast" && flags.stores === undefined) args.push("--stores", "40");
  for (const [flag, value] of [["at", flags.at], ["stores", flags.stores], ["limit", flags.semanticMode === "llm" ? undefined : flags.limit], ["vertical", flags.vertical]]) {
    if (value !== undefined) args.push(`--${flag}`, String(value));
  }
  const result = await runLegacyJustEat(args, { allowFailure: true });
  if (result.error) throw new CliError(result.error.message ?? result.error.code ?? "Just Eat search failed", result.error.code ?? "JUSTEAT_SEARCH_FAILED");
  return {
    offers: justEatOffers(result),
    providerMeta: {
      strategy: "complete-area-menu-scan",
      discoveredStores: result.scope?.discoveredStores ?? null,
      eligibleStores: result.scope?.eligibleStores ?? null,
      availableStores: result.scope?.availableStores ?? null,
      excludedUnavailableStores: result.scope?.excludedUnavailableStores ?? null,
      candidateStores: result.scope?.candidateStores ?? null,
      searchedStores: result.scope?.scannedStores ?? null,
      failedMenus: result.scope?.failedMenus ?? 0,
      deliveryLocation: result.location ? {
        latitude: result.location.latitude,
        longitude: result.location.longitude,
        postcode: result.location.postcode ?? null,
        city: result.location.city ?? null,
        source: "justeat-saved-address",
      } : null,
      partial: Number(result.scope?.failedMenus ?? 0) > 0
        || (Number.isFinite(Number(result.scope?.candidateStores))
          && Number(result.scope.candidateStores) > Number(result.scope?.scannedStores ?? 0)),
    },
  };
}

async function collectGlovo(intent, flags) {
  let location;
  if (flags.at) location = await resolveLocation(String(flags.at));
  else {
    const addresses = await glovoAddresses();
    location = addresses.find((address) => address.isDefault) ?? addresses[0];
    if (!location) throw new CliError("Glovo has no usable saved delivery address; pass --at once", "LOCATION_REQUIRED");
  }
  const parsed = parseIntent(intent);
  const fallbackQueries = providerSearchQueries(parsed);
  const plannedDiscoveryQueries = flags.retrievalPlan?.discovery?.queries?.length
    ? flags.retrievalPlan.discovery.queries : mergedQueries(flags.discoveryQueries, fallbackQueries, 24);
  const discoveryQueries = expandProviderDiscoveryQueries("glovo", plannedDiscoveryQueries, 24);
  const catalogQueries = flags.retrievalPlan?.catalog?.queries?.length
    ? flags.retrievalPlan.catalog.queries : mergedQueries(flags.catalogQueries, fallbackQueries, 24);
  const results = await settleConcurrent(discoveryQueries, 3, (query) => searchGlovo(query, location, {
    limit: flags.limit,
    storeLimit: MAX_GLOVO_DISCOVERED_STORES,
  }));
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) throw results[0].reason;
  const discoveryFailures = results.filter((result) => result.status === "rejected");
  const allStores = [...new Map(fulfilled.flatMap((result) => result.value.stores ?? [])
    .map((store) => [`${store.id}:${store.addressId}`, store])).values()];
  const maxStores = Math.max(1, Math.min(MAX_GLOVO_DISCOVERED_STORES,
    Number(flags.stores ?? MAX_GLOVO_DISCOVERED_STORES)));
  const fulfilmentStores = storesForFulfilment("glovo", allStores, parsed);
  const stores = fulfilmentStores.slice(0, maxStores);
  const requireEligibility = [parsed, ...(flags.shoppingItems ?? []).map((item) => parseIntent(item.intent))]
    .some((itemIntent) => productIntentSpec(itemIntent).concept?.id === "vape");
  const catalogs = [];
  const fullMenus = [];
  const catalogErrors = [];
  let failedCatalogs = 0;
  const menuOutcomes = await settleConcurrent(stores, 4, async (store) => {
    const menu = await glovoMenu(store.url);
    let catalog = null;
    if (requireEligibility || menu.restrictionsDetected) {
      catalog = await glovoStoreCatalog(store, catalogQueries, location, {
        requireEligibility,
        queryLimit: Math.max(1, catalogQueries.length),
        concurrency: 1,
      });
    }
    return { store, menu, catalog };
  });
  for (const outcome of menuOutcomes) {
    if (outcome.status === "rejected") {
      failedCatalogs += 1;
      catalogErrors.push(outcome.reason);
      continue;
    }
    fullMenus.push(outcome.value);
    if (outcome.value.catalog) catalogs.push(outcome.value.catalog);
  }
  if (stores.length && !fullMenus.length) {
    if (catalogErrors.some((error) => error?.code === "RATE_LIMITED")) {
      throw new CliError("Glovo temporarily rate-limited catalog search; wait before retrying", "RATE_LIMITED", {
        discoveredStores: stores.length,
        failedCatalogs,
      });
    }
    throw new CliError("Glovo discovered relevant merchants but every catalog request failed; retry instead of treating this as no match", "GLOVO_CATALOG_SEARCH_FAILED", {
      discoveredStores: stores.length,
      failedCatalogs,
    });
  }
  const directOffers = fulfilled.flatMap((result) => result.value.offers ?? []);
  const menuOffers = fullMenus.flatMap(({ store, menu }) => glovoMenuOffers(store, menu, { requireEligibility }));
  const allOffers = [...directOffers, ...menuOffers, ...catalogs.flatMap((catalog) => catalog.offers)];
  const discovered = offersForFulfilment([...new Map(allOffers.map((offer) => [
    `${offer.merchant?.id}:${offer.source?.storeProductId ?? offer.source?.productExternalId ?? offer.item?.id}`,
    {
      ...offer,
      available: parsed.deliveryTime === "scheduled"
        ? (stores.find((store) => String(store.id) === String(offer.merchant?.id))?.schedulable || offer.available)
        : offer.available,
      ...(parsed.deliveryTime === "scheduled" ? { fulfilment: { requestedAt: parsed.scheduledAt, timeZone: parsed.timeZone, status: "unverified", source: "glovo-scheduled-search" } } : {}),
    },
  ])).values()], parsed);
  return {
    offers: discovered,
    providerMeta: {
      strategy: "merchant-discovery-then-complete-menu-scan",
      discoveryQueries,
      failedDiscoveryQueries: discoveryFailures.length,
      rateLimitedDiscoveryQueries: discoveryFailures.filter((result) => result.reason?.code === "RATE_LIMITED").length,
      catalogQueries,
      discoveredStores: allStores.length,
      eligibleStores: fulfilmentStores.length,
      excludedUnavailableStores: allStores.length - fulfilmentStores.length,
      searchedStores: fullMenus.length,
      catalogProducts: menuOffers.length,
      failedCatalogs,
      rateLimitedCatalogs: catalogErrors.filter((error) => error?.code === "RATE_LIMITED").length,
      failedCatalogQueries: catalogs.reduce((sum, catalog) => sum + catalog.failedQueries, 0),
      retrievalPlan: flags.retrievalPlan ?? null,
      deliveryLocation: {
        latitude: location.latitude,
        longitude: location.longitude,
        postcode: location.postcode ?? null,
        city: location.city ?? null,
        source: "glovo-saved-address",
      },
      partial: discoveryFailures.length > 0 || failedCatalogs > 0 || stores.length < fulfilmentStores.length
        || flags.retrievalPlan?.complete === false || catalogs.some((catalog) => catalog.failedQueries > 0),
      eligibilityRequired: catalogs.filter((catalog) => catalog.eligibility).map((catalog) => ({
        merchantId: catalog.store.id,
        merchantName: catalog.store.name,
        providerActionUrl: catalog.store.url,
        kind: catalog.eligibility.kind,
      })),
    },
  };
}

async function collectUberEats(intent, flags) {
  const parsed = parseIntent(intent);
  const queryPlan = uberEatsRetrievalQueries(flags, providerSearchQueries(parsed));
  const { queries, discoveryQueries, catalogQueries } = queryPlan;
  const shoppingItemCount = Array.isArray(flags.shoppingItems) ? flags.shoppingItems.length : 0;
  const requestedStoreLimit = Number(flags.stores);
  const storeLimit = Number.isFinite(requestedStoreLimit) && requestedStoreLimit > 0
    ? Math.max(1, Math.min(24, requestedStoreLimit))
    : Math.min(24, Math.max(12, shoppingItemCount * 3));
  const menuCache = new Map();
  const storeCache = new Map();
  const results = await settleConcurrent(queries, 1, async (query, index) => {
    if (index > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
    return searchUberEats(query, {
      limit: flags.limit,
      scheduledAt: parsed.scheduledAt,
      timeZone: parsed.timeZone,
      storeLimit,
      concurrency: 1,
      expandStores: false,
      menuCache,
      storeCache,
    });
  });
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  if (!fulfilled.length) throw results[0].reason;
  const failures = results.filter((result) => result.status === "rejected");
  const crossCatalogQueries = catalogQueries;
  let crossCatalog = { offers: [], searchedStores: 0, failedStores: 0, rateLimitedStores: 0 };
  let crossCatalogError = null;
  if (storeCache.size) {
    try {
      const priorityStoreIds = fulfilled.flatMap((result) => result.value.offers ?? [])
        .map((offer) => offer.merchant?.id).filter(Boolean);
      crossCatalog = await expandUberEatsCatalogs(storeCache.values(), [""], {
        menuCache,
        storeLimit,
        concurrency: 2,
        requestDelayMs: 250,
        scheduledAt: parsed.scheduledAt,
        timeZone: parsed.timeZone,
        priorityStoreIds,
      });
    } catch (error) { crossCatalogError = error; }
  }
  const offers = offersForFulfilment([...new Map([...fulfilled.flatMap((result) => result.value.offers), ...crossCatalog.offers]
    .map((offer) => [`${offer.merchant?.id}:${offer.item?.id}`, {
      ...offer,
      ...(parsed.deliveryTime === "scheduled" ? { fulfilment: { requestedAt: parsed.scheduledAt, timeZone: parsed.timeZone, status: "candidate", source: "uber-scheduled-search" } } : {}),
    }])).values()], parsed);
  const fulfilmentStores = storesForFulfilment("ubereats", [...storeCache.values()], parsed);
  let deliveryLocation = null;
  try { deliveryLocation = uberEatsDraftDeliveryLocation(await uberEatsCarts()); }
  catch { /* Search remains usable when there is no readable draft location. */ }
  return {
    offers,
    providerMeta: {
      strategy: "rate-aware-representative-search-and-prioritized-full-menu-expansion",
      queries,
      queryBudget: queryPlan.maximumQueries,
      omittedQueries: queryPlan.omittedQueries,
      completedQueries: fulfilled.length,
      failedQueries: failures.length,
      rateLimitedQueries: failures.filter((result) => result.reason?.code === "RATE_LIMITED").length
        + crossCatalog.rateLimitedStores
        + (crossCatalogError?.code === "RATE_LIMITED" ? 1 : 0),
      crossCatalogStores: crossCatalog.searchedStores,
      crossCatalogFailedStores: crossCatalog.failedStores,
      crossCatalogRateLimitedStores: crossCatalog.rateLimitedStores,
      crossCatalogOffers: crossCatalog.offers.length,
      crossCatalogError: crossCatalogError?.code ?? null,
      discoveredStores: storeCache.size,
      eligibleStores: fulfilmentStores.length,
      excludedUnavailableStores: storeCache.size - fulfilmentStores.length,
      unexpandedStoreCards: Math.max(0, fulfilmentStores.length - crossCatalog.searchedStores),
      catalogQueries: crossCatalogQueries,
      retrievalPlan: flags.retrievalPlan ?? null,
      deliveryLocation,
      partial: failures.length > 0 || crossCatalog.failedStores > 0 || Boolean(crossCatalogError)
        || flags.retrievalPlan?.complete === false,
    },
  };
}

export async function runConcurrentProviderTasks(providers, task) {
  return Promise.all(providers.map(async (provider) => {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    try {
      const value = await task(provider);
      return { provider, value, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs };
    } catch (error) {
      return { provider, error, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - startedMs };
    }
  }));
}

async function collectAllProviders(searchId, providers, intent, flags) {
  const collectors = { justeat: collectJustEat, glovo: collectGlovo, ubereats: collectUberEats };
  const outcomes = await runConcurrentProviderTasks(providers, async (provider) => {
    await assertProviderAvailable(provider);
    try {
      const value = await collectors[provider](intent, flags);
      const providerMeta = Array.isArray(value) ? null : value.providerMeta;
      const wasRateLimited = Object.entries(providerMeta ?? {})
        .some(([key, entry]) => /rateLimited/i.test(key) && Number(entry) > 0);
      if (wasRateLimited) {
        const cooldown = await recordProviderRateLimit(provider);
        if (providerMeta) providerMeta.cooldown = { retryAt: cooldown.retryAt, attempt: cooldown.attempt };
      } else await clearProviderCooldown(provider);
      return value;
    } catch (error) {
      if (error.code === "RATE_LIMITED" && error.details?.source !== "local-cooldown") {
        const cooldown = await recordProviderRateLimit(provider, { retryAfter: error.details?.retryAfter });
        error.details = {
          ...(error.details ?? {}),
          provider,
          retryAt: cooldown.retryAt,
          attempt: cooldown.attempt,
        };
      }
      if (provider === "justeat" || !["AUTH_EXPIRED", "AUTH_REQUIRED"].includes(error.code)) throw error;
      await refreshChromeProviderSession(provider);
      const value = await collectors[provider](intent, flags);
      await clearProviderCooldown(provider);
      return value;
    }
  });

  // Provider I/O is concurrent, but local search-file updates are serialized so
  // one provider cannot overwrite another provider's offers.
  for (const outcome of outcomes) {
    const timing = { startedAt: outcome.startedAt, completedAt: outcome.completedAt, durationMs: outcome.durationMs };
    if (outcome.error) await recordProviderError(searchId, outcome.provider, outcome.error, timing);
    else await ingestOffers(searchId, outcome.provider, Array.isArray(outcome.value) ? outcome.value : outcome.value.offers, {
      timing,
      providerMeta: Array.isArray(outcome.value) ? null : outcome.value.providerMeta,
      complete: Array.isArray(outcome.value) || !outcome.value.providerMeta?.partial,
    });
  }
}

async function refreshChromeProviderSession(provider) {
  const imported = await importChromeSession(provider, {
    profile: "auto",
    timeout: 30_000,
    verify: (session) => provider === "glovo"
      ? glovoMe({ session })
      : uberEatsMe({ cookieHeader: session.cookieHeader }),
  });
  const account = imported.verified;
  await recordProviderStatus(provider, { authenticated: true, membershipActive: account.membershipActive, transport: "api" });
  return { imported, account };
}

async function providerAuthStatus(provider) {
  if (provider === "justeat") {
    const status = await runLegacyJustEat(["auth", "status", "--agent"], { allowFailure: true });
    if (status?.error) return { provider, authenticated: false, source: null, error: status.error };
    return { provider, ...status };
  }
  const stored = await loadBrowserSession(provider);
  if (!stored) return { provider, authenticated: false, source: null, importedAt: null };
  try {
    const account = provider === "glovo" ? await glovoMe() : await uberEatsMe();
    const current = provider === "glovo" ? await loadBrowserSession(provider) : stored;
    return {
      provider,
      ...account,
      source: current.source,
      importedAt: current.importedAt ?? null,
      ...(provider === "glovo" ? { persistent: Boolean(current.refreshToken), accessExpiresAt: current.accessExpiresAt ?? null } : {}),
    };
  } catch (error) {
    if (["AUTH_EXPIRED", "AUTH_REQUIRED"].includes(error.code)) {
      try {
        const refreshed = await refreshChromeProviderSession(provider);
        return {
          provider,
          ...refreshed.account,
          source: refreshed.imported.source,
          importedAt: refreshed.imported.importedAt ?? null,
          ...(provider === "glovo" ? { persistent: refreshed.imported.persistent } : {}),
          refreshed: true,
        };
      } catch { /* return the original direct verification error below */ }
    }
    return { provider, authenticated: false, source: stored.source, importedAt: stored.importedAt ?? null, error: { code: error.code, message: error.message } };
  }
}

async function liveAccountsStatus() {
  const cached = publicAccountStatus(await loadAccounts());
  const liveResults = await Promise.all(cached.providers.map((account) => providerAuthStatus(account.id)));
  // Persist verified auth and membership state sequentially to avoid concurrent
  // account-file writers dropping another provider's update.
  for (const live of liveResults) {
    await recordProviderStatus(live.provider, {
      authenticated: Boolean(live.authenticated),
      membershipActive: live.membershipActive,
      transport: "api",
    });
  }
  const persisted = publicAccountStatus(await loadAccounts());
  const providers = persisted.providers.map((account) => {
    const live = liveResults.find((entry) => entry.provider === account.id);
    return {
      ...account,
      source: live?.source ?? null,
      ...(live?.refreshed ? { refreshed: true } : {}),
      ...(live?.persistent !== undefined ? { persistent: live.persistent } : {}),
      ...(live?.error ? { error: live.error } : {}),
    };
  });
  return { providers, live: true, verifiedAt: new Date().toISOString() };
}

export async function runOrderScout(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.agent) flags.compact = true;
  const [command, ...rest] = positionals;
  if (flags.version) return process.stdout.write(`${packageJson.version}\n`);
  if (!command || command === "help" || flags.help) return process.stdout.write(HELP);

  if (command === "mcp") return runOrderScoutMcpServer();
  if (command === "context") {
    const accounts = publicAccountStatus(await loadAccounts());
    return writeOutput({
      name: "OrderScout",
      version: packageJson.version,
      workflowContract: "llm-comparison-v8",
      requiredTools: [
        "orderscout_search_begin", "orderscout_candidates", "orderscout_record_external_evidence", "orderscout_select_candidates",
        "orderscout_review_provider", "orderscout_quote_comparison", "orderscout_results",
      ],
      country: "ES",
      providers: Object.values(PROVIDERS),
      accounts,
      comparison: ["exact delivered total", "fees", "membership benefits", "promotions", "ETA", "provider ratings", "quantity", "LLM request fit", "identity-matched external web evidence"],
      priceRule: "Exact cheapest requires a final checkout total for the best suitable offer from every enabled provider that returned a match; listed promotions count as exact only when checkout applies them.",
      purchaseBoundary: "Search, ingest, compare, quote recording, and browser opening never place an order. Final purchase remains provider-specific and requires exact human confirmation.",
    }, flags);
  }

  if (command === "auth") {
    const [action, provider] = rest;
    if (!provider || !PROVIDERS[provider]) throw new CliError("Use `orderscout auth login|complete|status|logout justeat|glovo|ubereats`");
    if (provider === "justeat") {
      if (action === "login") {
        const status = await runLegacyJustEat(["auth", "status", "--agent"]);
        if (status.authenticated) {
          return writeOutput({ ...status, opened: false, reused: true, next: "Already signed in; no browser login was needed." }, flags);
        }
        return writeOutput(await runLegacyJustEat(["auth", "browser-start", "--agent"]), flags);
      }
      const legacyAction = action === "complete" ? "browser-complete" : action;
      return writeOutput(await runLegacyJustEat(["auth", legacyAction, "--agent"]), flags);
    }
    if (action === "login") return writeOutput(beginBrowserLogin(provider), flags);
    if (action === "complete") {
      const refreshed = flags.profile || flags["cookie-path"]
        ? await importChromeSession(provider, {
          profile: flags.profile ?? "auto",
          cookiePath: flags["cookie-path"],
          timeout: Number(flags.timeout ?? 30_000),
          verify: (session) => provider === "glovo"
            ? glovoMe({ session })
            : uberEatsMe({ cookieHeader: session.cookieHeader }),
        }).then(async (imported) => {
          await recordProviderStatus(provider, { authenticated: true, membershipActive: imported.verified.membershipActive, transport: "api" });
          return { imported, account: imported.verified };
        })
        : await refreshChromeProviderSession(provider);
      const { verified: _verified, profile: chromeProfile, ...result } = refreshed.imported;
      const account = refreshed.account;
      return writeOutput({
        ...result,
        chromeProfile,
        profile: { id: account.id, name: account.name },
        membershipActive: account.membershipActive ?? null,
      }, flags);
    }
    if (action === "status") {
      return writeOutput(await providerAuthStatus(provider), flags);
    }
    if (action === "logout") {
      const result = await logoutBrowserSession(provider);
      await recordProviderStatus(provider, { authenticated: false });
      return writeOutput(result, flags);
    }
    throw new CliError("Use `orderscout auth login|complete|status|logout <provider>`");
  }

  if (command === "accounts") {
    const [action, provider] = rest;
    if (!action || action === "status") {
      return writeOutput(flags.cached ? publicAccountStatus(await loadAccounts()) : await liveAccountsStatus(), flags);
    }
    if (action === "set") {
      const enabledProviders = flags.providers ? parseProviderList(flags.providers) : undefined;
      return writeOutput(await configureAccounts({
        enabledProviders,
        accounts: jsonFlag(flags, "accounts", {}),
        memberships: jsonFlag(flags, "memberships", {}),
      }), flags);
    }
    if (action === "record") {
      return writeOutput(await recordProviderStatus(provider, {
        authenticated: booleanFlag(flags, "authenticated"),
        membershipActive: booleanFlag(flags, "membership"),
        transport: flags.transport,
        addressSelected: booleanFlag(flags, "address-selected"),
      }), flags);
    }
    throw new CliError("Use `orderscout accounts status|set|record`");
  }

  if (command === "recommend" || command === "search") {
    const action = command === "recommend" ? "begin" : rest[0];
    const args = command === "recommend" ? rest : rest.slice(1);
    if (action === "begin") {
      const intent = args.join(" ");
      if (flags.providers) throw new CliError("Search always uses every enabled account. Change providers with `orderscout accounts set --providers ...`.", "PROVIDER_SELECTION_IS_ACCOUNT_SETTING");
      const shoppingItems = shoppingItemsFlag(flags);
      const explicitDiscoveryQueries = stringArrayFlag(flags, "discovery-queries");
      const explicitCatalogQueries = stringArrayFlag(flags, "catalog-queries");
      const parsedIntent = parseIntent(intent);
      const fallback = providerSearchQueries(parsedIntent);
      const retrievalPlan = planProviderRetrieval({
        discoveryQueries: explicitDiscoveryQueries.length ? explicitDiscoveryQueries : fallback,
        catalogQueries: explicitCatalogQueries.length ? explicitCatalogQueries : fallback,
        shoppingItems,
        discoveryBudget: 24,
        catalogBudget: 24,
      });
      const discoveryQueries = retrievalPlan.discovery.queries;
      const catalogQueries = retrievalPlan.catalog.queries;
      const semanticMode = flags["semantic-mode"] === "llm" || flags.agent ? "llm" : "deterministic";
      const started = await startSearch(intent, {
        objective: flags.objective,
        locationHint: flags.at,
        semanticMode,
        shoppingItems,
        externalResearch: flags["external-research"] ?? "not_needed",
        externalDimensions: stringArrayFlag(flags, "external-dimensions"),
        queryPlan: {
          source: semanticMode === "llm" ? "llm-retrieval-plan" : "deterministic",
          semanticMode,
          discoveryQueries,
          catalogQueries,
          retrievalPlan,
        },
      });
      let result = started;
      if (!flags["skip-api"]) {
        await collectAllProviders(started.search.id, started.apiProviders, intent, {
          ...flags, discoveryQueries, catalogQueries, shoppingItems, semanticMode, retrievalPlan,
        });
        const finalResults = compactSearchResult(await searchResults(started.search.id), flags);
        result = completedSearchResponse(started, finalResults);
      }
      return writeOutput(result, flags);
    }
    if (action === "ingest") {
      const [searchId, provider] = args;
      return writeOutput(await ingestOffers(searchId, provider, jsonFlag(flags, "json"), {
        complete: booleanFlag(flags, "complete") ?? true,
      }), flags);
    }
    if (action === "error") {
      const [searchId, provider] = args;
      return writeOutput(await recordProviderError(searchId, provider, flags.message ?? "Provider search failed"), flags);
    }
    if (action === "candidates") {
      const [searchId] = args;
      return writeOutput(await searchCandidates(searchId, {
        offset: flags.offset,
        limit: flags.limit,
        provider: flags.provider,
        merchantId: flags["merchant-id"],
        query: flags.query,
      }), flags);
    }
    if (action === "evidence") {
      const [searchId] = args;
      return writeOutput(await recordExternalEvidence(searchId, jsonFlag(flags, "offer-ids"), jsonFlag(flags, "json")), flags);
    }
    if (action === "select") {
      const [searchId] = args;
      return writeOutput(await selectCandidates(searchId, jsonFlag(flags, "json")), flags);
    }
    if (action === "review") {
      const [searchId, provider] = args;
      return writeOutput(await reviewProvider(searchId, provider, flags.disposition, flags.reason), flags);
    }
    if (action === "results" || action === "show") return writeOutput(compactSearchResult(await searchResults(args[0]), flags), flags);
    throw new CliError("Use `orderscout search begin|ingest|error|candidates|select|review|results`");
  }

  if (command === "quote" && rest[0] === "record") {
    return writeOutput(await recordQuote(rest[1], rest[2], jsonFlag(flags, "json")), flags);
  }

  if (command === "eligibility" && rest[0] === "confirm") {
    return writeOutput(await confirmEligibility(rest[1], rest[2], booleanFlag(flags, "confirmed")), flags);
  }

  if (command === "comparison" && rest[0] === "quote") {
    return writeOutput(await quoteSelectedProviderComparison(rest[1], {
      customizations: jsonFlag(flags, "customizations", {}),
      allergenReviewed: booleanFlag(flags, "allergen-reviewed") === true,
    }), flags);
  }

  if (command === "basket") {
    const [action, searchId, offerId] = rest;
    if (!["prepare", "create", "checkout", "open"].includes(action)) throw new CliError("Use `orderscout basket prepare|create|checkout|open`");
    const search = await loadSearch(searchId);
    const offer = search.offers.find((entry) => entry.id === offerId);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    if (action === "open") {
      if (offer.provider === "justeat") {
        if (!offer.source?.planId) throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
        return writeOutput(await runLegacyJustEat(["order", "open", offer.source.planId, ...(flags["no-open"] ? ["--no-open"] : []), "--agent"]), flags);
      }
      if (offer.provider === "ubereats") {
        const handoff = uberEatsBasketHandoff(offer, { opened: !flags["no-open"] });
        if (!flags["no-open"]) await openSystemUrl(handoff.url);
        return writeOutput(handoff, flags);
      }
      const url = offer.provider === "glovo" ? glovoCheckoutUrl(offer) : null;
      if (!url) throw new CliError("This provider has no basket handoff", "BASKET_HANDOFF_REQUIRED");
      if (!flags["no-open"]) await openSystemUrl(url);
      return writeOutput({ provider: offer.provider, opened: !flags["no-open"], url, submitted: false }, flags);
    }
    assertAllergenReview(search, flags);
    if (action === "checkout") {
      const customizations = jsonFlag(flags, "customizations");
      const basket = offer.basket?.id
        ? offer.basket
        : await createBasketForOffer(search, offer, { customizations });
      if (!offer.basket?.id) {
        await recordBasket(searchId, offerId, {
          provider: offer.provider,
          id: String(basket.id),
          ...(basket.fulfilment ? { fulfilment: basket.fulfilment } : {}),
        });
      }
      const reviewed = await quoteBasketForOffer(search, offer, basket);
      return writeOutput(await saveCheckoutResult(
        searchId,
        offerId,
        reviewed.quoted,
        reviewed.pricing,
      ), flags);
    }
    if (offer.provider === "glovo") {
      const result = await createGlovoBasket(offer, { prepareOnly: action === "prepare", customizations: jsonFlag(flags, "customizations") });
      if (action === "create") {
        const id = result.basket?.basketId ?? result.basket?.id;
        if (id) await recordBasket(searchId, offerId, { provider: "glovo", id: String(id) });
      }
      return writeOutput(result, flags);
    }
    if (offer.provider === "ubereats") {
      const result = await createUberEatsBasket(offer, {
        prepareOnly: action === "prepare", customizations: jsonFlag(flags, "customizations"),
        scheduledAt: search.fulfilment?.requestedAt, timeZone: search.fulfilment?.timeZone,
      });
      if (action === "create") {
        const draft = result.draftOrder;
        const id = draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid;
        if (id) await recordBasket(searchId, offerId, { provider: "ubereats", id: String(id) });
      }
      return writeOutput(result, flags);
    }
    const source = offer.source;
    if (!source?.planId || !Number.isInteger(source.candidateIndex)) {
      throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
    }
    const args = ["order", "prepare", source.planId, "--candidate", String(source.candidateIndex), "--agent"];
    if (offer.lines?.length) {
      args.push("--lines", JSON.stringify(offer.lines.map((line) => ({
        candidateIndex: line.source?.candidateIndex,
        quantity: line.quantity ?? 1,
      }))));
    } else {
      args.push("--quantity", String(offer.quantity ?? 1));
    }
    const lineModifiers = justEatLineModifierSelections(offer, jsonFlag(flags, "customizations"));
    if (lineModifiers) args.push("--line-modifiers", JSON.stringify(lineModifiers));
    if (action === "create") args.push("--create");
    const result = await runLegacyJustEat(args);
    let configuration = null;
    if (action === "create") {
      configuration = await runLegacyJustEat([
        "order", "configure", source.planId,
        "--address-index", String(source.addressIndex ?? 0),
        ...(search.fulfilment?.requestedAt ? ["--scheduled", search.fulfilment.requestedAt] : []),
        "--apply", "--agent",
      ], { allowFailure: true });
      if (configuration?.error) throw new CliError(configuration.error.message ?? "Just Eat checkout configuration failed", configuration.error.code ?? "CHECKOUT_CONFIGURATION_FAILED", configuration.error.details);
      if (result?.basketId) await recordBasket(searchId, offerId, {
        provider: "justeat", id: String(result.basketId),
        ...(configuration?.selectedWindow ? { fulfilment: { requestedAt: search.fulfilment.requestedAt, timeZone: search.fulfilment.timeZone, status: "verified", selectedWindow: configuration.selectedWindow, source: "justeat-availabletimes" } } : {}),
      });
    }
    return writeOutput({ provider: "justeat", offerId, action, result, configuration, submitted: false }, flags);
  }

  if (command === "order" && rest[0] === "place") {
    const search = await loadSearch(rest[1]);
    const offer = search.offers.find((entry) => entry.id === rest[2]);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    assertAllergenReview(search, flags);
    if (offer.provider === "ubereats") {
      let id = offer.basket?.id;
      if (!id) {
        const carts = await uberEatsCarts();
        const draft = carts.draftOrders.find((entry) => String(entry.storeUuid ?? entry.storeUUID) === String(offer.source?.storeUuid));
        id = draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid;
      }
      if (!id) throw new CliError("Create this Uber Eats basket first", "BASKET_REQUIRED");
      const quoted = await quoteUberEatsBasket(id, {
        scheduledAt: search.fulfilment?.requestedAt, timeZone: search.fulfilment?.timeZone,
        expectedLines: offer.lines?.length
          ? offer.lines
          : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }],
      });
      if (!quoted.pricing.exact) throw new CliError("The scheduled Uber Eats checkout must be configured and requoted in the official checkout before placement", "SCHEDULED_CHECKOUT_REQUIRED");
      return writeOutput(await placeUberEatsOrder(id, quoted.quote, { confirm: flags.confirm }), flags);
    }
    if (offer.provider === "glovo") {
      let basketId = offer.basket?.id;
      if (!basketId) {
        const baskets = await glovoBaskets();
        const basket = baskets.baskets.find((entry) => String(entry.storeId) === String(offer.source?.storeId));
        basketId = basket?.basketId ?? basket?.id;
      }
      if (!basketId) throw new CliError("Create this Glovo basket first", "BASKET_REQUIRED");
      const quoted = await quoteGlovoBasket(basketId, {
        scheduledAt: search.fulfilment?.requestedAt, timeZone: search.fulfilment?.timeZone,
        expectedLines: offer.lines?.length
          ? offer.lines
          : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }],
      });
      return writeOutput(await placeGlovoOrder(offer, { basketId, ...quoted.quote }, { confirm: flags.confirm }), flags);
    }
    const source = offer.source;
    if (!source?.planId) throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
    return writeOutput(await runLegacyJustEat([
      "order", "place", source.planId,
      ...(flags.confirm ? ["--confirm", String(flags.confirm)] : []),
      "--agent",
    ]), flags);
  }

  if (command === "glovo") {
    const [action, ...args] = rest;
    if (action === "me") return writeOutput(await glovoMe({ raw: Boolean(flags.raw) }), flags);
    if (action === "addresses") return writeOutput({ addresses: await glovoAddresses() }, flags);
    if (action === "baskets") return writeOutput(await glovoBaskets(), flags);
    if (action === "search") {
      const intent = args.join(" ");
      const location = flags.at ? await resolveLocation(String(flags.at)) : (await glovoAddresses()).find((entry) => entry.isDefault) ?? (await glovoAddresses())[0];
      if (!location) throw new CliError("Pass --at or save an address in Glovo", "LOCATION_REQUIRED");
      return writeOutput(await searchGlovo(intent, location, { raw: Boolean(flags.raw), limit: flags.limit }), flags);
    }
    if (action === "menu") return writeOutput(await glovoMenu(args[0]), flags);
    throw new CliError("Use `orderscout glovo me|addresses|search|menu|baskets`");
  }

  if (command === "ubereats") {
    const [action, ...args] = rest;
    if (action === "me") return writeOutput(await uberEatsMe(), flags);
    if (action === "carts") return writeOutput(summarizeUberEatsCarts(await uberEatsCarts()), flags);
    if (action === "search") return writeOutput(await searchUberEats(args.join(" "), { raw: Boolean(flags.raw), limit: flags.limit }), flags);
    if (action === "menu") return writeOutput(await uberEatsMenu(args[0], { raw: Boolean(flags.raw) }), flags);
    throw new CliError("Use `orderscout ubereats me|search|menu|carts`");
  }

  if (command === "offer" && rest[0] === "open") {
    const search = await loadSearch(rest[1]);
    const offer = search.offers.find((entry) => entry.id === rest[2]);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    if (!offer.url) throw new CliError("Offer has no trusted provider URL", "OFFER_URL_MISSING");
    await openSystemUrl(offer.url);
    return writeOutput({ opened: true, browserActionRequired: false, provider: offer.provider, url: offer.url, submitted: false }, flags);
  }

  if (command === "justeat") {
    const result = await execFileAsync(process.execPath, [JUSTEAT_CLI, ...rest, ...Object.entries(flags).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)])], {
      encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }

  throw new CliError(`Unknown command ${command}`);
}

function isMainModule() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainModule()) {
  runOrderScout(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify(errorEnvelope(error))}\n`);
    process.exitCode = exitCodeFor(error);
  });
}
