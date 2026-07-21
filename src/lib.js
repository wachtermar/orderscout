const API_BASE = "https://i18n.api.just-eat.io";
const MENU_CDN = "https://menu-globalmenucdn.justeat-int.com";

export class CliError extends Error {
  constructor(message, code = "USAGE_ERROR", details) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function providerErrorDetails(body) {
  if (!body || typeof body !== "object") return {};
  const entries = Object.entries(body);
  const value = (...names) => {
    const expected = new Set(names.map((name) => name.toLowerCase()));
    const match = entries.find(([key]) => expected.has(key.toLowerCase()));
    return match?.[1];
  };
  const shortString = (input) => typeof input === "string" && input.trim()
    ? input.trim().slice(0, 300)
    : undefined;
  const providerErrorType = shortString(value("errorType", "type"));
  const providerSubErrorType = shortString(value("subErrorType", "subType"));
  const providerMessage = shortString(value("message", "errorMessage", "title"));
  const providerCode = shortString(value("code", "errorCode"));
  const isOrderableValue = value("isOrderable");
  const serviceType = shortString(value("serviceType"));
  return {
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerSubErrorType ? { providerSubErrorType } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(typeof isOrderableValue === "boolean" ? { isOrderable: isOrderableValue } : {}),
    ...(serviceType ? { serviceType } : {}),
  };
}

function httpErrorCode(status, details) {
  if (status === 429) return "RATE_LIMITED";
  if (details.isOrderable === false || details.providerSubErrorType === "PartnerThrottled") {
    return "MERCHANT_UNAVAILABLE";
  }
  if (details.providerErrorType === "RestaurantDoesNotDeliverToLocation") {
    return "DELIVERY_UNAVAILABLE";
  }
  return "HTTP_ERROR";
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  const {
    headers: optionHeaders,
    timeout = 15_000,
    retries,
    ...fetchOptions
  } = options;
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "es-ES",
    "x-jet-application": "OneWeb",
    ...optionHeaders,
  };
  const method = String(fetchOptions.method ?? "GET").toUpperCase();
  const maxAttempts = retries === undefined
    ? (["GET", "HEAD", "OPTIONS"].includes(method) ? 3 : 1)
    : Math.max(1, Number(retries) + 1);
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...fetchOptions,
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) return await response.json();
      const responseText = await response.text();
      let responseBody;
      try {
        responseBody = responseText ? JSON.parse(responseText) : null;
      } catch {
        responseBody = null;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts - 1) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1_000, 5_000)
          : 250 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      const providerDetails = providerErrorDetails(responseBody);
      const code = httpErrorCode(response.status, providerDetails);
      throw new CliError(
        response.status === 429 ? "Just Eat rate limit exceeded" : `Just Eat returned HTTP ${response.status}`,
        code,
        {
          status: response.status,
          url: String(url),
          ...providerDetails,
        },
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      lastError = error;
      if (attempt < maxAttempts - 1) await sleep(250 * 2 ** attempt);
    }
  }
  throw new CliError("Could not reach Just Eat", "NETWORK_ERROR", {
    cause: lastError?.message,
    url: String(url),
  });
}

export async function autocomplete(query, limit = 10, fetchImpl = fetch) {
  if (!query) throw new CliError("A location query is required");
  const url = new URL(`${API_BASE}/autocomplete/addresses/es`);
  url.searchParams.set("input", query);
  url.searchParams.set("type", "any");
  url.searchParams.set("limit", String(limit));
  return requestJson(url, {
    headers: { "accept-language": "es", "x-je-canonical-area": "true" },
  }, fetchImpl);
}

export async function locationDetail(id, session, fetchImpl = fetch) {
  const url = new URL(`${API_BASE}/autocomplete/addresses/es/${encodeURIComponent(id)}`);
  url.searchParams.set("session", session);
  return requestJson(url, {
    headers: { "accept-language": "es", "x-je-canonical-area": "true" },
  }, fetchImpl);
}

