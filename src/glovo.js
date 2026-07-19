import { createHash, randomUUID } from "node:crypto";
import { CliError } from "./lib.js";
import { loadBrowserSession } from "./browser-session.js";

const API = "https://api.glovoapp.com";
const WEB = "https://glovoapp.com";
const APP_VERSION = "v1.1782.0";

function slug(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cookieValue(header, name) {
  const prefix = `${name}=`;
  return String(header ?? "").split(/;\s*/).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function deepToken(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["accessToken", "access_token", "token"]) {
    if (typeof value[key] === "string" && value[key].length > 20) return value[key];
  }
  for (const child of Object.values(value)) {
    const token = deepToken(child);
    if (token) return token;
  }
  return null;
}

function accessToken(session) {
  const raw = cookieValue(session?.cookieHeader, "glovo_auth_info");
  if (!raw) return null;
  for (const candidate of [raw, decodeURIComponent(raw)]) {
    try {
      const token = deepToken(JSON.parse(candidate));
      if (token) return token;
    } catch { /* try the next representation */ }
  }
  return null;
}

function headers(location = {}, token) {
  const session = randomUUID();
  const now = String(Date.now());
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "glovo-api-version": "14",
    "glovo-app-context": "web",
    "glovo-app-development-state": "prod",
    "glovo-app-platform": "web",
    "glovo-app-type": "customer",
    "glovo-app-version": APP_VERSION,
    "glovo-client-info": `web-customer-web-react/${APP_VERSION} project:customer-web`,
    "glovo-delivery-location-latitude": String(location.latitude ?? ""),
    "glovo-delivery-location-longitude": String(location.longitude ?? ""),
    "glovo-delivery-location-accuracy": "0",
    "glovo-delivery-location-timestamp": now,
    "glovo-device-urn": `glv:device:${randomUUID()}`,
    "glovo-dynamic-session-id": session,
    "glovo-language-code": "es",
    "glovo-location-city-code": location.cityCode ?? "",
    "glovo-location-country-code": "ES",
    "glovo-perseus-client-id": randomUUID(),
    "glovo-perseus-consent": "essential",
    "glovo-perseus-session-id": session,
    "glovo-perseus-session-timestamp": now,
    "glovo-request-id": randomUUID(),
    "glovo-request-ttl": "7500",
    ...(token ? { authorization: /^Bearer /i.test(token) ? token : `Bearer ${token}` } : {}),
  };
}

