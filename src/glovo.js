import { createHash, randomUUID } from "node:crypto";
import { CliError } from "./lib.js";
import { loadBrowserSession, persistBrowserSession, withBrowserSessionLock } from "./browser-session.js";
import { cachedProviderRead } from "./provider-cache.js";

const API = "https://api.glovoapp.com";
const WEB = "https://glovoapp.com";
const APP_VERSION = "v1.2483.0";
const REFRESH_LEEWAY_MS = 90_000;
const DISCOVERY_CACHE_TTL_MS = 2 * 60_000;
const MENU_CACHE_TTL_MS = 15 * 60_000;
const CATALOG_QUERY_CACHE_TTL_MS = 5 * 60_000;
const DISCOVERY_STALE_IF_ERROR_MS = 15 * 60_000;
const MENU_STALE_IF_ERROR_MS = 30 * 60_000;
const CATALOG_STALE_IF_ERROR_MS = 15 * 60_000;
const refreshes = new Map();

function slug(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function cacheText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().replace(/\s+/g, " ").toLowerCase();
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

function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(Number(payload.exp)) ? new Date(Number(payload.exp) * 1_000).toISOString() : null;
  } catch { return null; }
}

function setCookieValue(header, name, value) {
  const encoded = `${name}=${value}`;
  const parts = String(header ?? "").split(/;\s*/).filter(Boolean);
  const index = parts.findIndex((part) => part.startsWith(`${name}=`));
  if (index >= 0) parts[index] = encoded;
  else parts.push(encoded);
  return parts.join("; ");
}

function headers(location = {}, token, sessionContext = {}) {
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
    "glovo-device-urn": sessionContext.deviceUrn ?? `glv:device:${randomUUID()}`,
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

async function responsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  try { return text ? parseJsonLosslessIds(text) : null; }
  catch { return { message: text }; }
}

// Glovo product IDs can exceed Number.MAX_SAFE_INTEGER. JSON.parse would round
// those identifiers and later produce a basket payload for the wrong/nonexistent
// product. Quote only unsafe integer tokens outside JSON strings before parsing;
// ordinary prices, timestamps, booleans, and string contents are untouched.
function parseJsonLosslessIds(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" || /[0-9]/.test(character)) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        const token = match[0];
        const digits = token.replace(/^-/, "");
        output += !/[.eE]/.test(token) && digits.length >= 16 ? `"${token}"` : token;
        index += token.length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return JSON.parse(output);
}

