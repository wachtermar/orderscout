import assert from "node:assert/strict";
import test from "node:test";
import { collectUberStores, createUberEatsBasket, expandUberEatsCatalogs, normalizeUberSearch, quoteUberEatsBasket, searchUberEats, summarizeUberEatsCarts, uberEatsDraftDeliveryLocation, uberEatsInternals, uberEatsMe, uberEatsOrderConfirmation } from "../src/ubereats.js";

test("Uber Eats login uses the current getUserV1 account contract", async () => {
  const account = await uberEatsMe({
    cookieHeader: "sid=synthetic",
    fetchImpl: async (url) => {
      assert.match(String(url), /getUserV1$/);
      return Response.json({ data: {
        isLoggedIn: true,
        firstName: "Test",
        lastName: "User",
        hasConfirmedMobile: true,
        subscriptionMeta: { eatsSubscriptionStatus: "ACTIVE" },
      } });
    },
  });
  assert.equal(account.authenticated, true);
  assert.equal(account.name, "Test User");
  assert.equal(account.membershipActive, true);
});

test("Uber Eats mini-store search response becomes a normalized offer", () => {
  const payload = { feedItems: [{ miniStoreWithItems: {
    store: { storeUuid: "store-1", title: "Super Test", rating: { ratingValue: 4.7, reviewCount: 200 }, etaRange: { text: "15–25 min" }, deliveryFee: 199, slug: "super-test", hasUberOneBenefits: true },
    items: [{ uuid: "water-1", title: "Agua 6 x 1.5 L", price: 445, sectionUuid: "s", subsectionUuid: "ss" }],
  } }] };
  const offers = normalizeUberSearch(payload);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider, "ubereats");
  assert.equal(offers[0].item.unitPrice, 4.45);
  assert.equal(offers[0].etaMinutes, 15);
  assert.equal(offers[0].membershipEligible, true);
  assert.equal(offers[0].source.sectionUuid, "s");
  assert.equal(uberEatsInternals.price(""), null);
});

test("Uber Eats treats every integer API price as minor units, including sub-euro catalog items", () => {
  const payload = { feedItems: [{ miniStoreWithItems: {
    store: { storeUuid: "store-1", title: "Super Test" },
    items: [
      { uuid: "water-90", title: "Water 1.5 L", price: 90 },
      { uuid: "water-30", title: "Water 500 ml", price: 30 },
      { uuid: "formatted", title: "Formatted water", price: "€0.85" },
    ],
  } }] };
  const prices = normalizeUberSearch(payload).map((offer) => offer.item.unitPrice);
  assert.deepEqual(prices, [0.9, 0.3, 0.85]);
  assert.equal(uberEatsInternals.price(99), 0.99);
  assert.equal(uberEatsInternals.price(2_550), 25.5);
  assert.equal(uberEatsInternals.price(4.45), 4.45);
});

test("Uber Eats search retains discounted item prices and promotion metadata", () => {
  const payload = { feedItems: [{ miniStoreWithItems: {
    store: {
      storeUuid: "store-1", title: "Deal Store", actionUrl: "/store/deal/store-1",
      tracking: { storePayload: { offerMetadata: { promotionUUIDs: ["promo-1"], concatSignpost: "offers.signpost.promo.discounted_item" } } },
    },
    items: [{
      uuid: "deal-1", title: "Deal Meal", price: 700,
      priceTagline: { accessibilityText: "€7.00, discounted from €10.00" },
      promoInfo: { promotionUUID: "promo-1", promoBadge: { accessibilityText: "30% off" } },
      catalogItemAnalyticsData: { promoType: "DISCOUNTED_ITEM" },
    }],
  } }] };
  const offer = normalizeUberSearch(payload)[0];
  assert.equal(offer.pricing.originalSubtotal, 10);
  assert.equal(offer.pricing.subtotal, 7);
  assert.equal(offer.pricing.itemSavings, 3);
  assert.ok(offer.promotion.types.includes("DISCOUNTED_ITEM"));
  assert.ok(offer.promotion.descriptions.includes("30% off"));
  assert.deepEqual(offer.promotion.ids, ["promo-1"]);
});