async function request(path, { method = "GET", body, location, auth = false, fetchImpl = fetch, cookieHeader } = {}) {
  const session = cookieHeader ? { cookieHeader, source: "verification" } : await loadBrowserSession("glovo");
  const token = accessToken(session);
  if (auth && !token) throw new CliError("Sign in with `orderscout auth login glovo` first", "AUTH_REQUIRED");
  const response = await fetchImpl(new URL(path, API), {
    method,
    headers: headers(location, token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { payload = { message: text }; }
  if (!response.ok) throw new CliError(payload?.message ?? `Glovo returned HTTP ${response.status}`, response.status === 401 ? "AUTH_EXPIRED" : "GLOVO_HTTP_ERROR", { status: response.status, path });
  return payload;
}

export async function glovoLocation(location, fetchImpl = fetch) {
  if (!Number.isFinite(Number(location?.latitude)) || !Number.isFinite(Number(location?.longitude))) {
    throw new CliError("Glovo search requires delivery coordinates", "INVALID_LOCATION");
  }
  const citySlug = slug(location.city ?? location.matched?.split(",").at(-1) ?? "");
  if (!citySlug) throw new CliError("Could not determine the Glovo city", "INVALID_LOCATION");
  const html = await fetchImpl(`${WEB}/es/es/${citySlug}`).then((response) => response.text());
  const cityCode = html.match(/cityCode(?:\\?"|&quot;):(?:\\?"|&quot;)([A-Z0-9_-]+)/)?.[1];
  if (!cityCode) throw new CliError(`Glovo does not appear to serve ${location.city ?? citySlug}`, "LOCATION_NOT_FOUND");
  return { ...location, citySlug, cityCode };
}

function queryFromAction(object) {
  const path = object?.actions?.find((action) => action?.data?.path)?.data?.path;
  if (!path) return {};
  try { return Object.fromEntries(new URL(path, WEB).searchParams); }
  catch { return {}; }
}

function numericText(value) {
  const number = Number(String(value ?? "").replace(/[^0-9,.-]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function storeFromCard(card, location) {
  const query = queryFromAction(card);
  const labels = card.data?.labels ?? [];
  const texts = JSON.stringify(labels);
  const eta = texts.match(/(\d+)\s*-\s*(\d+)\s*min/i);
  const rating = texts.match(/(\d{1,3})%/);
  return {
    id: query.store_id ?? null,
    addressId: query.shop_id ?? null,
    categoryId: query.category_id ?? "1",
    name: card.data?.title?.text?.text ?? card.data?.title ?? "Glovo store",
    slug: card.data?.slug ?? null,
    rating: rating ? Number(rating[1]) / 20 : null,
    ratingPercent: rating ? Number(rating[1]) : null,
    etaMinutes: eta ? { min: Number(eta[1]), max: Number(eta[2]) } : null,
    deliveryFee: numericText(query.shop_delivery_fee),
    prime: query.shop_is_prime === "true",
    url: card.data?.slug ? `${WEB}/es/es/${location.citySlug}/stores/${card.data.slug}` : null,
  };
}

function offersFromSearch(payload, location) {
  const offers = [];
  const seen = new Set();
  function walk(value, currentStore = null) {
    if (!value || typeof value !== "object") return currentStore;
    if (Array.isArray(value)) {
      let store = currentStore;
      for (const item of value) store = walk(item, store) ?? store;
      return store;
    }
    let store = currentStore;
    if (value.type === "STORE_CARD_V2") store = storeFromCard(value, location);
    if (value.type === "PRODUCT_ITEM_CARD_V2" && store) {
      const query = queryFromAction(value);
      const id = query.product_id ?? value.data?.id ?? value.data?.storeProductId;
      const key = `${store.addressId}:${id}`;
      if (id && !seen.has(key)) {
        seen.add(key);
        offers.push({
          provider: "glovo",
          merchant: { id: store.id, addressId: store.addressId, name: store.name, rating: store.rating, ratingPercent: store.ratingPercent },
          item: { id, externalId: query.product_external_id ?? null, storeProductId: query.store_product_id ?? null, name: value.data?.name?.text ?? value.data?.name, unitPrice: numericText(value.data?.pricing?.finalPrice) },
          quantity: 1,
          etaMinutes: store.etaMinutes?.min ?? null,
          available: true,
          pricing: { currency: "EUR", subtotal: numericText(value.data?.pricing?.finalPrice), total: null, exact: false, fees: { delivery: store.deliveryFee } },
          membershipEligible: store.prime,
          url: store.url,
          source: { adapter: "glovo-api", storeId: store.id, storeAddressId: store.addressId, storeCategoryId: store.categoryId, productId: id, productExternalId: query.product_external_id ?? null, storeProductId: query.store_product_id ?? null },
        });
      }
    }
    for (const child of Object.values(value)) store = walk(child, store) ?? store;
    return store;
  }
  walk(payload);
  return offers;
}

export async function searchGlovo(query, location, options = {}) {
  const resolved = location.cityCode && location.citySlug ? location : await glovoLocation(location, options.fetchImpl);
  const payload = await request(`/v1/web/store_wall/search?searchQuery=${encodeURIComponent(query)}`, {
    method: "POST",
    body: { searchContext: { searchId: randomUUID() } },
    location: resolved,
    fetchImpl: options.fetchImpl,
  });
  const limit = Math.max(1, Number(options.limit ?? 60));
  return { location: resolved, offers: offersFromSearch(payload, resolved).slice(0, limit), raw: options.raw ? payload : undefined };
}

function nextFlightText(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)<\/script>/g)]
    .map((match) => JSON.parse(match[1])).join("");
}

function objectsOfType(text, type) {
  const needle = `{"type":"${type}","data":`;
  const objects = [];
  for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + needle.length)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { objects.push(JSON.parse(text.slice(start, index + 1))); } catch { /* ignore an RSC boundary */ }
        break;
      }
    }
  }
  return objects;
}

export async function glovoMenu(url, fetchImpl = fetch) {
  const parsed = new URL(url);
  if (parsed.origin !== WEB || !parsed.pathname.includes("/stores/")) throw new CliError("A trusted Glovo store URL is required", "INVALID_URL");
  const response = await fetchImpl(parsed, { headers: { "accept-language": "es-ES" } });
  if (!response.ok) throw new CliError(`Glovo store page returned HTTP ${response.status}`, "GLOVO_HTTP_ERROR");
  const products = objectsOfType(nextFlightText(await response.text()), "PRODUCT_ROW").map(({ data }) => ({
    id: data.id, externalId: data.externalId, storeProductId: data.storeProductId, name: data.name,
    description: data.description ?? null, price: data.priceInfo?.amount ?? data.price, currency: data.priceInfo?.currencyCode ?? "EUR",
    requiresCustomizations: Boolean(data.attributeGroups?.length), attributeGroups: data.attributeGroups ?? [], available: true,
  }));
  return { url: parsed.toString(), products: [...new Map(products.map((item) => [item.id, item])).values()] };
}

