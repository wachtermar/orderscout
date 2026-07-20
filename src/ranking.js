import { createHash } from "node:crypto";
import { CliError } from "./lib.js";
import { PROVIDERS, assertProvider } from "./providers.js";
import { parseIntent, parsePackVolume } from "./recommend.js";

const numberOrNull = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
  ? null : Number(value);
const money = (value) => value === null ? null : Math.round(value * 100) / 100;

function stringList(value, splitCommas = true) {
  const values = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
  return [...new Set(values.flatMap((entry) => splitCommas ? String(entry).split(",") : [String(entry)])
    .map((entry) => entry.trim()).filter(Boolean))];
}

function normalizePromotion(value, pricing) {
  if (!value) return null;
  const source = typeof value === "string" ? { descriptions: [value] } : value;
  const descriptions = stringList(source.descriptions ?? source.description ?? source.label ?? source.title, false);
  const types = stringList(source.types ?? source.type).map((type) => type.toUpperCase());
  const ids = stringList(source.ids ?? source.id);
  const savings = numberOrNull(source.savings ?? pricing.itemSavings);
  return {
    types,
    descriptions,
    ids,
    eligible: source.eligible !== false,
    applied: Boolean(source.applied || (savings !== null && savings > 0) || pricing.discount > 0),
    savings: money(savings),
    source: source.source ?? null,
  };
}

export function parseObjective(intent) {
  const text = String(intent ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(fastest|quickest|soonest|rapid|rapido|rapida|antes|asap|lo antes posible|menos tiempo)\b/.test(text)) return "fastest";
  if (/\b(best[ -]rated|highest[ -]rated|top[ -]rated|best reviews?|most popular|mejor valorad[oa]s?|mejores resenas|mas popular|calidad|best quality|highest quality|tasty|delicious|sabros[oa]?|rico|rica)\b/.test(text)) return "best";
  if (/\b(cheapest|lowest (?:price|total|fees?)|least expensive|cheap|barat|econom|mejor oferta|menor precio|mas barato|menos gastos)\b/.test(text)) return "cheapest";
  return "value";
}

