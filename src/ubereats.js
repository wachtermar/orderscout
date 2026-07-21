import { createHash, randomUUID } from "node:crypto";
import { CliError } from "./lib.js";
import { loadBrowserSession } from "./browser-session.js";

const BASE = "https://www.ubereats.com";
const CHECKOUT_PAYLOAD_TYPES = [
  "cartItems", "basketSize", "subtotal", "paymentBarPayload", "total", "fareBreakdown", "upfrontTipping", "promotion",
  "requestUtensilPayload", "promoAndMembershipSavingBannerPayloadCheckout", "deliveryOptInInfo",
  "eta", "restrictedItems", "orderConfirmations", "paymentProfilesEligibility",
];

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

async function request(operation, body = {}, { auth = false, fetchImpl = fetch, cookieHeader } = {}) {
  const session = cookieHeader ? { cookieHeader, source: "verification" } : await loadBrowserSession("ubereats");
  if (auth && !session) throw new CliError("Sign in with `orderscout auth login ubereats` first", "AUTH_REQUIRED");
  const response = await fetchImpl(`${BASE}/_p/api/${operation}`, {
    method: "POST",
    headers: apiHeaders(session?.cookieHeader),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const message = payload?.data?.message ?? payload?.message ?? `Uber Eats returned HTTP ${response.status}`;
    const rateLimited = response.status === 429 || /too[_ ]many[_ ]requests|rate.?limit/i.test(message);
    const authExpired = response.status === 401 || (response.status === 403 && !rateLimited);
    throw new CliError(
      rateLimited ? "Uber Eats temporarily rate-limited search; wait before retrying" : `Uber Eats returned HTTP ${response.status}`,
      rateLimited ? "RATE_LIMITED" : authExpired ? "AUTH_EXPIRED" : "UBEREATS_HTTP_ERROR",
      { status: response.status, operation, retryAfter: response.headers.get("retry-after") ?? null },
    );
  }
  if (payload?.status === "failure" || payload?.code === 3) {
    const message = payload?.data?.message || payload?.message || "Uber Eats rejected the session";
    const upstreamCode = Number(payload?.data?.code ?? payload?.code);
    const authExpired = upstreamCode === 401 || upstreamCode === 403
      || /session (?:has )?expired|unauth(?:enticated|orized)|not logged in|login required/i.test(message)
      || (operation === "getUserV1" && payload?.code === 3);
    throw new CliError(message, authExpired ? "AUTH_EXPIRED" : "UBEREATS_API_ERROR", {
      operation,
      upstreamCode: Number.isFinite(upstreamCode) ? upstreamCode : null,
    });
  }
  return payload?.data ?? payload;
}

function cookieValue(header, name) {
  const prefix = `${name}=`;
  return String(header ?? "").split(/;\s*/).find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export function uberEatsDeliveryAddressFromCookies(cookieHeader) {
  const encoded = cookieValue(cookieHeader, "uev2.loc");
  if (!encoded) return null;
  try {
    const location = JSON.parse(decodeURIComponent(encoded));
    const latitude = finiteCoordinate(location?.latitude);
    const longitude = finiteCoordinate(location?.longitude);
    return latitude === null || longitude === null ? null : { ...location, latitude, longitude };
  } catch { return null; }
}

function localScheduleParts(value, timeZone = "Europe/Madrid", windowMinutes = 30) {
  const requested = new Date(value);
  if (Number.isNaN(requested.getTime())) throw new CliError("Scheduled delivery requires a valid ISO date and time", "INVALID_SCHEDULE");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(requested).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const startTime = parts.hour * 60 + parts.minute;
  return {
    scheduled: true,
    date: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    startTime,
    startTimeMs: requested.getTime(),
    endTime: startTime + Math.max(15, Number(windowMinutes) || 30),
    deliveryType: "ASAP",
  };
}

export async function updateUberEatsDraftSchedule(draftOrderUuid, scheduledAt, options = {}) {
  const session = options.cookieHeader
    ? { cookieHeader: options.cookieHeader }
    : await loadBrowserSession("ubereats");
  const deliveryAddress = options.deliveryAddress ?? uberEatsDeliveryAddressFromCookies(session?.cookieHeader);
  if (!deliveryAddress) {
    throw new CliError("Select a delivery address in Uber Eats before scheduling an order", "LOCATION_REQUIRED");
  }
  const targetDeliveryTimeRange = localScheduleParts(
    scheduledAt,
    options.timeZone,
    options.windowMinutes,
  );
  const payload = await request("updateDraftOrderV2", {
    promotionOptions: {
      autoApplyPromotionUUIDs: [],
      selectedPromotionInstanceUUIDs: [],
      skipApplyingPromotion: false,
    },
    useCredits: true,
    deliveryType: "ASAP",
    extraPaymentProfiles: [],
    interactionType: "door_to_door",
    businessDetails: {
      profileUUID: null,
      profileType: "Personal",
      policyUUID: null,
      policyVersion: null,
      expenseCode: null,
      expenseMemo: null,
      voucherUUID: null,
      voucherPolicyVersion: null,
    },
    cartLockOptions: null,
    targetDeliveryTimeRange,
    deliveryAddress,
    diningMode: "DELIVERY",
    draftOrderUUID: draftOrderUuid,
  }, { ...options, cookieHeader: session?.cookieHeader, auth: true });
  return {
    draftOrder: payload.draftOrder ?? payload,
    targetDeliveryTimeRange,
  };
}

function price(value) {
  if (typeof value === "object" && value) {
    if (value.amountE5 !== undefined) {
      const amountE5 = typeof value.amountE5 === "object" ? value.amountE5.low : value.amountE5;
      return Number.isFinite(Number(amountE5)) ? Number(amountE5) / 100_000 : null;
    }
    if (value.base?.low !== undefined && Number.isFinite(Number(value.exponent))) return Number(value.base.low) * 10 ** Number(value.exponent);
    return price(value.amount ?? value.value ?? value.price ?? value.purchasePriceV2);
  }
  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9,.-]/g, "").replace(",", ".").trim();
    if (!normalized || normalized === "-" || normalized === ".") return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // Uber's numeric money fields are integer minor units, including values
  // below one euro (for example `90` means €0.90). Formatted strings and
  // decimal numbers are already major-unit values.
  return Number.isInteger(number) ? number / 100 : number;
}