export async function glovoMe(options = {}) {
  const profile = await request("/v3/me", { auth: true, fetchImpl: options.fetchImpl, cookieHeader: options.cookieHeader });
  const membership = await request(`/customers/${profile.id}/subscription/status`, { auth: true, fetchImpl: options.fetchImpl, cookieHeader: options.cookieHeader }).catch(() => null);
  return { authenticated: true, id: profile.id, name: profile.name, email: profile.email, preferredCityCode: profile.preferredCityCode, membershipActive: Boolean(membership?.isSubscribed), raw: options.raw ? profile : undefined };
}

export async function glovoAddresses(options = {}) {
  const payload = await request("/customer_profile/api/v1/address_book/me/addresses", { auth: true, fetchImpl: options.fetchImpl, cookieHeader: options.cookieHeader });
  const entries = Array.isArray(payload) ? payload : payload?.addresses ?? payload?.data?.addresses ?? payload?.data ?? [];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const address = entry?.address ?? entry;
    return {
      id: address.id ?? address.addressId,
      label: entry?.title ?? address.label ?? address.tag ?? address.type ?? address.kind ?? address.addressLine,
      latitude: Number(address.latitude ?? address.location?.latitude ?? address.coordinates?.latitude),
      longitude: Number(address.longitude ?? address.location?.longitude ?? address.coordinates?.longitude),
      city: address.city ?? address.cityName,
      cityCode: address.cityCode ?? address.city?.code,
      isDefault: Boolean(address.isDefault ?? address.default ?? entry?.entryType === "CURRENT"),
    };
  }).filter((address) => Number.isFinite(address.latitude) && Number.isFinite(address.longitude));
}

export async function glovoBaskets(options = {}) {
  const me = await glovoMe(options);
  const baskets = await request(`/v1/authenticated/customers/${me.id}/baskets`, { auth: true, location: options.location, fetchImpl: options.fetchImpl });
  return { customerId: me.id, baskets: baskets ?? [] };
}

function glovoProduct(source, quantity) {
  return { ids: { id: String(source.productId), externalId: source.productExternalId ?? "", legacyId: String(source.productId), storeProductId: source.storeProductId ?? "" }, quantity: { increments: quantity }, customizations: [] };
}

export async function createGlovoBasket(offer, options = {}) {
  const source = offer.source ?? {};
  if (!source.storeId || !source.storeAddressId || !source.productId) throw new CliError("Glovo offer is missing basket identifiers", "SOURCE_PLAN_MISSING");
  if (options.prepareOnly) return { mutated: false, payload: { products: [glovoProduct(source, offer.quantity ?? 1)], storeId: source.storeId, storeAddressId: Number(source.storeAddressId), storeCategoryId: source.storeCategoryId ?? "1", handlingStrategy: "DELIVERY" } };
  const me = await glovoMe(options);
  const existing = await request(`/v1/authenticated/customers/${me.id}/baskets/stores/${source.storeId}`, { auth: true, location: options.location, fetchImpl: options.fetchImpl });
  let basket;
  if (!existing) {
    basket = await request(`/v1/authenticated/customers/${me.id}/baskets`, { method: "POST", auth: true, location: options.location, fetchImpl: options.fetchImpl, body: { products: [glovoProduct(source, offer.quantity ?? 1)], storeId: source.storeId, storeAddressId: Number(source.storeAddressId), storeCategoryId: source.storeCategoryId ?? "1", handlingStrategy: "DELIVERY" } });
  } else {
    const product = glovoProduct(source, offer.quantity ?? 1);
    basket = await request(`/v1/authenticated/customers/${me.id}/baskets/${existing.basketId}/products`, { method: "PUT", auth: true, location: options.location, fetchImpl: options.fetchImpl, body: { ...existing, products: [...(existing.products ?? []), product] } });
  }
  return { mutated: true, basket, submitted: false };
}

export async function quoteGlovoBasket(basketId, options = {}) {
  const quote = await request(`/v1/authenticated/customers/baskets/${encodeURIComponent(basketId)}/validate`, { method: "POST", auth: true, location: options.location, fetchImpl: options.fetchImpl });
  return { provider: "glovo", basketId, quote, submitted: false };
}

