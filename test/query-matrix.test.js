import assert from "node:assert/strict";
import test from "node:test";

import { ORDERSCOUT_MCP_TOOLS } from "../src/orderscout-mcp.js";
import { normalizeOffer, parseObjective, rankOffers } from "../src/ranking.js";
import { parseIntent, providerSearchQueries } from "../src/recommend.js";
import {
  buildLlmSelection, candidatePageForSearch, resultsFor, semanticInputsForSearch,
} from "../src/searches.js";

const PROVIDERS = ["justeat", "glovo", "ubereats"];

function rawCandidate(index = 0) {
  return {
    merchant: { id: `merchant-${index}`, name: `Merchant ${index}` },
    item: { id: `item-${index}`, name: `Item ${index}`, unitPrice: 2 + index },
  };
}

function candidate(provider, index, options = {}) {
  const merchantId = options.merchantId ?? `${provider}-merchant`;
  return normalizeOffer(provider, {
    merchant: {
      id: merchantId,
      name: options.merchantName ?? `${provider} Market`,
      rating: options.rating ?? 4.5,
      ratingCount: options.ratingCount ?? 250,
    },
    item: {
      id: options.itemId ?? `${provider}-item-${index}`,
      name: options.itemName ?? `Product ${index}`,
      description: options.description ?? `Catalog product number ${index}`,
      category: options.category ?? "Catalog",
      unitPrice: options.unitPrice ?? index + 1,
    },
    etaMinutes: options.etaMinutes ?? 25,
    available: options.available ?? true,
    pricing: {
      originalSubtotal: options.originalSubtotal,
      itemSavings: options.itemSavings,
      fees: options.fees ?? { delivery: 1.5, service: 0.75 },
      total: options.total,
      exact: options.exact ?? false,
      discount: options.discount,
    },
    promotion: options.promotion,
    membership: options.membership,
    membershipEligible: options.membershipEligible,
    fulfilment: options.fulfilment,
    source: {
      planId: options.planId ?? `${provider}-plan`,
      storeId: merchantId,
      eligibility: options.eligibility,
      matchedCatalogQueries: options.matchedCatalogQueries,
    },
  });
}

