import assert from "node:assert/strict";
import test from "node:test";
import { createGlovoBasket, glovoInternals } from "../src/glovo.js";

test("Glovo browser cookie token is parsed without exposing other cookies", () => {
  const encoded = encodeURIComponent(JSON.stringify({ access: { accessToken: "a".repeat(40) } }));
  assert.equal(glovoInternals.accessToken({ cookieHeader: `other=secret; glovo_auth_info=${encoded}` }), "a".repeat(40));
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

