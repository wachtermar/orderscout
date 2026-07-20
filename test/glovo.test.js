import assert from "node:assert/strict";
import test from "node:test";
import { createGlovoBasket, enrichGlovoOffers, glovoAddresses, glovoInternals, glovoMe, glovoMenu, glovoOrderConfirmation, glovoStoreCatalog, glovoSubmissionRequest, normalizeGlovoQuote, placeGlovoOrder, quoteGlovoBasket, searchGlovo } from "../src/glovo.js";

function jwt(expiresAtSeconds) {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expiresAtSeconds })).toString("base64url")}.${"s".repeat(40)}`;
}

test("Glovo browser cookie token is parsed without exposing other cookies", () => {
  const encoded = encodeURIComponent(JSON.stringify({ access: { accessToken: "a".repeat(40) } }));
  assert.equal(glovoInternals.accessToken({ cookieHeader: `other=secret; glovo_auth_info=${encoded}` }), "a".repeat(40));
});

test("Glovo preserves product identifiers larger than JavaScript's safe integer range", () => {
  const payload = glovoInternals.parseJsonLosslessIds('{"id":4611686018754460727,"price":4.95,"label":"4611686018754460727"}');
  assert.equal(payload.id, "4611686018754460727");
  assert.equal(payload.price, 4.95);
  assert.equal(payload.label, "4611686018754460727");
});

test("Glovo silently renews an expired access token with the saved refresh token", async () => {
  const expired = jwt(Math.floor(Date.now() / 1_000) - 60);
  const renewed = jwt(Math.floor(Date.now() / 1_000) + 1_200);
  const session = {
    version: 2,
    source: "verification",
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: expired }))}`,
    refreshToken: "r".repeat(64),
    deviceUrn: "glv:device:test",
  };
  const calls = [];
  const account = await glovoMe({
    session,
    fetchImpl: async (url, options) => {
      calls.push({ path: new URL(url).pathname, authorization: options.headers.authorization ?? null, deviceUrn: options.headers["glovo-device-urn"] });
      if (new URL(url).pathname === "/oauth/refresh") {
        assert.deepEqual(JSON.parse(options.body), { refreshToken: "r".repeat(64) });
        return Response.json({ accessToken: renewed, refreshToken: "n".repeat(64), expiresIn: 1_200, tokenType: "bearer", scope: null });
      }
      if (new URL(url).pathname === "/v3/me") return Response.json({ id: 7, name: "Test", preferredCityCode: "MBA" });
      return Response.json({ isSubscribed: true });
    },
  });

  assert.equal(account.authenticated, true);
  assert.equal(account.membershipActive, true);
  assert.deepEqual(calls.map((call) => call.path), ["/oauth/refresh", "/v3/me", "/customers/7/subscription/status"]);
  assert.equal(calls[1].authorization, `Bearer ${renewed}`);
  assert.ok(calls.every((call) => call.deviceUrn === "glv:device:test"));
  assert.equal(session.refreshToken, "n".repeat(64));
  assert.equal(glovoInternals.accessToken(session), renewed);
  assert.equal(session.accessExpiresAt, glovoInternals.jwtExpiresAt(renewed));
});