export async function resolveLocation(query, fetchImpl = fetch) {
  const suggestions = await autocomplete(query, 10, fetchImpl);
  const suggestion = suggestions.data?.[0];
  if (!suggestion) {
    throw new CliError(`No location matched: ${query}`, "LOCATION_NOT_FOUND");
  }
  const detail = await locationDetail(suggestion.id, suggestions.session, fetchImpl);
  const feature = detail.features?.[0];
  if (!feature) throw new CliError("The location has no coordinates", "INVALID_LOCATION");
  const [longitude, latitude] = feature.geometry.coordinates;
  const address = feature.properties?.structuredAddress ?? {};
  return {
    query,
    matched: suggestion.description,
    latitude,
    longitude,
    postcode: address.formattedPostcode ?? address.postcode,
    city: address.city,
    canonicalName: feature.properties?.area?.fullCanonicalName,
    raw: detail,
  };
}

export async function discoverRestaurants(location, options = {}, fetchImpl = fetch) {
  const url = new URL(`${API_BASE}/discovery/es/restaurants/enriched`);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("serviceType", options.serviceType ?? "delivery");
  url.searchParams.set("ratingsOutOfFive", "true");
  url.searchParams.set("je-tgl-ops_include_closed", "true");
  url.searchParams.set("defaultLayout", "variant_2");
  url.searchParams.set("vertical", options.vertical ?? "all");
  const token = options.token;
  return requestJson(url, {
    headers: {
      accept: "application/json;v=3",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }, fetchImpl);
}

function etaValue(restaurant) {
  return restaurant.deliveryEtaMinutes?.rangeLower ?? Number.POSITIVE_INFINITY;
}

export function normalizeRestaurants(payload, options = {}) {
  let restaurants = payload.restaurants ?? [];
  const cuisine = options.cuisine?.toLocaleLowerCase("es");
  const name = options.name?.toLocaleLowerCase("es");
  if (cuisine) {
    restaurants = restaurants.filter((restaurant) => restaurant.cuisines?.some((entry) =>
      entry.name?.toLocaleLowerCase("es").includes(cuisine)
      || entry.uniqueName?.toLocaleLowerCase("es").includes(cuisine)));
  }
  if (name) {
    restaurants = restaurants.filter((restaurant) =>
      restaurant.name?.toLocaleLowerCase("es").includes(name)
      || restaurant.brandName?.toLocaleLowerCase("es").includes(name));
  }
  if (options.open) {
    restaurants = restaurants.filter((restaurant) =>
      options.serviceType === "collection"
        ? restaurant.isOpenNowForCollection
        : restaurant.isOpenNowForDelivery);
  }
  const sort = options.sort ?? "recommended";
  if (sort === "rating") {
    restaurants = [...restaurants].sort((left, right) =>
      (right.rating?.starRating ?? -1) - (left.rating?.starRating ?? -1));
  } else if (sort === "distance") {
    restaurants = [...restaurants].sort((left, right) =>
      (left.driveDistanceMeters ?? Infinity) - (right.driveDistanceMeters ?? Infinity));
  } else if (sort === "eta") {
    restaurants = [...restaurants].sort((left, right) => etaValue(left) - etaValue(right));
  } else if (sort !== "recommended") {
    throw new CliError(`Unknown sort: ${sort}`);
  }
  const limit = Number(options.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new CliError("--limit must be an integer between 1 and 1000");
  }
  return restaurants.slice(0, limit).map((restaurant) => ({
    id: restaurant.id,
    name: restaurant.name,
    brand: restaurant.brandName || null,
    slug: restaurant.uniqueName,
    menuUrl: `https://www.just-eat.es/restaurants-${restaurant.uniqueName}/menu`,
    cuisines: restaurant.cuisines?.map((entry) => entry.name) ?? [],
    rating: restaurant.rating?.starRating ?? null,
    ratingCount: restaurant.rating?.count ?? 0,
    distanceMeters: restaurant.driveDistanceMeters ?? null,
    etaMinutes: restaurant.deliveryEtaMinutes ?? null,
    delivery: restaurant.isDelivery,
    collection: restaurant.isCollection,
    open: options.serviceType === "collection"
      ? restaurant.isOpenNowForCollection
      : restaurant.isOpenNowForDelivery,
    preorder: restaurant.isOpenNowForPreorder,
    temporarilyOffline: restaurant.isTemporarilyOffline,
    address: restaurant.address,
    deals: restaurant.deals?.map((deal) => deal.description) ?? [],
  }));
}

export function normalizeSlug(value) {
  if (!value) throw new CliError("A restaurant slug or menu URL is required");
  let slug = value.trim();
  try {
    if (/^https?:\/\//i.test(slug)) slug = new URL(slug).pathname;
  } catch {
    throw new CliError("Invalid restaurant URL");
  }
  slug = slug.replace(/^\/+|\/+$/g, "").replace(/\/menu$/i, "");
  slug = slug.replace(/^restaurants-/, "");
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new CliError("Invalid restaurant slug");
  return slug.toLowerCase();
}

export async function fetchMenu(slugInput, fetchImpl = fetch) {
  const slug = normalizeSlug(slugInput);
  let manifest;
  let manifestPath;
  for (const candidate of [`v2_2/${slug}_es_manifest.json`, `${slug}_es_manifest.json`]) {
    try {
      manifest = await requestJson(`${MENU_CDN}/${candidate}`, {}, fetchImpl);
      manifestPath = candidate;
      break;
    } catch (error) {
      if (error.details?.status !== 404) throw error;
    }
  }
  if (!manifest) throw new CliError(`Restaurant menu not found: ${slug}`, "MENU_NOT_FOUND");
  const manifestDirectory = manifestPath.includes("/")
    ? manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1)
    : "";
  const resolveCdnPath = (value, fallback) => {
    const selected = value || fallback;
    if (/^https?:\/\//i.test(selected)) return selected;
    return `${MENU_CDN}/${selected.startsWith("/") ? selected.slice(1) : selected}`;
  };
  const [items, details] = await Promise.all([
    requestJson(resolveCdnPath(manifest.ItemsUrl, `${manifestDirectory}${slug}_es_items.json`), {}, fetchImpl),
    requestJson(resolveCdnPath(manifest.ItemDetailsUrl, `${manifestDirectory}${slug}_es_itemDetails.json`), {}, fetchImpl),
  ]);
  return { slug, manifest, items, details };
}

export function normalizeMenu(menuData) {
  const { slug, manifest, items, details } = menuData;
  const itemById = new Map((items.Items ?? []).map((item) => [item.Id, item]));
  const categories = [];
  for (const menu of manifest.Menus ?? []) {
    for (const category of menu.Categories ?? []) {
      categories.push({
        id: category.Id,
        name: category.Name,
        description: category.Description || null,
        parentIds: category.ParentIds ?? [],
        serviceTypes: menu.ServiceTypes ?? [],
        items: (category.ItemIds ?? []).map((id) => itemById.get(id)).filter(Boolean).map((item) => ({
          id: item.Id,
          name: item.Name,
          description: item.Description || null,
          type: item.Type,
          labels: item.Labels ?? [],
          image: item.ImageSources?.find((source) => source.Source === "Cloudinaryv2")?.Path
            ?? item.ImageSources?.[0]?.Path
            ?? null,
          variations: (item.Variations ?? []).map((variation) => ({
            id: variation.Id,
            name: variation.Name || null,
            price: variation.BasePrice,
            modifierGroupIds: variation.ModifierGroupsIds ?? [],
            dealGroupIds: variation.DealGroupsIds ?? [],
            restrictions: variation.Restrictions ?? item.Restrictions ?? null,
          })),
        })),
      });
    }
  }
  return {
    restaurant: {
      id: manifest.RestaurantId,
      name: manifest.RestaurantInfo?.Name,
      slug,
      description: manifest.RestaurantInfo?.Description || null,
      cuisines: manifest.RestaurantInfo?.CuisineTypes?.map((entry) => entry.Name) ?? [],
      location: manifest.RestaurantInfo?.Location,
      offline: manifest.RestaurantInfo?.IsOffline,
      halal: manifest.RestaurantInfo?.IsHalal,
    },
    currency: "EUR",
    menuVersion: manifest.MenuVersion,
    categories,
    modifierGroups: details.ModifierGroups ?? [],
    modifierSets: details.ModifierSets ?? [],
    dealGroups: details.DealGroups ?? [],
  };
}

export function filterMenu(menu, query) {
  if (!query) return menu;
  const normalized = String(query).toLocaleLowerCase("es");
  const categories = menu.categories.map((category) => ({
    ...category,
    items: category.items.filter((item) =>
      item.name?.toLocaleLowerCase("es").includes(normalized)
      || item.description?.toLocaleLowerCase("es").includes(normalized)),
  })).filter((category) => category.items.length > 0);
  return { ...menu, query, matches: categories.reduce((sum, category) => sum + category.items.length, 0), categories };
}

export function decodeToken(token) {
  if (!token) throw new CliError("Set JUSTEAT_TOKEN to a Just Eat bearer token", "AUTH_REQUIRED");
  const parts = token.split(".");
  if (parts.length !== 3) throw new CliError("JUSTEAT_TOKEN is not a JWT", "INVALID_TOKEN");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      authenticated: true,
      subject: payload.sub,
      tenant: payload.tenant,
      role: payload.role,
      expiresAt: payload.exp ? new Date(payload.exp * 1_000).toISOString() : null,
      expired: payload.exp ? payload.exp * 1_000 <= Date.now() : null,
    };
  } catch {
    throw new CliError("JUSTEAT_TOKEN has an invalid payload", "INVALID_TOKEN");
  }
}