async function refreshGlovoSession(session, { fetchImpl = fetch, persist = true } = {}) {
  if (!session?.refreshToken) throw new CliError("The saved Glovo login cannot be renewed; complete Glovo login once more", "AUTH_EXPIRED");
  const refreshKey = createHash("sha256").update(session.refreshToken).digest("hex");
  if (refreshes.has(refreshKey)) return refreshes.get(refreshKey);
  const renew = async () => {
    if (persist && session.source !== "environment" && session.source !== "verification") {
      const current = await loadBrowserSession("glovo");
      if (current?.refreshToken && current.refreshToken !== session.refreshToken) {
        Object.assign(session, current);
        if (!shouldRefresh(session, accessToken(session))) return session;
      }
    }
    const response = await fetchImpl(new URL("/oauth/refresh", API), {
      method: "POST",
      headers: headers({}, null, session),
      body: JSON.stringify({ refreshToken: session.refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      const expired = [400, 401, 403].includes(response.status);
      throw new CliError(
        expired ? "The saved Glovo login can no longer be renewed; complete Glovo login once more" : (payload?.message ?? `Glovo returned HTTP ${response.status}`),
        expired ? "AUTH_EXPIRED" : "GLOVO_HTTP_ERROR",
        { status: response.status, path: "/oauth/refresh" },
      );
    }
    if (typeof payload?.accessToken !== "string" || payload.accessToken.length < 48 || typeof payload?.refreshToken !== "string" || payload.refreshToken.length < 48) {
      throw new CliError("Glovo returned incomplete renewed credentials", "INVALID_AUTH");
    }
    Object.assign(session, {
      version: 2,
      cookieHeader: setCookieValue(session.cookieHeader, "glovo_auth_info", encodeURIComponent(JSON.stringify({ accessToken: payload.accessToken }))),
      refreshToken: payload.refreshToken,
      refreshedAt: new Date().toISOString(),
      accessExpiresAt: jwtExpiresAt(payload.accessToken),
    });
    if (persist && session.source !== "environment" && session.source !== "verification") await persistBrowserSession("glovo", session);
    return session;
  };
  const pending = persist && session.source !== "environment" && session.source !== "verification"
    ? withBrowserSessionLock("glovo", renew)
    : renew();
  refreshes.set(refreshKey, pending);
  try { return await pending; }
  finally { refreshes.delete(refreshKey); }
}

function shouldRefresh(session, token, now = Date.now()) {
  if (!session?.refreshToken) return false;
  if (!token) return true;
  const expiresAt = jwtExpiresAt(token);
  return expiresAt ? Date.parse(expiresAt) - now <= REFRESH_LEEWAY_MS : false;
}

async function request(path, {
  method = "GET", body, location, auth = false, retryAuth = method === "GET",
  retryNetwork = method === "GET", fetchImpl = fetch, cookieHeader, session: providedSession,
} = {}) {
  let session = providedSession ?? (cookieHeader ? { cookieHeader, source: "verification" } : await loadBrowserSession("glovo"));
  const persistRefresh = !providedSession && !cookieHeader;
  let token = accessToken(session);
  if (shouldRefresh(session, token)) {
    session = await refreshGlovoSession(session, { fetchImpl, persist: persistRefresh });
    token = accessToken(session);
  }
  if (auth && !token) throw new CliError("Sign in with `orderscout auth login glovo` first", "AUTH_REQUIRED");
  for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
    let response;
    const networkAttempts = retryNetwork ? 2 : 1;
    for (let networkAttempt = 0; networkAttempt < networkAttempts; networkAttempt += 1) {
      try {
        response = await fetchImpl(new URL(path, API), {
          method,
          headers: headers(location, token, session),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(20_000),
        });
        break;
      } catch (error) {
        if (networkAttempt + 1 < networkAttempts) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          continue;
        }
        throw new CliError("Could not reach Glovo", "NETWORK_ERROR", { path, cause: error?.name ?? "Error" });
      }
    }
    const payload = await responsePayload(response);
    if (response.ok) return payload;
    if (response.status === 401 && authAttempt === 0 && retryAuth && session?.refreshToken) {
      session = await refreshGlovoSession(session, { fetchImpl, persist: persistRefresh });
      token = accessToken(session);
      continue;
    }
    throw new CliError(
      response.status === 429 ? "Glovo temporarily rate-limited search; wait before retrying" : (payload?.message ?? `Glovo returned HTTP ${response.status}`),
      response.status === 401 ? "AUTH_EXPIRED" : response.status === 429 ? "RATE_LIMITED" : "GLOVO_HTTP_ERROR",
      { status: response.status, path, retryAfter: response.headers.get("retry-after") ?? null },
    );
  }
  throw new CliError("Glovo authentication retry failed", "AUTH_EXPIRED");
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
  const normalized = String(value ?? "").replace(/[^0-9,.-]/g, "").replace(",", ".").trim();
  if (!normalized || normalized === "-" || normalized === ".") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function promotionText(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(promotionText);
  if (typeof value !== "object") return [];
  const direct = [typeof value.text === "string" ? value.text : null, value.accessibilityText]
    .filter((entry) => typeof entry === "string" && entry.trim());
  const semanticKeys = ["content", "richText", "richTextElements", "text", "label", "title"];
  return [...direct, ...semanticKeys.filter((key) => typeof value[key] === "object").flatMap((key) => promotionText(value[key]))];
}

function promotionFromCard(card, finalPrice) {
  const eventData = (card.actions ?? []).flatMap((action) => action?.data?.events ?? [])
    .map((event) => event?.data).filter(Boolean);
  const types = [...new Set(eventData.flatMap((event) => String(event.shopPromotionTypes ?? "").split(","))
    .map((type) => type.trim().toUpperCase()).filter(Boolean))];
  const ids = [...new Set(eventData.flatMap((event) => String(event.shopPromotionId ?? "").split(","))
    .map((id) => id.trim()).filter((id) => id && id !== "-1"))];
  const descriptions = [...new Set([
    ...promotionText(card.data?.promotionTags),
    ...promotionText(card.data?.bottomPromotionTags),
  ])];
  const originalPrice = numericText(card.data?.pricing?.originalPrice);
  const itemSavings = originalPrice !== null && finalPrice !== null && originalPrice > finalPrice
    ? Math.round((originalPrice - finalPrice) * 100) / 100 : 0;
  if (!types.length && !ids.length && !descriptions.length && itemSavings <= 0) {
    return { promotion: null, originalPrice: null, itemSavings: 0 };
  }
  return {
    promotion: {
      types,
      ids,
      descriptions,
      eligible: true,
      applied: itemSavings > 0,
      savings: itemSavings,
      source: "glovo-search-card",
    },
    originalPrice,
    itemSavings,
  };
}

function storeFromCard(card, location) {
  const query = queryFromAction(card);
  const labels = card.data?.labels ?? [];
  const texts = JSON.stringify(labels);
  const eta = texts.match(/(\d+)\s*-\s*(\d+)\s*min/i);
  const rating = texts.match(/(\d{1,3})%/);
  const impression = (card.actions ?? []).flatMap((action) => action?.data?.events ?? [])
    .find((event) => event?.name === "shop_impressions.loaded")?.data ?? {};
  const availabilityStatus = String(query.shop_availability_status ?? impression.shopAvailabilityStatus ?? "").toUpperCase();
  const open = availabilityStatus === "OPEN" || availabilityStatus === "ASAP" || impression.shopIsOpen === "true";
  const schedulable = availabilityStatus === "SCHEDULABLE"
    || query.shop_is_schedulable === "true" || impression.shopIsSchedulable === "true";
  const promotionTypes = [...new Set(String(query.shop_promotion_types ?? impression.shopPromotionTypes ?? "")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
  const promotionIds = [...new Set(String(query.shop_promotion_id ?? impression.shopPromotionId ?? "")
    .split(",").map((value) => value.trim()).filter((value) => value && value !== "-1"))];
  return {
    id: query.store_id ?? null,
    addressId: query.shop_id ?? null,
    categoryId: query.category_id ?? "1",
    name: card.data?.title?.text?.text ?? card.data?.title ?? "Glovo store",
    slug: card.data?.slug ?? null,
    rating: rating ? Number(rating[1]) / 20 : numericText(impression.shopRating) !== null ? numericText(impression.shopRating) / 20 : null,
    ratingPercent: rating ? Number(rating[1]) : numericText(impression.shopRating),
    ratingCount: numericText(impression.numberOfRatedOrders),
    categories: String(impression.cuisineTypeStoreTags ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    etaMinutes: eta ? { min: Number(eta[1]), max: Number(eta[2]) } : null,
    deliveryFee: numericText(query.shop_delivery_fee),
    prime: query.shop_is_prime === "true",
    open,
    schedulable,
    availabilityStatus: availabilityStatus || null,
    openingAt: query.opening_or_schedulable_time ?? impression.openingOrSchedulableTime ?? null,
    promotion: promotionTypes.length || promotionIds.length ? {
      types: promotionTypes,
      ids: promotionIds,
      descriptions: [],
      eligible: true,
      applied: false,
      savings: 0,
      source: "glovo-store-card",
    } : null,
    url: card.data?.slug ? `${WEB}/es/es/${location.citySlug}/stores/${card.data.slug}` : null,
  };
}

function storesFromSearch(payload, location) {
  const stores = [];
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.type === "STORE_CARD_V2") {
      const store = storeFromCard(value, location);
      const key = `${store.id}:${store.addressId}`;
      if (store.id && store.addressId && !seen.has(key)) {
        seen.add(key);
        stores.push(store);
      }
    }
    Object.values(value).forEach(walk);
  }
  walk(payload);
  return stores;
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
        const finalPrice = numericText(value.data?.pricing?.finalPrice);
        const deal = promotionFromCard(value, finalPrice);
        offers.push({
          provider: "glovo",
          merchant: { id: store.id, addressId: store.addressId, name: store.name, rating: store.rating, ratingPercent: store.ratingPercent },
          item: { id, externalId: query.product_external_id ?? null, storeProductId: query.store_product_id ?? null, name: value.data?.name?.text ?? value.data?.name, unitPrice: finalPrice },
          quantity: 1,
          etaMinutes: store.etaMinutes?.min ?? null,
          available: store.open === true,
          pricing: {
            currency: "EUR",
            originalSubtotal: deal.originalPrice,
            subtotal: finalPrice,
            itemSavings: deal.itemSavings,
            total: null,
            exact: false,
            fees: { delivery: store.deliveryFee },
          },
          promotion: deal.promotion,
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
  const limit = Math.max(1, Number(options.limit ?? 60));
  const storeLimit = Math.max(1, Number(options.storeLimit ?? 24));
  const cacheKey = {
    query: cacheText(query),
    latitude: Number(Number(location.latitude).toFixed(5)),
    longitude: Number(Number(location.longitude).toFixed(5)),
    cityCode: location.cityCode ?? null,
    limit,
    storeLimit,
  };
  const { value, cache } = await cachedProviderRead("glovo-discovery", cacheKey, async () => {
    const knownCitySlug = location.citySlug ?? slug(location.city ?? location.matched?.split(",").at(-1) ?? "");
    const resolved = location.cityCode && knownCitySlug
      ? { ...location, citySlug: knownCitySlug }
      : await glovoLocation(location, options.fetchImpl);
    const payload = await request(`/v1/web/store_wall/search?searchQuery=${encodeURIComponent(query)}`, {
      method: "POST",
      body: { searchContext: { searchId: randomUUID() } },
      location: resolved,
      retryAuth: true,
      retryNetwork: true,
      fetchImpl: options.fetchImpl,
      cookieHeader: options.cookieHeader,
      session: options.session,
    });
    return {
      location: resolved,
      stores: storesFromSearch(payload, resolved).slice(0, storeLimit),
      offers: offersFromSearch(payload, resolved).slice(0, limit),
      raw: options.raw ? payload : undefined,
    };
  }, {
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    staleIfErrorMs: DISCOVERY_STALE_IF_ERROR_MS,
    enabled: (options.fetchImpl ?? fetch) === fetch && !options.raw,
  });
  return { ...value, cache };
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
  const { value, cache } = await cachedProviderRead("glovo-menu", { url: parsed.toString() }, async () => {
    let response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetchImpl(parsed, { headers: { "accept-language": "es-ES" } });
        break;
      } catch (error) {
        if (attempt === 0) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
          continue;
        }
        throw new CliError("Could not reach Glovo", "NETWORK_ERROR", { url: parsed.toString(), cause: error?.name ?? "Error" });
      }
    }
    if (!response.ok) throw new CliError(`Glovo store page returned HTTP ${response.status}`, response.status === 429 ? "RATE_LIMITED" : "GLOVO_HTTP_ERROR", {
      status: response.status,
      retryAfter: response.headers.get("retry-after") ?? null,
    });
    const flight = nextFlightText(await response.text());
    const storeRoute = flight.match(/\/v\d+\/stores\/([^/"?]+)\/addresses\/([^/"?]+)\//);
    const products = ["PRODUCT_ROW", "PRODUCT_TILE"].flatMap((type) => objectsOfType(flight, type)).map(({ data }) => ({
      id: data.id, externalId: data.externalId, storeProductId: data.storeProductId, name: data.name,
      description: data.description ?? null, price: data.promotion?.priceInfo?.amount ?? data.promotion?.price ?? data.priceInfo?.amount ?? data.price,
      currency: data.priceInfo?.currencyCode ?? data.promotion?.priceInfo?.currencyCode ?? "EUR",
      requiresCustomizations: Boolean(data.attributeGroups?.length), attributeGroups: data.attributeGroups ?? [], available: true,
    }));
    const restricted = objectsOfType(flight, "RESTRICTED_PRODUCT_TILE");
    const collections = objectsOfType(flight, "COLLECTION_TILE").map(({ data }) => ({
      name: data.title ?? null,
      slug: data.slug ?? null,
      restricted: data.action?.type === "POPUP" && data.action?.data?.id === "RESTRICTIONS",
    }));
    return {
      url: parsed.toString(),
      store: storeRoute ? { id: storeRoute[1], addressId: storeRoute[2] } : null,
      products: [...new Map(products.filter((item) => item.id && item.name).map((item) => [`${item.storeProductId ?? item.externalId ?? item.id}`, item])).values()],
      restrictionsDetected: restricted.length > 0 || collections.some((collection) => collection.restricted),
      collections,
    };
  }, { ttlMs: MENU_CACHE_TTL_MS, staleIfErrorMs: MENU_STALE_IF_ERROR_MS, enabled: fetchImpl === fetch });
  return { ...value, cache };
}

function catalogMenuSummary(menu) {
  const categories = [];
  let restrictionsDetected = false;
  function walk(value, parent = null) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, parent));
    if (value.name && value.slug) {
      const action = value.action ?? value.actions?.find((candidate) => candidate?.data?.path || candidate?.data?.redirectPath);
      const restricted = action?.type === "POPUP" && action?.data?.id === "RESTRICTIONS";
      if (restricted) restrictionsDetected = true;
      categories.push({
        name: value.name,
        slug: value.slug,
        parent,
        restricted,
        path: action?.data?.path ?? action?.data?.redirectPath ?? null,
      });
      parent = value.name;
    }
    for (const child of Object.values(value)) walk(child, parent);
  }
  walk(menu?.data?.elements ?? menu);
  return { categories, restrictionsDetected };
}