test("Glovo retries one rejected authenticated request after renewal", async () => {
  const current = jwt(Math.floor(Date.now() / 1_000) + 1_200);
  const renewed = jwt(Math.floor(Date.now() / 1_000) + 1_400);
  const session = {
    version: 2,
    source: "verification",
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: current }))}`,
    refreshToken: "r".repeat(64),
  };
  let profileAttempts = 0;
  const account = await glovoMe({
    session,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/refresh") return Response.json({ accessToken: renewed, refreshToken: "n".repeat(64) });
      if (path === "/v3/me" && profileAttempts++ === 0) return Response.json({ message: "expired" }, { status: 401 });
      if (path === "/v3/me") return Response.json({ id: 8, name: "Retry" });
      return Response.json({ isSubscribed: false });
    },
  });
  assert.equal(profileAttempts, 2);
  assert.equal(account.id, 8);
});

test("Glovo never retries a rejected mutation after refreshing would be ambiguous", async () => {
  const current = jwt(Math.floor(Date.now() / 1_000) + 1_200);
  const session = {
    version: 2,
    source: "verification",
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: current }))}`,
    refreshToken: "r".repeat(64),
  };
  const paths = [];
  await assert.rejects(() => glovoInternals.request("/v1/authenticated/customers/7/baskets", {
    method: "POST",
    auth: true,
    session,
    body: { synthetic: true },
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return Response.json({ message: "expired" }, { status: 401 });
    },
  }), { code: "AUTH_EXPIRED" });
  assert.deepEqual(paths, ["/v1/authenticated/customers/7/baskets"]);
});

test("Glovo exposes provider throttling as a rate limit rather than an authentication failure", async () => {
  const session = {
    source: "verification",
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1_000) + 1_200) }))}`,
  };
  await assert.rejects(() => glovoInternals.request("/v3/stores/test/search", {
    session,
    fetchImpl: async () => Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "30" } }),
  }), (error) => {
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.details.retryAfter, "30");
    return true;
  });
});

test("Glovo treats an invalid refresh grant as an expired login", async () => {
  const session = {
    version: 2,
    source: "verification",
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: jwt(0) }))}`,
    refreshToken: "r".repeat(64),
  };
  await assert.rejects(() => glovoInternals.refreshGlovoSession(session, {
    persist: false,
    fetchImpl: async () => Response.json({ message: "invalid_grant" }, { status: 400 }),
  }), { code: "AUTH_EXPIRED" });
});

test("Glovo addresses normalize the current data.addresses envelope", async () => {
  const addresses = await glovoAddresses({
    cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: "a".repeat(40) }))}`,
    fetchImpl: async () => Response.json({ data: { addresses: [{
      entryType: "CURRENT",
      address: { id: 7, addressLine: "Private address", latitude: 36.5, longitude: -4.8, cityCode: "MBA", cityName: "Marbella", kind: "HOME" },
    }] } }),
  });
  assert.deepEqual(addresses, [{ id: 7, label: "HOME", latitude: 36.5, longitude: -4.8, city: "Marbella", cityCode: "MBA", isDefault: true }]);
});

test("Glovo search response becomes a direct normalized offer", () => {
  const payload = { data: { elements: [
    {
      type: "STORE_CARD_V2",
      actions: [{ data: { path: "open?store_id=12&shop_id=34&category_id=1&shop_is_prime=true&shop_delivery_fee=1.49" } }],
      data: { slug: "mercado-test", title: { text: { text: "Mercado Test" } }, labels: [{ label: "20-30 min" }, { label: "96%" }] },
    },
    { data: { elements: [{
      type: "PRODUCT_ITEM_CARD_V2",
      actions: [{ data: { path: "open?product_id=56&product_external_id=P56&store_product_id=sp56" } }],
      data: { name: { text: "Agua 6 x 1,5 L" }, pricing: { finalPrice: "4,50 €" } },
    }] } },
  ] } };
  const offers = glovoInternals.offersFromSearch(payload, { citySlug: "marbella" });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider, "glovo");
  assert.equal(offers[0].merchant.id, "12");
  assert.equal(offers[0].item.unitPrice, 4.5);
  assert.equal(offers[0].etaMinutes, 20);
  assert.equal(offers[0].source.storeAddressId, "34");
  assert.equal(offers[0].pricing.originalSubtotal, null);
});

test("Glovo search preserves store-only results for second-stage catalog discovery", () => {
  const payload = { data: { elements: [{
    type: "STORE_CARD_V2",
    actions: [
      { data: { events: [{ name: "shop_impressions.loaded", data: { cuisineTypeStoreTags: "Vapeo", numberOfRatedOrders: "12" } }] } },
      { data: { path: "open?store_id=580573&shop_id=935347&category_id=22&shop_availability_status=OPEN&shop_delivery_fee=2.99" } },
    ],
    data: { slug: "estanco-marbella", title: { text: { text: "Estanco" } }, labels: [{ text: { text: "20-35 min" } }] },
  }] } };
  assert.equal(glovoInternals.offersFromSearch(payload, { citySlug: "marbella" }).length, 0);
  const stores = glovoInternals.storesFromSearch(payload, { citySlug: "marbella" });
  assert.equal(stores.length, 1);
  assert.equal(stores[0].name, "Estanco");
  assert.equal(stores[0].open, true);
  assert.deepEqual(stores[0].categories, ["Vapeo"]);
});

test("Glovo reuses the saved city code and derives only the harmless URL slug", async () => {
  const calls = [];
  await searchGlovo("indio", { latitude: 36.5, longitude: -4.8, city: "Marbella", cityCode: "MBA" }, {
    session: { source: "verification", cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: "a".repeat(40) }))}` },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json({ data: { elements: [] } });
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /store_wall\/search/);
  assert.doesNotMatch(calls[0], /\/es\/es\/marbella$/);
});