export async function accountGet(resource, token, fetchImpl = fetch) {
  decodeToken(token);
  const paths = {
    me: "/applications/international/consumer/me",
    addresses: "/applications/international/consumer/me/address",
  };
  if (!paths[resource]) throw new CliError("Account resource must be me or addresses");
  return requestJson(`${API_BASE}${paths[resource]}`, {
    headers: { authorization: `Bearer ${token}`, "accept-tenant": "es" },
  }, fetchImpl);
}

export function normalizeSavedAddresses(payload) {
  const addresses = Array.isArray(payload)
    ? payload
    : payload?.addresses ?? payload?.Addresses ?? payload?.data ?? payload?.Data ?? [];
  return addresses.map((entry, index) => {
    const geolocation = entry.Geolocation ?? entry.GeoLocation ?? entry.geolocation ?? entry.geoLocation ?? {};
    const additional = entry.AdditionalInformation ?? entry.additionalInformation ?? {};
    return {
      index,
      id: entry.AddressId ?? entry.addressId ?? entry.Id ?? entry.id ?? null,
      name: entry.AddressName ?? entry.addressName ?? entry.Name ?? entry.name ?? null,
      city: entry.City ?? entry.city ?? null,
      postcode: entry.ZipCode ?? entry.PostCode ?? entry.zipCode ?? entry.postcode ?? null,
      lines: [
        entry.Line1 ?? entry.line1,
        entry.Line2 ?? entry.line2,
        entry.Line3 ?? entry.line3,
        entry.Line4 ?? entry.line4,
      ].filter(Boolean),
      latitude: geolocation.Latitude ?? geolocation.latitude ?? entry.Latitude ?? entry.latitude ?? null,
      longitude: geolocation.Longitude ?? geolocation.longitude ?? entry.Longitude ?? entry.longitude ?? null,
      additionalInformation: additional,
    };
  });
}

