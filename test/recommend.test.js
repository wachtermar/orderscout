import assert from "node:assert/strict";
import test from "node:test";
import {
  isHealthyBreakfastItem, isPreparedBreakfastItem, parseIntent, parsePackVolume,
  productIntentSpec, productRelevance, providerSearchQueries, recommend,
} from "../src/recommend.js";

test("parsePackVolume understands Spanish packs and metric units", () => {
  assert.deepEqual(parsePackVolume("Pack 6 unidades de 1,5L"), {
    unitLiters: 1.5,
    packCount: 6,
    totalLiters: 9,
  });
  assert.deepEqual(parsePackVolume("AGUA PX6 FONTVELLA 50CL"), {
    unitLiters: 0.5,
    packCount: 6,
    totalLiters: 3,
  });
  assert.deepEqual(parsePackVolume("Agua 6 x 1.5 L"), {
    unitLiters: 1.5,
    packCount: 6,
    totalLiters: 9,
  });
  assert.equal(parsePackVolume("Ensalada de pollo"), null);
});

test("parseIntent extracts quantity, budget, health, taste, and dietary needs", () => {
  assert.deepEqual(parseIntent("cheap 6 litres of water under €10"), {
    text: "cheap 6 litres of water under €10",
    normalized: "cheap 6 litres of water under €10",
    kind: "water",
    targetLiters: 6,
    people: null,
    healthy: false,
    tasty: false,
    cheap: true,
    budget: 10,
    sparkling: false,
    occasion: null,
    deliveryTime: "now",
    scheduledAt: null,
    timeZone: "Europe/Madrid",
    allergyMentioned: false,
    dietary: {
      vegan: false,
      vegetarian: false,
      halal: false,
      glutenFree: false,
      lactoseFree: false,
    },
  });
  const meal = parseIntent("healthy tasty vegan food under 18 EUR");
  assert.equal(meal.kind, "meal");
  assert.equal(meal.healthy, true);
  assert.equal(meal.tasty, true);
  assert.equal(meal.dietary.vegan, true);
  assert.equal(meal.budget, 18);
  assert.equal(parseIntent("healthy tasty food for two under €30").people, 2);
  assert.deepEqual(providerSearchQueries("healthy tasty food for two under €30"), ["poke", "ensalada", "pollo a la plancha"]);
  const breakfast = parseIntent("best-rated healthy breakfast for 2 tomorrow at 10am under €30", {
    now: new Date("2026-07-20T00:00:00.000Z"),
  });
  assert.equal(breakfast.occasion, "breakfast");
  assert.equal(breakfast.tasty, true);
  assert.equal(breakfast.deliveryTime, "scheduled");
  assert.equal(breakfast.scheduledAt, "2026-07-21T08:00:00.000Z");
  assert.deepEqual(providerSearchQueries(breakfast), ["desayuno saludable", "açaí", "tostada aguacate", "huevos"]);
  assert.deepEqual(providerSearchQueries("20 litres of water now"), ["agua"]);
  assert.deepEqual(providerSearchQueries("Which pharmacy can deliver SPF 50 sunscreen fastest tonight?"), [
    "spf sunscreen", "protector solar spf", "sunscreen spf", "protector solar", "sunscreen",
  ]);
});

test("product search separates the requested product from preferences and generates bounded provider queries", () => {
  const request = "I need some vape liquid, preferably something with ice";
  const spec = productIntentSpec(request);
  assert.equal(spec.concept.id, "vape");
  assert.deepEqual(spec.coreTerms, []);
  assert.deepEqual(spec.preferenceConcepts.map((entry) => entry.id), ["ice"]);
  assert.deepEqual(providerSearchQueries(request), [
    "vape liquid ice", "vape ice", "vape hielo", "vape liquid", "vape", "vaper",
  ]);
});

test("product relevance requires a whole product anchor and treats preferences as ranking signals", () => {
  const request = "I need some vape liquid, preferably something with ice";
  for (const name of ["Plain rice", "Lipton Ice Tea", "Leche liquida entera", "Vanilla ice cream"]) {
    assert.equal(productRelevance(request, { item: { name } }).relevant, false, name);
  }
  const icy = productRelevance(request, { item: { name: "Vape Lost Mary Peach Ice (1000)" } });
  const mango = productRelevance(request, { item: { name: "Vape Lost Mary Triple Mango (1000)" } });
  assert.equal(icy.relevant, true);
  assert.equal(icy.preference, 100);
  assert.equal(mango.relevant, true);
  assert.equal(mango.preference, 0);
  assert.equal(productRelevance(request, {
    item: { name: "AROMA KING MINI - 700 SANDÍA HELADA", category: "VAPES DESECHABLES" },
  }).preference, 100);
});