test("Glovo searches a discovered store catalog and surfaces its legal-age gate", async () => {
  const store = {
    id: "580573", addressId: "935347", categoryId: "22", name: "Estanco", categories: ["Vapeo"],
    rating: 4.6, ratingCount: 12, etaMinutes: { min: 20, max: 35 }, deliveryFee: 2.99,
    open: true, schedulable: false, prime: false, url: "https://glovoapp.com/es/es/marbella/stores/estanco-marbella",
  };
  const calls = [];
  const catalog = await glovoStoreCatalog(store, ["ice", "recarga"], { latitude: 36.5, longitude: -4.8, cityCode: "MBA" }, {
    requireEligibility: true,
    session: { source: "verification", cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: "a".repeat(40) }))}` },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(`${parsed.pathname}${parsed.search}`);
      if (parsed.pathname.endsWith("/node/store_menu")) return Response.json({ type: "STORE_MENU", data: { elements: [{
        name: "Recargas", slug: "recargas", action: { type: "POPUP", data: { id: "RESTRICTIONS", redirectPath: "/restricted" } }, elements: [],
      }] } });
      if (parsed.pathname.endsWith("/restrictions")) return Response.json({ title: "Confirma que eres mayor de edad", restrictions: [{ id: "TBC", text: "Confirmo que soy mayor de edad." }] });
      if (parsed.pathname.endsWith("/search") && parsed.searchParams.get("query") === "ice") return Response.json({ totalProducts: 1, results: [{ products: [{
        id: "product-1", externalId: "1784", storeProductId: "1784", name: "Desechable Vuse Mango Ice 20mg", price: 14.25,
        priceInfo: { amount: 14.25, currencyCode: "EUR" }, attributeGroups: [],
      }] }] });
      return Response.json({ totalProducts: 0, results: [{ products: [] }] });
    },
  });
  assert.equal(catalog.products.length, 1);
  assert.equal(catalog.offers[0].item.name, "Desechable Vuse Mango Ice 20mg");
  assert.equal(catalog.offers[0].source.storeProductId, "1784");
  assert.equal(catalog.offers[0].source.eligibility.status, "confirmation_required");
  assert.deepEqual(catalog.products[0].matchedQueries, ["ice"]);
  assert.deepEqual(catalog.offers[0].source.catalogQueriesMatched, ["ice"]);
  assert.equal(catalog.offers[0].source.eligibility.restrictions[0].id, "TBC");
  assert.ok(calls.some((value) => value.includes("query=ice")));
});

test("Glovo parses the current PRODUCT_TILE flight format and detects restricted collections", async () => {
  const flight = [
    { type: "PRODUCT_TILE", data: { id: "p1", externalId: "e1", storeProductId: "s1", name: "Chicken bowl", description: "Grilled chicken", price: 9.5, priceInfo: { amount: 9.5, currencyCode: "EUR" }, attributeGroups: [] } },
    { type: "COLLECTION_TILE", data: { title: "Recargas", slug: "recargas", action: { type: "POPUP", data: { id: "RESTRICTIONS" } } } },
  ].map((value) => JSON.stringify(value)).join("");
  const html = `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
  const menu = await glovoMenu("https://glovoapp.com/es/es/marbella/stores/test-store", async () => new Response(html));
  assert.equal(menu.products.length, 1);
  assert.equal(menu.products[0].name, "Chicken bowl");
  assert.equal(menu.restrictionsDetected, true);
});