function glovoCatalogPromotion(product) {
  const listed = product.promotion ?? product.promotions?.[0] ?? null;
  const originalPrice = numericText(product.priceInfo?.amount ?? product.price);
  const promotionPrice = numericText(listed?.priceInfo?.amount ?? listed?.price);
  const finalPrice = promotionPrice ?? originalPrice;
  const savings = originalPrice !== null && finalPrice !== null && originalPrice > finalPrice
    ? Math.round((originalPrice - finalPrice) * 100) / 100 : 0;
  if (!listed && savings <= 0) return { finalPrice, originalPrice: null, savings: 0, promotion: null };
  return {
    finalPrice,
    originalPrice: savings > 0 ? originalPrice : null,
    savings,
    promotion: {
      types: [listed?.type].filter(Boolean).map((value) => String(value).toUpperCase()),
      ids: [listed?.promotionId ?? listed?.promoId].filter((value) => value !== null && value !== undefined).map(String),
      descriptions: [listed?.title].filter(Boolean),
      eligible: true,
      applied: savings > 0,
      savings,
      source: "glovo-store-catalog",
    },
  };
}

function glovoCatalogOffer(store, product, options = {}) {
  const id = product.id === null || product.id === undefined ? null : String(product.id);
  const externalId = product.externalId === null || product.externalId === undefined ? null : String(product.externalId);
  const storeProductId = product.storeProductId === null || product.storeProductId === undefined ? null : String(product.storeProductId);
  if (!product.name || (!id && !externalId && !storeProductId)) return null;
  const deal = glovoCatalogPromotion(product);
  const eligibility = options.eligibility ?? null;
  return {
    provider: "glovo",
    merchant: { id: store.id, addressId: store.addressId, name: store.name, rating: store.rating, ratingCount: store.ratingCount, ratingPercent: store.ratingPercent, categories: store.categories ?? [] },
    item: { id: id ?? externalId ?? storeProductId, externalId, storeProductId, name: product.name, description: product.description ?? null, unitPrice: deal.finalPrice },
    quantity: 1,
    etaMinutes: store.etaMinutes?.min ?? null,
    available: store.open !== false,
    pricing: {
      currency: product.priceInfo?.currencyCode ?? "EUR",
      originalSubtotal: deal.originalPrice,
      subtotal: deal.finalPrice,
      itemSavings: deal.savings,
      total: null,
      exact: false,
      fees: { delivery: store.deliveryFee },
    },
    promotion: deal.promotion ?? store.promotion,
    membershipEligible: store.prime,
    url: store.url,
    source: {
      adapter: "glovo-api",
      storeId: store.id,
      storeAddressId: store.addressId,
      storeCategoryId: store.categoryId,
      productId: id ?? externalId ?? storeProductId,
      productExternalId: externalId,
      storeProductId,
      product: {
        id: id ?? externalId ?? storeProductId,
        externalId,
        storeProductId,
        attributeGroups: product.attributeGroups ?? [],
      },
      catalogQueriesMatched: product.matchedQueries ?? [],
      ...(eligibility ? { eligibility } : {}),
    },
  };
}