test("product relevance generalizes to exact product qualifiers", () => {
  const request = "find AA batteries under €12";
  assert.deepEqual(providerSearchQueries(request), ["aa batteries", "pilas aa", "baterias aa", "pilas", "baterias"]);
  assert.equal(productRelevance(request, { item: { name: "Pilas AA 8 pack" } }).relevant, true);
  assert.equal(productRelevance(request, { item: { name: "Pilas AAA 8 pack" } }).relevant, false);
  assert.equal(productRelevance("phone charger with USB-C", { item: { name: "Cargador para teléfono USB-C" } }).preference, 100);
  assert.equal(productRelevance("shampoo for curly hair", { item: { name: "Curly hair shampoo" } }).relevant, true);
  assert.equal(productRelevance("shampoo for curly hair", { item: { name: "Plain rice" } }).relevant, false);
  assert.equal(productIntentSpec("phone case preferably with a battery").concept, null);
});

test("prepared breakfast classification rejects raw groceries, pasta, and non-food egg matches", () => {
  assert.equal(isPreparedBreakfastItem("Tostada integral de aguacate y huevo"), true);
  assert.equal(isPreparedBreakfastItem("Açaí bowl con fruta y granola"), true);
  assert.equal(isPreparedBreakfastItem("Huevos revueltos con espinacas"), true);
  assert.equal(isPreparedBreakfastItem("Huevos revueltos con gambas", "Jardín Chino"), false);
  assert.equal(isPreparedBreakfastItem("Pack 12 huevos frescos de gallina"), false);
  assert.equal(isPreparedBreakfastItem("Tagliatelle pasta al huevo"), false);
  assert.equal(isPreparedBreakfastItem("Juego Playmobil búsqueda del huevo"), false);
  assert.equal(isPreparedBreakfastItem("Natural Bowl de pollo y arroz"), false);
  assert.equal(isPreparedBreakfastItem("Pulpa de açaí natural pack 400 g"), false);
  assert.equal(isPreparedBreakfastItem("Rogan Josh Vegetables", "cooked with homemade yoghurt"), false);
  assert.equal(isHealthyBreakfastItem("Tostada de mantequilla y mermelada"), false);
  assert.equal(isHealthyBreakfastItem("Huevos revueltos con panceta"), false);
  assert.equal(isHealthyBreakfastItem("Tostada integral con aguacate y semillas"), true);
});

test("parseIntent routes arbitrary platform products beyond restaurants", () => {
  assert.equal(parseIntent("find AA batteries under €12").kind, "product");
  assert.equal(parseIntent("healthy dinner").kind, "meal");
});

function menuData(items, name = "Test Store") {
  return {
    slug: "test-store",
    manifest: {
      RestaurantId: "1",
      MenuVersion: "v1",
      RestaurantInfo: { Name: name },
      Menus: [{ MenuGroupId: "menu-group", ServiceTypes: ["delivery"], Categories: [{
        Id: "category",
        Name: "Aguas y comida",
        ItemIds: items.map((item) => item.Id),
      }] }],
    },
    items: { Items: items },
    details: { ModifierGroups: [], ModifierSets: [], DealGroups: [] },
  };
}

function restaurant(overrides = {}) {
  return {
    id: "1",
    name: "Test Store",
    uniqueName: "test-store",
    isDelivery: true,
    isOpenNowForDelivery: true,
    isOpenNowForPreorder: false,
    isTemporarilyOffline: false,
    cuisines: [{ name: "Sana" }],
    rating: { starRating: 4.6, count: 100 },
    ...overrides,
  };
}

test("recommend ranks real quantities and excludes unavailable stores", async () => {
  const discovery = {
    restaurants: [restaurant(), restaurant({ id: "2", uniqueName: "closed", isOpenNowForDelivery: false })],
    metaData: { postalCode: "29603", area: "Marbella" },
  };
  const fetchImpl = async () => Response.json(discovery);
  const result = await recommend(
    { latitude: 36.5, longitude: -4.8, postcode: "29603", matched: "Marbella" },
    "cheap 6 litres of water",
    {
      fetchImpl,
      fetchMenuImpl: async () => menuData([
        { Id: "pack", Name: "AGUA PX6 1,5L", Variations: [{ Id: "pack", BasePrice: 4.45 }] },
        { Id: "bottle", Name: "AGUA 1,5L", Variations: [{ Id: "bottle", BasePrice: 1.8 }] },
        { Id: "vape", Name: "LOST MARY WATERME", Variations: [{ Id: "vape", BasePrice: 1 }] },
      ]),
    },
  );
  assert.equal(result.scope.scannedStores, 1);
  assert.equal(result.candidates[0].item.id, "pack");
  assert.equal(result.candidates[0].quantity, 1);
  assert.equal(result.candidates[0].suppliedLiters, 9);
  assert.equal(result.candidates.some((candidate) => candidate.item.id === "vape"), false);
});