test("Glovo blocks age-restricted basket creation until explicit confirmation", async () => {
  await assert.rejects(() => createGlovoBasket({
    item: { name: "Vape" }, quantity: 1,
    source: {
      storeId: "12", storeAddressId: "34", storeCategoryId: "22", productId: "56", productExternalId: "P56", storeProductId: "sp56",
      eligibility: { kind: "legal_age", status: "confirmation_required", providerActionUrl: "https://glovoapp.com/es/es/marbella/stores/test" },
    },
  }, { prepareOnly: true }), { code: "AGE_CONFIRMATION_REQUIRED" });
});

test("Glovo search retains provider-listed promotions and item savings", () => {
  const payload = { data: { elements: [
    {
      type: "STORE_CARD_V2",
      actions: [{ data: { path: "open?store_id=12&shop_id=34&category_id=1&shop_delivery_fee=0" } }],
      data: { slug: "deal-test", title: { text: { text: "Deal Test" } }, labels: [] },
    },
    { data: { elements: [{
      type: "PRODUCT_ITEM_CARD_V2",
      actions: [
        { data: { path: "open?product_id=56&product_external_id=P56&store_product_id=sp56" } },
        { data: { events: [{ data: { shopPromotionTypes: "PERCENTAGE_DISCOUNT,FREE_DELIVERY", shopPromotionId: "promo-1,-1" } }] } },
      ],
      data: { name: { text: "Deal meal" }, pricing: { originalPrice: "10,00 €", finalPrice: "7,00 €" }, promotionTags: [{ text: "30% de descuento" }] },
    }] } },
  ] } };
  const offer = glovoInternals.offersFromSearch(payload, { citySlug: "marbella" })[0];
  assert.equal(offer.pricing.originalSubtotal, 10);
  assert.equal(offer.pricing.subtotal, 7);
  assert.equal(offer.pricing.itemSavings, 3);
  assert.deepEqual(offer.promotion.types, ["PERCENTAGE_DISCOUNT", "FREE_DELIVERY"]);
  assert.deepEqual(offer.promotion.ids, ["promo-1"]);
  assert.ok(offer.promotion.descriptions.includes("30% de descuento"));
});

test("Glovo offer enrichment adds menu descriptions before health ranking", async () => {
  const offers = [{
    url: "https://glovoapp.com/es/es/marbella/stores/test-store",
    item: { id: "breakfast", name: "Scrambled egg combo", description: null, unitPrice: 8 },
    source: { productId: "breakfast" },
  }];
  const enriched = await enrichGlovoOffers(offers, { menuLoader: async () => ({ products: [{
    id: "breakfast", description: "Scrambled eggs with bacon", price: 8, requiresCustomizations: true,
  }] }) });
  assert.equal(enriched[0].item.description, "Scrambled eggs with bacon");
  assert.equal(enriched[0].source.requiresCustomizations, true);
});

test("Glovo basket prepare is a non-mutating direct API payload", async () => {
  const prepared = await createGlovoBasket({ quantity: 3, source: { storeId: "12", storeAddressId: "34", storeCategoryId: "1", productId: "56", productExternalId: "P56", storeProductId: "sp56" } }, { prepareOnly: true });
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.payload.products[0].quantity.increments, 3);
  assert.equal(prepared.payload.storeAddressId, 34);
});