export function glovoMenuOffers(store, menu, options = {}) {
  const eligibility = menu?.restrictionsDetected && options.requireEligibility ? {
    kind: "legal_age",
    status: "confirmation_required",
    title: "Legal-age confirmation required",
    restrictions: [],
    providerActionUrl: store.url,
  } : null;
  const currentStore = {
    ...store,
    ...(menu?.store?.id ? { id: menu.store.id } : {}),
    ...(menu?.store?.addressId ? { addressId: menu.store.addressId } : {}),
  };
  return (menu?.products ?? []).map((product) => glovoCatalogOffer(currentStore, product, { eligibility })).filter(Boolean);
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      try { output[index] = await mapper(values[index], index); }
      catch (error) { output[index] = { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, worker));
  return output;
}

function catalogQueryMatchesProduct(query, product) {
  const text = cacheText([product?.name, product?.description, product?.categoryName].filter(Boolean).join(" "));
  const terms = cacheText(query).split(/\s+/).filter((term) => term.length > 2)
    .map((term) => term.endsWith("s") && term.length > 4 ? term.slice(0, -1) : term);
  return terms.length > 0 && terms.every((term) => text.includes(term));
}

export async function glovoStoreCatalog(store, queries, location, options = {}) {
  if (!store?.id || !store?.addressId) throw new CliError("Glovo store identifiers are required", "SOURCE_PLAN_MISSING");
  const catalogQueries = [...new Set((Array.isArray(queries) ? queries : [queries])
    .map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, Math.max(1, Number(options.queryLimit ?? 8)));
  const batchSize = options.batchQueries === true
    ? Math.max(1, Math.min(8, Number(options.batchSize ?? 4)))
    : 1;
  const queryBatches = [];
  for (let index = 0; index < catalogQueries.length; index += batchSize) {
    const members = catalogQueries.slice(index, index + batchSize);
    queryBatches.push({ query: members.join(" "), members });
  }
  const cacheEnabled = (options.fetchImpl ?? fetch) === fetch;
  const menuRead = await cachedProviderRead("glovo-catalog-menu", { storeId: store.id, addressId: store.addressId }, () => request(`/v3/stores/${encodeURIComponent(store.id)}/addresses/${encodeURIComponent(store.addressId)}/node/store_menu`, {
    location, fetchImpl: options.fetchImpl, session: options.session,
  }), { ttlMs: MENU_CACHE_TTL_MS, staleIfErrorMs: MENU_STALE_IF_ERROR_MS, enabled: cacheEnabled });
  const menu = menuRead.value;
  const summary = catalogMenuSummary(menu);
  let restrictions = null;
  if (summary.restrictionsDetected) {
    try {
      restrictions = await request(`/v4/stores/${encodeURIComponent(store.id)}/addresses/${encodeURIComponent(store.addressId)}/restrictions`, {
        location, fetchImpl: options.fetchImpl, session: options.session,
      });
    } catch { /* a missing restriction description must not hide catalog results */ }
  }
  const eligibility = summary.restrictionsDetected && options.requireEligibility ? {
    kind: "legal_age",
    status: "confirmation_required",
    title: restrictions?.title ?? "Legal-age confirmation required",
    restrictions: (restrictions?.restrictions ?? []).map((entry) => ({ id: entry.id, text: entry.text, hyperlink: entry.hyperlink ?? null })),
    providerActionUrl: store.url,
  } : null;
  let requestSlot = 0;
  const searchBatch = async ({ query, members }) => {
    const slot = requestSlot++;
    const requestDelayMs = Math.max(0, Math.min(2_000, Number(options.requestDelayMs ?? (options.batchQueries === true ? 200 : 0))));
    if (slot > 0 && requestDelayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, requestDelayMs));
    const result = await cachedProviderRead("glovo-catalog-query", {
      storeId: store.id,
      addressId: store.addressId,
      query: cacheText(query),
      latitude: Number(Number(location.latitude).toFixed(5)),
      longitude: Number(Number(location.longitude).toFixed(5)),
    }, async () => {
      const payload = await request(`/v3/stores/${encodeURIComponent(store.id)}/addresses/${encodeURIComponent(store.addressId)}/search?query=${encodeURIComponent(query)}&searchId=${randomUUID()}`, {
        location, fetchImpl: options.fetchImpl, session: options.session,
      });
      return (payload?.results ?? []).flatMap((entry) => entry?.products ?? []);
    }, { ttlMs: CATALOG_QUERY_CACHE_TTL_MS, staleIfErrorMs: CATALOG_STALE_IF_ERROR_MS, enabled: cacheEnabled });
    return {
      query,
      members,
      products: result.value,
      cacheHit: result.cache.hit,
      cacheStale: result.cache.stale === true,
      fallbackErrorCode: result.cache.fallbackErrorCode ?? null,
    };
  };
  const initialSearches = await mapConcurrent(queryBatches, Number(options.concurrency ?? 2), searchBatch);
  const missingIndependentQueries = options.batchQueries === true
    ? catalogQueries.filter((query) => !initialSearches.some((entry) => !entry?.error
      && (entry.members ?? []).includes(query)
      && (entry.products ?? []).some((product) => catalogQueryMatchesProduct(query, product))))
    : [];
  const fallbackSearches = await mapConcurrent(
    missingIndependentQueries.map((query) => ({ query, members: [query] })),
    Number(options.fallbackConcurrency ?? 1),
    searchBatch,
  );
  const searched = [...initialSearches, ...fallbackSearches];
  if (searched.length && searched.every((entry) => entry?.error)) throw searched[0].error;
  const productsById = new Map();
  for (const entry of searched) {
    if (entry?.error) continue;
    for (const product of entry?.products ?? []) {
      const key = String(product.storeProductId ?? product.externalId ?? product.id);
      const existing = productsById.get(key);
      const matchedQueries = (entry.members ?? [entry.query]).filter((query) =>
        entry.members?.length === 1 || catalogQueryMatchesProduct(query, product));
      productsById.set(key, {
        ...(existing ?? product),
        matchedQueries: [...new Set([...(existing?.matchedQueries ?? []), ...matchedQueries])],
      });
    }
  }
  const products = [...productsById.values()];
  return {
    store,
    queries: catalogQueries,
    queryBatches: queryBatches.map((entry) => entry.query),
    fallbackQueries: missingIndependentQueries,
    categories: summary.categories,
    restrictionsDetected: summary.restrictionsDetected,
    eligibility,
    products,
    offers: products.map((product) => glovoCatalogOffer(store, product, { eligibility })).filter(Boolean),
    failedQueries: searched.filter((entry) => entry?.error).length,
    rateLimitedQueries: searched.filter((entry) => entry?.error?.code === "RATE_LIMITED"
      || entry?.fallbackErrorCode === "RATE_LIMITED").length,
    cache: {
      menuHit: menuRead.cache.hit,
      menuStale: menuRead.cache.stale === true,
      queryHits: searched.filter((entry) => entry?.cacheHit).length,
      queryStale: searched.filter((entry) => entry?.cacheStale).length,
      liveQueries: searched.filter((entry) => entry && !entry.error && !entry.cacheHit).length,
      requestCount: searched.length,
    },
  };
}