export function hasUsableCoordinates(value) {
  const latitude = value?.latitude;
  const longitude = value?.longitude;
  return latitude !== null && latitude !== undefined && latitude !== ""
    && longitude !== null && longitude !== undefined && longitude !== ""
    && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));
}

export async function resolveSavedLocation(token, index = 0, fetchImpl = fetch) {
  const payload = await accountGet("addresses", token, fetchImpl);
  const addresses = normalizeSavedAddresses(payload);
  const address = addresses[index];
  if (!address) throw new CliError(`Saved address ${index} does not exist`, "ADDRESS_NOT_FOUND", {
    available: addresses.length,
  });
  if (hasUsableCoordinates(address)) {
    return {
      source: "saved-address",
      addressIndex: index,
      matched: address.lines.join(", ") || address.name,
      latitude: Number(address.latitude),
      longitude: Number(address.longitude),
      postcode: address.postcode,
      city: address.city,
    };
  }
  const queries = [...new Set([
    [...address.lines, address.postcode, address.city].filter(Boolean).join(", "),
    [address.lines[0], address.postcode, address.city].filter(Boolean).join(", "),
  ].filter(Boolean))];
  if (!queries.length) throw new CliError("The saved address has no usable location", "INVALID_LOCATION");
  let lastError;
  for (const [queryIndex, query] of queries.entries()) {
    try {
      return { ...await resolveLocation(query, fetchImpl), source: "saved-address", addressIndex: index };
    } catch (error) {
      lastError = error;
      const retryableSavedAddressShape = error.code === "LOCATION_NOT_FOUND" || error.details?.status === 404;
      if (!retryableSavedAddressShape || queryIndex === queries.length - 1) throw error;
    }
  }
  throw lastError;
}