test("Uber Eats expands store-only search results into matching menu offers", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    const operation = String(url).split("/").at(-1);
    requested.push(operation);
    if (operation === "getSearchFeedV1") return Response.json({ data: { feedItems: [{ store: {
      storeUuid: "store-1", title: "Healthy Poke", rating: { ratingValue: 4.8 }, actionUrl: "/store/healthy-poke/store-1",
    } }] } });
    return Response.json({ data: { title: "Healthy Poke", isOpen: true, sections: [{ sectionUuid: "section", items: [
      { uuid: "poke-1", title: "Healthy Salmon Poke", itemDescription: "Salmon and vegetables", price: 1345 },
      { uuid: "cake-1", title: "Chocolate Cake", price: 500 },
    ] }] } });
  };
  const result = await searchUberEats("poke", { fetchImpl, cookieHeader: "sid=test", storeLimit: 2 });
  assert.equal(collectUberStores({ feedItems: [{ store: { storeUuid: "store-1", title: "Healthy Poke" } }] }).length, 1);
  assert.deepEqual(requested, ["getSearchFeedV1", "getStoreV1"]);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].item.name, "Healthy Salmon Poke");
  assert.equal(result.offers[0].source.sectionUuid, "section");
});

test("Uber Eats reuses one store menu across independent agent catalog queries", async () => {
  let menuRequests = 0;
  const menuCache = new Map();
  const fetchImpl = async (url) => {
    const operation = String(url).split("/").at(-1);
    if (operation === "getSearchFeedV1") return Response.json({ data: { feedItems: [{ store: {
      storeUuid: "store-1", title: "Healthy Poke", actionUrl: "/store/healthy-poke/store-1",
    } }] } });
    menuRequests += 1;
    return Response.json({ data: { title: "Healthy Poke", sections: [{ items: [
      { uuid: "poke-1", title: "Salmon Poke", price: 1_300 },
    ] }] } });
  };
  await searchUberEats("poke", { fetchImpl, cookieHeader: "sid=test", menuCache, storeLimit: 1 });
  await searchUberEats("salmon", { fetchImpl, cookieHeader: "sid=test", menuCache, storeLimit: 1 });
  assert.equal(menuRequests, 1);
});

test("Uber Eats scans each candidate store once for independent multi-item needs", async () => {
  const menuCache = new Map([
    ["complete-store", Promise.resolve({ isOpen: true, items: [
      { uuid: "spf", title: "Protector solar SPF 50", description: "Farmacia", price: 5.84, rawPrice: 584 },
      { uuid: "paste", title: "Pasta dental sensible", description: "Sensodyne", price: 5.25, rawPrice: 525 },
      { uuid: "plasters", title: "Tiritas resistentes", description: "20 unidades", price: 3.45, rawPrice: 345 },
    ] })],
    ["partial-store", Promise.resolve({ isOpen: true, items: [
      { uuid: "paste-only", title: "Pasta dental", price: 4, rawPrice: 400 },
    ] })],
  ]);
  const result = await expandUberEatsCatalogs([
    { id: "partial-store", name: "Partial Market", queryHits: 1, rating: 4.9 },
    { id: "complete-store", name: "Complete Market", queryHits: 3, rating: 4.5 },
  ], ["protector solar", "pasta dental", "tiritas"], { menuCache, storeLimit: 1 });
  assert.equal(result.searchedStores, 1);
  assert.equal(result.failedStores, 0);
  assert.equal(result.rateLimitedStores, 0);
  assert.deepEqual(result.offers.map((offer) => offer.item.id), ["spf", "paste", "plasters"]);
  assert.ok(result.offers.every((offer) => offer.merchant.id === "complete-store"));
});