test("Glovo basket prepare preserves distinct meal lines", async () => {
  const prepared = await createGlovoBasket({ lines: [
    { item: { name: "Chicken poke" }, quantity: 1, source: { storeId: "12", storeAddressId: "34", productId: "56", productExternalId: "P56", storeProductId: "sp56" } },
    { item: { name: "Salmon poke" }, quantity: 1, source: { storeId: "12", storeAddressId: "34", productId: "57", productExternalId: "P57", storeProductId: "sp57" } },
  ] }, { prepareOnly: true });
  assert.deepEqual(prepared.payload.products.map((product) => product.ids.id), ["56", "57"]);
});

test("Glovo customizations match the current frontend basket payload", async () => {
  const prepared = await createGlovoBasket({
    item: { name: "Pad Thai" },
    source: {
      storeId: "12", storeAddressId: "34", productId: "56", productExternalId: "P56", storeProductId: "sp56",
      product: { attributeGroups: [{
        id: 101, externalId: "group-external", name: "Heat level", min: 1, max: 1, position: 2,
        attributes: [{ id: 202, externalId: "attribute-external", name: "Thai spicy", priceImpact: 0 }],
      }] },
    },
  }, { prepareOnly: true });

  assert.deepEqual(prepared.payload.products[0].customizations, [{
    ids: {
      groupLegacyId: "101", groupId: "101", groupExternalId: "group-external", groupPosition: 2,
      legacyId: "202", externalId: "attribute-external",
    },
    name: "Heat level",
    quantity: { increments: 1 },
    customizationName: "Thai spicy",
    groupName: "Heat level",
  }]);
});