function eta(value) {
  const text = typeof value === "string" ? value : value?.text ?? value?.label ?? "";
  const numbers = text.match(/\d+/g)?.map(Number) ?? [];
  if (!numbers.length) return null;
  return { min: numbers[0], max: numbers[1] ?? numbers[0] };
}

function textValues(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value !== "object") return [];
  const direct = [value.accessibilityText, typeof value.text === "string" ? value.text : null]
    .filter((entry) => typeof entry === "string" && entry.trim());
  const semanticKeys = ["content", "richText", "richTextElements", "text", "promoBadge", "label", "title", "priceTagline"];
  return [...direct, ...semanticKeys.filter((key) => typeof value[key] === "object").flatMap((key) => textValues(value[key]))];
}

function promotionTypes(value) {
  const source = String(value ?? "").toLowerCase();
  return [...new Set([
    ...(/bogo|two_for_one|2.?for.?1/.test(source) ? ["BOGO"] : []),
    ...(/discounted_item|items_on_sale|percentage_discount/.test(source) ? ["DISCOUNTED_ITEM"] : []),
    ...(/free_delivery/.test(source) ? ["FREE_DELIVERY"] : []),
  ])];
}

function mergePromotions(...values) {
  const promotions = values.filter(Boolean);
  if (!promotions.length) return null;
  return {
    types: [...new Set(promotions.flatMap((promotion) => promotion.types ?? []))],
    descriptions: [...new Set(promotions.flatMap((promotion) => promotion.descriptions ?? []).filter(Boolean))],
    ids: [...new Set(promotions.flatMap((promotion) => promotion.ids ?? []).filter(Boolean))],
    eligible: promotions.every((promotion) => promotion.eligible !== false),
    applied: promotions.some((promotion) => promotion.applied),
    savings: Math.max(0, ...promotions.map((promotion) => Number(promotion.savings ?? 0))),
    source: promotions.map((promotion) => promotion.source).filter(Boolean).join("+") || null,
  };
}

function storeWidePromotion(value) {
  if (!value) return null;
  const types = (value.types ?? []).filter((type) => type === "FREE_DELIVERY");
  if (!types.length) return null;
  return { ...value, types };
}

function itemPromotion(item, finalPrice) {
  const promoInfo = item?.promoInfo;
  const promoType = item?.catalogItemAnalyticsData?.promoType;
  const taglineValues = textValues(item?.priceTagline);
  const originalCandidates = [
    price(item?.purchaseInfo?.purchaseOptions?.[0]?.purchasePriceV2),
    ...taglineValues.flatMap((text) => [...text.matchAll(/(?:€|EUR)\s*([0-9]+(?:[.,][0-9]+)?)/gi)]
      .map((match) => Number(match[1].replace(",", ".")))),
  ].filter((value) => Number.isFinite(value) && value > Number(finalPrice ?? 0));
  const originalPrice = originalCandidates.length ? Math.round(Math.max(...originalCandidates) * 100) / 100 : null;
  const itemSavings = originalPrice !== null && finalPrice !== null
    ? Math.round((originalPrice - finalPrice) * 100) / 100 : 0;
  if (!promoInfo && !promoType && itemSavings <= 0) return { promotion: null, originalPrice: null, itemSavings: 0 };
  const descriptions = [...new Set([
    ...textValues(promoInfo?.promoBadge),
    ...taglineValues.filter((text) => /off|discount|descuento|ahorra/i.test(text)),
  ])];
  return {
    promotion: {
      types: promotionTypes(promoType),
      descriptions,
      ids: promoInfo?.promotionUUID ? [promoInfo.promotionUUID] : [],
      eligible: true,
      applied: itemSavings > 0,
      savings: itemSavings,
      source: "ubereats-menu",
    },
    originalPrice,
    itemSavings,
  };
}

