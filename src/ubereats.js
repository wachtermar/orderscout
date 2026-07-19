import { createHash, randomUUID } from "node:crypto";
import { CliError } from "./lib.js";
import { loadBrowserSession } from "./browser-session.js";

const BASE = "https://www.ubereats.com";

function apiHeaders(cookieHeader) {
  return {
    accept: "application/json",
    "accept-language": "es-ES,es;q=0.9",
    "content-type": "application/json",
    "x-csrf-token": "x",
    origin: BASE,
    referer: `${BASE}/es`,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  };
}

async function request(operation, body = {}, { auth = false, fetchImpl = fetch } = {}) {
  const session = await loadBrowserSession("ubereats");
  if (auth && !session) throw new CliError("Sign in with `pide auth login ubereats` first", "AUTH_REQUIRED");
  const response = await fetchImpl(`${BASE}/_p/api/${operation}`, {
    method: "POST",
    headers: apiHeaders(session?.cookieHeader),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 500) }; }
  if (!response.ok) throw new CliError(`Uber Eats returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? "AUTH_EXPIRED" : "UBEREATS_HTTP_ERROR", { status: response.status, operation });
  if (payload?.status === "failure" || payload?.code === 3) {
    const message = payload?.data?.message || payload?.message || "Uber Eats rejected the session";
    throw new CliError(message, /session|status code error|unauth/i.test(message) || payload?.code === 3 ? "AUTH_EXPIRED" : "UBEREATS_API_ERROR", { operation });
  }
  return payload?.data ?? payload;
}

function price(value) {
  if (typeof value === "object" && value) {
    if (value.base?.low !== undefined && Number.isFinite(Number(value.exponent))) return Number(value.base.low) * 10 ** Number(value.exponent);
    return price(value.amount ?? value.value ?? value.price ?? value.purchasePriceV2);
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9,.-]/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number.isInteger(number) && Math.abs(number) >= 100 ? number / 100 : number;
}

function eta(value) {
  const text = typeof value === "string" ? value : value?.text ?? value?.label ?? "";
  const numbers = text.match(/\d+/g)?.map(Number) ?? [];
  if (!numbers.length) return null;
  return { min: numbers[0], max: numbers[1] ?? numbers[0] };
}

function storeValue(value) {
  if (!value || typeof value !== "object") return null;
  const uuid = value.storeUuid ?? value.uuid ?? value.storeUUID;
  const name = value.title?.text ?? value.name?.text ?? value.title ?? value.name;
  if (!uuid || !name) return null;
  return {
    id: uuid,
    name,
    slug: value.slug ?? null,
    rating: Number(value.rating?.ratingValue ?? value.rating ?? value.ratingValue ?? value.tracking?.storePayload?.ratingInfo?.storeRatingScore) || null,
    ratingCount: Number(String(value.rating?.reviewCount ?? value.ratingCount ?? value.tracking?.storePayload?.ratingInfo?.ratingCount ?? "").replace(/[^0-9]/g, "")) || null,
    etaMinutes: value.tracking?.storePayload?.etdInfo?.dropoffETARange ?? eta(value.etaRange ?? value.eta ?? value.etaString ?? value.meta?.find((entry) => entry.badgeType === "ETD")),
    deliveryFee: price(value.deliveryFee?.discount ?? value.deliveryFee ?? value.fareInfo?.deliveryFee),
    membershipEligible: Boolean(value.hasUberOneBenefits ?? value.uberOne ?? value.membershipBenefit),
    orderable: value.tracking?.storePayload?.isOrderable !== false,
    url: value.actionUrl ? new URL(value.actionUrl, BASE).toString() : value.slug ? `${BASE}/store/${value.slug}/${uuid}` : `${BASE}/search`,
  };
}

function itemValues(container) {
  const candidates = [container?.items, container?.catalogItems, container?.menuItems, container?.products, container?.payload?.standardItemsPayload?.catalogItems];
  return candidates.find(Array.isArray) ?? [];
}

export function normalizeUberSearch(payload) {
  const offers = [];
  const seen = new Set();
  function add(store, item) {
    const id = item?.uuid ?? item?.catalogItemUuid ?? item?.menuItemUuid;
    const title = item?.title?.text ?? item?.name?.text ?? item?.title ?? item?.name;
    if (!store || !id || !title || seen.has(`${store.id}:${id}`)) return;
    seen.add(`${store.id}:${id}`);
    const unitPrice = price(item.price ?? item.itemPrice ?? item.priceTagline ?? item.subtitles?.[0]?.text ?? item.purchaseInfo?.purchaseOptions?.[0]?.purchasePriceV2);
    offers.push({
      provider: "ubereats",
      merchant: { id: store.id, name: store.name, rating: store.rating, ratingCount: store.ratingCount },
      item: { id, name: title, description: item.itemDescription ?? item.description ?? null, unitPrice },
      quantity: 1,
      etaMinutes: store.etaMinutes?.min ?? null,
      available: store.orderable !== false && item.isSoldOut !== true && item.isAvailable !== false,
      pricing: { currency: "EUR", subtotal: unitPrice, total: null, exact: false, fees: { delivery: store.deliveryFee } },
      membershipEligible: store.membershipEligible,
      url: store.url,
      source: { adapter: "ubereats-api", storeUuid: store.id, itemUuid: id, sectionUuid: item.sectionUuid ?? "", subsectionUuid: item.subsectionUuid ?? "", rawPrice: item.price ?? item.itemPrice ?? (unitPrice === null ? null : Math.round(unitPrice * 100)), requiresCustomizations: Boolean(item.hasCustomizations ?? item.customizationsList?.length) },
    });
  }
  function walk(value, inheritedStore = null) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((item) => walk(item, inheritedStore));
    const mini = value.miniStoreWithItems ?? value.storeWithItems;
    if (mini) {
      const store = storeValue(mini.store ?? mini.storeInfo ?? mini) ?? inheritedStore;
      itemValues(mini).forEach((item) => add(store, item));
      walk(mini, store);
    }
    const store = storeValue(value.store ?? value.storeInfo ?? value.analyticsLabel?.store) ?? inheritedStore;
    itemValues(value).forEach((item) => add(store, item));
    for (const child of Object.values(value)) walk(child, store);
  }
  walk(payload);
  return offers;
}

export async function searchUberEats(query, options = {}) {
  const payload = await request("getSearchFeedV1", {
    userQuery: query,
    date: "",
    startTime: 0,
    endTime: 0,
    sortAndFilters: [],
    vertical: "ALL",
    searchSource: "SEARCH_BAR",
    displayType: "SEARCH_RESULTS",
    searchType: "GLOBAL_SEARCH",
    keyName: "",
    cacheKey: "",
    recaptchaToken: "",
  }, options);
  const limit = Math.max(1, Number(options.limit ?? 60));
  return { offers: normalizeUberSearch(payload).slice(0, limit), raw: options.raw ? payload : undefined };
}

function collectCatalog(payload) {
  const items = [];
  const seen = new Set();
  function walk(value, sectionUuid = "", subsectionUuid = "") {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((item) => walk(item, sectionUuid, subsectionUuid));
    const nextSection = value.sectionUuid ?? sectionUuid;
    const nextSubsection = value.subsectionUuid ?? subsectionUuid;
    if (value.uuid && value.title && value.price !== undefined && !seen.has(value.uuid)) {
      seen.add(value.uuid);
      items.push({ uuid: value.uuid, title: value.title, description: value.itemDescription ?? null, price: price(value.price), rawPrice: value.price, imageUrl: value.imageUrl ?? null, available: value.isSoldOut !== true && value.isAvailable !== false, hasCustomizations: Boolean(value.hasCustomizations ?? value.customizationsList?.length), sectionUuid: nextSection, subsectionUuid: nextSubsection });
    }
    for (const [key, child] of Object.entries(value)) walk(child, key.includes("section") ? key : nextSection, nextSubsection);
  }
  walk(payload);
  return items;
}

export async function uberEatsMenu(storeUuid, options = {}) {
  const payload = await request("getStoreV1", { storeUuid, sfNuggetCount: 0 }, options);
  return { storeUuid, title: payload.title ?? payload.store?.title ?? "", isOpen: payload.isOpen !== false, items: collectCatalog(payload), raw: options.raw ? payload : undefined };
}

export async function uberEatsItem(source, options = {}) {
  return request("getMenuItemV1", { itemRequestType: "ITEM", storeUuid: source.storeUuid, sectionUuid: source.sectionUuid ?? "", subsectionUuid: source.subsectionUuid ?? "", menuItemUuid: source.itemUuid, diningMode: "DELIVERY" }, options);
}

export async function uberEatsMe(options = {}) {
  const payload = await request("getProfilesForUserV1", {}, { ...options, auth: true });
  const profiles = payload.profiles ?? [];
  const profile = profiles[0];
  if (!profile) throw new CliError("Uber Eats session has no active eater profile", "AUTH_EXPIRED");
  return { authenticated: true, id: profile.uuid ?? profile.id ?? null, name: [profile.firstName, profile.lastName].filter(Boolean).join(" "), email: profile.email ?? null, phone: profile.phoneNumber ?? null };
}

export async function uberEatsCarts(options = {}) {
  const payload = await request("getDraftOrdersByEaterUuidV1", {}, { ...options, auth: true });
  return { draftOrders: payload.draftOrders ?? payload.orders ?? [] };
}

export async function createUberEatsBasket(offer, options = {}) {
  const source = offer.source ?? {};
  if (!source.storeUuid || !source.itemUuid) throw new CliError("Uber Eats offer is missing cart identifiers", "SOURCE_PLAN_MISSING");
  if (source.requiresCustomizations && !options.customizations) {
    const details = await uberEatsItem(source, options);
    throw new CliError("This item requires customization choices", "MODIFIERS_REQUIRED", { customizations: details.customizationsList ?? [] });
  }
  const item = {
    uuid: source.itemUuid,
    shoppingCartItemUuid: randomUUID(),
    storeUuid: source.storeUuid,
    sectionUuid: source.sectionUuid ?? "",
    subsectionUuid: source.subsectionUuid ?? "",
    price: source.rawPrice ?? Math.round(Number(offer.item?.unitPrice ?? 0) * 100),
    title: offer.item?.name,
    quantity: offer.quantity ?? 1,
    customizations: options.customizations ?? {},
  };
  if (options.prepareOnly) return { mutated: false, payload: { isMulticart: true, shoppingCartItems: [item] }, submitted: false };
  const payload = await request("createDraftOrderV2", { isMulticart: true, shoppingCartItems: [item] }, { ...options, auth: true });
  return { mutated: true, draftOrder: payload.draftOrder ?? payload, submitted: false };
}

export async function quoteUberEatsBasket(draftOrderUuid, options = {}) {
  const quote = await request("getCheckoutPresentationV1", { draftOrderUUID: draftOrderUuid }, { ...options, auth: true });
  return { provider: "ubereats", draftOrderUuid, quote, submitted: false };
}

function findNumber(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (value[key] !== undefined) { const amount = price(value[key]); if (amount !== null) return amount; }
  for (const child of Object.values(value)) { const amount = findNumber(child, keys); if (amount !== null) return amount; }
  return null;
}

export function uberEatsOrderConfirmation(draftOrderUuid, quote) {
  const requestBody = { draftOrderUUIDs: [draftOrderUuid] };
  const confirmation = { provider: "ubereats", draftOrderUuid, total: findNumber(quote, ["total", "totalAmount", "payableAmount"]), currency: quote?.currencyCode ?? quote?.currency ?? "EUR", requestBody };
  return { ...confirmation, fingerprint: createHash("sha256").update(JSON.stringify(confirmation)).digest("hex").slice(0, 16) };
}

export async function placeUberEatsOrder(draftOrderUuid, quote, options = {}) {
  const confirmation = uberEatsOrderConfirmation(draftOrderUuid, quote);
  if (!options.confirm) return { ...confirmation, submitted: false, requiresConfirmation: confirmation.fingerprint, warning: "Final purchase boundary. Confirm the current exact total and payment method before re-running with this fingerprint." };
  if (options.confirm !== confirmation.fingerprint) throw new CliError("Confirmation fingerprint does not match the current checkout", "CONFIRMATION_MISMATCH");
  if (process.env.PIDE_ENABLE_ORDER_PLACEMENT !== "1") throw new CliError("Order placement is disabled; set PIDE_ENABLE_ORDER_PLACEMENT=1 only after explicit approval", "ORDER_PLACEMENT_DISABLED");
  try {
    const response = await request("checkoutOrdersByDraftOrdersV1", confirmation.requestBody, { ...options, auth: true });
    return { submitted: true, response };
  } catch (error) {
    if (error.code === "NETWORK_ERROR" || error.code === "UBEREATS_HTTP_ERROR") throw new CliError("The Uber Eats checkout outcome is unknown. Do not retry automatically; inspect active orders.", "ORDER_STATUS_UNKNOWN", { draftOrderUuid });
    throw error;
  }
}

export const uberEatsInternals = { apiHeaders, collectCatalog, price, request };
