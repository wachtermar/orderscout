import { CliError, discoverRestaurants, fetchMenu, normalizeMenu } from "./lib.js";

const HEALTHY_TERMS = [
  "ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable",
  "pollo", "chicken", "pavo", "turkey", "salmón", "salmon", "atún", "tuna", "quinoa",
  "integral", "healthy", "saludable", "sana", "vegan", "vegano", "vegetariano",
];
const INDULGENT_TERMS = [
  "frito", "fried", "burger", "hamburgues", "pizza", "donut", "tarta", "cake", "helado",
  "chocolate", "bacon", "patatas", "fries", "kebab", "mayonesa", "mayonnaise",
];
const DIETARY = {
  vegan: ["vegan", "vegano", "vegana"],
  vegetarian: ["vegetarian", "vegetariano", "vegetariana"],
  halal: ["halal"],
  glutenFree: ["gluten free", "sin gluten"],
  lactoseFree: ["lactose free", "sin lactosa"],
};

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function parseIntent(text) {
  const normalized = normalizedText(text).replace(/,/g, ".");
  const volumeMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:l|litro|litros|litre|litres)\b/);
  const budgetMatch = normalized.match(/(?:under|below|less than|max(?:imum)?|hasta|menos de|por debajo de)\s*(?:€|eur)?\s*(\d+(?:\.\d+)?)/)
    ?? normalized.match(/(?:€|eur)\s*(\d+(?:\.\d+)?)\s*(?:max)?/);
  const water = /\b(?:agua|water)\b/.test(normalized);
  const meal = /\b(?:food|meal|dinner|lunch|breakfast|restaurant|pizza|burger|kebab|sushi|tacos?|comida|cena|almuerzo|desayuno|restaurante|hamburguesa|saludable|healthy|tasty|vegetarian|vegetariano|vegan|vegano|halal)\b/.test(normalized);
  return {
    text: String(text).trim(),
    normalized,
    kind: water ? "water" : meal ? "meal" : "product",
    targetLiters: water ? Number(volumeMatch?.[1] ?? 1.5) : null,
    healthy: /\b(?:healthy|healthier|saludable|sano|sana|light|ligero)\b/.test(normalized),
    tasty: /\b(?:tasty|delicious|rico|rica|sabroso|sabrosa|best rated|mejor valorado)\b/.test(normalized),
    cheap: /\b(?:cheap|cheapest|budget|barato|barata|economico|economica|best deal|mejor oferta)\b/.test(normalized),
    budget: budgetMatch ? Number(budgetMatch[1]) : null,
    sparkling: /\b(?:sparkling|con gas|gaseosa)\b/.test(normalized),
    deliveryTime: /\b(?:tomorrow|manana|later|despues|preorder|programar)\b/.test(normalized) ? "scheduled" : "now",
    allergyMentioned: /\b(?:allergy|allergic|allergen|alergia|alergico|alergica|anaphyl)/.test(normalized),
    dietary: Object.fromEntries(Object.entries(DIETARY).map(([key, terms]) =>
      [key, terms.some((term) => normalized.includes(term))])),
  };
}

export function parsePackVolume(value) {
  const text = normalizedText(value).replace(/,/g, ".");
  const packMatch = text.match(/\b(\d+)\s*(?:x|botellas?|unidades?|uds?\.?)(?:\s+de)?\b/)
    ?? text.match(/(?:px|pack(?:\s+de)?)\s*(\d+)\b/);
  const volumeMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ml|cl|l|litros?|litres?)\b/g)];
  if (!volumeMatches.length) return null;
  const [amountText, unit] = volumeMatches.at(-1).slice(1);
  const amount = Number(amountText);
  const unitLiters = unit === "ml" ? amount / 1_000 : unit === "cl" ? amount / 100 : amount;
  const packCount = Number(packMatch?.[1] ?? 1);
  if (!(unitLiters > 0) || !(packCount > 0)) return null;
  return { unitLiters, packCount, totalLiters: unitLiters * packCount };
}