function storeValue(value) {
  if (!value || typeof value !== "object") return null;
  const uuid = value.storeUuid ?? value.uuid ?? value.storeUUID;
  const name = value.title?.text ?? value.name?.text ?? value.title ?? value.name;
  if (!uuid || !name) return null;
  const meta = Array.isArray(value.meta) ? value.meta : [];
  const offerMetadata = value.tracking?.storePayload?.offerMetadata;
  const storePromotionTypes = promotionTypes(offerMetadata?.concatSignpost);
  const promotionIds = offerMetadata?.promotionUUIDs ?? (value.tracking?.storePayload?.promotionUUID ? [value.tracking.storePayload.promotionUUID] : []);
  const promotion = storePromotionTypes.length || promotionIds.length ? {
    types: storePromotionTypes,
    descriptions: [],
    ids: promotionIds,
    eligible: true,
    applied: false,
    savings: 0,
    source: "ubereats-search-card",
  } : null;
  return {
    id: uuid,
    name,
    slug: value.slug ?? null,
    rating: Number(value.rating?.ratingValue ?? value.rating ?? value.ratingValue ?? value.tracking?.storePayload?.ratingInfo?.storeRatingScore) || null,
    ratingCount: Number(String(value.rating?.reviewCount ?? value.ratingCount ?? value.tracking?.storePayload?.ratingInfo?.ratingCount ?? "").replace(/[^0-9]/g, "")) || null,
    etaMinutes: value.tracking?.storePayload?.etdInfo?.dropoffETARange ?? eta(value.etaRange ?? value.eta ?? value.etaString ?? value.meta?.find((entry) => entry.badgeType === "ETD")),
    deliveryFee: price(value.deliveryFee?.discount ?? value.deliveryFee ?? value.fareInfo?.deliveryFee)
      ?? price(meta.find((entry) => entry.badgeType === "FARE")?.badgeData?.fare?.deliveryFee),
    membershipEligible: Boolean(value.hasUberOneBenefits ?? value.uberOne ?? value.membershipBenefit
      ?? meta.some((entry) => entry.badgeType === "MembershipBenefit" || entry.badgeDataWithFallback?.membership?.brandingType === "UBER_ONE")),
    promotion,
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
    const deal = itemPromotion(item, unitPrice);
    offers.push({
      provider: "ubereats",
      merchant: { id: store.id, name: store.name, rating: store.rating, ratingCount: store.ratingCount },
      item: { id, name: title, description: item.itemDescription ?? item.description ?? null, unitPrice },
      quantity: 1,
      etaMinutes: store.etaMinutes?.min ?? null,
      available: store.orderable !== false && item.isSoldOut !== true && item.isAvailable !== false,
      pricing: {
        currency: "EUR",
        originalSubtotal: deal.originalPrice,
        subtotal: unitPrice,
        itemSavings: deal.itemSavings,
        total: null,
        exact: false,
        fees: { delivery: store.deliveryFee },
      },
      promotion: mergePromotions(storeWidePromotion(store.promotion), deal.promotion),
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

export function collectUberStores(payload) {
  const stores = [];
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach(walk);
    const candidates = [value.store, value.storeInfo, value.miniStoreWithItems?.store, value.storeWithItems?.store];
    for (const candidate of candidates) {
      const store = storeValue(candidate);
      if (store && !seen.has(store.id)) {
        seen.add(store.id);
        stores.push(store);
      }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(payload);
  return stores;
}

function normalizedTerms(query) {
  const ignored = new Set(["a", "al", "con", "de", "del", "el", "en", "la", "las", "los", "y"]);
  return String(query).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !ignored.has(term));
}

export function uberEatsMenuOffers(store, menu, query) {
  const terms = normalizedTerms(query);
  return menu.items.filter((item) => {
    if (!terms.length) return true;
    const text = `${item.title} ${item.description ?? ""}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return terms.some((term) => text.includes(term));
  }).map((item) => ({
    provider: "ubereats",
    merchant: { id: store.id, name: store.name, rating: store.rating, ratingCount: store.ratingCount },
    item: { id: item.uuid, name: item.title, description: item.description, unitPrice: item.price },
    quantity: 1,
    etaMinutes: store.etaMinutes?.min ?? null,
    available: store.orderable !== false && menu.isOpen !== false && item.available !== false,
    pricing: {
      currency: "EUR",
      originalSubtotal: item.originalPrice,
      subtotal: item.price,
      itemSavings: item.itemSavings,
      total: null,
      exact: false,
      fees: { delivery: store.deliveryFee },
    },
    promotion: mergePromotions(storeWidePromotion(store.promotion), item.promotion),
    membershipEligible: store.membershipEligible,
    url: store.url,
    source: {
      adapter: "ubereats-api", storeUuid: store.id, itemUuid: item.uuid,
      sectionUuid: item.sectionUuid ?? "", subsectionUuid: item.subsectionUuid ?? "",
      rawPrice: item.rawPrice, requiresCustomizations: item.hasCustomizations,
    },
  }));
}

async function mapConcurrentOutcomes(values, concurrency, mapper) {
  const results = new Array(values.length);
  let index = 0;
  async function worker() {
    while (index < values.length) {
      const current = index++;
      try { results[current] = { status: "fulfilled", value: await mapper(values[current], current) }; }
      catch (reason) { results[current] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

async function mapConcurrent(values, concurrency, mapper) {
  const outcomes = await mapConcurrentOutcomes(values, concurrency, mapper);
  return outcomes.filter((outcome) => outcome.status === "fulfilled").flatMap((outcome) => outcome.value);
}

export async function expandUberEatsCatalogs(stores, queries, options = {}) {
  const priorityStoreIds = new Set((options.priorityStoreIds ?? []).map(String));
  const selected = [...stores]
    .sort((left, right) => Number(priorityStoreIds.has(String(right.id))) - Number(priorityStoreIds.has(String(left.id)))
      || Number(right.queryHits ?? 0) - Number(left.queryHits ?? 0)
      || Number(right.rating ?? 0) - Number(left.rating ?? 0))
    .slice(0, Math.max(1, Number(options.storeLimit ?? 3)));
  const outcomes = await mapConcurrentOutcomes(selected, Number(options.concurrency ?? 2), async (store, index) => {
    const requestDelayMs = Math.max(0, Number(options.requestDelayMs ?? 0));
    if (requestDelayMs > 0 && index > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(2_000, index * requestDelayMs)));
    }
    let menuPromise = options.menuCache?.get(store.id);
    if (!menuPromise) {
      menuPromise = uberEatsMenu(store.id, options);
      options.menuCache?.set(store.id, menuPromise);
    }
    let menu;
    try { menu = await menuPromise; }
    catch (error) {
      if (options.menuCache?.get(store.id) === menuPromise) options.menuCache.delete(store.id);
      throw error;
    }
    return queries.flatMap((query) => uberEatsMenuOffers(store, menu, query));
  });
  const offers = outcomes.filter((outcome) => outcome.status === "fulfilled").flatMap((outcome) => outcome.value);
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  return {
    offers: [...new Map(offers.map((offer) => [`${offer.merchant.id}:${offer.item.id}`, offer])).values()],
    searchedStores: outcomes.length - failures.length,
    failedStores: failures.length,
    rateLimitedStores: failures.filter((outcome) => outcome.reason?.code === "RATE_LIMITED").length,
  };
}

export async function searchUberEats(query, options = {}) {
  const requestedAt = options.scheduledAt ? new Date(options.scheduledAt) : null;
  const scheduled = requestedAt && !Number.isNaN(requestedAt.getTime());
  const date = scheduled ? new Intl.DateTimeFormat("en-CA", {
    timeZone: options.timeZone ?? "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(requestedAt) : "";
  const startTime = scheduled ? Math.floor(requestedAt.getTime() / 1_000) : 0;
  const endTime = scheduled ? startTime + Math.max(900, Number(options.windowMinutes ?? 30) * 60) : 0;
  const payload = await request("getSearchFeedV1", {
    userQuery: query,
    date,
    startTime,
    endTime,
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
  const directOffers = normalizeUberSearch(payload);
  let expandedOffers = [];
  const allStores = collectUberStores(payload);
  for (const store of allStores) {
    const existing = options.storeCache?.get(store.id);
    options.storeCache?.set(store.id, { ...existing, ...store, queryHits: Number(existing?.queryHits ?? 0) + 1 });
  }
  if (directOffers.length < Math.min(10, limit) && options.expandStores !== false) {
    const terms = normalizedTerms(query);
    const stores = allStores;
    const relevant = stores.filter((store) => {
      const name = store.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return terms.some((term) => name.includes(term));
    });
    const selected = [...new Map([...relevant, ...stores].map((store) => [store.id, store])).values()]
      .slice(0, Math.max(1, Number(options.storeLimit ?? 6)));
    expandedOffers = await mapConcurrent(selected, Number(options.concurrency ?? 4), async (store) => {
      let menuPromise = options.menuCache?.get(store.id);
      if (!menuPromise) {
        menuPromise = uberEatsMenu(store.id, options);
        options.menuCache?.set(store.id, menuPromise);
      }
      let menu;
      try { menu = await menuPromise; }
      catch (error) {
        if (options.menuCache?.get(store.id) === menuPromise) options.menuCache.delete(store.id);
        throw error;
      }
      return uberEatsMenuOffers(store, menu, query);
    });
  }
  const offers = [...new Map([...directOffers, ...expandedOffers]
    .map((offer) => [`${offer.merchant.id}:${offer.item.id}`, offer])).values()].slice(0, limit);
  return {
    offers,
    fulfilment: scheduled ? { requestedAt: requestedAt.toISOString(), date, startTime, endTime, status: offers.length ? "candidate" : "unavailable", source: "uber-scheduled-search" } : null,
    searchedStores: allStores.length,
    expandedStores: expandedOffers.length ? new Set(expandedOffers.map((offer) => offer.merchant.id)).size : 0,
    raw: options.raw ? payload : undefined,
  };
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
      const finalPrice = price(value.price);
      const deal = itemPromotion(value, finalPrice);
      items.push({
        uuid: value.uuid,
        title: value.title,
        description: value.itemDescription ?? null,
        price: finalPrice,
        originalPrice: deal.originalPrice,
        itemSavings: deal.itemSavings,
        promotion: deal.promotion,
        rawPrice: value.price,
        imageUrl: value.imageUrl ?? null,
        available: value.isSoldOut !== true && value.isAvailable !== false,
        hasCustomizations: Boolean(value.hasCustomizations ?? value.customizationsList?.length),
        sectionUuid: nextSection,
        subsectionUuid: nextSubsection,
      });
    }
    for (const [key, child] of Object.entries(value)) walk(child, key.includes("section") ? key : nextSection, nextSubsection);
  }
  walk(payload);
  return items;
}

export async function uberEatsMenu(storeUuid, options = {}) {
  const requestedAt = options.scheduledAt ? new Date(options.scheduledAt) : null;
  const scheduled = requestedAt && !Number.isNaN(requestedAt.getTime());
  const target = scheduled ? localScheduleParts(requestedAt, options.timeZone, options.windowMinutes) : null;
  const payload = await request("getStoreV1", {
    storeUuid,
    sfNuggetCount: 0,
    diningMode: "DELIVERY",
    ...(target ? { time: target, cbType: "EATER_ENDORSED" } : {}),
  }, options);
  const unavailableMessage = /(?:delivery |currently |not )?unavailable|no disponible|cerrad|closed/i.test(String(payload.closedMessage ?? ""));
  const scheduledRanges = target ? payload.adaptedDeliveryHoursInfos?.timeRanges?.[target.date] : null;
  const scheduledSlotAvailable = !target || !Array.isArray(scheduledRanges)
    || scheduledRanges.some((range) => Number(range.startTime) <= target.startTime && Number(range.endTime) >= target.endTime);
  return {
    storeUuid,
    title: payload.title ?? payload.store?.title ?? "",
    isOpen: payload.isOpen !== false && payload.isWithinDeliveryRange !== false
      && !unavailableMessage && scheduledSlotAvailable,
    closedMessage: payload.closedMessage ?? null,
    scheduledSlotAvailable,
    items: collectCatalog(payload),
    raw: options.raw ? payload : undefined,
  };
}

export async function uberEatsItem(source, options = {}) {
  return request("getMenuItemV1", { itemRequestType: "ITEM", storeUuid: source.storeUuid, sectionUuid: source.sectionUuid ?? "", subsectionUuid: source.subsectionUuid ?? "", menuItemUuid: source.itemUuid, diningMode: "DELIVERY" }, options);
}

export async function uberEatsMe(options = {}) {
  const user = await request("getUserV1", {}, { ...options, auth: true });
  if (user.isLoggedIn !== true) throw new CliError("Uber Eats session is not logged in", "AUTH_EXPIRED");
  const subscriptionStatus = user.subscriptionMeta?.eatsSubscriptionStatus ?? null;
  return {
    authenticated: true,
    id: user.uuid ?? user.id ?? null,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    email: user.email ?? null,
    phone: user.phoneNumber ?? null,
    hasConfirmedMobile: user.hasConfirmedMobile ?? null,
    membershipActive: subscriptionStatus === "ACTIVE",
  };
}

export async function uberEatsCarts(options = {}) {
  const payload = await request("getDraftOrdersByEaterUuidV1", {}, { ...options, auth: true });
  return { draftOrders: payload.draftOrders ?? payload.orders ?? [] };
}

function draftItems(draft) {
  const candidates = [
    draft?.shoppingCartItems,
    draft?.shoppingCart?.shoppingCartItems,
    draft?.shoppingCart?.items,
    draft?.cart?.shoppingCartItems,
    draft?.cart?.items,
    draft?.items,
  ];
  const items = candidates.find(Array.isArray) ?? [];
  return items.map((entry) => ({
    name: entry?.title ?? entry?.name ?? entry?.item?.title ?? entry?.item?.name ?? "Item",
    quantity: Number(entry?.quantity ?? entry?.count ?? 1),
  })).filter((entry) => entry.name && Number.isFinite(entry.quantity) && entry.quantity > 0);
}

function draftStore(draft) {
  const store = draft?.store ?? draft?.shoppingCart?.store ?? draft?.cart?.store ?? {};
  return {
    id: draft?.storeUuid ?? draft?.storeUUID ?? store?.storeUuid ?? store?.uuid ?? store?.id ?? null,
    name: store?.title ?? store?.name ?? draft?.storeName ?? null,
  };
}

function draftId(draft) {
  return draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid ?? null;
}

function normalizedLineName(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().replace(/\s+/g, " ").toLowerCase();
}

function summarizedLineQuantities(lines, mapper) {
  const quantities = new Map();
  for (const line of lines) {
    const mapped = mapper(line);
    const name = normalizedLineName(mapped.name);
    const quantity = Number(mapped.quantity);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) continue;
    quantities.set(name, (quantities.get(name) ?? 0) + quantity);
  }
  return [...quantities.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, quantity]) => ({ name, quantity }));
}

export function verifyUberEatsDraftLines(carts, draftOrderUuid, expectedLines) {
  const draft = (carts?.draftOrders ?? []).find((entry) => String(draftId(entry)) === String(draftOrderUuid));
  if (!draft) {
    throw new CliError("Uber Eats did not return the created draft for verification", "REMOTE_BASKET_MISMATCH", {
      draftOrderUuid: String(draftOrderUuid),
    });
  }
  const expected = summarizedLineQuantities(expectedLines ?? [], (line) => ({
    name: line.item?.name ?? line.name,
    quantity: line.quantity ?? 1,
  }));
  const actual = summarizedLineQuantities(draftItems(draft), (line) => line);
  if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CliError("Uber Eats remote draft does not match the selected items and quantities", "REMOTE_BASKET_MISMATCH", {
      expected,
      actual,
    });
  }
  return { verified: true, lines: actual, itemCount: actual.reduce((sum, line) => sum + line.quantity, 0) };
}

export function verifyUberEatsDraftSchedule(carts, draftOrderUuid, scheduledAt, timeZone = "Europe/Madrid") {
  const draft = (carts?.draftOrders ?? []).find((entry) => String(draftId(entry)) === String(draftOrderUuid));
  if (!draft) {
    throw new CliError("Uber Eats did not return the scheduled draft for verification", "SCHEDULE_UNVERIFIED", {
      draftOrderUuid: String(draftOrderUuid),
    });
  }
  const expected = localScheduleParts(scheduledAt, timeZone);
  const actual = draft.targetDeliveryTimeRange ?? draft.deliveryTime ?? null;
  const verified = actual?.scheduled === true
    && String(actual.date) === expected.date
    && Number(actual.startTime) === expected.startTime
    && Number(actual.endTime) === expected.endTime;
  if (!verified) {
    throw new CliError("Uber Eats did not persist the requested delivery window", "SCHEDULE_UNVERIFIED", {
      requestedAt: new Date(scheduledAt).toISOString(),
      expected: { date: expected.date, startTime: expected.startTime },
      actual: actual ? {
        scheduled: actual.scheduled,
        date: actual.date ?? null,
        startTime: actual.startTime ?? null,
        endTime: actual.endTime ?? null,
      } : null,
    });
  }
  return {
    verified: true,
    requestedAt: new Date(scheduledAt).toISOString(),
    timeZone,
    selectedWindow: {
      date: expected.date,
      startMinute: expected.startTime,
      endMinute: Number(actual.endTime ?? expected.endTime),
    },
    source: "ubereats-remote-draft",
  };
}

function finiteCoordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function findDeliveryLocation(value, depth = 0, deliveryBranch = false) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  const latitude = deliveryBranch ? finiteCoordinate(value.latitude ?? value.lat) : null;
  const longitude = deliveryBranch ? finiteCoordinate(value.longitude ?? value.lng ?? value.lon) : null;
  if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return {
      latitude,
      longitude,
      city: value.city ?? value.cityName ?? null,
      postcode: value.postalCode ?? value.postcode ?? value.zipCode ?? null,
      source: "ubereats-draft-delivery-location",
    };
  }
  for (const [key, child] of Object.entries(value)) {
    const match = findDeliveryLocation(child, depth + 1, deliveryBranch || /(delivery|dropoff|address|location|destination)/i.test(key));
    if (match) return match;
  }
  return null;
}

export function uberEatsDraftDeliveryLocation(carts) {
  for (const draft of carts?.draftOrders ?? []) {
    const location = findDeliveryLocation(draft);
    if (location) return location;
  }
  return null;
}

export function summarizeUberEatsCarts(carts) {
  return {
    draftOrders: (carts?.draftOrders ?? []).map((draft) => {
      const items = draftItems(draft);
      return {
        id: draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid ?? null,
        store: draftStore(draft),
        items,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        state: draft?.state ?? draft?.status ?? null,
        createdAt: draft?.createdAt ?? draft?.createdTime ?? null,
        deliveryLocationSelected: Boolean(findDeliveryLocation(draft)),
      };
    }),
  };
}

export async function createUberEatsBasket(offer, options = {}) {
  const lines = offer.lines?.length ? offer.lines : [{ item: offer.item, quantity: offer.quantity ?? 1, source: offer.source }];
  const stores = new Set(lines.map((line) => line.source?.storeUuid).filter(Boolean));
  if (stores.size !== 1 || lines.some((line) => !line.source?.itemUuid)) {
    throw new CliError("Uber Eats basket lines must belong to one store and include item identifiers", "SOURCE_PLAN_MISSING");
  }
  const shoppingCartItems = [];
  for (const [index, line] of lines.entries()) {
    const source = line.source;
    const customizations = options.customizations?.[source.itemUuid] ?? options.customizations?.[index]
      ?? (lines.length === 1 ? options.customizations : null);
    if (source.requiresCustomizations && !customizations) {
      const details = await uberEatsItem(source, options);
      const groups = details.customizationsList ?? [];
      const required = groups.filter((group) => Number(group.minPermitted ?? group.minPermittedUnique ?? 0) > 0);
      if (required.length) {
        throw new CliError(`"${line.item?.name}" requires customization choices`, "MODIFIERS_REQUIRED", {
          itemId: source.itemUuid,
          customizations: groups,
          requiredCustomizations: required,
        });
      }
    }
    shoppingCartItems.push({
      uuid: source.itemUuid,
      shoppingCartItemUuid: randomUUID(),
      storeUuid: source.storeUuid,
      sectionUuid: source.sectionUuid ?? "",
      subsectionUuid: source.subsectionUuid ?? "",
      price: source.rawPrice ?? Math.round(Number(line.item?.unitPrice ?? 0) * 100),
      title: line.item?.name,
      quantity: line.quantity ?? 1,
      customizations: customizations ?? {},
      imageURL: null,
      specialInstructions: "",
      itemId: null,
    });
  }
  const requestBody = {
    removeAdapters: true,
    isMulticart: true,
    useCredits: true,
    extraPaymentProfiles: [],
    promotionOptions: {
      autoApplyPromotionUUIDs: [],
      selectedPromotionInstanceUUIDs: [],
      skipApplyingPromotion: false,
    },
    deliveryTime: { asap: true },
    deliveryType: "ASAP",
    currencyCode: lines[0]?.source?.currencyCode ?? "EUR",
    interactionType: "door_to_door",
    checkMultipleDraftOrdersCap: true,
    actionMeta: { isQuickAdd: false, numClicks: 0 },
    analyticsRelevantData: { profileSource: "" },
    businessDetails: {},
    shoppingCartItems,
  };
  if (options.prepareOnly) return { mutated: false, payload: requestBody, submitted: false };
  const payload = await request("createDraftOrderV2", requestBody, { ...options, auth: true });
  const draftOrder = payload.draftOrder ?? payload;
  const draftOrderUuid = draftId(draftOrder);
  let scheduling = null;
  if (options.scheduledAt) {
    if (!draftOrderUuid) throw new CliError("Uber Eats created a draft without returning its ID", "BASKET_PROTOCOL_ERROR");
    scheduling = await updateUberEatsDraftSchedule(draftOrderUuid, options.scheduledAt, options);
  }
  return { mutated: true, draftOrder, scheduling, submitted: false };
}

function checkoutText(value) {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object") {
    const text = value.text ?? value.accessibilityText ?? value.title ?? value.label;
    return typeof text === "string" ? text.trim() || null : null;
  }
  return null;
}

function uberEatsCheckoutWarnings(quote) {
  const cartItems = findPayload(quote, "cartItems");
  const warnings = cartItems?.cartItemsWarnings ?? cartItems?.warnings ?? [];
  if (!Array.isArray(warnings)) return [];
  return warnings.map((warning) => ({
    title: checkoutText(warning?.title),
    subtitle: checkoutText(warning?.subtitle ?? warning?.description),
  })).filter((warning) => warning.title || warning.subtitle);
}

function uberEatsCheckoutIssues(quote, options = {}) {
  const cartItems = findPayload(quote, "cartItems");
  const allowed = new Set(options.scheduledAt ? ["STORE_UNAVAILABLE_BUT_SCHEDULABLE"] : []);
  const issues = (Array.isArray(quote?.validationErrors) ? quote.validationErrors : [])
    .filter((error) => !allowed.has(error?.type))
    .map((error) => ({
      type: error?.type ?? "CHECKOUT_VALIDATION_ERROR",
      title: checkoutText(error?.alert?.title),
    }));
  return { cartValidationPresent: Boolean(cartItems), issues, warnings: uberEatsCheckoutWarnings(quote) };
}

export async function quoteUberEatsBasket(draftOrderUuid, options = {}) {
  const carts = options.expectedLines || options.scheduledAt ? await uberEatsCarts(options) : null;
  const remoteBasketVerification = options.expectedLines
    ? verifyUberEatsDraftLines(carts, draftOrderUuid, options.expectedLines)
    : null;
  const scheduleVerification = options.scheduledAt
    ? verifyUberEatsDraftSchedule(carts, draftOrderUuid, options.scheduledAt, options.timeZone)
    : null;
  const requestBody = {
    payloadTypes: CHECKOUT_PAYLOAD_TYPES,
    draftOrderUUID: draftOrderUuid,
    isGroupOrder: false,
    clientFeaturesData: {
      paymentSelectionContext: {
        value: JSON.stringify({ deviceContext: { thirdPartyApplications: ["google_pay", "venmo"] } }),
      },
    },
    webGiftingPersonalizationEnabled: true,
  };
  const quote = await request("getCheckoutPresentationV1", requestBody, { ...options, auth: true });
  const pricing = normalizeUberEatsQuote(quote);
  const checkoutBlockers = uberEatsCheckoutIssues(quote, options);
  if (!checkoutBlockers.cartValidationPresent) {
    throw new CliError("Uber Eats did not return verifiable cart validation", "CHECKOUT_UNVERIFIED", {
      issues: [{ type: "CART_VALIDATION_MISSING", title: null }],
      warnings: [],
    });
  }
  if (checkoutBlockers.issues.length || checkoutBlockers.warnings.length) {
    throw new CliError(
      options.scheduledAt ? "Uber Eats rejected the scheduled checkout" : "Uber Eats checkout is not currently orderable",
      options.scheduledAt ? "SCHEDULE_UNAVAILABLE" : "CHECKOUT_UNAVAILABLE",
      {
      issues: checkoutBlockers.issues,
      warnings: checkoutBlockers.warnings,
      },
    );
  }
  if (!options.scheduledAt) return {
    provider: "ubereats", draftOrderUuid, quote, pricing, remoteBasketVerification, submitted: false,
  };
  return {
    provider: "ubereats", draftOrderUuid, quote,
    fulfilment: { ...scheduleVerification, status: "verified" },
    remoteBasketVerification,
    scheduleVerification,
    pricing,
    submitted: false,
  };
}

export function uberEatsBasketHandoff(offer, options = {}) {
  const draftOrderUuid = offer?.basket?.id;
  if (!draftOrderUuid) throw new CliError("Create this Uber Eats basket first", "BASKET_REQUIRED");
  const lines = (offer.lines?.length
    ? offer.lines
    : [{ item: offer.item, quantity: offer.quantity ?? 1 }])
    .map((line) => ({ name: line.item?.name ?? line.name ?? "Item", quantity: Number(line.quantity ?? 1) }))
    .filter((line) => line.name && Number.isFinite(line.quantity) && line.quantity > 0);
  return {
    provider: "ubereats",
    opened: options.opened === true,
    url: `${BASE}/feed`,
    directCheckout: false,
    handoff: {
      mode: "select_existing_cart",
      draftOrderUuid: String(draftOrderUuid),
      merchantName: offer.merchant?.name ?? null,
      expectedLines: lines,
      successCriteria: "Open the matching Uber Eats cart and verify its merchant and every line before checkout.",
    },
    submitted: false,
  };
}

function uberEatsScheduleAvailability(quote, requestedAt, timeZone = "Europe/Madrid") {
  const requested = new Date(requestedAt);
  if (Number.isNaN(requested.getTime())) throw new CliError("Scheduled delivery requires a valid ISO date and time", "INVALID_SCHEDULE");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(requested).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const date = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const minute = parts.hour * 60 + parts.minute;
  const errors = quote?.validationErrors ?? [];
  const schedulable = errors.find((error) => error.type === "STORE_UNAVAILABLE_BUT_SCHEDULABLE");
  const hours = schedulable?.alert?.primaryButton?.params?.scheduleTimePickerParams?.orderForLaterInfo?.isSchedulable === false
    ? [] : schedulable?.alert?.primaryButton?.params?.scheduleTimePickerParams?.deliveryHoursInfos ?? [];
  const day = hours.find((entry) => entry.date === date);
  const window = day?.openHours?.find((entry) => minute >= Number(entry.startTime)
    && minute + Number(entry.durationOffset ?? entry.incrementStep ?? 0) <= Number(entry.endTime));
  if (window) return {
    requestedAt: requested.toISOString(), timeZone, status: "available_unconfigured",
    selectedWindow: { date, startMinute: minute, durationMinutes: Number(window.durationOffset ?? window.incrementStep ?? 0) },
    source: "uber-checkout-schedule-hours",
  };
  if (schedulable || errors.some((error) => /STORE_UNAVAILABLE/.test(error.type))) {
    throw new CliError("The Uber Eats store cannot deliver at the requested time", "SCHEDULE_UNAVAILABLE", {
      requestedAt: requested.toISOString(), hours: day?.openHours ?? [],
    });
  }
  throw new CliError("Uber Eats did not return verifiable delivery hours for the requested time", "SCHEDULE_UNVERIFIED", {
    requestedAt: requested.toISOString(),
  });
}

function findNumber(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) if (value[key] !== undefined) { const amount = price(value[key]); if (amount !== null) return amount; }
  for (const child of Object.values(value)) { const amount = findNumber(child, keys); if (amount !== null) return amount; }
  return null;
}

function findPayload(value, type) {
  if (!value || typeof value !== "object") return null;
  if (value[type] && typeof value[type] === "object") return value[type];
  if (value.checkoutPayloads?.[type] && typeof value.checkoutPayloads[type] === "object") return value.checkoutPayloads[type];
  const label = String(value.type ?? value.payloadType ?? value.name ?? "").toLowerCase();
  if (label === type.toLowerCase()) return value.payload ?? value;
  for (const child of Object.values(value)) {
    const match = findPayload(child, type);
    if (match) return match;
  }
  return null;
}

function findFareAmount(value, pattern) {
  if (!value || typeof value !== "object") return null;
  if (pattern.test(String(value.fareInfoID ?? ""))) {
    const amount = price(value.currencyAmount ?? value.amount ?? value.value);
    if (amount !== null) return amount;
  }
  for (const child of Object.values(value)) {
    const amount = findFareAmount(child, pattern);
    if (amount !== null) return amount;
  }
  return null;
}

export function normalizeUberEatsQuote(quote) {
  const subtotalPayload = findPayload(quote, "subtotal");
  const totalPayload = findPayload(quote, "total");
  const farePayload = findPayload(quote, "fareBreakdown");
  const subtotal = price(subtotalPayload?.subtotal?.value ?? subtotalPayload?.value)
    ?? findNumber(subtotalPayload, ["subtotal", "amount", "price", "value"]);
  const total = price(totalPayload?.total?.value ?? totalPayload?.value)
    ?? findNumber(totalPayload, ["total", "amount", "price", "value"])
    ?? findNumber(quote, ["totalAmount", "payableAmount"]);
  const delivery = findFareAmount(farePayload, /delivery_fee/i)
    ?? findNumber(farePayload, ["deliveryFee", "deliveryFeeAmount"]);
  const service = findFareAmount(farePayload, /basket_dependent_fee|service_fee|marketplace_fee/i)
    ?? findNumber(farePayload, ["serviceFee", "serviceFeeAmount"]);
  const smallOrder = findFareAmount(farePayload, /small_order/i)
    ?? findNumber(farePayload, ["smallOrderFee", "smallOrderFeeAmount"]);
  const fees = { delivery, service, smallOrder, bag: null, other: null };
  const explicitDiscount = findNumber(findPayload(quote, "promotion"), ["discountAmount", "promotionAmount", "savingsAmount"])
    ?? findNumber(findPayload(quote, "promoAndMembershipSavingBannerPayloadCheckout"), ["discountAmount", "promotionAmount", "savingsAmount", "amount"]);
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

export function uberEatsOrderConfirmation(draftOrderUuid, quote) {
  const requestBody = { draftOrderUUIDs: [draftOrderUuid] };
  const confirmation = { provider: "ubereats", draftOrderUuid, total: findNumber(quote, ["total", "totalAmount", "payableAmount"]), currency: quote?.currencyCode ?? quote?.currency ?? "EUR", requestBody };
  return { ...confirmation, fingerprint: createHash("sha256").update(JSON.stringify(confirmation)).digest("hex").slice(0, 16) };
}

export async function placeUberEatsOrder(draftOrderUuid, quote, options = {}) {
  const confirmation = uberEatsOrderConfirmation(draftOrderUuid, quote);
  if (!options.confirm) return { ...confirmation, submitted: false, requiresConfirmation: confirmation.fingerprint, warning: "Final purchase boundary. Confirm the current exact total and payment method before re-running with this fingerprint." };
  if (options.confirm !== confirmation.fingerprint) throw new CliError("Confirmation fingerprint does not match the current checkout", "CONFIRMATION_MISMATCH");
  if (process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT !== "1") throw new CliError("Order placement is disabled; set ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1 only after explicit approval", "ORDER_PLACEMENT_DISABLED");
  try {
    const response = await request("checkoutOrdersByDraftOrdersV1", confirmation.requestBody, { ...options, auth: true });
    return { submitted: true, response };
  } catch (error) {
    if (error.code === "NETWORK_ERROR" || error.code === "UBEREATS_HTTP_ERROR") throw new CliError("The Uber Eats checkout outcome is unknown. Do not retry automatically; inspect active orders.", "ORDER_STATUS_UNKNOWN", { draftOrderUuid });
    throw error;
  }
}

export const uberEatsInternals = { apiHeaders, checkoutPayloadTypes: CHECKOUT_PAYLOAD_TYPES, collectCatalog, draftItems, findDeliveryLocation, itemPromotion, localScheduleParts, menuOffers: uberEatsMenuOffers, mergePromotions, price, request, storeValue, storeWidePromotion, uberEatsScheduleAvailability };
