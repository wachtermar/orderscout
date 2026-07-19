import assert from "node:assert/strict";
import test from "node:test";
import { collectUberStores, createUberEatsBasket, normalizeUberSearch, quoteUberEatsBasket, searchUberEats, uberEatsInternals, uberEatsMe, uberEatsOrderConfirmation } from "../src/ubereats.js";

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

test("Uber Eats basket prepare uses createDraftOrderV2 shape without mutation", async () => {
  const prepared = await createUberEatsBasket({ item: { name: "Water", unitPrice: 4.45 }, quantity: 2, source: { storeUuid: "store-1", itemUuid: "water-1", sectionUuid: "s", subsectionUuid: "ss", rawPrice: 445 } }, { prepareOnly: true });
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.payload.isMulticart, true);
  assert.equal(prepared.payload.shoppingCartItems[0].quantity, 2);
  assert.equal(prepared.payload.shoppingCartItems[0].price, 445);
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