function tasteScore(restaurant) {
  const rating = Number(restaurant.rating?.starRating ?? 0);
  const count = Number(restaurant.rating?.count ?? 0);
  return Math.round((rating * 16 + Math.min(Math.log10(count + 1) * 5, 15)) * 10) / 10;
}

function healthScore(text) {
  const normalized = normalizedText(text);
  const positive = HEALTHY_TERMS.filter((term) => normalized.includes(normalizedText(term)));
  const negative = INDULGENT_TERMS.filter((term) => normalized.includes(normalizedText(term)));
  return { score: positive.length * 12 - negative.length * 9, positive, negative };
}

function matchesDietary(text, dietary) {
  const normalized = normalizedText(text);
  return Object.entries(dietary).every(([key, required]) => {
    if (!required) return true;
    return DIETARY[key].some((term) => normalized.includes(normalizedText(term)));
  });
}

function modifierConfiguration(menuData, variation) {
  const groupById = new Map((menuData.details.ModifierGroups ?? []).map((group) => [group.Id, group]));
  const setById = new Map((menuData.details.ModifierSets ?? []).map((set) => [set.Id, set.Modifier]));
  return (variation.modifierGroupIds ?? []).map((id) => {
    const group = groupById.get(id);
    return {
      id,
      name: group?.Name ?? null,
      minChoices: group?.MinChoices ?? 0,
      maxChoices: group?.MaxChoices ?? 0,
      choices: (group?.Modifiers ?? []).map((setId) => {
        const modifier = setById.get(setId);
        return {
          setId,
          id: modifier?.Id ?? setId,
          name: modifier?.Name ?? null,
          price: modifier?.AdditionPrice ?? 0,
          defaultChoices: modifier?.DefaultChoices ?? 0,
        };
      }),
    };
  });
}

function baseCandidate(restaurant, menuData, menu, category, item, variation) {
  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.uniqueName,
      rating: restaurant.rating?.starRating ?? null,
      ratingCount: restaurant.rating?.count ?? 0,
      etaMinutes: restaurant.deliveryEtaMinutes ?? null,
      distanceMeters: restaurant.driveDistanceMeters ?? null,
      open: restaurant.isOpenNowForDelivery,
      preorder: restaurant.isOpenNowForPreorder,
    },
    menuGroupId: menuData.manifest.Menus?.find((entry) =>
      entry.ServiceTypes?.some((type) => normalizedText(type) === "delivery"))?.MenuGroupId
      ?? menuData.manifest.Menus?.[0]?.MenuGroupId,
    item: {
      id: item.id,
      variationId: variation.id,
      name: item.name,
      description: item.description,
      category: category.name,
      unitPrice: variation.price,
      currency: menu.currency,
    },
    modifierGroups: modifierConfiguration(menuData, variation),
  };
}

function waterCandidates(restaurant, menuData, menu, intent) {
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const text = `${category.name} ${item.name} ${item.description ?? ""}`;
      const normalized = normalizedText(text);
      const isWater = /\bagua\b/.test(normalized) || normalizedText(category.name) === "aguas";
      if (!isWater || /waterm(?:e|elon)|red bull|vape|chicle|caramelo/.test(normalized)) continue;
      if (intent.sparkling && !/(con gas|sparkling|gaseosa)/.test(normalized)) continue;
      if (!intent.sparkling && /(con gas|sparkling|gaseosa)/.test(normalized)) continue;
      const volume = parsePackVolume(`${item.name} ${item.description ?? ""}`);
      if (!volume) continue;
      for (const variation of item.variations) {
        const units = Math.ceil(intent.targetLiters / volume.totalLiters);
        const suppliedLiters = units * volume.totalLiters;
        const itemTotal = Math.round(units * Number(variation.price) * 100) / 100;
        if (intent.budget !== null && itemTotal > intent.budget) continue;
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: units,
          package: volume,
          suppliedLiters,
          requestedLiters: intent.targetLiters,
          itemTotal,
          pricePerLiter: Math.round((itemTotal / suppliedLiters) * 100) / 100,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round((1_000 / Math.max(itemTotal, 0.01) + tasteScore(restaurant)) * 10) / 10,
            reasons: [`${suppliedLiters} litres for €${itemTotal.toFixed(2)}`],
          },
        });
      }
    }
  }
  return candidates;
}

