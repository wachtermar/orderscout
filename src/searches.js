import { mkdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { CliError } from "./lib.js";
import {
  PROVIDER_IDS, PROVIDERS, atomicPrivateWrite, loadAccounts,
  providerPaths, publicAccountStatus, searchId,
} from "./providers.js";
import { normalizeOffer, parseObjective, rankOffers } from "./ranking.js";
import {
  isHealthyBreakfastItem, isPreparedBreakfastItem, parseIntent, parsePackVolume, productIntentSpec, productRelevance,
} from "./recommend.js";

const searchPath = (id) => join(providerPaths.searchesDirectory, `${validateId(id)}.json`);

const EXTERNAL_RESEARCH_MODES = new Set(["not_needed", "required", "unavailable"]);
const EXTERNAL_EVIDENCE_STATUSES = new Set(["found", "not_found", "ambiguous"]);
const EXTERNAL_SOURCE_TYPES = new Set([
  "official_menu", "official_site", "official_social", "independent_review", "local_press", "review_aggregator", "other",
]);
const EXTERNAL_CLAIM_DIMENSIONS = new Set([
  "spiciness", "food_quality", "outside_rating", "authenticity", "popularity", "portion_size", "healthiness", "dietary_fit", "other",
]);
const EXTERNAL_IDENTITY_SIGNALS = new Set(["name", "city", "address", "phone", "official_domain", "provider_url", "menu_item"]);

function validateId(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id ?? ""))) throw new CliError("Invalid OrderScout search ID", "INVALID_SEARCH_ID");
  return id;
}