test("Glovo rejects a basket that silently drops requested products", async (t) => {
  const previousCookie = process.env.ORDERSCOUT_GLOVO_COOKIE;
  t.after(() => {
    if (previousCookie === undefined) delete process.env.ORDERSCOUT_GLOVO_COOKIE;
    else process.env.ORDERSCOUT_GLOVO_COOKIE = previousCookie;
  });
  process.env.ORDERSCOUT_GLOVO_COOKIE = `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1_000) + 1_200) }))}`;

  const offer = { lines: [
    {
      item: { name: "Customized main" }, quantity: 1,
      source: {
        storeId: "12", storeAddressId: "34", storeCategoryId: "1", productId: "56", productExternalId: "P56", storeProductId: "sp56",
        product: { attributeGroups: [{
          id: 101, externalId: "group-external", name: "Heat level", min: 1, max: 1, position: 0,
          attributes: [{ id: 202, externalId: "attribute-external", name: "Thai spicy", priceImpact: 0 }],
        }] },
      },
    },
    {
      item: { name: "Water" }, quantity: 1,
      source: { storeId: "12", storeAddressId: "34", storeCategoryId: "1", productId: "57", productExternalId: "P57", storeProductId: "sp57" },
    },
  ] };
  let rollbackCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/customer_profile/api/v1/address_book/me/addresses") {
      return Response.json({ data: { addresses: [{
        entryType: "CURRENT", address: { id: 1, latitude: 36.5, longitude: -4.8, cityCode: "MBA", cityName: "Marbella" },
      }] } });
    }
    if (path === "/v3/me") return Response.json({ id: 7, name: "Test" });
    if (path === "/customers/7/subscription/status") return Response.json({ isSubscribed: false });
    if (path === "/v1/authenticated/customers/7/baskets/stores/12") return Response.json(null);
    if (path === "/v1/authenticated/customers/7/baskets" && options.method === "POST") {
      const payload = JSON.parse(options.body);
      return Response.json({
        basketId: "basket-1", storeId: 12, storeAddressId: 34, storeCategoryId: 1,
        products: [payload.products[1]],
      });
    }
    if (path === "/v1/authenticated/customers/7/baskets/basket-1" && options.method === "DELETE") {
      rollbackCalls += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Glovo test request: ${options.method ?? "GET"} ${path}`);
  };

  await assert.rejects(() => createGlovoBasket(offer, { fetchImpl }), (error) => {
    assert.equal(error.code, "BASKET_CONTENT_MISMATCH");
    assert.deepEqual(error.details.missingItems, [{ itemId: "56", itemName: "Customized main", expectedQuantity: 1, acceptedQuantity: 0 }]);
    assert.equal(error.details.expectedItemCount, 2);
    assert.equal(error.details.acceptedItemCount, 1);
    assert.deepEqual(error.details.rollback, { attempted: true, succeeded: true });
    return true;
  });
  assert.equal(rollbackCalls, 1);
});

test("Glovo refuses to quote a previously recorded partial basket", async (t) => {
  const previousCookie = process.env.ORDERSCOUT_GLOVO_COOKIE;
  t.after(() => {
    if (previousCookie === undefined) delete process.env.ORDERSCOUT_GLOVO_COOKIE;
    else process.env.ORDERSCOUT_GLOVO_COOKIE = previousCookie;
  });
  process.env.ORDERSCOUT_GLOVO_COOKIE = `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1_000) + 1_200) }))}`;
  let checkoutCalls = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v3/me") return Response.json({ id: 7, name: "Test" });
    if (path === "/customers/7/subscription/status") return Response.json({ isSubscribed: false });
    if (path === "/v1/authenticated/customers/7/baskets/basket-1") {
      return Response.json({
        basketId: "basket-1", storeId: 12, storeAddressId: 34, storeCategoryId: 1,
        products: [{ ids: { id: "rewritten-water-id", storeProductId: "stable-water" }, quantity: { increments: 1 } }],
      });
    }
    if (path === "/v3/checkouts/order/1/template") checkoutCalls += 1;
    throw new Error(`Unexpected Glovo test request: ${path}`);
  };

  await assert.rejects(() => quoteGlovoBasket("basket-1", {
    fetchImpl,
    location: { latitude: 36.5, longitude: -4.8, cityCode: "MBA" },
    expectedLines: [
      { item: { name: "Customized main" }, quantity: 1, source: { productId: "56" } },
      { item: { name: "Water" }, quantity: 1, source: { productId: "57", storeProductId: "stable-water" } },
    ],
  }), (error) => {
    assert.equal(error.code, "BASKET_CONTENT_MISMATCH");
    assert.deepEqual(error.details.missingItems, [{ itemId: "56", itemName: "Customized main", expectedQuantity: 1, acceptedQuantity: 0 }]);
    assert.deepEqual(error.details.unexpectedItems, []);
    return true;
  });
  assert.equal(checkoutCalls, 0);
});

test("Glovo checkout prefers the submit action returned by validation", () => {
  const request = glovoSubmissionRequest("basket-1", {
    actions: [{ type: "SUBMIT_ORDER", data: { method: "POST", path: "/v2/checkout/orders", body: { checkoutSessionId: "session-1", basketId: "basket-1" } } }],
  });
  assert.deepEqual(request, {
    method: "POST",
    path: "/v2/checkout/orders",
    body: { checkoutSessionId: "session-1", basketId: "basket-1" },
    source: "checkout-action",
  });
});

test("Glovo checkout normalizes exact itemized pricing", () => {
  const pricing = normalizeGlovoQuote({
    subtotal: 22,
    charges: [
      { name: "Delivery fee", amount: 2.5 },
      { name: "Service fee", amount: 1 },
    ],
    total: 25.5,
    currency: "EUR",
  });
  assert.equal(pricing.subtotal, 22);
  assert.equal(pricing.fees.delivery, 2.5);
  assert.equal(pricing.fees.service, 1);
  assert.equal(pricing.total, 25.5);
  assert.equal(pricing.exact, true);
});

test("Glovo checkout template honors applied free fees and the final total", () => {
  const pricing = normalizeGlovoQuote({
    orderDetails: { purchaseTotalCents: 1050, currencyCode: "EUR" },
    components: [{ id: "priceBreakdown", type: "priceBreakdown", priceBreakdownData: { breakDown: [
      { type: "OTHER", title: "Productos", value: "10,50 €" },
      { type: "DELIVERY", title: "Entrega", value: "2,99 €", valuePrefix: "GRATIS", valueStyle: "STRIKETHROUGH" },
      { type: "OTHER", title: "Servicios", value: "0,73 €", valuePrefix: "GRATIS", valueStyle: "STRIKETHROUGH" },
      { type: "OTHER", title: "Pedido pequeño", value: "1,50 €" },
      { type: "TOTAL", title: "TOTAL", value: "12,00 €" },
    ] } }],
  });
  assert.deepEqual(pricing, {
    currency: "EUR", subtotal: 10.5,
    fees: { delivery: 0, service: 0, smallOrder: 1.5, bag: null, other: null },
    discount: 0, total: 12, exact: true,
  });
});

test("Glovo checkout infers an applied promotion from the exact payable total", () => {
  const pricing = normalizeGlovoQuote({
    subtotal: 20,
    charges: [{ name: "Delivery fee", amount: 2 }],
    total: 17,
  });
  assert.equal(pricing.discount, 5);
  assert.equal(pricing.total, 17);
});

test("Glovo final order is preview-first and fingerprint protected", async () => {
  const offer = { source: { storeId: "12" } };
  const quote = { basketId: "basket-1", total: 18.09, currency: "EUR" };
  const confirmation = glovoOrderConfirmation(offer, quote);
  const preview = await placeGlovoOrder(offer, quote);
  assert.equal(preview.submitted, false);
  assert.equal(preview.experimental, true);
  assert.equal(preview.requiresConfirmation, confirmation.fingerprint);
  await assert.rejects(() => placeGlovoOrder(offer, quote, { confirm: "wrong" }), { code: "CONFIRMATION_MISMATCH" });
  await assert.rejects(() => placeGlovoOrder(offer, quote, { confirm: confirmation.fingerprint }), { code: "ORDER_PLACEMENT_DISABLED" });
});

test("Glovo confirmed checkout submits the validated action through the direct API", async (t) => {
  const previousGate = process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT;
  const previousCookie = process.env.ORDERSCOUT_GLOVO_COOKIE;
  t.after(() => {
    if (previousGate === undefined) delete process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT;
    else process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT = previousGate;
    if (previousCookie === undefined) delete process.env.ORDERSCOUT_GLOVO_COOKIE;
    else process.env.ORDERSCOUT_GLOVO_COOKIE = previousCookie;
  });
  process.env.ORDERSCOUT_ENABLE_ORDER_PLACEMENT = "1";
  process.env.ORDERSCOUT_GLOVO_COOKIE = `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: "a".repeat(40) }))}`;
  const offer = { source: { storeId: "12" } };
  const quote = {
    basketId: "basket-1",
    total: 18.09,
    actions: [{ type: "SUBMIT_ORDER", data: { path: "/v2/checkout/orders", body: { basketId: "basket-1", checkoutSessionId: "session-1" } } }],
  };
  const confirmation = glovoOrderConfirmation(offer, quote);
  let submitted;
  const result = await placeGlovoOrder(offer, quote, {
    confirm: confirmation.fingerprint,
    fetchImpl: async (url, options) => {
      submitted = { url: String(url), method: options.method, body: JSON.parse(options.body) };
      return Response.json({ orderId: "synthetic-order" });
    },
  });
  assert.equal(result.submitted, true);
  assert.deepEqual(submitted, {
    url: "https://api.glovoapp.com/v2/checkout/orders",
    method: "POST",
    body: { basketId: "basket-1", checkoutSessionId: "session-1" },
  });
});