function llmSearch(offers, overrides = {}) {
  return {
    id: "1234567890abcdef12345678",
    version: 2,
    intent: overrides.intent ?? "Find the best option",
    parsedIntent: parseIntent(overrides.intent ?? "Find the best option"),
    fulfilment: overrides.fulfilment ?? { mode: "now", requestedAt: null, timeZone: "Europe/Madrid" },
    objective: overrides.objective ?? "value",
    queryPlan: { source: "llm", discoveryQueries: [], catalogQueries: [] },
    semanticMode: "llm",
    shoppingItems: overrides.shoppingItems ?? [],
    providers: overrides.providers ?? PROVIDERS,
    providerStatus: overrides.providerStatus ?? Object.fromEntries(PROVIDERS.map((provider) => [provider, {
      state: "complete", error: null, offerCount: offers.filter((offer) => offer.provider === provider).length,
    }])),
    orchestration: "concurrent",
    offers,
    selections: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

const FOOD_TERMS = [
  "food", "dinner", "lunch", "breakfast", "brunch", "pizza", "burger", "kebab", "sushi", "tacos",
  "burritos", "ramen", "curry", "pasta", "paella", "risotto", "noodles", "sandwiches", "wraps", "salad",
  "poke", "grain bowl", "soup", "steak", "grilled chicken", "Thai food", "Chinese food", "Indian food",
  "Italian food", "Mexican food", "Mediterranean food", "Japanese food", "Vietnamese food", "Korean food",
  "Greek food", "comida", "cena", "almuerzo", "desayuno", "merienda", "hamburguesa", "ensalada",
  "bocadillo", "pollo a la plancha", "paella de marisco", "comida tailandesa", "comida china", "comida india",
  "shawarma", "falafel", "tandoori", "sopa", "postre", "helado", "tarta", "comida japonesa", "comida coreana",
];

const PARTY_CASES = [
  [1, "for 1 person"], [2, "for two people"], [3, "for three"], [4, "for 4 guests"],
  [5, "for five diners"], [6, "for six"], [7, "for 7 people"], [8, "for eight people"],
  [10, "for ten"], [12, "for twelve people"], [15, "for fifteen"], [20, "for twenty guests"],
  [1, "para una persona"], [2, "para dos"], [3, "para tres personas"], [4, "para cuatro comensales"],
  [5, "para cinco"], [6, "para seis personas"], [8, "para ocho"], [10, "para diez invitados"],
  [12, "para doce personas"], [20, "para veinte comensales"], [4, "for 2 adults and 2 kids"],
  [5, "para 2 adultos y 3 niños"], [2, "for my wife and me"], [2, "para mi pareja y mi"],
  [5, "for a family of 5"], [6, "para una familia de 6"],
];

test(`agent mode preserves candidates for ${FOOD_TERMS.length * PARTY_CASES.length} food and party-size queries`, () => {
  const candidates = [rawCandidate(1), rawCandidate(2)];
  let count = 0;
  for (const food of FOOD_TERMS) {
    for (const [people, phrase] of PARTY_CASES) {
      const query = `${food} ${phrase} under €120`;
      const intent = parseIntent(query);
      assert.equal(intent.kind, "meal", query);
      assert.equal(intent.people, people, query);
      assert.equal(intent.budget, 120, query);
      assert.strictEqual(semanticInputsForSearch({ semanticMode: "llm", intent: query }, candidates), candidates, query);
      count += 1;
    }
  }
  assert.equal(count, FOOD_TERMS.length * PARTY_CASES.length);
});

const PRODUCT_TERMS = [
  "ibuprofen", "paracetamol", "aspirin", "bandages", "plasters", "thermometer", "sunscreen SPF 50",
  "toothpaste", "mouthwash", "shampoo", "conditioner", "deodorant", "tampons", "baby formula", "diapers size 4",
  "milk", "oat milk", "eggs", "bread", "bananas", "avocados", "tomatoes", "rice", "pasta sauce", "olive oil",
  "coffee", "tea", "orange juice", "cola zero", "beer", "red wine", "ice cubes", "dog food", "cat litter",
  "laundry detergent", "dishwasher tablets", "toilet paper", "kitchen roll", "bin bags", "batteries AA",
  "USB-C charger", "phone cable", "flowers", "birthday candles", "notebook", "pen", "vape liquid",
  "Lost Mary Tappo pods", "protector solar", "pasta dental", "pañales talla 4", "leche", "huevos", "pan",
  "plátanos", "aceite de oliva", "pienso para perro", "detergente", "papel higiénico", "pilas AA", "cargador USB-C",
];

const PRODUCT_TEMPLATES = [
  (item) => `Find ${item} near me`,
  (item) => `Cheapest ${item} under €25`,
  (item) => `I need ${item} delivered now`,
  (item) => `Necesito ${item} por menos de 25€`,
];

test(`agent mode preserves candidates for ${PRODUCT_TERMS.length * PRODUCT_TEMPLATES.length} shop, grocery, pharmacy, household, and restricted-item queries`, () => {
  const candidates = [rawCandidate(1), rawCandidate(2), rawCandidate(3)];
  let count = 0;
  for (const product of PRODUCT_TERMS) {
    for (const template of PRODUCT_TEMPLATES) {
      const query = template(product);
      const intent = parseIntent(query);
      assert.equal(intent.kind, "product", query);
      assert.strictEqual(semanticInputsForSearch({ semanticMode: "llm", intent: query }, candidates), candidates, query);
      if (/under|menos de/.test(query)) assert.equal(intent.budget, 25, query);
      count += 1;
    }
  }
  assert.equal(count, PRODUCT_TERMS.length * PRODUCT_TEMPLATES.length);
});

test("budget language matrix parses delivered-total constraints", () => {
  const cases = [
    ["dinner under €30", 30], ["dinner under 30€", 30], ["meal below EUR 25", 25],
    ["food less than 22 euros", 22], ["lunch no more than €19.50", 19.5], ["dinner not over 40€", 40],
    ["breakfast up to €18", 18], ["meal maximum 35 euros", 35], ["food max €27", 27],
    ["dinner budget of €42", 42], ["lunch €28 max", 28], ["breakfast 20€ budget", 20],
    ["dinner €24 or less", 24], ["cena hasta 30€", 30], ["comida menos de €25", 25],
    ["almuerzo por debajo de 21 euros", 21], ["cena no más de €36", 36], ["comida máximo 29€", 29],
    ["cena presupuesto de €45", 45], ["almuerzo 26€ de presupuesto", 26], ["cena 23€ o menos", 23],
    ["dinner for €31", 31], ["cena por 32 euros", 32],
  ];
  for (const [query, expected] of cases) assert.equal(parseIntent(query).budget, expected, query);
});

test("water and drink quantity matrix handles aggregate bottle quantities", () => {
  const cases = [
    ["20L of still water", 20, false], ["at least 6 litres of water", 6, false],
    ["6 x 1.5L water", 9, false], ["6 bottles of 1.5 litres water", 9, false],
    ["6 botellas de 1,5 litros de agua", 9, false], ["12 units of 500ml water", 6, false],
    ["8 botellas de 50cl de agua", 4, false], ["10L sparkling water", 10, true],
    ["agua con gas 3 litros", 3, true], ["some mineral water", 1.5, false],
  ];
  for (const [query, liters, sparkling] of cases) {
    const intent = parseIntent(query);
    assert.equal(intent.kind, "water", query);
    assert.equal(intent.targetLiters, liters, query);
    assert.equal(intent.sparkling, sparkling, query);
  }
});

test("objective language matrix distinguishes cheapest, fastest, best, and value", () => {
  const groups = {
    cheapest: ["cheapest", "lowest price", "lowest total", "least expensive", "más barato", "menor precio", "menos gastos"],
    fastest: ["fastest", "quickest", "soonest", "ASAP", "rápido", "lo antes posible", "menos tiempo"],
    best: ["best-rated", "highest rated", "top-rated", "best reviews", "most popular", "mejor valorado", "mejores reseñas", "best quality", "tasty", "sabroso"],
    value: ["best value overall", "balance price rating and ETA", "compare everything", "good deal and quality"],
  };
  for (const [objective, phrases] of Object.entries(groups)) {
    for (const phrase of phrases) assert.equal(parseObjective(`Find dinner: ${phrase}`), objective, phrase);
  }
});

test("dietary matrix preserves common constraints for agent reasoning", () => {
  const cases = {
    vegan: ["vegan", "vegano"], vegetarian: ["vegetarian", "vegetariano"],
    pescatarian: ["pescatarian", "pescetariano"], halal: ["halal"], kosher: ["kosher"],
    glutenFree: ["gluten free", "sin gluten"], lactoseFree: ["lactose free", "sin lactosa"],
    dairyFree: ["dairy free", "sin lácteos"], nutFree: ["nut free", "sin frutos secos"],
    keto: ["keto", "cetogénico"], lowCarb: ["low carb", "bajo en carbohidratos"], noPork: ["no pork", "sin cerdo"],
  };
  for (const [constraint, phrases] of Object.entries(cases)) {
    for (const phrase of phrases) {
      const intent = parseIntent(`healthy dinner for two, ${phrase}`);
      assert.equal(intent.dietary[constraint], true, phrase);
    }
  }
});

test("allergy language is carried into the provider-independent basket safety gate", () => {
  for (const query of [
    "meal for two with a peanut allergy", "I am allergic to shellfish", "severe allergen concern",
    "risk of anaphylaxis from nuts", "cena con alergia al cacahuete", "soy alérgica al marisco",
  ]) assert.equal(parseIntent(query).allergyMentioned, true, query);
});

test("scheduled-delivery matrix parses relative, weekday, ISO, named-month, and numeric dates", () => {
  const options = { now: new Date("2026-07-20T08:00:00.000Z"), timeZone: "Europe/Madrid" };
  const cases = [
    ["breakfast tomorrow at 10am", "2026-07-21T08:00:00.000Z"],
    ["desayuno mañana a las 10", "2026-07-21T08:00:00.000Z"],
    ["lunch day after tomorrow at noon", "2026-07-22T10:00:00.000Z"],
    ["comida pasado mañana al mediodía", "2026-07-22T10:00:00.000Z"],
    ["dinner Friday at 20:00", "2026-07-24T18:00:00.000Z"],
    ["cena el viernes a las 20h", "2026-07-24T18:00:00.000Z"],
    ["dinner 2026-07-25 at 8pm", "2026-07-25T18:00:00.000Z"],
    ["desayuno 25/07/2026 a las 10.30", "2026-07-25T08:30:00.000Z"],
    ["lunch 25 July 2026 at 12:45", "2026-07-25T10:45:00.000Z"],
    ["cena 25 julio 2026 a las 21", "2026-07-25T19:00:00.000Z"],
    ["breakfast 5 January at 10am", "2027-01-05T09:00:00.000Z"],
  ];
  for (const [query, iso] of cases) {
    const intent = parseIntent(query, options);
    assert.equal(intent.deliveryTime, "scheduled", query);
    assert.equal(intent.scheduledAt, iso, query);
  }
  for (const query of ["breakfast tomorrow", "desayuno mañana", "preorder dinner later", "deliver dinner later"]) {
    const intent = parseIntent(query, options);
    assert.equal(intent.deliveryTime, "scheduled", query);
    assert.equal(intent.scheduledAt, null, query);
  }
  for (const query of [
    "grocery basics and ingredients to cook a good lunch later for four people",
    "buy shakshuka ingredients to use later",
    "something I can cook for later",
    "order groceries to cook later",
  ]) {
    const intent = parseIntent(query, options);
    assert.equal(intent.deliveryTime, "now", query);
    assert.equal(intent.scheduledAt, null, query);
  }
  assert.equal(parseIntent("grocery basics and ingredients to cook lunch later for four people", options).kind, "product");
  assert.equal(parseIntent("breakfast 31 February 2027 at 10am", options).scheduledAt, null);
});

test("LLM search tools preserve 1-24 independent shopping lines instead of combining their semantics", () => {
  const begin = ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === "orderscout_search_begin");
  assert.equal(begin.inputSchema.properties.shoppingItems.maxItems, 24);
  for (let size = 1; size <= 24; size += 1) {
    const shoppingItems = Array.from({ length: size }, (_, index) => ({
      id: `line-${index + 1}`,
      intent: index % 2 ? `food requirement ${index + 1}` : `grocery requirement ${index + 1}`,
      quantity: index + 1,
      discoveryQueries: [`merchant ${index + 1}`],
      catalogQueries: [`item ${index + 1}`],
    }));
    const command = begin.command({
      intent: `A list with ${size} independent needs`,
      discoveryQueries: ["supermarket", "restaurant"],
      catalogQueries: ["grocery", "meal"],
      shoppingItems,
    });
    assert.deepEqual(command.slice(0, 6), ["search", "begin", `A list with ${size} independent needs`, "--agent", "--semantic-mode", "llm"]);
    const encoded = command[command.indexOf("--shopping-items") + 1];
    assert.deepEqual(JSON.parse(encoded), shoppingItems);
  }
});

test("provider fallback queries stay bounded and non-empty across the complete query taxonomy", () => {
  const queries = [
    ...FOOD_TERMS.map((term) => `${term} for two`),
    ...PRODUCT_TERMS.map((term) => `find ${term}`),
    "20 litres of water", "sparkling water", "healthy breakfast tomorrow", "vegan dinner under €30",
  ];
  for (const query of queries) {
    const planned = providerSearchQueries(query);
    assert.ok(planned.length >= 1 && planned.length <= 6, query);
    assert.ok(planned.every((entry) => typeof entry === "string" && entry.trim()), query);
  }
});

test("candidate paging covers large cross-provider catalogs without duplicates", () => {
  const offers = PROVIDERS.flatMap((provider, providerIndex) => Array.from({ length: 137 }, (_, index) => candidate(provider, index, {
    merchantId: `${provider}-merchant-${index % 7}`,
    merchantName: `${provider} Merchant ${index % 7}`,
    itemName: index % 11 === 0 ? `Mint Ice Special ${index}` : `Catalog Product ${providerIndex}-${index}`,
    category: index % 11 === 0 ? "Vape Liquid" : "General",
  })));
  const search = llmSearch(offers);
  const ids = [];
  let offset = 0;
  do {
    const page = candidatePageForSearch(search, { offset, limit: 37 });
    ids.push(...page.candidates.map((offer) => offer.id));
    if (!page.hasMore) break;
    assert.equal(page.nextOffset, offset + page.candidates.length);
    offset = page.nextOffset;
  } while (true);
  assert.equal(ids.length, offers.length);
  assert.equal(new Set(ids).size, offers.length);
  const glovo = candidatePageForSearch(search, { provider: "glovo", limit: 100 });
  assert.equal(glovo.total, 137);
  assert.ok(glovo.candidates.every((offer) => offer.provider === "glovo"));
  const mintIce = candidatePageForSearch(search, { query: "mint ice", limit: 100 });
  assert.equal(mintIce.total, PROVIDERS.length * 13);
  assert.ok(mintIce.candidates.every((offer) => /mint ice/i.test(offer.item.name)));
});

test("lexical candidate narrowing uses whole tokens without becoming a semantic filter", () => {
  const offers = [
    candidate("glovo", 1, { itemName: "Agua mineral natural" }),
    candidate("glovo", 2, { itemName: "Tostada de aguacate" }),
    candidate("glovo", 3, { itemName: "Menthol Ice liquid" }),
    candidate("glovo", 4, { itemName: "Jasmine rice" }),
  ];
  const search = llmSearch(offers, { providers: ["glovo"] });
  assert.deepEqual(candidatePageForSearch(search, { query: "agua" }).candidates.map((offer) => offer.item.name), ["Agua mineral natural"]);
  assert.deepEqual(candidatePageForSearch(search, { query: "ice" }).candidates.map((offer) => offer.item.name), ["Menthol Ice liquid"]);
  assert.equal(candidatePageForSearch(search, {}).total, 4);
});

test("LLM can select varied same-merchant bundles with exact quantities and deal metadata", () => {
  for (const provider of PROVIDERS) {
    const offers = Array.from({ length: 12 }, (_, index) => candidate(provider, index, {
      itemName: `Requested line ${index + 1}`,
      unitPrice: index + 1,
      originalSubtotal: index === 0 ? 2 : undefined,
      itemSavings: index === 0 ? 1 : undefined,
      promotion: index === 0 ? { types: ["BOGO"], descriptions: ["2 for 1"], eligible: true, applied: true } : undefined,
    }));
    for (let size = 1; size <= 12; size += 1) {
      const selections = offers.slice(0, size).map((offer, index) => ({
        offerId: offer.id,
        quantity: (index % 3) + 1,
        forItem: `Need ${index + 1}`,
        reason: `The model determined candidate ${index + 1} satisfies this independent need.`,
      }));
      const selection = buildLlmSelection(llmSearch(offers, { providers: [provider] }), selections);
      const expectedSubtotal = selections.reduce((sum, selected, index) => sum + offers[index].item.unitPrice * selected.quantity, 0);
      assert.equal(selection.provider, provider);
      assert.equal(selection.lines.length, size);
      assert.equal(selection.pricing.subtotal, expectedSubtotal);
      assert.equal(selection.composition.requestedItems, size);
      assert.equal(selection.source.llmSelected, true);
      assert.equal(selection.pricing.exact, false);
      if (size >= 1) assert.ok(selection.promotion?.types.includes("BOGO"));
    }
  }
});

test("invalid LLM bundles fail closed without provider mutations", () => {
  const sameMerchant = [candidate("glovo", 1), candidate("glovo", 2)];
  const differentMerchant = candidate("glovo", 3, { merchantId: "other", merchantName: "Other" });
  const otherProvider = candidate("ubereats", 4);
  const selections = (offers) => offers.map((offer, index) => ({ offerId: offer.id, quantity: 1, forItem: `line ${index}`, reason: "semantic match" }));
  assert.throws(() => buildLlmSelection(llmSearch([...sameMerchant, differentMerchant]), selections([sameMerchant[0], differentMerchant])), { code: "SELECTION_BASKET_CONFLICT" });
  assert.throws(() => buildLlmSelection(llmSearch([...sameMerchant, otherProvider]), selections([sameMerchant[0], otherProvider])), { code: "SELECTION_BASKET_CONFLICT" });
  assert.throws(() => buildLlmSelection(llmSearch(sameMerchant), selections([sameMerchant[0], sameMerchant[0]])), { code: "DUPLICATE_SELECTION" });
  assert.throws(() => buildLlmSelection(llmSearch(sameMerchant), [{ offerId: sameMerchant[0].id, quantity: 0, forItem: "line", reason: "match" }]), { code: "INVALID_SELECTION" });
  assert.throws(() => buildLlmSelection(llmSearch(sameMerchant), [{ offerId: "missing", quantity: 1, forItem: "line", reason: "match" }]), { code: "CANDIDATE_NOT_FOUND" });
});

test("results never turn uninspected LLM candidates into a false no-match", () => {
  const offers = PROVIDERS.map((provider, index) => candidate(provider, index));
  const before = resultsFor(llmSearch(offers));
  assert.equal(before.candidatePool.total, 3);
  assert.equal(before.candidatePool.selectionRequired, true);
  assert.equal(before.comparison.offers.length, 0);
  assert.match(before.warnings.join(" "), /semantic selection is still required/i);

  const selected = buildLlmSelection(llmSearch(offers), [{
    offerId: offers[0].id, quantity: 2, forItem: "meal for two", reason: "Two portions satisfy the party size.",
  }]);
  const after = resultsFor(llmSearch([...offers, selected], { providers: ["justeat"] }));
  assert.equal(after.candidatePool.selectionRequired, false);
  assert.equal(after.comparison.offers.length, 1);
  assert.equal(after.comparison.offers[0].lines[0].quantity, 2);
});

test("ranking uses exact delivered totals, budgets, ETA, ratings, deals, and membership signals", () => {
  const cheap = candidate("justeat", 1, { unitPrice: 15, exact: true, total: 18, etaMinutes: 40, rating: 4.2 });
  const fast = candidate("glovo", 2, { unitPrice: 17, exact: true, total: 21, etaMinutes: 15, rating: 4.5, membership: { active: true, name: "Glovo Prime" }, membershipEligible: true });
  const best = candidate("ubereats", 3, { unitPrice: 20, exact: true, total: 24, etaMinutes: 30, rating: 4.9, ratingCount: 2_000, itemSavings: 5, promotion: { types: ["TWO_FOR_ONE"], eligible: true, applied: true } });
  const offers = [cheap, fast, best];
  assert.equal(rankOffers(offers, "cheapest dinner under €30").offers[0].id, cheap.id);
  assert.equal(rankOffers(offers, "fastest dinner under €30").offers[0].id, fast.id);
  assert.equal(rankOffers(offers, "best-rated dinner under €30").offers[0].id, best.id);
  const constrained = rankOffers(offers, "best-rated dinner under €20");
  assert.equal(constrained.offers.find((offer) => offer.id === best.id).ranking.overBudget, true);
  assert.ok(constrained.offers.find((offer) => offer.id === fast.id).ranking.badges.includes("Glovo Prime eligible"));
  assert.ok(constrained.offers.find((offer) => offer.id === best.id).ranking.badges.some((badge) => /2-for-1/.test(badge)));
});

test("scheduled rankings fail closed until provider fulfilment and totals are verified", () => {
  const requestedAt = "2026-07-21T08:00:00.000Z";
  const verified = candidate("justeat", 1, { exact: true, total: 20, fulfilment: { requestedAt, status: "verified", selectedWindow: "10:00-10:15" } });
  const unverified = candidate("glovo", 2, { exact: true, total: 18, fulfilment: { requestedAt, status: "unverified" } });
  const ranking = rankOffers([verified, unverified], "breakfast tomorrow at 10am under €30", "cheapest", { providers: ["justeat", "glovo"] });
  assert.equal(ranking.winnerReady, false);
  assert.deepEqual(ranking.exactPriceCoverage.missingQuoteProviders, ["glovo"]);
  assert.ok(ranking.offers.find((offer) => offer.id === unverified.id).ranking.badges.includes("requested time not verified"));
});