export async function startSearch(intent, options = {}) {
  const text = String(intent ?? "").trim();
  if (!text) throw new CliError("Describe what you want", "INTENT_REQUIRED");
  const accounts = await loadAccounts();
  const enabled = PROVIDER_IDS.filter((id) => accounts.providers[id].enabled && accounts.providers[id].hasAccount !== false);
  if (!enabled.length) throw new CliError("No enabled providers have an account", "NO_ENABLED_PROVIDERS");
  const parsedIntent = parseIntent(text, options);
  const externalResearch = normalizeExternalResearchPlan(options.externalResearch, options.externalDimensions);
  const search = {
    id: searchId(),
    version: 2,
    intent: text,
    parsedIntent,
    fulfilment: {
      mode: parsedIntent.deliveryTime,
      requestedAt: parsedIntent.scheduledAt,
      timeZone: parsedIntent.timeZone,
    },
    objective: options.objective ?? parseObjective(text),
    locationHint: options.locationHint ?? null,
    queryPlan: options.queryPlan ?? { source: "deterministic", discoveryQueries: [], catalogQueries: [] },
    semanticMode: options.semanticMode === "llm" ? "llm" : "deterministic",
    shoppingItems: Array.isArray(options.shoppingItems) ? options.shoppingItems : [],
    externalResearch,
    providers: enabled,
    providerStatus: Object.fromEntries(enabled.map((id) => [id, { state: "pending", error: null }])),
    orchestration: "concurrent",
    offers: [],
    selections: [],
    providerReviews: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(providerPaths.searchesDirectory, { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(searchPath(search.id), search);
  const routes = providerRoutes(enabled, accounts);
  return {
    search: summarizeSearch(search),
    accounts: publicAccountStatus(accounts),
    ...routes,
  };
}

export function normalizeExternalResearchPlan(mode = "not_needed", dimensions = []) {
  const normalizedMode = String(mode ?? "not_needed").trim();
  if (!EXTERNAL_RESEARCH_MODES.has(normalizedMode)) {
    throw new CliError("External research must be not_needed, required, or unavailable", "INVALID_EXTERNAL_RESEARCH");
  }
  if (!Array.isArray(dimensions) || dimensions.length > 8) {
    throw new CliError("External research dimensions must be an array with at most 8 values", "INVALID_EXTERNAL_RESEARCH");
  }
  const normalizedDimensions = [...new Set(dimensions.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  for (const dimension of normalizedDimensions) {
    if (!EXTERNAL_CLAIM_DIMENSIONS.has(dimension)) {
      throw new CliError(`Unsupported external research dimension: ${dimension}`, "INVALID_EXTERNAL_RESEARCH");
    }
  }
  if (["required", "unavailable"].includes(normalizedMode) && !normalizedDimensions.length) {
    throw new CliError(`${normalizedMode} external research needs at least one qualitative dimension`, "INVALID_EXTERNAL_RESEARCH");
  }
  if (normalizedMode === "not_needed" && normalizedDimensions.length) {
    throw new CliError("External research dimensions require required or unavailable mode", "INVALID_EXTERNAL_RESEARCH");
  }
  return { mode: normalizedMode, dimensions: normalizedDimensions };
}

export function providerRoutes(enabled, accounts) {
  return {
    // Provider operations are always executed by OrderScout's CLI adapters.
    // A previously recorded browser session must never turn the browser into
    // a search, menu, basket, or checkout execution backend.
    apiProviders: enabled.filter((provider) => PROVIDERS[provider].transport === "api"),
    browserProviders: [],
  };
}

export async function loadSearch(id) {
  try { return JSON.parse(await readFile(searchPath(id), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new CliError("OrderScout search not found", "SEARCH_NOT_FOUND");
    throw error;
  }
}

export async function writeSearch(search) {
  search.updatedAt = new Date().toISOString();
  await atomicPrivateWrite(searchPath(search.id), search);
  return search;
}

export async function ingestOffers(id, provider, inputs, options = {}) {
  const search = await loadSearch(id);
  if (!search.providers.includes(provider)) throw new CliError(`${provider} is not enabled for this search`, "PROVIDER_NOT_ENABLED");
  const accounts = await loadAccounts();
  const rawInputs = Array.isArray(inputs) ? inputs : [inputs];
  let values = semanticInputsForSearch(search, rawInputs);
  if (search.fulfilment?.mode === "scheduled") {
    values = values.map((input) => ({
      ...input,
      available: input.fulfilment?.status === "unavailable" ? false : true,
      fulfilment: {
        requestedAt: search.fulfilment.requestedAt,
        timeZone: search.fulfilment.timeZone,
        status: input.fulfilment?.status ?? "unverified",
        selectedWindow: input.fulfilment?.selectedWindow ?? null,
        source: input.fulfilment?.source ?? null,
      },
    }));
  }
  const normalized = values.map((input) => normalizeOffer(provider, input, {
    membership: accounts.providers[provider].membership,
  }));
  const incomingIds = new Set(normalized.map((offer) => offer.id));
  search.offers = [...search.offers.filter((offer) => offer.provider !== provider || !incomingIds.has(offer.id)), ...normalized];
  search.providerStatus[provider] = {
    state: options.complete === false ? "partial" : "complete",
    error: null,
    offerCount: normalized.length,
    candidateCount: search.semanticMode === "llm" ? normalized.length : undefined,
    ...(options.providerMeta ? { discovery: options.providerMeta } : {}),
    ...(options.timing ?? {}),
  };
  await writeSearch(search);
  return resultsFor(search);
}

export function semanticInputsForSearch(search, inputs) {
  return search.semanticMode === "llm" ? inputs : applyIntent(inputs, search.intent);
}

export function applyIntent(inputs, text) {
  const intent = parseIntent(text);
  if (intent.kind === "meal") {
    const positive = ["ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable", "pollo", "chicken", "pavo", "salm", "atun", "tuna", "quinoa", "integral", "healthy", "saludable", "vegan", "vegano", "vegetar", "fruta", "fruit", "huevo", "egg", "yogur", "avena", "oat", "granola", "aguacate", "avocado", "tostada", "toast", "acai", "chia"];
    const negative = ["frito", "fried", "burger", "hamburgues", "pizza", "donut", "tarta", "cake", "helado", "chocolate", "bacon", "patatas", "fries", "mayonesa", "empanado", "breaded", "battered", "croqueta", "crispy", "creamy", "chips"];
    const stronglyIndulgent = ["frito", "fried", "burger", "hamburgues", "pizza", "donut", "cake", "empanado", "breaded", "battered", "croqueta", "chips"];
    const healthyAnchors = ["ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable", "quinoa", "integral", "healthy", "saludable", "vegan", "vegano", "vegetar", "fruta", "fruit", "huevo", "egg", "yogur", "avena", "oat", "granola", "aguacate", "avocado", "tostada", "toast", "acai", "chia"];
    const dietaryTerms = {
      vegan: ["vegan", "vegano", "vegana"],
      vegetarian: ["vegetarian", "vegetariano", "vegetariana"],
      pescatarian: ["pescatarian", "pescetarian", "pescetariano", "pescetariana"],
      halal: ["halal"], kosher: ["kosher"],
      glutenFree: ["gluten free", "sin gluten"],
      lactoseFree: ["lactose free", "sin lactosa", "lactosa cero"],
      dairyFree: ["dairy free", "without dairy", "sin lacteos", "sin leche"],
      nutFree: ["nut free", "without nuts", "sin frutos secos", "sin nueces"],
      keto: ["keto", "ketogenic", "cetogenico", "cetogenica"],
      lowCarb: ["low carb", "low carbohydrate", "bajo en carbohidratos", "baja en carbohidratos"],
      noPork: ["no pork", "without pork", "sin cerdo"],
    };
    const eligible = inputs.flatMap((input) => {
      const itemName = `${input.item?.name ?? input.itemName ?? ""}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const itemText = `${itemName} ${input.item?.description ?? ""}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (intent.occasion === "breakfast" && !isPreparedBreakfastItem(itemName, `${input.item?.description ?? ""} ${input.merchant?.name ?? input.merchantName ?? ""}`)) return [];
      if (intent.occasion === "breakfast" && intent.healthy && !isHealthyBreakfastItem(itemText)) return [];
      if (Object.entries(intent.dietary).some(([key, required]) => required && !dietaryTerms[key].some((term) => itemText.includes(term)))) return [];
      const health = positive.filter((term) => itemText.includes(term)).length * 12
        - negative.filter((term) => itemText.includes(term)).length * 9;
      if (intent.healthy && (health <= 0
        || !healthyAnchors.some((term) => itemText.includes(term))
        || stronglyIndulgent.some((term) => itemText.includes(term)))) return [];
      const unitPrice = Number(input.item?.unitPrice ?? input.unitPrice);
      const subtotal = Number.isFinite(unitPrice) ? Math.round(unitPrice * 100) / 100 : null;
      if (intent.budget !== null && subtotal !== null && subtotal > intent.budget) return [];
      const rating = Number(input.merchant?.rating ?? input.rating);
      return [{
        ...input,
        quantity: 1,
        pricing: { ...input.pricing, subtotal, total: null, exact: false },
        signals: {
          ...input.signals,
          health,
          taste: Number.isFinite(rating) ? Math.round(rating * 20) : Number(input.signals?.taste ?? 0),
        },
      }];
    });
    return (intent.people ?? 1) > 1 ? composeMealBundles(eligible, intent) : eligible;
  }
  if (intent.kind === "product") {
    const spec = productIntentSpec(intent);
    return inputs.flatMap((input) => {
      const fit = productRelevance(spec, input);
      if (!fit.relevant) return [];
      const quantity = Math.max(1, Number(input.quantity ?? 1));
      const unitPrice = Number(input.item?.unitPrice ?? input.unitPrice);
      const subtotal = Number.isFinite(unitPrice) ? Math.round(unitPrice * quantity * 100) / 100 : null;
      if (intent.budget !== null && subtotal !== null && subtotal > intent.budget) return [];
      return [{
        ...input,
        pricing: { ...input.pricing, subtotal, total: input.pricing?.exact ? input.pricing?.total ?? null : null },
        signals: {
          ...input.signals,
          relevance: fit.relevance,
          preference: fit.preference,
          matchedCore: fit.matchedCore,
          matchedPreference: fit.matchedPreference,
        },
      }];
    });
  }
  return inputs.flatMap((input) => {
    const itemText = `${input.item?.name ?? input.itemName ?? ""} ${input.item?.description ?? ""}`;
    const normalized = itemText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!/\b(agua|water)\b/.test(normalized) || /(watermelon|sandia|aquarius|agua de coco|coconut|flavor|mix|kombucha)/.test(normalized)) return [];
    const sparkling = /(con gas|sparkling|gaseosa)/.test(normalized);
    if (intent.sparkling !== sparkling) return [];
    const pack = input.package ?? parsePackVolume(itemText);
    if (!pack?.totalLiters) return [];
    const quantity = Math.max(1, Math.ceil(intent.targetLiters / pack.totalLiters));
    const unitPrice = Number(input.item?.unitPrice ?? input.unitPrice);
    const subtotal = Number.isFinite(unitPrice) ? Math.round(unitPrice * quantity * 100) / 100 : null;
    if (intent.budget !== null && subtotal !== null && subtotal > intent.budget) return [];
    return [{
      ...input,
      quantity,
      package: pack,
      suppliedLiters: Math.round(pack.totalLiters * quantity * 1_000) / 1_000,
      pricing: {
        ...input.pricing,
        originalSubtotal: Number.isFinite(Number(input.pricing?.originalSubtotal))
          ? Math.round(Number(input.pricing.originalSubtotal) * quantity * 100) / 100 : null,
        subtotal,
        itemSavings: Math.round(Number(input.pricing?.itemSavings ?? 0) * quantity * 100) / 100,
        total: null,
        exact: false,
      },
    }];
  });
}

function mealText(input) {
  return `${input.item?.name ?? input.itemName ?? ""} ${input.item?.description ?? ""}`
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function isMainCourse(input) {
  const value = mealText(input);
  const unitPrice = Number(input.item?.unitPrice ?? input.unitPrice ?? 0);
  const complete = /\b(menu|meal|combo|plato|plate|poke|bowl|ramen|sushi|pasta|noodles?|tallarines?|curry|tikka|tandoori|kebab|kabse|paella|desayuno|breakfast|brunch|tostada|toast|avena|oatmeal|porridge|granola|yogur|yogurt|bagel|pancakes?)\b/.test(value)
    || isPreparedBreakfastItem(value);
  const protein = /\b(pollo|chicken|pavo|turkey|salmon|atun|tuna|tofu|seitan|ternera|beef|carne|cordero|lamb|pescado|fish|gambas?|prawns?)\b/.test(value);
  const preparation = /\b(plancha|grilled|roast|asado|verduras?|vegetables?)\b/.test(value);
  const salad = /\b(ensalada|salad)\b/.test(value);
  const sideOnly = /\b(gyozas?|dumplings?|empanadillas?|dim sum|spring rolls?|rollitos?|sopa|soup|patatas|fries|arroz|rice|pan|bread|bebida|drink|postre|dessert|edamame|hummus|tabbouleh|wakame|salsa)\b/.test(value);
  return complete || (!sideOnly && protein && unitPrice >= 8 && (preparation || !salad)) || (salad && protein && unitPrice >= 8);
}

function mealIdentity(name) {
  return String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\b(?:small|medium|large|pequeno|pequena|mediano|mediana|grande|xl|\d+\s*(?:g|gr|ml))\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function servesParty(input, people) {
  const value = mealText(input);
  return new RegExp(`(?:for|para)\\s*${people}\\b|${people}\\s*(?:people|personas?|comensales?)\\b|\\b(?:sharing|compartir|familiar|family)\\b`).test(value);
}

function estimatedFeeReserve(group) {
  const sample = group[0]?.pricing ?? {};
  const deliveryValue = sample.fees?.delivery ?? sample.deliveryFee;
  const serviceValue = sample.fees?.service;
  const delivery = deliveryValue === null || deliveryValue === undefined ? Number.NaN : Number(deliveryValue);
  const service = serviceValue === null || serviceValue === undefined ? Number.NaN : Number(serviceValue);
  const provider = group[0]?.provider;
  const unknownReserve = provider === "justeat" ? { delivery: 1.5, service: 1 }
    : provider === "glovo" ? { delivery: 2.5, service: 1 }
      : { delivery: 2.5, service: 1.5 };
  return Math.round(((Number.isFinite(delivery) ? delivery : unknownReserve.delivery)
    + (Number.isFinite(service) ? service : unknownReserve.service)) * 100) / 100;
}

function bundleCombinations(values, size, limit = 80) {
  const output = [];
  function visit(start, selected) {
    if (output.length >= limit) return;
    if (selected.length === size) {
      output.push([...selected]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      selected.push(values[index]);
      visit(index + 1, selected);
      selected.pop();
      if (output.length >= limit) return;
    }
  }
  visit(0, []);
  return output;
}

export function composeMealBundles(inputs, intent) {
  const people = Math.max(2, Math.min(8, Number(intent.people ?? 2)));
  const grouped = new Map();
  for (const input of inputs) {
    const merchantKey = String(input.merchant?.id ?? input.merchant?.name ?? input.merchantName ?? "");
    if (!merchantKey) continue;
    const key = `${input.provider ?? ""}:${merchantKey}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(input);
  }
  const bundles = [];
  for (const group of grouped.values()) {
    const feeReserve = estimatedFeeReserve(group);
    const budgetSubtotal = intent.budget === null ? Number.POSITIVE_INFINITY : Math.max(0, intent.budget - feeReserve);
    const shared = group.filter((input) => servesParty(input, people));
    const mains = group.filter(isMainCourse)
      .sort((left, right) => (Number(right.signals?.health ?? 0) + Number(right.signals?.taste ?? 0) * 0.2)
        - (Number(left.signals?.health ?? 0) + Number(left.signals?.taste ?? 0) * 0.2)
        || Number(left.item?.unitPrice ?? Infinity) - Number(right.item?.unitPrice ?? Infinity))
      .slice(0, 12);
    const combinations = [
      ...shared.map((input) => [input]),
      ...bundleCombinations(mains, people),
    ];
    const merchantBundles = [];
    for (const lines of combinations) {
      const names = lines.map((line) => String(line.item?.name ?? line.itemName ?? "").trim());
      if (new Set(names.map(mealIdentity)).size !== names.length) continue;
      const subtotal = Math.round(lines.reduce((sum, line) => sum + Number(line.item?.unitPrice ?? line.unitPrice ?? 0), 0) * 100) / 100;
      if (!Number.isFinite(subtotal) || subtotal <= 0 || subtotal > budgetSubtotal) continue;
      const estimatedTotal = Math.round((subtotal + feeReserve) * 100) / 100;
      const first = lines[0];
      const health = Math.round(lines.reduce((sum, line) => sum + Number(line.signals?.health ?? 0), 0) / lines.length);
      const taste = Math.round(lines.reduce((sum, line) => sum + Number(line.signals?.taste ?? 0), 0) / lines.length);
      const lineItems = lines.map((line) => ({
        item: { ...line.item },
        quantity: 1,
        pricing: line.pricing ?? null,
        promotion: line.promotion ?? null,
        source: line.source,
        signals: line.signals,
      }));
      const itemSavings = Math.round(lines.reduce((sum, line) => sum + Number(line.pricing?.itemSavings ?? 0), 0) * 100) / 100;
      const originalSubtotal = itemSavings > 0 ? Math.round((subtotal + itemSavings) * 100) / 100 : null;
      const promotions = lines.map((line) => line.promotion).filter(Boolean);
      const promotion = promotions.length ? {
        types: [...new Set(promotions.flatMap((deal) => deal.types ?? []))],
        descriptions: [...new Set(promotions.flatMap((deal) => deal.descriptions ?? []))],
        ids: [...new Set(promotions.flatMap((deal) => deal.ids ?? []))],
        eligible: promotions.every((deal) => deal.eligible !== false),
        applied: promotions.some((deal) => deal.applied) || itemSavings > 0,
        savings: itemSavings,
        source: promotions.map((deal) => deal.source).filter(Boolean).join("+") || null,
      } : null;
      merchantBundles.push({
        ...first,
        item: {
          id: lineItems.map((line) => line.item.id).filter(Boolean).join("+") || null,
          name: names.join(" + "),
          description: `A ${people}-person meal with ${names.join(" and ")}.`,
          unitPrice: subtotal,
        },
        quantity: 1,
        servesPeople: people,
        composition: { kind: lines.length === 1 ? "sharing-item" : "distinct-dishes", distinctItems: lines.length > 1 },
        lines: lineItems,
        pricing: { ...first.pricing, originalSubtotal, subtotal, itemSavings, total: estimatedTotal, exact: false },
        promotion,
        source: { ...first.source, bundle: true },
        signals: { ...first.signals, health, taste },
      });
    }
    merchantBundles.sort((left, right) => Number(right.signals?.health ?? 0) - Number(left.signals?.health ?? 0)
      || Number(right.signals?.taste ?? 0) - Number(left.signals?.taste ?? 0)
      || Number(left.pricing?.total ?? Infinity) - Number(right.pricing?.total ?? Infinity));
    bundles.push(...merchantBundles.slice(0, 8));
  }
  return bundles.sort((left, right) => Number(right.signals?.health ?? 0) - Number(left.signals?.health ?? 0)
    || Number(right.signals?.taste ?? 0) - Number(left.signals?.taste ?? 0)
    || Number(left.pricing?.total ?? Infinity) - Number(right.pricing?.total ?? Infinity));
}

export async function recordProviderError(id, provider, error, timing = {}) {
  const search = await loadSearch(id);
  const message = error instanceof Error ? error.message : String(error);
  search.providerStatus[provider] = {
    state: "error",
    error: message.slice(0, 300),
    errorCode: error?.code ?? timing.errorCode ?? null,
    ...(error?.details ? { errorDetails: error.details } : {}),
    offerCount: 0,
    ...timing,
  };
  await writeSearch(search);
  return resultsFor(search);
}

export function offerWithRecordedQuote(offer, pricing) {
  const basket = offer.basket;
  const normalized = normalizeOffer(offer.provider, {
    ...offer,
    pricing: { ...offer.pricing, ...pricing, exact: true },
    ...(pricing.fulfilment ? { fulfilment: pricing.fulfilment } : {}),
  });
  if (basket) normalized.basket = basket;
  return normalized;
}

export async function recordQuote(id, offerId, pricing) {
  const search = await loadSearch(id);
  const index = search.offers.findIndex((offer) => offer.id === offerId);
  if (index < 0) throw new CliError("Offer not found in this search", "OFFER_NOT_FOUND");
  search.offers[index] = offerWithRecordedQuote(search.offers[index], pricing);
  await writeSearch(search);
  return resultsFor(search);
}

export async function recordComparisonOutcomes(id, outcomes) {
  const search = await loadSearch(id);
  const recordedAt = new Date().toISOString();
  const values = Array.isArray(outcomes) ? outcomes : [];
  search.comparisonQuotes = { ...(search.comparisonQuotes ?? {}) };
  for (const outcome of values) {
    if (!outcome?.provider) continue;
    search.comparisonQuotes[outcome.provider] = {
      provider: outcome.provider,
      offerId: outcome.offerId ?? null,
      status: outcome.status ?? "error",
      basketId: outcome.basketId ?? null,
      pricing: outcome.pricing ?? null,
      fulfilment: outcome.fulfilment ?? null,
      issues: outcome.issues ?? [],
      customizationReview: outcome.customizationReview ?? null,
      error: outcome.error ?? null,
      recordedAt,
    };
    if (!outcome.offerId) continue;
    const index = search.offers.findIndex((offer) => offer.id === outcome.offerId);
    if (index < 0) continue;
    let offer = search.offers[index];
    if (outcome.basketId) {
      offer = {
        ...offer,
        basket: {
          provider: outcome.provider,
          id: String(outcome.basketId),
          ...(outcome.fulfilment ? { fulfilment: outcome.fulfilment } : {}),
          createdAt: outcome.basketCreatedAt ?? offer.basket?.createdAt ?? recordedAt,
        },
      };
    }
    if (outcome.pricing) {
      const basket = offer.basket;
      offer = normalizeOffer(offer.provider, {
        ...offer,
        pricing: { ...offer.pricing, ...outcome.pricing },
        ...(outcome.fulfilment ? { fulfilment: outcome.fulfilment } : {}),
      });
      if (basket) offer.basket = basket;
    } else if (outcome.status === "error") {
      const basket = offer.basket;
      const lineSubtotals = offer.lines?.map((line) => Number(line.pricing?.subtotal));
      const subtotal = lineSubtotals?.length && lineSubtotals.every(Number.isFinite)
        ? Math.round(lineSubtotals.reduce((sum, value) => sum + value, 0) * 100) / 100
        : offer.pricing?.subtotal;
      offer = normalizeOffer(offer.provider, {
        ...offer,
        pricing: {
          ...offer.pricing,
          subtotal,
          fees: { delivery: null, service: null, smallOrder: null, bag: null, other: null },
          discount: 0,
          total: null,
          exact: false,
        },
      });
      if (basket) offer.basket = basket;
    }
    search.offers[index] = offer;
  }
  search.comparisonQuoteRun = {
    recordedAt,
    providers: values.map((outcome) => outcome.provider).filter(Boolean),
    complete: values.length > 0 && values.every((outcome) => ["quoted", "provisional", "error"].includes(outcome.status)),
  };
  await writeSearch(search);
  return resultsFor(search);
}

export async function recordBasket(id, offerId, basket) {
  const search = await loadSearch(id);
  const index = search.offers.findIndex((offer) => offer.id === offerId);
  if (index < 0) throw new CliError("Offer not found in this search", "OFFER_NOT_FOUND");
  search.offers[index] = {
    ...search.offers[index],
    basket: { ...basket, createdAt: new Date().toISOString() },
  };
  await writeSearch(search);
  return search.offers[index];
}

export async function confirmEligibility(id, offerId, confirmed) {
  if (confirmed !== true) throw new CliError("Explicit legal-age confirmation is required", "AGE_CONFIRMATION_REQUIRED");
  const search = await loadSearch(id);
  const selected = search.offers.find((offer) => offer.id === offerId);
  const eligibility = selected?.source?.eligibility
    ?? selected?.lines?.map((line) => line.source?.eligibility).find(Boolean);
  if (!selected) throw new CliError("Offer not found in this search", "OFFER_NOT_FOUND");
  if (selected.provider !== "glovo" || eligibility?.kind !== "legal_age") {
    throw new CliError("This offer has no Glovo legal-age requirement", "ELIGIBILITY_NOT_REQUIRED");
  }
  const storeId = selected.source?.storeId ?? selected.lines?.[0]?.source?.storeId;
  const confirmedAt = new Date().toISOString();
  let updatedOffers = 0;
  const confirmSource = (source) => source?.eligibility?.kind === "legal_age"
    ? { ...source, eligibility: { ...source.eligibility, status: "confirmed", confirmedAt } }
    : source;
  search.offers = search.offers.map((offer) => {
    const offerStoreId = offer.source?.storeId ?? offer.lines?.[0]?.source?.storeId;
    if (offer.provider !== "glovo" || String(offerStoreId) !== String(storeId)) return offer;
    updatedOffers += 1;
    return {
      ...offer,
      source: confirmSource(offer.source),
      lines: offer.lines?.map((line) => ({ ...line, source: confirmSource(line.source) })) ?? offer.lines,
    };
  });
  await writeSearch(search);
  return { provider: "glovo", storeId, status: "confirmed", confirmedAt, updatedOffers };
}

function isLlmSelection(offer) {
  return offer.source?.llmSelected === true;
}

function merchantKey(offer) {
  return `${offer.provider}:${offer.merchant?.id ?? offer.merchant?.name ?? ""}`;
}

function selectionPromotion(lines) {
  const promotions = lines.map((line) => line.promotion).filter(Boolean);
  if (!promotions.length) return null;
  return {
    types: [...new Set(promotions.flatMap((promotion) => promotion.types ?? []))],
    descriptions: [...new Set(promotions.flatMap((promotion) => promotion.descriptions ?? []))],
    ids: [...new Set(promotions.flatMap((promotion) => promotion.ids ?? []))],
    eligible: promotions.every((promotion) => promotion.eligible !== false),
    applied: promotions.some((promotion) => promotion.applied),
    savings: Math.round(lines.reduce((sum, line) => sum + Number(line.pricing?.itemSavings ?? 0), 0) * 100) / 100,
    source: "llm-selected-lines",
  };
}

function lexicalForms(value) {
  return new Set([
    value,
    ...(value.endsWith("ies") && value.length > 4 ? [`${value.slice(0, -3)}y`] : []),
    ...(value.endsWith("es") && value.length > 4 ? [value.slice(0, -2)] : []),
    ...(value.endsWith("s") && value.length > 3 ? [value.slice(0, -1)] : []),
  ]);
}

export function candidatePageForSearch(search, options = {}) {
  let candidates = search.offers.filter((offer) => !isLlmSelection(offer));
  if (options.provider) candidates = candidates.filter((offer) => offer.provider === options.provider);
  if (options.merchantId) candidates = candidates.filter((offer) => String(offer.merchant?.id) === String(options.merchantId));
  if (options.query) {
    const terms = String(options.query).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .split(/[^a-z0-9]+/).filter(Boolean);
    candidates = candidates.filter((offer) => {
      const text = `${offer.merchant?.name ?? ""} ${offer.item?.name ?? ""} ${offer.item?.description ?? ""} ${offer.item?.category ?? ""}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
      return terms.every((term) => {
        const wanted = lexicalForms(term);
        return tokens.some((token) => [...lexicalForms(token)].some((form) => wanted.has(form)));
      });
    });
  }
  const offset = Math.max(0, Math.trunc(Number(options.offset ?? 0)) || 0);
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(options.limit ?? 50)) || 50));
  const page = candidates.slice(offset, offset + limit);
  return {
    searchId: search.id,
    semanticMode: search.semanticMode ?? "deterministic",
    total: candidates.length,
    offset,
    limit,
    hasMore: offset + page.length < candidates.length,
    nextOffset: offset + page.length < candidates.length ? offset + page.length : null,
    candidates: page,
  };
}

export async function searchCandidates(id, options = {}) {
  return candidatePageForSearch(await loadSearch(id), options);
}

function boundedText(value, label, maximum, required = true) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new CliError(`${label} is required`, "INVALID_EXTERNAL_EVIDENCE");
  if (text.length > maximum) throw new CliError(`${label} is too long`, "INVALID_EXTERNAL_EVIDENCE");
  return text || null;
}

function externalSourceUrl(value) {
  let url;
  try { url = new URL(String(value ?? "")); } catch { throw new CliError("External evidence source URL is invalid", "INVALID_EXTERNAL_EVIDENCE"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new CliError("External evidence must use a public HTTP(S) source without embedded credentials", "INVALID_EXTERNAL_EVIDENCE");
  }
  const host = url.hostname.toLowerCase();
  const unbracketedHost = host.replace(/^\[|\]$/g, "");
  if (!host || isIP(unbracketedHost) || host === "localhost" || host.endsWith(".local") || /^127\./.test(host) || /^10\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^0\./.test(host) || host === "::1") {
    throw new CliError("External evidence source must be a public web page", "INVALID_EXTERNAL_EVIDENCE");
  }
  url.hash = "";
  return url.toString();
}

function normalizeExternalClaim(input) {
  if (!input || typeof input !== "object") throw new CliError("External evidence claims must be objects", "INVALID_EXTERNAL_EVIDENCE");
  const dimension = String(input.dimension ?? "").trim();
  if (!EXTERNAL_CLAIM_DIMENSIONS.has(dimension)) throw new CliError(`Unsupported external claim dimension: ${dimension}`, "INVALID_EXTERNAL_EVIDENCE");
  const confidence = String(input.confidence ?? "").trim();
  if (!["low", "medium", "high"].includes(confidence)) throw new CliError("External claim confidence must be low, medium, or high", "INVALID_EXTERNAL_EVIDENCE");
  const scope = String(input.scope ?? "merchant").trim();
  if (!["merchant", "item"].includes(scope)) throw new CliError("External claim scope must be merchant or item", "INVALID_EXTERNAL_EVIDENCE");
  let rating = null;
  if (input.rating !== undefined && input.rating !== null) {
    const value = Number(input.rating.value);
    const scale = Number(input.rating.scale);
    const count = input.rating.count === undefined || input.rating.count === null ? null : Number(input.rating.count);
    if (!Number.isFinite(value) || !Number.isFinite(scale) || scale <= 0 || value < 0 || value > scale
      || (count !== null && (!Number.isInteger(count) || count < 0))) {
      throw new CliError("External rating requires a value within its positive scale and an optional non-negative count", "INVALID_EXTERNAL_EVIDENCE");
    }
    rating = { value, scale, count };
  }
  return {
    dimension,
    summary: boundedText(input.summary, "External claim summary", 500),
    confidence,
    scope,
    ...(rating ? { rating } : {}),
  };
}

function normalizeExternalSource(input) {
  if (!input || typeof input !== "object") throw new CliError("External evidence sources must be objects", "INVALID_EXTERNAL_EVIDENCE");
  const sourceType = String(input.sourceType ?? "").trim();
  if (!EXTERNAL_SOURCE_TYPES.has(sourceType)) throw new CliError(`Unsupported external source type: ${sourceType}`, "INVALID_EXTERNAL_EVIDENCE");
  if (!Array.isArray(input.claims) || !input.claims.length || input.claims.length > 8) {
    throw new CliError("Each external source requires 1 to 8 structured claims", "INVALID_EXTERNAL_EVIDENCE");
  }
  const retrievedAt = input.retrievedAt ? new Date(input.retrievedAt) : new Date();
  if (Number.isNaN(retrievedAt.getTime())) throw new CliError("External source retrievedAt must be a valid date", "INVALID_EXTERNAL_EVIDENCE");
  return {
    url: externalSourceUrl(input.url),
    title: boundedText(input.title, "External source title", 300),
    publisher: boundedText(input.publisher, "External source publisher", 200),
    sourceType,
    retrievedAt: retrievedAt.toISOString(),
    claims: input.claims.map(normalizeExternalClaim),
  };
}

export function normalizeExternalEvidence(input) {
  if (!input || typeof input !== "object") throw new CliError("External evidence must be an object", "INVALID_EXTERNAL_EVIDENCE");
  const status = String(input.status ?? "").trim();
  if (!EXTERNAL_EVIDENCE_STATUSES.has(status)) throw new CliError("External evidence status must be found, not_found, or ambiguous", "INVALID_EXTERNAL_EVIDENCE");
  if (!Array.isArray(input.dimensions) || !input.dimensions.length || input.dimensions.length > 8) {
    throw new CliError("External evidence needs 1 to 8 qualitative dimensions", "INVALID_EXTERNAL_EVIDENCE");
  }
  const dimensions = [...new Set(input.dimensions.map((entry) => String(entry ?? "").trim()))];
  for (const dimension of dimensions) {
    if (!EXTERNAL_CLAIM_DIMENSIONS.has(dimension)) throw new CliError(`Unsupported external research dimension: ${dimension}`, "INVALID_EXTERNAL_EVIDENCE");
  }
  const query = boundedText(input.query, "External research query", 500);
  const identityInput = input.identity ?? {};
  const identityConfidence = String(identityInput.confidence ?? "low").trim();
  if (!["low", "medium", "high"].includes(identityConfidence)) throw new CliError("Merchant identity confidence must be low, medium, or high", "INVALID_EXTERNAL_EVIDENCE");
  if (!Array.isArray(identityInput.matchedSignals) || identityInput.matchedSignals.length > 8) {
    throw new CliError("Merchant identity matchedSignals must be an array", "INVALID_EXTERNAL_EVIDENCE");
  }
  const matchedSignals = [...new Set(identityInput.matchedSignals.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  for (const signal of matchedSignals) {
    if (!EXTERNAL_IDENTITY_SIGNALS.has(signal)) throw new CliError(`Unsupported merchant identity signal: ${signal}`, "INVALID_EXTERNAL_EVIDENCE");
  }
  const identity = {
    confidence: identityConfidence,
    matchedSignals,
    reason: boundedText(identityInput.reason, "Merchant identity reason", 500, status === "found"),
  };
  if (status === "found" && (identityConfidence === "low" || matchedSignals.length < 2)) {
    throw new CliError("Found evidence requires a medium/high-confidence merchant match with at least two identity signals", "EXTERNAL_IDENTITY_MISMATCH");
  }
  if (!Array.isArray(input.sources) || input.sources.length > 8 || (status === "found" && !input.sources.length)) {
    throw new CliError("Found external evidence needs 1 to 8 sources", "INVALID_EXTERNAL_EVIDENCE");
  }
  const sources = (input.sources ?? []).map(normalizeExternalSource);
  if (status === "found") {
    const claimedDimensions = new Set(sources.flatMap((source) => source.claims.map((claim) => claim.dimension)));
    const missing = dimensions.filter((dimension) => !claimedDimensions.has(dimension));
    if (missing.length) throw new CliError(`External sources do not support every declared dimension: ${missing.join(", ")}`, "INVALID_EXTERNAL_EVIDENCE");
  }
  return {
    id: searchId().slice(0, 20),
    status,
    query,
    dimensions,
    identity,
    sources,
    recordedAt: new Date().toISOString(),
  };
}

function completedExternalDimensions(offer) {
  return new Set((offer.externalEvidence ?? [])
    .filter((record) => record.status === "found" || record.status === "not_found")
    .flatMap((record) => record.dimensions ?? []));
}

function missingExternalDimensions(search, offer) {
  if (search.externalResearch?.mode !== "required") return [];
  const complete = completedExternalDimensions(offer);
  return (search.externalResearch.dimensions ?? []).filter((dimension) => !complete.has(dimension));
}

export async function recordExternalEvidence(id, offerIds, input) {
  const search = await loadSearch(id);
  if (search.semanticMode !== "llm") throw new CliError("External research recording is only available for LLM-mode searches", "EXTERNAL_RESEARCH_NOT_AVAILABLE");
  if (!Array.isArray(offerIds) || !offerIds.length || offerIds.length > 20) {
    throw new CliError("External evidence needs 1 to 20 candidate offer IDs", "INVALID_EXTERNAL_EVIDENCE");
  }
  const uniqueIds = [...new Set(offerIds.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
  const candidates = new Map(search.offers.filter((offer) => !isLlmSelection(offer)).map((offer) => [offer.id, offer]));
  const selected = uniqueIds.map((offerId) => {
    const offer = candidates.get(offerId);
    if (!offer) throw new CliError(`Candidate ${offerId} does not exist in this search`, "CANDIDATE_NOT_FOUND");
    return offer;
  });
  const record = normalizeExternalEvidence(input);
  for (const offer of selected) offer.externalEvidence = [...(offer.externalEvidence ?? []), record].slice(-20);
  await writeSearch(search);
  return {
    searchId: search.id,
    offerIds: selected.map((offer) => offer.id),
    evidence: record,
    externalResearch: search.externalResearch,
    mutatedProviderState: false,
  };
}

export function buildLlmSelection(search, requestedSelections) {
  if (search.semanticMode !== "llm") throw new CliError("LLM selection is only available for LLM-mode searches", "LLM_SELECTION_NOT_AVAILABLE");
  if (!Array.isArray(requestedSelections) || !requestedSelections.length || requestedSelections.length > 20) {
    throw new CliError("Selections must be a non-empty array with at most 20 lines", "INVALID_SELECTION");
  }
  const candidates = new Map(search.offers.filter((offer) => !isLlmSelection(offer)).map((offer) => [offer.id, offer]));
  const seen = new Set();
  const lines = requestedSelections.map((requested, index) => {
    if (!requested || typeof requested !== "object") throw new CliError(`Selection ${index + 1} must be an object`, "INVALID_SELECTION");
    const offer = candidates.get(String(requested.offerId ?? ""));
    if (!offer) throw new CliError(`Candidate ${requested.offerId ?? ""} does not exist in this search`, "CANDIDATE_NOT_FOUND");
    if (offer.available === false && search.fulfilment?.mode !== "scheduled") {
      throw new CliError(`Candidate ${offer.id} is not currently available for immediate delivery`, "CANDIDATE_UNAVAILABLE", {
        candidateId: offer.id,
        provider: offer.provider,
        merchantId: offer.merchant?.id ?? null,
      });
    }
    const missingResearch = missingExternalDimensions(search, offer);
    if (missingResearch.length) {
      throw new CliError(`Candidate ${offer.id} still needs external research for: ${missingResearch.join(", ")}`, "EXTERNAL_RESEARCH_REQUIRED", {
        candidateId: offer.id,
        dimensions: missingResearch,
      });
    }
    if (seen.has(offer.id)) throw new CliError(`Candidate ${offer.id} was selected more than once; use quantity instead`, "DUPLICATE_SELECTION");
    seen.add(offer.id);
    const quantity = Number(requested.quantity ?? offer.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new CliError(`Selection ${index + 1} quantity must be an integer from 1 to 99`, "INVALID_SELECTION");
    const forItem = String(requested.forItem ?? "").trim();
    const reason = String(requested.reason ?? "").trim();
    if (!forItem || !reason) throw new CliError(`Selection ${index + 1} requires forItem and reason`, "INVALID_SELECTION");
    if (forItem.length > 200 || reason.length > 500) throw new CliError(`Selection ${index + 1} labels are too long`, "INVALID_SELECTION");
    const requestFit = requested.requestFit === undefined ? null : Number(requested.requestFit);
    if (requestFit !== null && (!Number.isFinite(requestFit) || requestFit < 0 || requestFit > 100)) {
      throw new CliError(`Selection ${index + 1} requestFit must be from 0 to 100`, "INVALID_SELECTION");
    }
    const confidence = requested.confidence === undefined ? null : String(requested.confidence);
    if (confidence !== null && !["low", "medium", "high"].includes(confidence)) {
      throw new CliError(`Selection ${index + 1} confidence must be low, medium, or high`, "INVALID_SELECTION");
    }
    const evidence = requested.evidence === undefined ? [] : requested.evidence;
    if (!Array.isArray(evidence) || evidence.length > 8 || evidence.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 300)) {
      throw new CliError(`Selection ${index + 1} evidence must contain at most 8 short strings`, "INVALID_SELECTION");
    }
    const unitPrice = Number(offer.item?.unitPrice);
    const subtotal = Number.isFinite(unitPrice) ? Math.round(unitPrice * quantity * 100) / 100 : null;
    const originalSubtotal = Number.isFinite(Number(offer.pricing?.originalSubtotal))
      ? Math.round(Number(offer.pricing.originalSubtotal) * quantity * 100) / 100 : null;
    const itemSavings = Math.round(Number(offer.pricing?.itemSavings ?? 0) * quantity * 100) / 100;
    return {
      candidateId: offer.id,
      item: { ...offer.item },
      quantity,
      forItem,
      reason,
      semanticAssessment: requestFit === null ? null : { requestFit, confidence: confidence ?? "low", evidence: evidence.map((entry) => entry.trim()) },
      pricing: { ...offer.pricing, originalSubtotal, subtotal, itemSavings, discount: 0, total: null, exact: false },
      promotion: offer.promotion,
      source: offer.source,
      signals: offer.signals,
      available: offer.available,
      externalEvidence: offer.externalEvidence ?? [],
    };
  });
  const selectedOffers = lines.map((line) => candidates.get(line.candidateId));
  if (new Set(selectedOffers.map((offer) => merchantKey(offer))).size !== 1) {
    throw new CliError("One selectable bundle must use a single provider and merchant", "SELECTION_BASKET_CONFLICT");
  }
  if (selectedOffers[0].provider === "justeat"
    && new Set(selectedOffers.map((offer) => offer.source?.planId).filter(Boolean)).size !== 1) {
    throw new CliError("Selected Just Eat candidates must come from the same source plan", "SELECTION_BASKET_CONFLICT");
  }
  const shoppingItems = Array.isArray(search.shoppingItems) ? search.shoppingItems : [];
  const parsed = search.parsedIntent ?? parseIntent(search.intent ?? "");
  if (shoppingItems.length) {
    const required = new Map(shoppingItems.map((item, index) => {
      const id = String(item?.id ?? `item-${index + 1}`).trim();
      return [id, Math.max(1, Number(item?.quantity ?? 1))];
    }));
    const covered = new Map();
    for (const line of lines) {
      if (!required.has(line.forItem)) {
        throw new CliError(`Selection line references unknown shopping item ${line.forItem}`, "INVALID_SELECTION");
      }
      const current = covered.get(line.forItem) ?? { quantity: 0, lines: [] };
      current.quantity += line.quantity;
      current.lines.push(line);
      covered.set(line.forItem, current);
    }
    const missing = [...required].filter(([id, quantity]) => {
      const itemLines = covered.get(id);
      if (!itemLines) return true;
      if (parsed.kind !== "meal") return itemLines.quantity < quantity;
      const selectedForItem = itemLines.lines.map((line) => candidates.get(line.candidateId));
      const explicitCapacity = Math.max(...selectedForItem.map((offer) => Number(offer.servesPeople ?? 0)), 0);
      const distinctItems = new Set(itemLines.lines.map((line) => line.item.id ?? line.item.name)).size;
      return Math.max(explicitCapacity, distinctItems) < quantity;
    }).map(([id]) => id);
    if (missing.length) {
      throw new CliError(`Selection does not cover every requested shopping item: ${missing.join(", ")}`, "INCOMPLETE_SELECTION");
    }
  }
  if (shoppingItems.length && parsed.kind === "meal" && Number(parsed.people ?? 1) > 1) {
    const people = Number(parsed.people);
    const explicitCapacity = Math.max(...selectedOffers.map((offer) => Number(offer.servesPeople ?? 0)), 0);
    const distinctItems = new Set(lines.map((line) => line.item.id ?? line.item.name)).size;
    if (explicitCapacity < people && distinctItems < people) {
      throw new CliError(
        `A meal for ${people} requires ${people} distinct dishes or an item explicitly serving the party`,
        "INCOMPLETE_MEAL",
      );
    }
  }
  const first = selectedOffers[0];
  const subtotalValues = lines.map((line) => line.pricing.subtotal);
  const subtotal = subtotalValues.every((value) => Number.isFinite(value))
    ? Math.round(subtotalValues.reduce((sum, value) => sum + value, 0) * 100) / 100 : null;
  const knownFees = Object.values(first.pricing?.fees ?? {}).filter((value) => Number.isFinite(Number(value)));
  const estimatedTotal = subtotal === null ? null
    : Math.round((subtotal + knownFees.reduce((sum, value) => sum + Number(value), 0)) * 100) / 100;
  return {
    ...first,
    id: searchId().slice(0, 20),
    item: {
      id: lines.map((line) => line.item.id).filter(Boolean).join("+") || null,
      name: lines.map((line) => line.item.name).join(" + "),
      description: lines.map((line) => `${line.forItem}: ${line.reason}`).join(" "),
      unitPrice: subtotal,
    },
    quantity: 1,
    composition: {
      kind: lines.length > 1 ? "llm-shopping-list" : "llm-selection",
      complete: true,
      requestedItems: shoppingItems.length || lines.length,
      distinctItems: new Set(lines.map((line) => line.item.id ?? line.item.name)).size,
    },
    lines,
    available: selectedOffers.every((offer) => offer.available !== false),
    etaMinutes: Math.max(...selectedOffers.map((offer) => Number(offer.etaMinutes ?? 0))) || null,
    pricing: {
      ...first.pricing,
      originalSubtotal: null,
      subtotal,
      itemSavings: Math.round(lines.reduce((sum, line) => sum + Number(line.pricing?.itemSavings ?? 0), 0) * 100) / 100,
      discount: 0,
      total: estimatedTotal,
      exact: false,
      missing: ["final checkout validation"],
    },
    promotion: selectionPromotion(lines),
    source: {
      ...first.source,
      bundle: lines.length > 1,
      llmSelected: true,
      selectedCandidateIds: lines.map((line) => line.candidateId),
    },
    semanticAssessment: lines.some((line) => line.semanticAssessment) ? {
      requestFit: Math.round(lines.reduce((sum, line) => sum + Number(line.semanticAssessment?.requestFit ?? 0), 0) / lines.length),
      confidence: lines.every((line) => line.semanticAssessment?.confidence === "high") ? "high"
        : lines.some((line) => line.semanticAssessment?.confidence === "low" || !line.semanticAssessment) ? "low" : "medium",
      evidence: [...new Set(lines.flatMap((line) => line.semanticAssessment?.evidence ?? []))].slice(0, 8),
    } : null,
    externalEvidence: lines.flatMap((line) => line.externalEvidence ?? []),
    signals: { ...first.signals },
  };
}

export async function selectCandidates(id, selections) {
  const search = await loadSearch(id);
  const selection = buildLlmSelection(search, selections);
  search.offers.push(selection);
  search.selections = [...(search.selections ?? []), {
    id: selection.id,
    candidateIds: selection.source.selectedCandidateIds,
    createdAt: new Date().toISOString(),
  }];
  search.providerReviews = {
    ...(search.providerReviews ?? {}),
    [selection.provider]: {
      disposition: "selected",
      offerId: selection.id,
      reason: selection.lines.map((line) => line.reason).join(" ").slice(0, 500),
      reviewedAt: new Date().toISOString(),
    },
  };
  await writeSearch(search);
  return { selection, results: resultsFor(search), mutatedProviderState: false };
}

export async function reviewProvider(id, provider, disposition, reason) {
  const search = await loadSearch(id);
  if (!search.providers.includes(provider)) throw new CliError(`${provider} is not enabled for this search`, "PROVIDER_NOT_ENABLED");
  if (!["inspected_no_suitable_match", "unavailable"].includes(disposition)) {
    throw new CliError("Provider review disposition must be inspected_no_suitable_match or unavailable", "INVALID_PROVIDER_REVIEW");
  }
  const explanation = String(reason ?? "").trim();
  if (!explanation) throw new CliError("Provider review requires a grounded reason", "INVALID_PROVIDER_REVIEW");
  if (explanation.length > 500) throw new CliError("Provider review reason is too long", "INVALID_PROVIDER_REVIEW");
  if (search.providerStatus?.[provider]?.state !== "complete") {
    throw new CliError("Provider retrieval must be complete before recording its review", "PROVIDER_REVIEW_INCOMPLETE", {
      provider,
      state: search.providerStatus?.[provider]?.state ?? "pending",
    });
  }
  search.providerReviews = {
    ...(search.providerReviews ?? {}),
    [provider]: {
      disposition,
      reason: explanation,
      reviewedAt: new Date().toISOString(),
    },
  };
  await writeSearch(search);
  return resultsFor(search);
}

export function resultsFor(search) {
  const llmMode = search.semanticMode === "llm";
  const candidates = search.offers.filter((offer) => !isLlmSelection(offer));
  const allSelectedOffers = search.offers.filter(isLlmSelection);
  const legacySelectedReviews = Object.fromEntries(allSelectedOffers.map((offer) => [offer.provider, {
    disposition: "selected", offerId: offer.id, reason: "Legacy model selection",
  }]));
  const providerReviews = search.providerReviews ?? legacySelectedReviews;
  const selectedOffers = llmMode && Object.keys(providerReviews).length
    ? allSelectedOffers.filter((offer) => providerReviews[offer.provider]?.disposition === "selected"
      && providerReviews[offer.provider]?.offerId === offer.id)
    : allSelectedOffers;
  const rankingInputs = llmMode ? selectedOffers : search.offers;
  const rankingProviders = llmMode ? [...new Set(selectedOffers.map((offer) => offer.provider))] : search.providers;
  const baseRanking = rankOffers(rankingInputs, search.intent, search.objective, { providers: rankingProviders });
  const statuses = Object.entries(search.providerStatus);
  const attemptedProviders = statuses.filter(([, status]) => status.state !== "pending").map(([provider]) => provider);
  const completedProviders = statuses.filter(([, status]) => status.state === "complete" || status.state === "partial").map(([provider]) => provider);
  const failedProviders = statuses.filter(([, status]) => status.state === "error").map(([provider]) => provider);
  const rateLimitedProviders = statuses.filter(([, status]) => status.errorCode === "RATE_LIMITED").map(([provider]) => provider);
  const partialProviders = statuses.filter(([, status]) => status.state === "partial").map(([provider]) => provider);
  const matchedProviders = [...new Set(rankingInputs.map((offer) => offer.provider))];
  const candidateProviders = [...new Set(candidates.map((offer) => offer.provider))];
  const completedCandidateProviders = candidateProviders.filter((provider) => search.providers.includes(provider)
    && search.providerStatus?.[provider]?.state === "complete");
  const reviewedProviders = search.providers.filter((provider) => Boolean(providerReviews[provider]));
  const unreviewedCandidateProviders = llmMode
    ? completedCandidateProviders.filter((provider) => !reviewedProviders.includes(provider)) : [];
  const unresolvedProviders = search.providers.filter((provider) => {
    if (search.providerStatus?.[provider]?.state !== "complete") return true;
    return llmMode && candidateProviders.includes(provider) && !reviewedProviders.includes(provider);
  });
  const deliveryLocation = deliveryLocationCoverage(search);
  const candidatesById = new Map(candidates.map((offer) => [offer.id, offer]));
  const selectedCandidateIds = [...new Set(selectedOffers.flatMap((offer) => offer.source?.selectedCandidateIds ?? []))];
  const externalMissing = selectedCandidateIds.flatMap((candidateId) => {
    const offer = candidatesById.get(candidateId);
    const dimensions = offer ? missingExternalDimensions(search, offer) : (search.externalResearch?.dimensions ?? []);
    return dimensions.length ? [{ candidateId, dimensions }] : [];
  });
  const externalEvidenceCoverage = {
    mode: search.externalResearch?.mode ?? "not_needed",
    dimensions: search.externalResearch?.dimensions ?? [],
    selectedCandidateIds,
    researchedCandidateIds: selectedCandidateIds.filter((candidateId) => {
      const offer = candidatesById.get(candidateId);
      return offer && missingExternalDimensions(search, offer).length === 0;
    }),
    missing: externalMissing,
    usableSources: selectedCandidateIds.reduce((count, candidateId) => count
      + (candidatesById.get(candidateId)?.externalEvidence ?? [])
        .filter((record) => record.status === "found").flatMap((record) => record.sources ?? []).length, 0),
    complete: search.externalResearch?.mode !== "required" || (selectedCandidateIds.length > 0 && externalMissing.length === 0),
  };
  const ranking = {
    ...baseRanking,
    winnerReady: baseRanking.winnerReady && unresolvedProviders.length === 0
      && deliveryLocation.status !== "mismatch" && externalEvidenceCoverage.complete,
  };
  const availableProviders = [...new Set(rankingInputs.filter((offer) => offer.available).map((offer) => offer.provider))];
  const unavailableOnlyProviders = matchedProviders.filter((provider) => !availableProviders.includes(provider));
  const pendingEligibility = rankingInputs.filter((offer) => offer.source?.eligibility?.status === "confirmation_required"
    || offer.lines?.some((line) => line.source?.eligibility?.status === "confirmation_required"));
  const candidatePool = llmMode ? {
    total: candidates.length,
    providers: Object.fromEntries(search.providers.map((provider) => [provider, candidates.filter((offer) => offer.provider === provider).length])),
    merchants: new Set(candidates.map(merchantKey)).size,
    selectedBundles: selectedOffers.length,
    selectionRequired: unreviewedCandidateProviders.length > 0,
    reviewedProviders,
    unreviewedCandidateProviders,
  } : null;
  const providerReview = Object.fromEntries(search.providers.map((provider) => {
    const state = search.providerStatus?.[provider]?.state;
    if (state === "error") return [provider, { disposition: "failed", reason: search.providerStatus[provider].error ?? "Provider retrieval failed" }];
    if (state === "pending") return [provider, { disposition: "pending", reason: null }];
    if (state === "partial") return [provider, { disposition: "partial", reason: "Provider retrieval did not complete" }];
    const explicit = providerReviews[provider];
    if (explicit) return [provider, explicit];
    if (!candidateProviders.includes(provider) && state === "complete") return [provider, { disposition: "no_candidates", reason: "Provider retrieval returned no candidates" }];
    return [provider, { disposition: "unreviewed", reason: null }];
  }));
  const coverage = {
    mode: search.orchestration ?? "legacy",
    configuredProviders: search.providers,
    attemptedProviders,
    completedProviders,
    failedProviders,
    rateLimitedProviders,
    matchedProviders,
    candidateProviders,
    availableProviders,
    unavailableOnlyProviders,
    providerReview,
    unreviewedCandidateProviders,
    unresolvedProviders,
    allConfiguredAttempted: attemptedProviders.length === search.providers.length,
    allConfiguredCompleted: search.providers.every((provider) => search.providerStatus?.[provider]?.state === "complete"),
    deliveryLocation,
    externalEvidence: externalEvidenceCoverage,
  };
  return {
    search: summarizeSearch(search),
    coverage,
    comparison: ranking,
    candidatePool,
    shoppingItems: search.shoppingItems ?? [],
    warnings: [
      ...(!ranking.exactPriceComparison && ranking.exactPriceCoverage.requiredProviders.length
        ? [`Exact checkout totals are still missing for: ${ranking.exactPriceCoverage.missingQuoteProviders.join(", ")}. Cheapest is provisional.`] : []),
      ...(!coverage.allConfiguredAttempted ? ["Not every configured provider has been attempted yet."] : []),
      ...(rateLimitedProviders.length ? [`Provider search is temporarily rate-limited: ${rateLimitedProviders.join(", ")}. The saved login may still be valid; wait before retrying instead of re-authenticating.`] : []),
      ...(failedProviders.length ? [`Provider search failed: ${failedProviders.join(", ")}. It was attempted and was not silently omitted.`] : []),
      ...(partialProviders.length ? [`Provider catalog coverage was partial: ${partialProviders.join(", ")}. Empty results from failed catalog calls were not treated as proof of no match.`] : []),
      ...(pendingEligibility.length ? ["Some Glovo matches require the user to confirm legal age on Glovo before basket creation."] : []),
      ...(llmMode && selectedOffers.length === 0
        ? ["Candidate retrieval is complete enough to inspect, but semantic selection is still required. Page through candidates and let the LLM choose; do not report no match yet."] : []),
      ...(unreviewedCandidateProviders.length
        ? [`Provider review is still required for: ${unreviewedCandidateProviders.join(", ")}. No winner can be confirmed yet.`] : []),
      ...(unresolvedProviders.length
        ? [`Comparison is unresolved for: ${unresolvedProviders.join(", ")}. Every configured provider must complete retrieval and candidate review before a winner can be confirmed.`] : []),
      ...(search.externalResearch?.mode === "required" && selectedOffers.length === 0
        ? [`External web research is required for ${search.externalResearch.dimensions.join(", ")} before qualitative candidates can be selected.`] : []),
      ...(search.externalResearch?.mode === "unavailable"
        ? ["Native web research was unavailable; qualitative claims are limited to current provider evidence and cannot be externally corroborated."] : []),
      ...(externalMissing.length
        ? [`External web research is incomplete for ${externalMissing.length} selected candidate(s); no qualitative winner can be confirmed.`] : []),
      ...(deliveryLocation.status === "mismatch"
        ? [`Provider delivery locations do not match (${deliveryLocation.maximumDistanceKm} km apart). Fix the saved address before comparing or quoting.`] : []),
      ...(deliveryLocation.status === "unverified"
        ? [`Delivery-location parity could not be verified for: ${deliveryLocation.missingProviders.join(", ")}. Exact checkout still determines the final address.`] : []),
      ...(Object.values(search.providerStatus).some((status) => status.state === "pending") ? ["Some enabled providers are still pending."] : []),
      ...(search.fulfilment?.mode === "scheduled" && !ranking.winnerReady
        ? [`No winner is confirmed until the requested time (${search.fulfilment.requestedAt ?? "unspecified"}) and exact delivered total are verified for every matching provider.`] : []),
    ],
  };
}

export async function searchResults(id) {
  return resultsFor(await loadSearch(id));
}

function summarizeSearch(search) {
  return {
    id: search.id,
    intent: search.intent,
    parsedIntent: search.parsedIntent ?? parseIntent(search.intent),
    fulfilment: search.fulfilment ?? null,
    objective: search.objective,
    queryPlan: search.queryPlan ?? null,
    semanticMode: search.semanticMode ?? "deterministic",
    shoppingItems: search.shoppingItems ?? [],
    externalResearch: search.externalResearch ?? { mode: "not_needed", dimensions: [] },
    providers: search.providers,
    providerStatus: Object.fromEntries(Object.entries(search.providerStatus ?? {}).map(([provider, status]) => [provider, {
      ...status,
      ...(status.discovery ? { discovery: {
        ...status.discovery,
        ...(status.discovery.deliveryLocation ? { deliveryLocation: {
          selected: true,
          city: status.discovery.deliveryLocation.city ?? null,
          postcode: status.discovery.deliveryLocation.postcode ?? null,
          source: status.discovery.deliveryLocation.source ?? null,
        } } : {}),
      } } : {}),
    }])),
    orchestration: search.orchestration ?? "legacy",
    offerCount: search.offers.length,
    candidateCount: search.offers.filter((offer) => !isLlmSelection(offer)).length,
    selectionCount: search.offers.filter(isLlmSelection).length,
    createdAt: search.createdAt,
    updatedAt: search.updatedAt,
  };
}

function deliveryLocationCoverage(search) {
  const locations = Object.fromEntries(search.providers.flatMap((provider) => {
    const location = search.providerStatus?.[provider]?.discovery?.deliveryLocation;
    const latitude = location?.latitude === null || location?.latitude === undefined ? NaN : Number(location.latitude);
    const longitude = location?.longitude === null || location?.longitude === undefined ? NaN : Number(location.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? [[provider, { latitude, longitude }]] : [];
  }));
  const providers = Object.keys(locations);
  const missingProviders = search.providers.filter((provider) => !providers.includes(provider));
  let maximumDistanceKm = 0;
  for (let left = 0; left < providers.length; left += 1) {
    for (let right = left + 1; right < providers.length; right += 1) {
      maximumDistanceKm = Math.max(maximumDistanceKm, haversineKm(locations[providers[left]], locations[providers[right]]));
    }
  }
  const rounded = Math.round(maximumDistanceKm * 10) / 10;
  return {
    status: rounded > 3 ? "mismatch" : (missingProviders.length ? "unverified" : "verified"),
    verifiedProviders: providers,
    missingProviders,
    maximumDistanceKm: rounded,
    thresholdKm: 3,
  };
}

function haversineKm(left, right) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const deltaLatitude = radians(right.latitude - left.latitude);
  const deltaLongitude = radians(right.longitude - left.longitude);
  const originLatitude = radians(left.latitude);
  const targetLatitude = radians(right.latitude);
  const value = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(originLatitude) * Math.cos(targetLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