function mealCandidates(restaurant, menuData, menu, intent) {
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const text = `${restaurant.cuisines?.map((entry) => entry.name).join(" ")} ${category.name} ${item.name} ${item.description ?? ""}`;
      if (!matchesDietary(text, intent.dietary)) continue;
      const health = healthScore(text);
      if (intent.healthy && health.score <= 0) continue;
      for (const variation of item.variations) {
        const price = Number(variation.price);
        if (!Number.isFinite(price) || (intent.budget !== null && price > intent.budget)) continue;
        const taste = tasteScore(restaurant);
        const value = Math.max(0, 25 - price);
        const score = health.score + taste + (intent.cheap ? value * 2 : value * 0.4);
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: 1,
          itemTotal: price,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round(score * 10) / 10,
            healthScore: health.score,
            tasteScore: taste,
            reasons: [
              ...(health.positive.length ? [`healthy signals: ${health.positive.slice(0, 4).join(", ")}`] : []),
              ...(health.negative.length ? [`indulgent signals: ${health.negative.slice(0, 3).join(", ")}`] : []),
              restaurant.rating?.starRating ? `restaurant rating ${restaurant.rating.starRating}/5` : "restaurant is unrated",
              `item price €${price.toFixed(2)} before delivery and service fees`,
            ],
          },
        });
      }
    }
  }
  return candidates;
}