test("Uber Eats reports partial cross-catalog scans without discarding successful stores", async () => {
  const limited = Object.assign(new Error("slow down"), { code: "RATE_LIMITED" });
  const result = await expandUberEatsCatalogs([
    { id: "good", name: "Good Market", queryHits: 2 },
    { id: "limited", name: "Limited Market", queryHits: 1 },
  ], ["water"], {
    menuCache: new Map([
      ["good", Promise.resolve({ isOpen: true, items: [{ uuid: "water", title: "Water", price: 1, rawPrice: 100 }] })],
      ["limited", Promise.reject(limited)],
    ]),
    storeLimit: 2,
  });
  assert.equal(result.searchedStores, 1);
  assert.equal(result.failedStores, 1);
  assert.equal(result.rateLimitedStores, 1);
  assert.equal(result.offers.length, 1);
});

test("Uber Eats distinguishes a 403 rate limit from an expired login", async () => {
  await assert.rejects(() => searchUberEats("poke", {
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ status: "failure", data: { message: "bd.error.too_many_requests" } }, { status: 403 }),
  }), { code: "RATE_LIMITED" });
});

test("Uber Eats basket prepare uses createDraftOrderV2 shape without mutation", async () => {
  const prepared = await createUberEatsBasket({ item: { name: "Water", unitPrice: 4.45 }, quantity: 2, source: { storeUuid: "store-1", itemUuid: "water-1", sectionUuid: "s", subsectionUuid: "ss", rawPrice: 445 } }, { prepareOnly: true });
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.payload.isMulticart, true);
  assert.equal(prepared.payload.shoppingCartItems[0].quantity, 2);
  assert.equal(prepared.payload.shoppingCartItems[0].price, 445);
});

test("Uber Eats cart summaries expose useful basket data without address, account, or payment PII", () => {
  const carts = { draftOrders: [{
    uuid: "draft-1",
    consumerUuid: "consumer-secret",
    paymentProfileUUID: "payment-secret",
    store: { storeUuid: "store-1", title: "Test Market" },
    shoppingCartItems: [{ title: "Mineral water", quantity: 2 }],
    deliveryAddress: {
      address1: "Secret street 123",
      latitude: 36.51,
      longitude: -4.84,
      city: "Marbella",
      postalCode: "29603",
    },
  }] };
  const summary = summarizeUberEatsCarts(carts);
  assert.deepEqual(summary.draftOrders[0], {
    id: "draft-1",
    store: { id: "store-1", name: "Test Market" },
    items: [{ name: "Mineral water", quantity: 2 }],
    itemCount: 2,
    state: null,
    createdAt: null,
    deliveryLocationSelected: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /Secret street|consumer-secret|payment-secret|36\.51|-4\.84|29603/);
  assert.deepEqual(uberEatsDraftDeliveryLocation(carts), {
    latitude: 36.51,
    longitude: -4.84,
    city: "Marbella",
    postcode: "29603",
    source: "ubereats-draft-delivery-location",
  });
});

test("Uber Eats basket prepare preserves distinct meal lines", async () => {
  const prepared = await createUberEatsBasket({
    lines: [
      { item: { name: "Salmon poke", unitPrice: 13 }, quantity: 1, source: { storeUuid: "store-1", itemUuid: "salmon", rawPrice: 1300 } },
      { item: { name: "Tuna poke", unitPrice: 12.5 }, quantity: 1, source: { storeUuid: "store-1", itemUuid: "tuna", rawPrice: 1250 } },
    ],
  }, { prepareOnly: true });
  assert.deepEqual(prepared.payload.shoppingCartItems.map((item) => [item.title, item.quantity]), [
    ["Salmon poke", 1], ["Tuna poke", 1],
  ]);
});

test("Uber Eats basket prepare ignores optional-only customization groups", async () => {
  const prepared = await createUberEatsBasket({
    item: { name: "Açaí smoothie", unitPrice: 8.4 }, quantity: 1,
    source: { storeUuid: "store-1", itemUuid: "smoothie", rawPrice: 840, requiresCustomizations: true },
  }, {
    prepareOnly: true,
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ data: { customizationsList: [
      { title: "Extras", minPermitted: 0, options: [{ title: "Extra fruit", price: 100 }] },
    ] } }),
  });
  assert.deepEqual(prepared.payload.shoppingCartItems[0].customizations, {});
});