export function glovoCheckoutUrl(offer) {
  const city = new URL(offer.url).pathname.split("/")[3];
  const url = new URL(`${WEB}/es/es/${city}/order-summary`);
  url.searchParams.set("storeId", offer.source.storeId);
  return url.toString();
}

export function glovoOrderConfirmation(offer, quote) {
  const basketId = quote?.basketId ?? quote?.id;
  const submission = glovoSubmissionRequest(basketId, quote);
  const request = {
    provider: "glovo",
    storeId: offer.source?.storeId,
    basketId,
    total: findAmount(quote, ["total", "totalAmount", "payableAmount", "finalPrice"]),
    currency: quote?.currencyCode ?? quote?.currency ?? "EUR",
    endpoint: submission.path,
    method: submission.method,
    requestBody: submission.body,
    protocolSource: submission.source,
  };
  return { ...request, fingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16) };
}

function findAmount(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (value[key] !== undefined) {
      const amount = numericText(value[key]?.major ?? value[key]?.amount ?? value[key]);
      if (amount !== null) return amount;
    }
  }
  for (const child of Object.values(value)) {
    const amount = findAmount(child, keys);
    if (amount !== null) return amount;
  }
  return null;
}

function findSubmitAction(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const action = findSubmitAction(child);
      if (action) return action;
    }
    return null;
  }
  const kind = String(value.type ?? value.name ?? value.actionType ?? value.id ?? "");
  const data = value.data ?? value;
  const endpoint = data.path ?? data.url ?? data.endpoint ?? data.uri;
  if (/(SUBMIT|CREATE|PLACE|CONFIRM).*(ORDER|CHECKOUT)|(ORDER|CHECKOUT).*(SUBMIT|CREATE|PLACE|CONFIRM)/i.test(kind) && endpoint) {
    return {
      method: String(data.method ?? "POST").toUpperCase(),
      path: trustedApiPath(endpoint),
      body: data.body ?? data.payload ?? data.requestBody ?? data.request ?? {},
      source: "checkout-action",
    };
  }
  for (const child of Object.values(value)) {
    const action = findSubmitAction(child);
    if (action) return action;
  }
  return null;
}

function trustedApiPath(value) {
  const url = new URL(value, API);
  if (url.origin !== API) throw new CliError("Glovo checkout returned an untrusted submission endpoint", "UNTRUSTED_CHECKOUT_ENDPOINT");
  return `${url.pathname}${url.search}`;
}

export function glovoSubmissionRequest(basketId, quote) {
  const observed = findSubmitAction(quote);
  if (observed) return observed;
  const checkoutSessionId = quote?.checkoutSessionId ?? quote?.checkoutSession?.id ?? quote?.id;
  const configuredPath = process.env.ORDERSCOUT_GLOVO_ORDER_PATH ?? "/v1/authenticated/customers/orders";
  return {
    method: "POST",
    path: trustedApiPath(configuredPath),
    body: { basketId, ...(checkoutSessionId ? { checkoutSessionId } : {}) },
    source: process.env.ORDERSCOUT_GLOVO_ORDER_PATH ? "environment-override" : "experimental-fallback",
  };
}

export async function placeGlovoOrder(offer, quote, options = {}) {
  const confirmation = glovoOrderConfirmation(offer, quote);
  if (!options.confirm) {
    return {
      ...confirmation,
      submitted: false,
      experimental: true,
      requiresConfirmation: confirmation.fingerprint,
      warning: "Experimental Glovo final-submit protocol. Confirm the exact current order, total, address, and payment method before re-running with this fingerprint.",
    };
  }
  if (options.confirm !== confirmation.fingerprint) throw new CliError("Confirmation fingerprint does not match the current Glovo checkout", "CONFIRMATION_MISMATCH");
  if (process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT !== "1") throw new CliError("Order placement is disabled; set ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1 only after explicit approval", "ORDER_PLACEMENT_DISABLED");
  const submission = glovoSubmissionRequest(confirmation.basketId, quote);
  try {
    const response = await request(submission.path, { method: submission.method, body: submission.body, auth: true, location: options.location, fetchImpl: options.fetchImpl });
    return { provider: "glovo", submitted: true, experimental: true, response };
  } catch (error) {
    if (!error.details?.status || error.details.status >= 500) {
      throw new CliError("The Glovo checkout outcome is unknown. Do not retry automatically; inspect active orders in Glovo.", "ORDER_STATUS_UNKNOWN", { basketId: confirmation.basketId });
    }
    throw error;
  }
}

export const glovoInternals = { accessToken, offersFromSearch, nextFlightText, objectsOfType, headers, findSubmitAction, trustedApiPath };
