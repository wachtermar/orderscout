import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./lib.js";
import {
  PROVIDER_IDS, PROVIDERS, atomicPrivateWrite, loadAccounts, parseProviderList,
  providerPaths, publicAccountStatus, searchId,
} from "./providers.js";
import { normalizeOffer, parseObjective, rankOffers } from "./ranking.js";
import { parseIntent, parsePackVolume } from "./recommend.js";

const searchPath = (id) => join(providerPaths.searchesDirectory, `${validateId(id)}.json`);

function validateId(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id ?? ""))) throw new CliError("Invalid OrderScout search ID", "INVALID_SEARCH_ID");
  return id;
}

export async function startSearch(intent, options = {}) {
  const text = String(intent ?? "").trim();
  if (!text) throw new CliError("Describe what you want", "INTENT_REQUIRED");
  const accounts = await loadAccounts();
  const requested = options.providers ? parseProviderList(options.providers) : PROVIDER_IDS;
  const enabled = requested.filter((id) => accounts.providers[id].enabled && accounts.providers[id].hasAccount !== false);
  if (!enabled.length) throw new CliError("No enabled providers have an account", "NO_ENABLED_PROVIDERS");
  const search = {
    id: searchId(),
    version: 1,
    intent: text,
    objective: options.objective ?? parseObjective(text),
    locationHint: options.locationHint ?? null,
    providers: enabled,
    providerStatus: Object.fromEntries(enabled.map((id) => [id, { state: "pending", error: null }])),
    offers: [],
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
  const values = applyIntent(Array.isArray(inputs) ? inputs : [inputs], search.intent);
  const normalized = values.map((input) => normalizeOffer(provider, input, {
    membership: accounts.providers[provider].membership,
  }));
  const incomingIds = new Set(normalized.map((offer) => offer.id));
  search.offers = [...search.offers.filter((offer) => offer.provider !== provider || !incomingIds.has(offer.id)), ...normalized];
  search.providerStatus[provider] = { state: options.complete === false ? "partial" : "complete", error: null };
  await writeSearch(search);
  return resultsFor(search);
}

export function applyIntent(inputs, text) {
  const intent = parseIntent(text);
  if (intent.kind === "meal") {
    const positive = ["ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable", "pollo", "chicken", "pavo", "salm", "atun", "tuna", "quinoa", "integral", "healthy", "saludable", "vegan", "vegano", "vegetar"];
    const negative = ["frito", "fried", "burger", "hamburgues", "pizza", "donut", "tarta", "cake", "helado", "chocolate", "bacon", "patatas", "fries", "mayonesa", "empanado", "breaded", "battered", "croqueta", "crispy", "creamy"];
    const stronglyIndulgent = ["frito", "fried", "burger", "hamburgues", "pizza", "donut", "cake", "empanado", "breaded", "battered", "croqueta"];
    const dietaryTerms = {
      vegan: ["vegan", "vegano", "vegana"], vegetarian: ["vegetarian", "vegetariano", "vegetariana"],
      halal: ["halal"], glutenFree: ["gluten free", "sin gluten"], lactoseFree: ["lactose free", "sin lactosa"],
    };
    return inputs.flatMap((input) => {
      const itemText = `${input.item?.name ?? input.itemName ?? ""} ${input.item?.description ?? ""}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      if (Object.entries(intent.dietary).some(([key, required]) => required && !dietaryTerms[key].some((term) => itemText.includes(term)))) return [];
      const health = positive.filter((term) => itemText.includes(term)).length * 12
        - negative.filter((term) => itemText.includes(term)).length * 9;
      if (intent.healthy && (health <= 0 || stronglyIndulgent.some((term) => itemText.includes(term)))) return [];
      const quantity = Math.max(1, intent.people ?? 1);
      const unitPrice = Number(input.item?.unitPrice ?? input.unitPrice);
      const subtotal = Number.isFinite(unitPrice) ? Math.round(unitPrice * quantity * 100) / 100 : null;
      if (intent.budget !== null && subtotal !== null && subtotal > intent.budget) return [];
      const rating = Number(input.merchant?.rating ?? input.rating);
      return [{
        ...input,
        quantity,
        pricing: { ...input.pricing, subtotal, total: null, exact: false },
        signals: {
          ...input.signals,
          health,
          taste: Number.isFinite(rating) ? Math.round(rating * 20) : Number(input.signals?.taste ?? 0),
        },
      }];
    });
  }
  if (intent.kind !== "water") return inputs;
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
      pricing: { ...input.pricing, subtotal, total: null, exact: false },
    }];
  });
}

export async function recordProviderError(id, provider, error) {
  const search = await loadSearch(id);
  search.providerStatus[provider] = { state: "error", error: String(error).slice(0, 300) };
  await writeSearch(search);
  return resultsFor(search);
}

export async function recordQuote(id, offerId, pricing) {
  const search = await loadSearch(id);
  const index = search.offers.findIndex((offer) => offer.id === offerId);
  if (index < 0) throw new CliError("Offer not found in this search", "OFFER_NOT_FOUND");
  search.offers[index] = normalizeOffer(search.offers[index].provider, {
    ...search.offers[index],
    pricing: { ...search.offers[index].pricing, ...pricing, exact: true },
  });
  await writeSearch(search);
  return resultsFor(search);
}

export function resultsFor(search) {
  const ranking = rankOffers(search.offers, search.intent, search.objective);
  return {
    search: summarizeSearch(search),
    comparison: ranking,
    warnings: [
      ...(!ranking.exactPriceComparison ? ["Fewer than two providers have exact checkout totals; cheapest is provisional."] : []),
      ...(Object.values(search.providerStatus).some((status) => status.state === "pending") ? ["Some enabled providers are still pending."] : []),
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
    objective: search.objective,
    providers: search.providers,
    providerStatus: search.providerStatus,
    offerCount: search.offers.length,
    createdAt: search.createdAt,
    updatedAt: search.updatedAt,
  };
}