test("Uber Eats basket prepare reports genuinely required customization groups", async () => {
  await assert.rejects(() => createUberEatsBasket({
    item: { name: "Breakfast bowl", unitPrice: 10 }, quantity: 1,
    source: { storeUuid: "store-1", itemUuid: "bowl", rawPrice: 1000, requiresCustomizations: true },
  }, {
    prepareOnly: true,
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ data: { customizationsList: [
      { title: "Choose a base", minPermitted: 1, options: [{ title: "Yogurt", price: 0 }] },
    ] } }),
  }), { code: "MODIFIERS_REQUIRED" });
});

test("Uber Eats checkout schedule hours reject an unavailable requested time", () => {
  const quote = { validationErrors: [{
    type: "STORE_UNAVAILABLE_BUT_SCHEDULABLE",
    alert: { primaryButton: { params: { scheduleTimePickerParams: {
      orderForLaterInfo: { isSchedulable: true },
      deliveryHoursInfos: [{ date: "2026-07-21", openHours: [{ startTime: 660, endTime: 1440, durationOffset: 60 }] }],
    } } } },
  }] };
  assert.throws(
    () => uberEatsInternals.uberEatsScheduleAvailability(quote, "2026-07-21T08:00:00.000Z", "Europe/Madrid"),
    { code: "SCHEDULE_UNAVAILABLE" },
  );
  const available = uberEatsInternals.uberEatsScheduleAvailability(quote, "2026-07-21T09:00:00.000Z", "Europe/Madrid");
  assert.equal(available.status, "available_unconfigured");
  assert.equal(available.selectedWindow.startMinute, 660);
});

test("Uber Eats quote uses the current official checkout payload and normalizes totals", async () => {
  let requestBody;
  const result = await quoteUberEatsBasket("draft-1", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async (url, options) => {
      assert.match(String(url), /getCheckoutPresentationV1$/);
      requestBody = JSON.parse(options.body);
      return Response.json({ data: { checkoutPayloads: {
        subtotal: { subtotal: { value: { amountE5: 2_550_000, currencyCode: "EUR" } } },
        fareBreakdown: { charges: [
          { fareBreakdownChargeMetadata: { analyticsInfo: [{ fareInfoID: "eats_fare.delivery_fee", currencyAmount: { amountE5: 199_000 } }] } },
          { fareBreakdownChargeMetadata: { analyticsInfo: [{ fareInfoID: "eats.mp.charges.byoc_basket_dependent_fee.net", currencyAmount: { amountE5: 125_000 } }] } },
        ] },
        total: { total: { value: { amountE5: 2_874_000, currencyCode: "EUR" } } },
      } } });
    },
  });
  assert.ok(requestBody.payloadTypes.includes("total"));
  assert.equal(requestBody.isGroupOrder, false);
  assert.match(requestBody.clientFeaturesData.paymentSelectionContext.value, /thirdPartyApplications/);
  assert.equal(result.pricing.subtotal, 25.5);
  assert.equal(result.pricing.fees.delivery, 1.99);
  assert.equal(result.pricing.total, 28.74);
  assert.equal(result.pricing.exact, true);
});

test("Uber Eats checkout captures exact promotion savings", async () => {
  const result = await quoteUberEatsBasket("draft-deal", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async () => Response.json({ data: { checkoutPayloads: {
      subtotal: { subtotal: { value: { amountE5: 2_000_000 } } },
      fareBreakdown: { charges: [{ fareBreakdownChargeMetadata: { analyticsInfo: [{ fareInfoID: "eats_fare.delivery_fee", currencyAmount: { amountE5: 200_000 } }] } }] },
      promotion: { promotionState: "APPLIED", savingsAmount: { amountE5: 500_000 } },
      total: { total: { value: { amountE5: 1_700_000 } } },
    } } }),
  });
  assert.equal(result.pricing.discount, 5);
  assert.equal(result.pricing.total, 17);
});

test("Uber Eats final order requires a stable confirmation fingerprint", () => {
  const first = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  const second = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.total, 18.09);
});
