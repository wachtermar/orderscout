import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUberStores, createUberEatsBasket, expandUberEatsCatalogs, normalizeUberSearch, quoteUberEatsBasket,
  searchUberEats, summarizeUberEatsCarts, uberEatsDraftDeliveryLocation, uberEatsInternals, uberEatsMe, uberEatsMenu,
  uberEatsBasketHandoff, uberEatsDeliveryAddressFromCookies, uberEatsOrderConfirmation, verifyUberEatsDraftLines,
  verifyUberEatsDraftSchedule,
} from "../src/ubereats.js";

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

test("Uber Eats menu validates a scheduled local slot with the official time shape", async () => {
  let requestBody;
  const menu = await uberEatsMenu("store-1", {
    scheduledAt: "2026-07-21T08:00:00.000Z",
    timeZone: "Europe/Madrid",
    cookieHeader: "sid=test",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return Response.json({ data: {
        title: "Breakfast Store",
        isOpen: true,
        isWithinDeliveryRange: true,
        closedMessage: "",
        adaptedDeliveryHoursInfos: { timeRanges: { "2026-07-21": [{ startTime: 600, endTime: 630 }] } },
        sections: [{ items: [{ uuid: "toast", title: "Toast", price: 800 }] }],
      } });
    },
  });
  assert.equal(requestBody.diningMode, "DELIVERY");
  assert.deepEqual(requestBody.time, {
    scheduled: true,
    date: "2026-07-21",
    startTime: 600,
    startTimeMs: new Date("2026-07-21T08:00:00.000Z").getTime(),
    endTime: 630,
    deliveryType: "ASAP",
  });
  assert.equal(requestBody.cbType, "EATER_ENDORSED");
  assert.equal(menu.isOpen, true);
  assert.equal(menu.scheduledSlotAvailable, true);

  const unavailable = await uberEatsMenu("store-2", {
    scheduledAt: "2026-07-21T08:00:00.000Z",
    timeZone: "Europe/Madrid",
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ data: {
      title: "Unavailable Store",
      isOpen: true,
      isWithinDeliveryRange: true,
      closedMessage: "Delivery unavailable",
      adaptedDeliveryHoursInfos: { timeRanges: { "2026-07-21": [{ startTime: 600, endTime: 630 }] } },
    } }),
  });
  assert.equal(unavailable.isOpen, false);
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

test("Uber Eats does not misreport a rejected API payload as an expired login", async () => {
  await assert.rejects(() => uberEatsInternals.request("createDraftOrderV2", {}, {
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ status: "failure", data: { code: "400", message: "status code error" } }),
  }), (error) => {
    assert.equal(error.code, "UBEREATS_API_ERROR");
    assert.equal(error.details.upstreamCode, 400);
    return true;
  });
  await assert.rejects(() => uberEatsInternals.request("getUserV1", {}, {
    cookieHeader: "sid=test",
    fetchImpl: async () => Response.json({ status: "failure", code: 3, message: "status code error" }),
  }), { code: "AUTH_EXPIRED" });
});

test("Uber Eats basket prepare uses createDraftOrderV2 shape without mutation", async () => {
  const prepared = await createUberEatsBasket({ item: { name: "Water", unitPrice: 4.45 }, quantity: 2, source: { storeUuid: "store-1", itemUuid: "water-1", sectionUuid: "s", subsectionUuid: "ss", rawPrice: 445 } }, { prepareOnly: true });
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.payload.isMulticart, true);
  assert.equal(prepared.payload.shoppingCartItems[0].quantity, 2);
  assert.equal(prepared.payload.shoppingCartItems[0].price, 445);
  assert.equal(prepared.payload.shoppingCartItems[0].imageURL, null);
  assert.equal(prepared.payload.shoppingCartItems[0].specialInstructions, "");
  assert.equal(prepared.payload.shoppingCartItems[0].itemId, null);
  assert.equal(prepared.payload.useCredits, true);
  assert.deepEqual(prepared.payload.deliveryTime, { asap: true });
  assert.equal(prepared.payload.deliveryType, "ASAP");
  assert.equal(prepared.payload.currencyCode, "EUR");
  assert.equal(prepared.payload.interactionType, "door_to_door");
  assert.equal(prepared.payload.checkMultipleDraftOrdersCap, true);
});

