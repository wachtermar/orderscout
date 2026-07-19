import assert from "node:assert/strict";
import test from "node:test";
import { createGlovoBasket, enrichGlovoOffers, glovoAddresses, glovoInternals, glovoOrderConfirmation, glovoSubmissionRequest, normalizeGlovoQuote, placeGlovoOrder } from "../src/glovo.js";

test("Glovo browser cookie token is parsed without exposing other cookies", () => {
  const encoded = encodeURIComponent(JSON.stringify({ access: { accessToken: "a".repeat(40) } }));
  assert.equal(glovoInternals.accessToken({ cookieHeader: `other=secret; glovo_auth_info=${encoded}` }), "a".repeat(40));
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
