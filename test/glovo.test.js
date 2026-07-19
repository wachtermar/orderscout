import assert from "node:assert/strict";
import test from "node:test";
import { createGlovoBasket, glovoAddresses, glovoInternals, glovoOrderConfirmation, glovoSubmissionRequest, normalizeGlovoQuote, placeGlovoOrder } from "../src/glovo.js";

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