test("Uber Eats schedules a created draft through updateDraftOrderV2", async () => {
  const location = { latitude: 36.5, longitude: -4.8, address: { title: "Test" }, reference: "place-1", type: "uber_places" };
  const cookieHeader = `sid=test; uev2.loc=${encodeURIComponent(JSON.stringify(location))}`;
  const operations = [];
  const bodies = [];
  const result = await createUberEatsBasket({
    item: { name: "Breakfast", unitPrice: 12.9 }, quantity: 1,
    source: { storeUuid: "store-1", itemUuid: "breakfast-1", rawPrice: 1290 },
  }, {
    scheduledAt: "2026-07-21T08:00:00.000Z",
    timeZone: "Europe/Madrid",
    cookieHeader,
    fetchImpl: async (url, options) => {
      const operation = String(url).split("/").at(-1);
      operations.push(operation);
      bodies.push(JSON.parse(options.body));
      if (operation === "createDraftOrderV2") return Response.json({ data: { draftOrder: { uuid: "draft-scheduled" } } });
      return Response.json({ data: { draftOrder: { uuid: "draft-scheduled", targetDeliveryTimeRange: bodies.at(-1).targetDeliveryTimeRange } } });
    },
  });
  assert.deepEqual(operations, ["createDraftOrderV2", "updateDraftOrderV2"]);
  assert.deepEqual(bodies[0].deliveryTime, { asap: true });
  assert.equal(bodies[0].targetDeliveryTimeRange, undefined);
  assert.deepEqual(bodies[1].targetDeliveryTimeRange, {
    scheduled: true,
    date: "2026-07-21",
    startTime: 600,
    startTimeMs: new Date("2026-07-21T08:00:00.000Z").getTime(),
    endTime: 630,
    deliveryType: "ASAP",
  });
  assert.deepEqual(bodies[1].deliveryAddress, location);
  assert.equal(result.scheduling.targetDeliveryTimeRange.startTime, 600);
  assert.deepEqual(uberEatsDeliveryAddressFromCookies(cookieHeader), location);
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

test("Uber Eats remote basket verification requires every selected line and quantity", () => {
  const carts = { draftOrders: [{
    uuid: "draft-1",
    shoppingCart: { items: [
      { title: "Pad Thai Original", quantity: 1 },
      { title: "Pad Thai Calle", quantity: 1 },
      { title: "Water", quantity: 2 },
    ] },
  }] };
  const expected = [
    { item: { name: "Pad Thai Calle" }, quantity: 1 },
    { item: { name: "Pad Thai Original" }, quantity: 1 },
    { item: { name: "Water" }, quantity: 2 },
  ];
  assert.deepEqual(verifyUberEatsDraftLines(carts, "draft-1", expected), {
    verified: true,
    lines: [
      { name: "pad thai calle", quantity: 1 },
      { name: "pad thai original", quantity: 1 },
      { name: "water", quantity: 2 },
    ],
    itemCount: 4,
  });
  assert.throws(() => verifyUberEatsDraftLines(carts, "draft-1", [
    ...expected,
    { item: { name: "Coca-Cola" }, quantity: 1 },
  ]), { code: "REMOTE_BASKET_MISMATCH" });
  assert.throws(() => verifyUberEatsDraftLines(carts, "missing", expected), { code: "REMOTE_BASKET_MISMATCH" });
});

test("Uber Eats scheduled draft verification requires the exact persisted local window", () => {
  const carts = { draftOrders: [{
    uuid: "draft-1",
    targetDeliveryTimeRange: { scheduled: true, date: "2026-07-21", startTime: 600, endTime: 630 },
  }] };
  const verified = verifyUberEatsDraftSchedule(carts, "draft-1", "2026-07-21T08:00:00.000Z", "Europe/Madrid");
  assert.equal(verified.verified, true);
  assert.equal(verified.selectedWindow.startMinute, 600);
  assert.throws(
    () => verifyUberEatsDraftSchedule(carts, "draft-1", "2026-07-21T09:00:00.000Z", "Europe/Madrid"),
    { code: "SCHEDULE_UNVERIFIED" },
  );
  assert.throws(() => verifyUberEatsDraftSchedule({ draftOrders: [{
    uuid: "draft-1", targetDeliveryTimeRange: { scheduled: true, startTime: 600, endTime: 630 },
  }] }, "draft-1", "2026-07-21T08:00:00.000Z", "Europe/Madrid"), { code: "SCHEDULE_UNVERIFIED" });
  assert.throws(() => verifyUberEatsDraftSchedule({ draftOrders: [{
    uuid: "draft-1", targetDeliveryTimeRange: { scheduled: true, date: "2026-07-21", startTime: 600, endTime: 645 },
  }] }, "draft-1", "2026-07-21T08:00:00.000Z", "Europe/Madrid"), { code: "SCHEDULE_UNVERIFIED" });
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

test("Uber Eats browser handoff identifies the exact multicart instead of using generic checkout", () => {
  const handoff = uberEatsBasketHandoff({
    merchant: { name: "Test Bakery" },
    basket: { id: "draft-water-snack" },
    lines: [
      { item: { name: "Water" }, quantity: 1 },
      { item: { name: "Chocolate muffin" }, quantity: 1 },
    ],
  });
  assert.equal(handoff.url, "https://www.ubereats.com/feed");
  assert.equal(handoff.directCheckout, false);
  assert.equal(handoff.handoff.mode, "select_existing_cart");
  assert.equal(handoff.handoff.draftOrderUuid, "draft-water-snack");
  assert.equal(handoff.handoff.merchantName, "Test Bakery");
  assert.deepEqual(handoff.handoff.expectedLines, [
    { name: "Water", quantity: 1 },
    { name: "Chocolate muffin", quantity: 1 },
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
        cartItems: { cartItemsWarnings: [] },
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

test("Uber Eats checkout fails closed when the provider omits requested cart validation", async () => {
  await assert.rejects(() => quoteUberEatsBasket("draft-without-cart-validation", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async () => Response.json({ data: {
      checkoutPayloads: {
        total: { total: { value: { amountE5: 1_239_000, currencyCode: "EUR" } } },
      },
      validationErrors: null,
    } }),
  }), { code: "CHECKOUT_UNVERIFIED" });
});

test("Uber Eats checkout rejects an API-priced basket that the official cart marks invalid", async () => {
  let requestBody;
  await assert.rejects(() => quoteUberEatsBasket("draft-below-minimum", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async (url, options) => {
      assert.match(String(url), /getCheckoutPresentationV1$/);
      requestBody = JSON.parse(options.body);
      return Response.json({ data: {
        checkoutPayloads: {
          cartItems: {
            cartItemsWarnings: [{
              title: "Adjust cart to place order",
              subtitle: "You are €16.00 away from the store minimum",
            }],
          },
          subtotal: { subtotal: { value: { amountE5: 400_000, currencyCode: "EUR" } } },
          total: { total: { value: { amountE5: 1_239_000, currencyCode: "EUR" } } },
        },
        validationErrors: [{ type: "INVALID_BASKET" }],
      } });
    },
  }), (error) => {
    assert.equal(error.code, "CHECKOUT_UNAVAILABLE");
    assert.deepEqual(error.details.issues, [{ type: "INVALID_BASKET", title: null }]);
    assert.deepEqual(error.details.warnings, [{
      title: "Adjust cart to place order",
      subtitle: "You are €16.00 away from the store minimum",
    }]);
    return true;
  });
  assert.ok(requestBody.payloadTypes.includes("cartItems"));
});

test("Uber Eats checkout rejects a store-minimum warning even without a validation error", async () => {
  await assert.rejects(() => quoteUberEatsBasket("draft-warning-only", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async () => Response.json({ data: {
      checkoutPayloads: {
        cartItems: {
          cartItemsWarnings: [{
            title: "Ajusta el carrito para realizar el pedido",
            subtitle: "Te faltan 8,00 € para alcanzar el pedido mínimo",
          }],
        },
        total: { total: { value: { amountE5: 900_000, currencyCode: "EUR" } } },
      },
      validationErrors: null,
    } }),
  }), { code: "CHECKOUT_UNAVAILABLE" });
});

test("Uber Eats scheduled checkout is exact only after line and remote schedule verification", async () => {
  const expectedLines = [{ item: { name: "Breakfast" }, quantity: 1 }];
  const result = await quoteUberEatsBasket("draft-scheduled", {
    scheduledAt: "2026-07-21T08:00:00.000Z",
    timeZone: "Europe/Madrid",
    expectedLines,
    cookieHeader: "sid=synthetic",
    fetchImpl: async (url) => {
      const operation = String(url).split("/").at(-1);
      if (operation === "getDraftOrdersByEaterUuidV1") return Response.json({ data: { draftOrders: [{
        uuid: "draft-scheduled",
        shoppingCart: { items: [{ title: "Breakfast", quantity: 1 }] },
        targetDeliveryTimeRange: { scheduled: true, date: "2026-07-21", startTime: 600, endTime: 630 },
      }] } });
      return Response.json({ data: { checkoutPayloads: {
        cartItems: { cartItemsWarnings: [] },
        subtotal: { subtotal: { value: { amountE5: 1_290_000, currencyCode: "EUR" } } },
        total: { total: { value: { amountE5: 1_699_000, currencyCode: "EUR" } } },
      }, validationErrors: [] } });
    },
  });
  assert.equal(result.remoteBasketVerification.verified, true);
  assert.equal(result.scheduleVerification.verified, true);
  assert.equal(result.fulfilment.status, "verified");
  assert.equal(result.pricing.total, 16.99);
  assert.equal(result.pricing.exact, true);
});

test("Uber Eats checkout captures exact promotion savings", async () => {
  const result = await quoteUberEatsBasket("draft-deal", {
    cookieHeader: "sid=synthetic",
    fetchImpl: async () => Response.json({ data: { checkoutPayloads: {
      cartItems: { cartItemsWarnings: [] },
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