export function normalizeOffer(provider, input, context = {}) {
  assertProvider(provider);
  if (!input || typeof input !== "object") throw new CliError("Each offer must be an object", "INVALID_OFFER");
  const merchantName = String(input.merchant?.name ?? input.merchantName ?? "").trim();
  const itemName = String(input.item?.name ?? input.itemName ?? "").trim();
  if (!merchantName || !itemName) throw new CliError("Offer merchant and item names are required", "INVALID_OFFER");
  const quantity = Math.max(1, Math.trunc(numberOrNull(input.quantity) ?? 1));
  const unitPrice = numberOrNull(input.item?.unitPrice ?? input.unitPrice);
  const subtotal = numberOrNull(input.pricing?.subtotal) ?? (unitPrice === null ? null : unitPrice * quantity);
  const fees = {
    delivery: numberOrNull(input.pricing?.fees?.delivery ?? input.deliveryFee),
    service: numberOrNull(input.pricing?.fees?.service),
    smallOrder: numberOrNull(input.pricing?.fees?.smallOrder),
    bag: numberOrNull(input.pricing?.fees?.bag),
    other: numberOrNull(input.pricing?.fees?.other),
  };
  const knownFees = Object.values(fees).filter((value) => value !== null);
  const discount = numberOrNull(input.pricing?.discount) ?? 0;
  const originalSubtotal = numberOrNull(input.pricing?.originalSubtotal);
  const itemSavings = numberOrNull(input.pricing?.itemSavings)
    ?? (originalSubtotal !== null && subtotal !== null && originalSubtotal > subtotal ? originalSubtotal - subtotal : 0);
  const computedTotal = subtotal === null ? null : subtotal + knownFees.reduce((sum, value) => sum + value, 0) - discount;
  const total = numberOrNull(input.pricing?.total) ?? computedTotal;
  const normalizedPricing = {
    currency: input.pricing?.currency ?? "EUR",
    originalSubtotal: money(originalSubtotal),
    subtotal: money(subtotal),
    itemSavings: money(itemSavings),
    fees: Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, money(value)])),
    discount: money(discount),
    total: money(total),
    exact: Boolean(input.pricing?.exact),
    missing: [
      ...(subtotal === null ? ["subtotal"] : []),
      ...(!input.pricing?.exact ? ["final checkout validation"] : []),
    ],
  };
  const promotion = normalizePromotion(input.promotion, normalizedPricing);
  const membership = input.membership ?? context.membership;
  const volume = input.package?.totalLiters
    ? input.package
    : parsePackVolume(`${itemName} ${input.item?.description ?? ""}`);
  const suppliedLiters = numberOrNull(input.suppliedLiters) ?? (volume ? volume.totalLiters * quantity : null);
  const stable = JSON.stringify([provider, input.merchant?.id, merchantName, input.item?.id, itemName,
    input.lines?.map((line) => [line.item?.id, line.quantity]), input.url]);
  const lines = Array.isArray(input.lines) ? input.lines.map((line) => ({
    candidateId: line.candidateId ?? null,
    item: {
      id: line.item?.id ?? null,
      name: String(line.item?.name ?? "").trim(),
      description: line.item?.description ?? null,
      unitPrice: money(numberOrNull(line.item?.unitPrice)),
    },
    quantity: Math.max(1, Math.trunc(numberOrNull(line.quantity) ?? 1)),
    forItem: line.forItem ?? null,
    reason: line.reason ?? null,
    pricing: line.pricing ?? null,
    promotion: line.promotion ?? null,
    source: line.source ?? null,
    signals: line.signals ?? null,
    semanticAssessment: line.semanticAssessment ?? null,
    externalEvidence: Array.isArray(line.externalEvidence) ? line.externalEvidence : [],
  })) : null;
  return {
    id: input.id ?? createHash("sha256").update(stable).digest("hex").slice(0, 20),
    provider,
    providerName: PROVIDERS[provider].name,
    merchant: {
      id: input.merchant?.id ?? null,
      name: merchantName,
      rating: numberOrNull(input.merchant?.rating ?? input.rating),
      ratingCount: numberOrNull(input.merchant?.ratingCount ?? input.ratingCount),
      categories: stringList(input.merchant?.categories, false),
    },
    item: {
      id: input.item?.id ?? null,
      name: itemName,
      description: input.item?.description ?? null,
      category: input.item?.category ?? input.category ?? null,
      unitPrice: money(unitPrice),
    },
    quantity,
    servesPeople: numberOrNull(input.servesPeople),
    composition: input.composition ?? null,
    lines,
    package: volume,
    suppliedLiters,
    etaMinutes: numberOrNull(input.etaMinutes),
    available: input.available !== false,
    fulfilment: input.fulfilment ? {
      requestedAt: input.fulfilment.requestedAt ?? null,
      timeZone: input.fulfilment.timeZone ?? "Europe/Madrid",
      status: input.fulfilment.status ?? "unverified",
      selectedWindow: input.fulfilment.selectedWindow ?? null,
      source: input.fulfilment.source ?? null,
    } : null,
    pricing: normalizedPricing,
    membership: membership ? {
      ...membership,
      eligible: input.membershipEligible ?? membership.eligible ?? null,
    } : null,
    promotion,
    url: trustedProviderUrl(provider, input.url),
    source: input.source ?? null,
    semanticAssessment: input.semanticAssessment ? {
      requestFit: Math.max(0, Math.min(100, numberOrNull(input.semanticAssessment.requestFit) ?? 0)),
      confidence: ["low", "medium", "high"].includes(input.semanticAssessment.confidence)
        ? input.semanticAssessment.confidence : "low",
      evidence: stringList(input.semanticAssessment.evidence, false).slice(0, 8),
    } : null,
    externalEvidence: Array.isArray(input.externalEvidence) ? input.externalEvidence : [],
    signals: {
      health: numberOrNull(input.signals?.health) ?? 0,
      taste: numberOrNull(input.signals?.taste) ?? 0,
      relevance: numberOrNull(input.signals?.relevance) ?? 0,
      preference: numberOrNull(input.signals?.preference) ?? 0,
      matchedCore: stringList(input.signals?.matchedCore, false),
      matchedPreference: stringList(input.signals?.matchedPreference, false),
    },
    collectedAt: input.collectedAt ?? new Date().toISOString(),
  };
}