export async function enrichGlovoOffers(offers, options = {}) {
  const values = Array.isArray(offers) ? offers : [];
  const urls = [...new Set(values.map((offer) => offer.url).filter(Boolean))]
    .slice(0, Math.max(1, Number(options.maxStores ?? 24)));
  const menuLoader = options.menuLoader ?? ((url) => glovoMenu(url, options.fetchImpl));
  const menus = new Map();
  for (let start = 0; start < urls.length; start += 6) {
    const batch = urls.slice(start, start + 6);
    const settled = await Promise.allSettled(batch.map(async (url) => [url, await menuLoader(url)]));
    for (const result of settled) if (result.status === "fulfilled") menus.set(...result.value);
  }
  return values.map((offer) => {
    const product = menus.get(offer.url)?.products?.find((entry) => String(entry.id) === String(offer.item?.id));
    if (!product) return offer;
    return {
      ...offer,
      item: {
        ...offer.item,
        description: product.description ?? offer.item?.description ?? null,
        unitPrice: Number.isFinite(Number(product.price)) ? Number(product.price) : offer.item?.unitPrice,
      },
      source: { ...offer.source, requiresCustomizations: product.requiresCustomizations },
    };
  });
}

export async function glovoMe(options = {}) {
  const profile = await request("/v3/me", { auth: true, fetchImpl: options.fetchImpl, cookieHeader: options.cookieHeader, session: options.session });
  const membership = await request(`/customers/${profile.id}/subscription/status`, { auth: true, fetchImpl: options.fetchImpl, cookieHeader: options.cookieHeader, session: options.session }).catch(() => null);
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
  const location = await defaultGlovoLocation(options);
  const baskets = await request(`/v1/authenticated/customers/${me.id}/baskets`, { auth: true, location, fetchImpl: options.fetchImpl });
  return { customerId: me.id, baskets: baskets ?? [] };
}

async function defaultGlovoLocation(options = {}) {
  if (Number.isFinite(Number(options.location?.latitude)) && Number.isFinite(Number(options.location?.longitude))) return options.location;
  const addresses = await glovoAddresses(options);
  const location = addresses.find((address) => address.isDefault) ?? addresses[0];
  if (!location) throw new CliError("Glovo has no usable saved delivery address", "LOCATION_REQUIRED");
  return location;
}

function selectedAttributes(group, selections) {
  const requested = selections?.[String(group.id)] ?? selections?.[group.id];
  if (requested !== undefined) {
    const ids = Array.isArray(requested) ? requested.map(String) : [String(requested)];
    const selected = group.attributes.filter((attribute) => ids.includes(String(attribute.id)) || ids.includes(String(attribute.externalId)));
    if (selected.length !== ids.length || selected.length < Number(group.min ?? 0) || selected.length > Number(group.max ?? selected.length)) {
      throw new CliError(`Invalid choices for Glovo modifier group "${group.name}"`, "INVALID_MODIFIER", { group });
    }
    return selected;
  }
  const minimum = Number(group.min ?? 0);
  if (minimum <= 0) return [];
  const preferred = [...group.attributes].sort((left, right) => {
    const leftNo = /^(?:no\b|sin\b)/i.test(left.name ?? "") ? 1 : 0;
    const rightNo = /^(?:no\b|sin\b)/i.test(right.name ?? "") ? 1 : 0;
    return Number(left.priceImpact ?? left.priceInfo?.amount ?? 0) - Number(right.priceImpact ?? right.priceInfo?.amount ?? 0)
      || leftNo - rightNo || Number(left.id) - Number(right.id);
  });
  return preferred.slice(0, minimum);
}

function glovoCustomization(group, attribute) {
  return {
    ids: {
      groupLegacyId: String(group.id), groupId: String(group.id), groupExternalId: group.externalId ?? "",
      groupPosition: Number(group.position ?? 0), legacyId: String(attribute.id), externalId: attribute.externalId ?? "",
    },
    name: group.name, quantity: { increments: 1 }, customizationName: attribute.name, groupName: group.name,
  };
}