function productCandidates(restaurant, menuData, menu, intent) {
  const ignored = new Set([
    "find", "get", "buy", "order", "deliver", "delivery", "cheap", "cheapest", "fast", "fastest", "best", "rated",
    "buscar", "comprar", "pedir", "entregar", "entrega", "barato", "barata", "mejor", "rapido", "rapida",
    "under", "below", "hasta", "menos", "para", "with", "con", "from", "the", "and", "que", "mis", "apps",
    "just", "eat", "glovo", "uber", "eats", "eur", "max",
  ]);
  const terms = intent.normalized.split(/[^a-z0-9áéíóúüñ]+/).filter((term) => term.length > 2 && !ignored.has(term) && !/^\d/.test(term));
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const text = normalizedText(`${category.name} ${item.name} ${item.description ?? ""}`);
      const matched = terms.filter((term) => text.includes(term));
      if (terms.length && !matched.length) continue;
      for (const variation of item.variations) {
        const price = Number(variation.price);
        if (!Number.isFinite(price) || (intent.budget !== null && price > intent.budget)) continue;
        const merchantScore = tasteScore(restaurant);
        const valueScore = Math.max(0, 25 - price);
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: 1,
          itemTotal: price,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round((merchantScore + valueScore) * 10) / 10,
            tasteScore: merchantScore,
            reasons: [
              ...(matched.length ? [`matched: ${matched.slice(0, 4).join(", ")}`] : []),
              restaurant.rating?.starRating ? `merchant rating ${restaurant.rating.starRating}/5` : "merchant is unrated",
              `item price €${price.toFixed(2)} before delivery and service fees`,
            ],
          },
        });
      }
    }
  }
  return candidates;
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        result[index] = await mapper(values[index], index);
      } catch (error) {
        result[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

export async function recommend(location, text, options = {}) {
  const intent = parseIntent(text);
  const resultLimit = Number(options.limit ?? 10);
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > 100) {
    throw new CliError("--limit must be an integer between 1 and 100");
  }
  const vertical = options.vertical ?? (intent.kind === "meal" ? "restaurants" : "all");
  const discovery = await discoverRestaurants(location, {
    serviceType: "delivery",
    vertical,
    token: options.token,
  }, options.fetchImpl);
  const storeLimit = Number(options.stores ?? (intent.kind === "meal" ? 12 : 20));
  if (!Number.isInteger(storeLimit) || storeLimit < 1 || storeLimit > 50) {
    throw new CliError("--stores must be an integer between 1 and 50");
  }
  const eligibleRestaurants = (discovery.restaurants ?? []).filter((restaurant) =>
    restaurant.isDelivery && !restaurant.isTemporarilyOffline);
  const openRestaurants = eligibleRestaurants.filter((restaurant) => restaurant.isOpenNowForDelivery);
  const shouldRequireOpen = options.open || (intent.deliveryTime === "now" && !options.includeClosed);
  let restaurants = shouldRequireOpen && openRestaurants.length ? openRestaurants : eligibleRestaurants;
  restaurants = restaurants.slice(0, storeLimit);
  const scanned = await mapConcurrent(restaurants, Number(options.concurrency ?? 4), async (restaurant) => {
    const menuData = await (options.fetchMenuImpl ?? fetchMenu)(restaurant.uniqueName, options.fetchImpl);
    const menu = normalizeMenu(menuData);
    return {
      restaurant,
      candidates: intent.kind === "water"
        ? waterCandidates(restaurant, menuData, menu, intent)
        : intent.kind === "meal"
          ? mealCandidates(restaurant, menuData, menu, intent)
          : productCandidates(restaurant, menuData, menu, intent),
    };
  });
  const uniqueCandidates = new Map();
  for (const candidate of scanned.flatMap((entry) => entry?.candidates ?? [])) {
    const key = `${candidate.restaurant.id}:${candidate.item.variationId}`;
    if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
  }
  const sortedCandidates = [...uniqueCandidates.values()].sort((left, right) => {
      if (intent.kind === "water") {
        return left.itemTotal - right.itemTotal
          || left.pricePerLiter - right.pricePerLiter
          || right.ranking.score - left.ranking.score;
      }
      return right.ranking.score - left.ranking.score || left.itemTotal - right.itemTotal;
    });
  const diverseCandidates = [];
  const includedKeys = new Set();
  const representedRestaurants = new Set();
  for (const candidate of sortedCandidates) {
    if (representedRestaurants.has(candidate.restaurant.id)) continue;
    diverseCandidates.push(candidate);
    includedKeys.add(`${candidate.restaurant.id}:${candidate.item.variationId}`);
    representedRestaurants.add(candidate.restaurant.id);
  }
  for (const candidate of sortedCandidates) {
    const key = `${candidate.restaurant.id}:${candidate.item.variationId}`;
    if (!includedKeys.has(key)) diverseCandidates.push(candidate);
  }
  const candidates = diverseCandidates.slice(0, resultLimit)
    .map((candidate, index) => ({ ...candidate, index }));
  return {
    intent,
    location: {
      matched: location.matched,
      latitude: location.latitude,
      longitude: location.longitude,
      postcode: location.postcode ?? discovery.metaData?.postalCode,
      city: location.city ?? discovery.metaData?.area,
    },
    scope: {
      vertical,
      discoveredStores: discovery.restaurants?.length ?? 0,
      scannedStores: restaurants.length,
      failedMenus: scanned.filter((entry) => entry?.error).length,
      availability: shouldRequireOpen && openRestaurants.length
        ? "open for delivery now"
        : "includes preorder or currently closed stores",
    },
    feeAccuracy: "Item totals exclude delivery, service, bag and small-order fees until `justeat order quote`.",
    allergenSafety: intent.allergyMentioned
      ? "Menu text is not sufficient for allergy safety. Verify directly with the restaurant before using --allergen-reviewed."
      : null,
    candidates,
  };
}