function trustedProviderUrl(provider, value) {
  if (!value) return null;
  let url;
  try { url = new URL(value, PROVIDERS[provider].origin); } catch { throw new CliError("Invalid provider URL", "INVALID_OFFER_URL"); }
  if (url.origin !== PROVIDERS[provider].origin) throw new CliError(`Offer URL must stay on ${PROVIDERS[provider].origin}`, "INVALID_OFFER_URL");
  return url.toString();
}

function ratingScore(offer) {
  const rating = offer.merchant.rating;
  if (rating === null) return 45;
  if (offer.merchant.ratingCount === null) return (rating / 5) * 100;
  const count = offer.merchant.ratingCount;
  const confidence = Math.min(1, Math.log10(count + 1) / 3);
  return ((rating / 5) * confidence + 0.7 * (1 - confidence)) * 100;
}

function priceForRanking(offer) {
  if (offer.pricing.total === null) return Number.POSITIVE_INFINITY;
  return offer.pricing.total + (offer.pricing.exact ? 0 : 4);
}

function scoreOffer(offer, objective, parsed) {
  const price = priceForRanking(offer);
  const eta = offer.etaMinutes ?? 120;
  const rating = ratingScore(offer);
  const healthTaste = offer.signals.health * 0.7 + offer.signals.taste * 0.6;
  const productFit = parsed.kind === "product"
    ? offer.signals.relevance * 0.8 + offer.signals.preference * 1.5 : 0;
  const semanticFit = Number(offer.semanticAssessment?.requestFit ?? 0);
  const dealSignal = Math.min(12, Number(offer.pricing.itemSavings ?? 0) * 2)
    + (offer.promotion?.types?.length ? 2 : 0)
    + (offer.membership?.active && offer.membership?.eligible ? 2 : 0);
  if (!offer.available) return -1_000_000;
  if (objective === "cheapest") return -price * 20 - eta * 0.08 + rating * 0.08 + productFit * 0.25 + semanticFit * 0.1;
  if (objective === "fastest") return -eta * 8 - price * 0.35 + rating * 0.08 + productFit * 0.25 + semanticFit * 0.1;
  if (objective === "best") {
    const explicitlyRatingLed = /\b(best[ -]rated|highest[ -]rated|mejor valorad)\b/.test(parsed.normalized);
    const ratingWeight = explicitlyRatingLed ? 20 : 2;
    const semanticWeight = explicitlyRatingLed ? 2 : 20;
    return rating * ratingWeight + semanticFit * semanticWeight + healthTaste + productFit + dealSignal * 0.35 - price * 0.8 - eta * 0.12;
  }
  return rating + semanticFit * 5 + healthTaste + productFit + dealSignal - price * 2.4 - eta * 0.45;
}