test("recommend explains health and taste heuristics", async () => {
  const fetchImpl = async () => Response.json({ restaurants: [restaurant({ deals: [{ description: "20% off orders over €20" }] })], metaData: {} });
  const result = await recommend(
    { latitude: 36.5, longitude: -4.8, postcode: "29603" },
    "healthy tasty food under 15 EUR",
    {
      fetchImpl,
      fetchMenuImpl: async () => menuData([
        { Id: "healthy", Name: "Pollo con verduras a la plancha", Variations: [{ Id: "healthy", BasePrice: 12 }] },
        { Id: "cake", Name: "Chocolate cake", Variations: [{ Id: "cake", BasePrice: 8 }] },
      ]),
    },
  );
  assert.equal(result.candidates[0].item.id, "healthy");
  assert.ok(result.candidates[0].ranking.healthScore > 0);
  assert.ok(result.candidates[0].ranking.reasons.some((reason) => reason.includes("restaurant rating")));
  assert.deepEqual(result.candidates[0].restaurant.deals, ["20% off orders over €20"]);
});

test("recommend finds arbitrary non-food products across all verticals", async () => {
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = new URL(url);
    return Response.json({ restaurants: [restaurant()], metaData: {} });
  };
  const result = await recommend(
    { latitude: 36.5, longitude: -4.8, postcode: "29603" },
    "find AA batteries under €12",
    {
      fetchImpl,
      fetchMenuImpl: async () => menuData([
        { Id: "batteries", Name: "AA Batteries 8 pack", Variations: [{ Id: "batteries", BasePrice: 7.5 }] },
        { Id: "snack", Name: "Chocolate bar", Variations: [{ Id: "snack", BasePrice: 2 }] },
      ]),
    },
  );
  assert.equal(requestedUrl.searchParams.get("vertical"), "all");
  assert.deepEqual(result.candidates.map((candidate) => candidate.item.id), ["batteries"]);
});

test("product discovery prioritizes a directly matching merchant even when it is closed and beyond the scan limit", async () => {
  const ordinary = Array.from({ length: 35 }, (_, index) => restaurant({
    id: `ordinary-${index}`,
    name: `Restaurant ${index}`,
    uniqueName: `restaurant-${index}`,
  }));
  const vapeStore = restaurant({
    id: "croco", name: "Croco Vapes", uniqueName: "croco-vapes",
    isOpenNowForDelivery: false, cuisines: [{ name: "Tiendas" }, { name: "Otros tipos" }],
  });
  const fetchImpl = async () => Response.json({ restaurants: [...ordinary, vapeStore], metaData: {} });
  const result = await recommend(
    { latitude: 36.5, longitude: -4.8, postcode: "29603" },
    "vape liquid preferably ice",
    {
      fetchImpl,
      fetchMenuImpl: async (slug) => slug === "croco-vapes" ? {
        ...menuData([{ Id: "icy", Name: "AROMA KING MINI - 700 SANDÍA HELADA", Variations: [{ Id: "icy", BasePrice: 6.5 }] }], "Croco Vapes"),
        manifest: {
          ...menuData([], "Croco Vapes").manifest,
          Menus: [{ MenuGroupId: "menu-group", ServiceTypes: ["delivery"], Categories: [{
            Id: "category", Name: "VAPES DESECHABLES", ItemIds: ["icy"],
          }] }],
        },
      } : menuData([{ Id: "rice", Name: "Plain rice", Variations: [{ Id: "rice", BasePrice: 3 }] }]),
    },
  );
  assert.equal(result.scope.scannedStores, 30);
  assert.equal(result.scope.availability, "includes preorder or currently closed stores");
  assert.deepEqual(result.candidates.map((candidate) => candidate.item.id), ["icy"]);
  assert.equal(result.candidates[0].restaurant.open, false);
  assert.equal(result.candidates[0].ranking.preferenceScore, 100);
});
