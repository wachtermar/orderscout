import { createHash } from "node:crypto";
import { CliError } from "./lib.js";
import { PROVIDERS, assertProvider } from "./providers.js";
import { parsePackVolume } from "./recommend.js";

const numberOrNull = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
  ? null : Number(value);
const money = (value) => value === null ? null : Math.round(value * 100) / 100;

export function parseObjective(intent) {
  const text = String(intent ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(fastest|quickest|rapido|rapida|antes|asap)\b/.test(text)) return "fastest";
  if (/\b(best rated|highest rated|mejor valorad|calidad|best quality|tasty|delicious|sabros|rico|rica)\b/.test(text)) return "best";
  if (/\b(cheapest|lowest price|cheap|barat|econom|mejor oferta)\b/.test(text)) return "cheapest";
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
  const computedTotal = subtotal === null ? null : subtotal + knownFees.reduce((sum, value) => sum + value, 0) - discount;
  const total = numberOrNull(input.pricing?.total) ?? computedTotal;
  const volume = input.package?.totalLiters
    ? input.package
    : parsePackVolume(`${itemName} ${input.item?.description ?? ""}`);
  const suppliedLiters = numberOrNull(input.suppliedLiters) ?? (volume ? volume.totalLiters * quantity : null);
  const stable = JSON.stringify([provider, input.merchant?.id, merchantName, input.item?.id, itemName, input.url]);
  return {
    id: input.id ?? createHash("sha256").update(stable).digest("hex").slice(0, 20),
    provider,
    providerName: PROVIDERS[provider].name,
    merchant: {
      id: input.merchant?.id ?? null,
      name: merchantName,
      rating: numberOrNull(input.merchant?.rating ?? input.rating),
      ratingCount: numberOrNull(input.merchant?.ratingCount ?? input.ratingCount),
    },
    item: {
      id: input.item?.id ?? null,
      name: itemName,
      description: input.item?.description ?? null,
      unitPrice: money(unitPrice),
    },
    quantity,
    package: volume,
    suppliedLiters,
    etaMinutes: numberOrNull(input.etaMinutes),
    available: input.available !== false,
    pricing: {
      currency: input.pricing?.currency ?? "EUR",
      subtotal: money(subtotal),
      fees: Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, money(value)])),
      discount: money(discount),
      total: money(total),
      exact: Boolean(input.pricing?.exact),
      missing: [
        ...(subtotal === null ? ["subtotal"] : []),
        ...(!input.pricing?.exact ? ["final checkout validation"] : []),
      ],
    },
    membership: input.membership ?? context.membership ?? null,
    promotion: input.promotion ?? null,
    url: trustedProviderUrl(provider, input.url),
    source: input.source ?? null,
    signals: {
      health: numberOrNull(input.signals?.health) ?? 0,
      taste: numberOrNull(input.signals?.taste) ?? 0,
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
  const count = offer.merchant.ratingCount ?? 0;
  const confidence = Math.min(1, Math.log10(count + 1) / 3);
  return ((rating / 5) * confidence + 0.7 * (1 - confidence)) * 100;
}

function priceForRanking(offer) {
  if (offer.pricing.total === null) return Number.POSITIVE_INFINITY;
  return offer.pricing.total + (offer.pricing.exact ? 0 : 4);
}

function scoreOffer(offer, objective) {
  const price = priceForRanking(offer);
  const eta = offer.etaMinutes ?? 120;
  const rating = ratingScore(offer);
  const healthTaste = offer.signals.health * 0.7 + offer.signals.taste * 0.6;
  if (!offer.available) return -1_000_000;
  if (objective === "cheapest") return -price * 20 - eta * 0.08 + rating * 0.08;
  if (objective === "fastest") return -eta * 8 - price * 0.35 + rating * 0.08;
  if (objective === "best") return rating * 2 + healthTaste - price * 0.8 - eta * 0.12;
  return rating + healthTaste - price * 2.4 - eta * 0.45;
}

export function rankOffers(offers, intent, objective = parseObjective(intent)) {
  const ranked = offers.map((offer) => ({ ...offer, ranking: { objective, score: scoreOffer(offer, objective), badges: [] } }))
    .sort((a, b) => b.ranking.score - a.ranking.score || String(a.id).localeCompare(String(b.id)));
  const available = ranked.filter((offer) => offer.available);
  const exactPriced = available.filter((offer) => offer.pricing.exact && offer.pricing.total !== null);
  const fastest = [...available].filter((offer) => offer.etaMinutes !== null).sort((a, b) => a.etaMinutes - b.etaMinutes)[0];
  const cheapest = [...exactPriced].sort((a, b) => a.pricing.total - b.pricing.total)[0];
  const bestRated = [...available].filter((offer) => offer.merchant.rating !== null)
    .sort((a, b) => ratingScore(b) - ratingScore(a))[0];
  for (const offer of ranked) {
    if (offer.id === cheapest?.id) offer.ranking.badges.push("cheapest exact total");
    if (offer.id === fastest?.id) offer.ranking.badges.push("fastest displayed ETA");
    if (offer.id === bestRated?.id) offer.ranking.badges.push("strongest rating signal");
    if (!offer.pricing.exact) offer.ranking.badges.push("estimate—validate checkout");
  }
  return { objective, offers: ranked, exactPriceComparison: exactPriced.length >= 2 };
}