export function rankOffers(offers, intent, objective = parseObjective(intent), options = {}) {
  const parsed = parseIntent(intent);
  const ranked = offers.map((offer) => {
    const overBudget = parsed.budget !== null && offer.pricing.exact
      && offer.pricing.total !== null && offer.pricing.total > parsed.budget;
    const scheduleVerified = parsed.deliveryTime !== "scheduled" || offer.fulfilment?.status === "verified";
    const scheduleUnavailable = parsed.deliveryTime === "scheduled" && offer.fulfilment?.status === "unavailable";
    return { ...offer, ranking: { objective, score: overBudget || scheduleUnavailable ? -999_999 : scoreOffer(offer, objective, parsed), badges: [], overBudget, scheduleVerified } };
  })
    .sort((a, b) => b.ranking.score - a.ranking.score || String(a.id).localeCompare(String(b.id)));
  const available = ranked.filter((offer) => offer.available && !offer.ranking.overBudget);
  const exactPriced = available.filter((offer) => offer.pricing.exact && offer.pricing.total !== null && offer.ranking.scheduleVerified);
  const requiredProviders = (options.providers ?? [...new Set(ranked.map((offer) => offer.provider))])
    .filter((provider) => ranked.some((offer) => offer.provider === provider && offer.available));
  const quotedProviders = [...new Set(ranked.filter((offer) => offer.available && offer.pricing.exact && offer.pricing.total !== null && offer.ranking.scheduleVerified)
    .map((offer) => offer.provider))];
  const missingQuoteProviders = requiredProviders.filter((provider) => !quotedProviders.includes(provider));
  const fastest = [...available].filter((offer) => offer.etaMinutes !== null).sort((a, b) => a.etaMinutes - b.etaMinutes)[0];
  const cheapest = [...exactPriced].sort((a, b) => a.pricing.total - b.pricing.total)[0];
  const bestRated = [...available].filter((offer) => offer.merchant.rating !== null)
    .sort((a, b) => ratingScore(b) - ratingScore(a))[0];
  for (const offer of ranked) {
    if (offer.id === cheapest?.id) offer.ranking.badges.push("cheapest exact total");
    if (offer.id === fastest?.id) offer.ranking.badges.push("fastest displayed ETA");
    if (offer.id === bestRated?.id) offer.ranking.badges.push("strongest rating signal");
    if (offer.ranking.overBudget) offer.ranking.badges.push(`exact total exceeds €${parsed.budget} budget`);
    if (Number(offer.pricing.itemSavings) > 0) offer.ranking.badges.push(`listed item deal saves €${Number(offer.pricing.itemSavings).toFixed(2)}`);
    if (Number(offer.pricing.discount) > 0 && offer.pricing.exact) offer.ranking.badges.push(`€${Number(offer.pricing.discount).toFixed(2)} checkout discount applied`);
    if (offer.promotion?.types?.includes("TWO_FOR_ONE") || offer.promotion?.types?.includes("BOGO")) offer.ranking.badges.push(
      offer.pricing.exact ? "listed 2-for-1 deal—exact checkout total used" : "listed 2-for-1 deal—validate checkout",
    );
    if (offer.promotion?.types?.includes("FREE_DELIVERY")) offer.ranking.badges.push(
      offer.pricing.exact ? "listed free delivery—exact checkout total used" : "listed free delivery—validate checkout",
    );
    if ((offer.promotion?.types?.length || offer.promotion?.descriptions?.length)
      && !offer.ranking.badges.some((badge) => /listed .*deal|listed free delivery/.test(badge))) offer.ranking.badges.push(
      offer.pricing.exact ? "listed provider deal—exact checkout total used" : "listed provider deal—validate checkout",
    );
    if (offer.membership?.active && offer.membership?.eligible) offer.ranking.badges.push(`${offer.membership.name ?? "membership"} eligible`);
    if (offer.signals.matchedPreference?.length) offer.ranking.badges.push(`matches preference: ${offer.signals.matchedPreference.join(", ")}`);
    if (offer.semanticAssessment) offer.ranking.badges.push(
      `model request fit ${offer.semanticAssessment.requestFit}/100 (${offer.semanticAssessment.confidence} confidence)`,
    );
    if (!offer.pricing.exact) offer.ranking.badges.push("estimate—validate checkout");
    if (parsed.deliveryTime === "scheduled" && !offer.ranking.scheduleVerified) offer.ranking.badges.push("requested time not verified");
  }
  return {
    objective,
    offers: ranked,
    exactPriceComparison: requiredProviders.length > 0 && missingQuoteProviders.length === 0,
    exactPriceCoverage: { requiredProviders, quotedProviders, missingQuoteProviders },
    winnerReady: exactPriced.length > 0 && requiredProviders.length > 0 && missingQuoteProviders.length === 0,
  };
}