function identifier(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function sourceProductIdentity(source) {
  const storeProductId = identifier(source?.storeProductId);
  if (storeProductId) return `store:${storeProductId}`;
  const externalId = identifier(source?.productExternalId ?? source?.externalId);
  if (externalId) return `external:${externalId}`;
  const id = identifier(source?.productId ?? source?.id);
  return id ? `id:${id}` : null;
}

function basketProductIdentity(product) {
  const ids = product?.ids ?? product;
  const storeProductId = identifier(ids?.storeProductId);
  if (storeProductId) return `store:${storeProductId}`;
  const externalId = identifier(ids?.externalId);
  if (externalId) return `external:${externalId}`;
  const id = identifier(ids?.id ?? ids?.legacyId ?? product?.productId);
  return id ? `id:${id}` : null;
}

function productQuantity(product) {
  const value = Number(product?.quantity?.increments ?? product?.quantity ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function glovoBasketLineMismatch(basket, lines) {
  const expected = new Map();
  for (const line of lines) {
    const identity = sourceProductIdentity(line?.source);
    if (!identity) continue;
    const itemId = identifier(line?.source?.productId ?? line?.source?.storeProductId ?? line?.source?.productExternalId);
    const requestedQuantity = Number(line.quantity ?? 1);
    const quantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0 ? requestedQuantity : 1;
    const current = expected.get(identity) ?? { identity, itemId, itemName: line.item?.name ?? null, quantity: 0 };
    current.quantity += quantity;
    expected.set(identity, current);
  }
  const accepted = new Map();
  for (const product of basket?.products ?? []) {
    const identity = basketProductIdentity(product);
    if (!identity) continue;
    const current = accepted.get(identity) ?? {
      itemId: identifier(product?.ids?.id ?? product?.ids?.legacyId ?? product?.id),
      quantity: 0,
    };
    current.quantity += productQuantity(product);
    accepted.set(identity, current);
  }
  const missingItems = [...expected.values()].flatMap((item) => {
    const acceptedQuantity = accepted.get(item.identity)?.quantity ?? 0;
    return acceptedQuantity < item.quantity ? [{
      itemId: item.itemId,
      itemName: item.itemName,
      expectedQuantity: item.quantity,
      acceptedQuantity,
    }] : [];
  });
  const unexpectedItems = [...accepted].flatMap(([identity, item]) => {
    const expectedQuantity = expected.get(identity)?.quantity ?? 0;
    return item.quantity > expectedQuantity ? [{ itemId: item.itemId, expectedQuantity, acceptedQuantity: item.quantity }] : [];
  });
  const expectedItemCount = [...expected.values()].reduce((sum, item) => sum + item.quantity, 0);
  const acceptedItemCount = [...accepted.values()].reduce((sum, item) => sum + item.quantity, 0);
  if (!missingItems.length && !unexpectedItems.length && expectedItemCount === acceptedItemCount) return null;
  return {
    basketId: basket?.basketId ?? basket?.id ?? null,
    expectedItemCount,
    acceptedItemCount,
    missingItems,
    unexpectedItems,
  };
}

function assertGlovoBasketLines(basket, lines) {
  const mismatch = glovoBasketLineMismatch(basket, lines);
  if (!mismatch) return {
    verified: true,
    itemCount: (basket?.products ?? []).reduce((sum, product) => sum + productQuantity(product), 0),
  };
  throw new CliError(
    "Glovo did not accept every configured basket item; checkout pricing for this partial basket is invalid",
    "BASKET_CONTENT_MISMATCH",
    mismatch,
  );
}

function glovoProduct(source, quantity, product, selections) {
  const selected = (product?.attributeGroups ?? []).flatMap((group) => selectedAttributes(group, selections)
    .map((attribute) => ({ group, attribute })));
  return {
    product: {
      ids: { id: String(source.productId), externalId: source.productExternalId ?? product?.externalId ?? "", legacyId: String(source.productId), storeProductId: source.storeProductId ?? product?.storeProductId ?? "" },
      quantity: { increments: quantity },
      customizations: selected.map(({ group, attribute }) => glovoCustomization(group, attribute)),
    },
    selections: selected.map(({ group, attribute }) => ({
      groupId: String(group.id), groupName: group.name, attributeId: String(attribute.id), name: attribute.name,
      price: Number(attribute.priceImpact ?? attribute.priceInfo?.amount ?? 0),
    })),
    groups: product?.attributeGroups ?? [],
  };
}

export async function createGlovoBasket(offer, options = {}) {
  const lines = offer.lines?.length ? offer.lines : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }];
  const pendingEligibility = lines.map((line) => line.source?.eligibility)
    .find((eligibility) => eligibility?.status === "confirmation_required");
  if (pendingEligibility) {
    throw new CliError("Confirm Glovo's legal-age requirement before creating this basket", "AGE_CONFIRMATION_REQUIRED", {
      eligibility: pendingEligibility,
    });
  }
  const stores = new Set(lines.map((line) => line.source?.storeId).filter(Boolean));
  if (stores.size !== 1 || lines.some((line) => !line.source?.storeAddressId || !line.source?.productId)) {
    throw new CliError("Glovo basket lines must belong to one store and include product identifiers", "SOURCE_PLAN_MISSING");
  }
  const source = lines[0].source;
  const menu = offer.url ? await glovoMenu(offer.url, options.fetchImpl) : { products: [] };
  const currentStore = {
    id: menu.store?.id ?? source.storeId,
    addressId: menu.store?.addressId ?? source.storeAddressId,
  };
  const configured = lines.map((line, index) => {
    const product = menu.products.find((entry) => String(entry.id) === String(line.source.productId)) ?? line.source.product;
    const selections = options.customizations?.[String(line.source.productId)] ?? options.customizations?.[index]
      ?? (lines.length === 1 ? options.customizations : null);
    return glovoProduct(line.source, line.quantity ?? 1, product, selections);
  });
  const products = configured.map((entry) => entry.product);
  const payload = {
    products,
    storeId: Number(currentStore.id),
    storeAddressId: Number(currentStore.addressId),
    storeCategoryId: Number(source.storeCategoryId ?? 1),
    handlingStrategy: "DELIVERY",
  };
  const customizationReview = configured.map((entry, index) => ({
    itemId: String(lines[index].source.productId), itemName: lines[index].item?.name ?? null,
    selectionMode: options.customizations ? "explicit" : "minimum-price-defaults",
    selections: entry.selections, groups: entry.groups,
  }));
  if (options.prepareOnly) return { mutated: false, payload, customizationReview, submitted: false };
  const location = await defaultGlovoLocation(options);
  const me = await glovoMe(options);
  const existing = await request(`/v1/authenticated/customers/${me.id}/baskets/stores/${currentStore.id}`, { auth: true, location, fetchImpl: options.fetchImpl });
  let basket;
  if (!existing) {
    basket = await request(`/v1/authenticated/customers/${me.id}/baskets`, { method: "POST", auth: true, location, fetchImpl: options.fetchImpl, body: payload });
  } else {
    if ((existing.products ?? []).length) {
      throw new CliError("This Glovo store already has a non-empty basket; review it before adding comparison items", "CART_CONFLICT", {
        storeId: currentStore.id,
        existingItemCount: existing.products.length,
      });
    }
    basket = await request(`/v1/authenticated/customers/${me.id}/baskets/${existing.basketId}/products`, { method: "PUT", auth: true, location, fetchImpl: options.fetchImpl, body: { ...existing, products: [...(existing.products ?? []), ...products] } });
  }
  const mismatch = glovoBasketLineMismatch(basket, lines);
  if (mismatch) {
    let rollback = { attempted: false, succeeded: false };
    if (mismatch.basketId) {
      rollback = { attempted: true, succeeded: false };
      try {
        await request(`/v1/authenticated/customers/${me.id}/baskets/${encodeURIComponent(mismatch.basketId)}`, {
          method: "DELETE", auth: true, location, fetchImpl: options.fetchImpl,
        });
        rollback.succeeded = true;
      } catch (error) {
        rollback.error = { code: error.code ?? "ROLLBACK_FAILED", message: error.message };
      }
    }
    throw new CliError(
      "Glovo did not accept every configured basket item; the partial basket cannot be quoted",
      "BASKET_CONTENT_MISMATCH",
      { ...mismatch, rollback },
    );
  }
  return { mutated: true, basket, customizationReview, submitted: false };
}

export async function quoteGlovoBasket(basketId, options = {}) {
  const location = await defaultGlovoLocation(options);
  const me = await glovoMe(options);
  const basket = await request(`/v1/authenticated/customers/${me.id}/baskets/${encodeURIComponent(basketId)}`, {
    auth: true, location, fetchImpl: options.fetchImpl,
  });
  const remoteBasketVerification = options.expectedLines?.length
    ? assertGlovoBasketLines(basket, options.expectedLines)
    : null;
  const products = (basket.products ?? []).map((product) => ({
    id: product.ids?.id ?? "", storeProductId: product.ids?.storeProductId ?? "", externalId: product.ids?.externalId ?? "",
    quantity: product.quantity?.increments ?? 0, name: product.name ?? "", displayedPrice: product.price?.final?.major ?? 0,
    customizations: (product.customizations ?? []).map((customization) => ({
      attributeId: Number(customization.ids?.legacyId), quantity: customization.quantity?.increments ?? 1,
      externalId: customization.ids?.externalId ?? "", groupId: customization.ids?.groupLegacyId === undefined ? undefined : Number(customization.ids.groupLegacyId),
      groupExternalId: customization.ids?.groupExternalId ?? "", groupPosition: customization.ids?.groupPosition ?? 0,
      name: customization.customizationName ?? customization.name, groupName: customization.groupName,
    })),
  }));
  const orderDetails = {
    categoryId: Number(basket.storeCategoryId ?? 1), cityCode: location.cityCode ?? "",
    handlingStrategy: { type: "DELIVERY" }, origin: "CHECKOUT", orderType: "STORES",
    storeAddressId: Number(basket.storeAddressId), storeId: Number(basket.storeId), baseOrderUrn: null,
    basketId: basket.basketId,
  };
  const components = {
    productList: { products },
    deliveryAddress: {
      label: location.label ?? location.city ?? "Delivery address", details: "",
      latitude: Number(location.latitude), longitude: Number(location.longitude), customFields: [],
    },
    ...(options.components ?? {}),
  };
  const fillTemplate = async (previous, nextComponents) => {
    const response = await request("/v3/checkouts/order/1/template", {
      method: "POST", auth: true, retryAuth: true, location, fetchImpl: options.fetchImpl,
      body: { checkout: {
        orderDetails: { ...(previous?.orderDetails ?? {}), ...orderDetails }, components: nextComponents,
        sourceScreen: "CART", analytics: { templateReceived: previous?.analytics?.templateReceived },
        basketDetails: { basketVersion: basket.basketVersion ?? null },
      } },
    });
    return response?.checkout ?? response;
  };
  let quote = await fillTemplate(null, components);
  let fulfilment = null;
  if (options.scheduledAt) {
    const requested = new Date(options.scheduledAt);
    if (Number.isNaN(requested.getTime())) throw new CliError("Scheduled delivery requires a valid ISO date and time", "INVALID_SCHEDULE");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: options.timeZone ?? "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(requested).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const requestedValue = `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    const selector = (quote.components ?? []).find((component) => component.id === "schedulingTime");
    const slots = selector?.timeSelectorData?.selectors?.flatMap((entry) => entry.options ?? [])
      .flatMap((entry) => entry.timeSlots ?? []) ?? [];
    const selected = slots.find((slot) => slot.value === requestedValue);
    if (!selected) throw new CliError("The Glovo store cannot deliver at the requested time", "SCHEDULE_UNAVAILABLE", {
      requestedAt: requested.toISOString(), available: slots.slice(0, 12).map((slot) => ({ label: slot.label, value: slot.value })),
    });
    quote = await fillTemplate(quote, { ...components, schedulingTime: { value: selected.value } });
    fulfilment = {
      requestedAt: requested.toISOString(), timeZone: options.timeZone ?? "Europe/Madrid", status: "verified",
      selectedWindow: { value: selected.value, label: selected.label }, source: "glovo-checkout-template",
    };
  }
  const pricing = assertGlovoCheckoutPlaceable(quote, { scheduledAt: options.scheduledAt });
  return {
    provider: "glovo", basketId, quote, fulfilment, pricing,
    remoteBasketVerification, submitted: false,
  };
}

export function glovoCheckoutUrl(offer) {
  const city = new URL(offer.url).pathname.split("/")[3];
  const url = new URL(`${WEB}/es/es/${city}/order-summary`);
  url.searchParams.set("storeId", offer.source.storeId);
  return url.toString();
}

function safePaymentSummary(value) {
  if (!value || typeof value !== "object") return null;
  const label = value.label ?? value.title ?? value.displayName ?? value.name ?? null;
  const brand = value.brand ?? value.cardBrand ?? value.type ?? null;
  const lastFour = String(value.lastFour ?? value.last4 ?? value.cardLastFour ?? "").match(/\d{4}$/)?.[0] ?? null;
  if (!label && !brand && !lastFour) return null;
  return {
    ...(label ? { label: String(label) } : {}),
    ...(brand ? { brand: String(brand) } : {}),
    ...(lastFour ? { lastFour } : {}),
  };
}

export function glovoCheckoutReview(quote, options = {}) {
  const components = Array.isArray(quote?.components) ? quote.components : [];
  const addressComponent = components.find((component) => component.id === "deliveryAddress" || component.type === "addressPicker");
  const addressData = addressComponent?.addressPickerData ?? addressComponent?.deliveryAddressData ?? addressComponent?.data ?? {};
  const addressValue = addressData.value ?? addressData.selectedAddress ?? addressData.address ?? {};
  const addressLabel = addressValue.label ?? addressValue.title ?? addressData.label ?? null;

  const timeComponent = components.find((component) => component.id === "schedulingTime" || component.type === "timeSelector");
  const selectors = timeComponent?.timeSelectorData?.selectors ?? [];
  const standard = selectors.find((selector) => String(selector?.value ?? "").toUpperCase() === "STANDARD")
    ?? selectors.find((selector) => /^(?:standard|estándar)$/i.test(String(selector?.label ?? "")));
  const timing = options.fulfilment?.status === "verified"
    ? { mode: "scheduled", status: "verified", window: options.fulfilment.selectedWindow ?? null }
    : standard && standard.disabled !== true
      ? { mode: "now", status: "verified", label: standard.label ?? null, description: standard.description ?? null }
      : { mode: "now", status: "unavailable" };

  const paymentComponent = components.find((component) => component.id === "paymentMethod" || component.type === "paymentMethodPicker");
  const paymentData = paymentComponent?.paymentMethodPickerData ?? paymentComponent?.paymentMethodData ?? paymentComponent?.data ?? {};
  const paymentValue = paymentData.value ?? paymentData.selectedPaymentMethod ?? paymentData.paymentMethod ?? null;
  const paymentSummary = safePaymentSummary(paymentValue);
  const payment = paymentSummary
    ? { status: "configured", ...paymentSummary }
    : { status: "unavailable", cashAllowed: paymentData.cash === true };

  const pricing = options.pricing ?? normalizeGlovoQuote(quote);
  const placeOrder = components.find((component) => component.id === "placeOrder" || component.type === "button");
  const checkoutEnabled = quote?.enabled !== false && placeOrder
    && placeOrder.buttonData?.disabled !== true && placeOrder.buttonData?.enabled !== false;
  const missing = [
    ...(!addressLabel ? ["delivery address summary"] : []),
    ...(timing.status !== "verified" ? ["delivery timing"] : []),
    ...(payment.status !== "configured" ? ["payment method summary"] : []),
    ...(!checkoutEnabled ? ["enabled purchase action"] : []),
  ];
  return {
    address: addressLabel ? { status: "configured", label: String(addressLabel) } : { status: "unavailable" },
    timing,
    payment,
    pricing,
    checkoutEnabled: Boolean(checkoutEnabled),
    purchaseApprovalReady: missing.length === 0 && pricing?.exact === true,
    missing,
  };
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

function findLabeledAmount(value, pattern) {
  if (!value || typeof value !== "object") return null;
  const label = String(value.type ?? value.name ?? value.label ?? value.title ?? value.id ?? "");
  if (pattern.test(label)) {
    const amount = findAmount(value, ["amount", "price", "value", "total"]);
    if (amount !== null) return amount;
  }
  for (const child of Object.values(value)) {
    const amount = findLabeledAmount(child, pattern);
    if (amount !== null) return amount;
  }
  return null;
}

export function normalizeGlovoQuote(quote) {
  const priceComponent = (quote?.components ?? []).find((component) => component.id === "priceBreakdown" || component.type === "priceBreakdown");
  const lines = priceComponent?.priceBreakdownData?.breakDown ?? [];
  const lineAmount = (pattern, options = {}) => {
    const line = lines.find((entry) => pattern.test(`${entry.type ?? ""} ${entry.title ?? ""}`));
    if (!line) return null;
    if (options.fee && (/gratis|free/i.test(String(line.valuePrefix ?? "")) || line.valueStyle === "STRIKETHROUGH")) return 0;
    return numericText(line.value);
  };
  const purchaseTotalCents = Number(quote?.orderDetails?.purchaseTotalCents);
  const total = lineAmount(/^TOTAL\b/i) ?? (Number.isFinite(purchaseTotalCents) ? purchaseTotalCents / 100
    : findAmount(quote, ["payableAmount", "finalPrice", "totalAmount", "total"]));
  const subtotal = lineAmount(/PRODUCT|PRODUCTOS/i) ?? findAmount(quote, ["subtotal", "productsPrice", "itemsPrice"]);
  const fees = {
    delivery: lineAmount(/DELIVERY|ENTREGA|ENVIO/i, { fee: true }) ?? findLabeledAmount(quote, /delivery|entrega|envio/i),
    service: lineAmount(/SERVICE|SERVICIO/i, { fee: true }) ?? findLabeledAmount(quote, /service|servicio|gestion/i),
    smallOrder: lineAmount(/SMALL.?ORDER|PEDIDO.?PEQUE|PEDIDO.?MINIMO/i, { fee: true }) ?? findLabeledAmount(quote, /small.?order|pedido.?minimo/i),
    bag: findLabeledAmount(quote, /bag|bolsa/i),
    other: null,
  };
  const explicitDiscount = findAmount(quote, ["discountAmount", "discount", "promotionDiscount"]);
  const knownBeforeDiscount = subtotal === null ? null : subtotal + Object.values(fees)
    .filter((value) => value !== null).reduce((sum, value) => sum + value, 0);
  const inferredDiscount = knownBeforeDiscount !== null && total !== null && knownBeforeDiscount > total
    ? Math.round((knownBeforeDiscount - total) * 100) / 100 : 0;
  return {
    currency: quote?.currencyCode ?? quote?.currency ?? "EUR",
    subtotal,
    fees,
    discount: explicitDiscount ?? inferredDiscount,
    total,
    exact: total !== null,
  };
}

function glovoScheduledWindows(selectors) {
  return selectors.flatMap((selector) => selector?.options ?? [])
    .flatMap((option) => option?.timeSlots ?? [])
    .filter((slot) => slot?.value)
    .slice(0, 12)
    .map((slot) => ({ label: slot.label ?? null, value: slot.value }));
}

function assertGlovoCheckoutPlaceable(quote, options = {}) {
  const pricing = normalizeGlovoQuote(quote);
  const components = quote?.components ?? [];
  const placeOrder = components.find((component) => component.id === "placeOrder" || component.type === "button");
  if (!placeOrder) {
    throw new CliError("Glovo checkout did not return a place-order action; the quoted price is not enough to prove orderability", "CHECKOUT_UNVERIFIED", {
      provider: "glovo", pricing,
    });
  }
  if (quote?.enabled === false || placeOrder.buttonData?.disabled === true || placeOrder.buttonData?.enabled === false) {
    throw new CliError("Glovo checkout is currently disabled", "CHECKOUT_UNAVAILABLE", {
      provider: "glovo", pricing,
    });
  }
  if (options.scheduledAt) return pricing;

  const timeSelector = components.find((component) => component.id === "schedulingTime" || component.type === "timeSelector");
  const selectors = timeSelector?.timeSelectorData?.selectors ?? [];
  const standard = selectors.find((selector) => String(selector?.value ?? "").toUpperCase() === "STANDARD")
    ?? selectors.find((selector) => /^(?:standard|estándar)$/i.test(String(selector?.label ?? "")));
  if (!standard) {
    throw new CliError("Glovo checkout did not verify immediate-delivery availability", "CHECKOUT_UNVERIFIED", {
      provider: "glovo", pricing,
    });
  }
  if (standard.disabled === true) {
    throw new CliError("Glovo cannot deliver this basket now", "CHECKOUT_UNAVAILABLE", {
      provider: "glovo",
      reason: standard.description ?? standard.label ?? "Immediate delivery is disabled",
      pricing,
      nextScheduledWindows: glovoScheduledWindows(selectors),
    });
  }
  return pricing;
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

export const glovoInternals = { accessToken, jwtExpiresAt, setCookieValue, shouldRefresh, refreshGlovoSession, request, parseJsonLosslessIds, offersFromSearch, storesFromSearch, nextFlightText, objectsOfType, catalogMenuSummary, glovoCatalogOffer, headers, findSubmitAction, promotionFromCard, trustedApiPath };
