import assert from "node:assert/strict";
import test from "node:test";
import { createUberEatsBasket, normalizeUberSearch, uberEatsOrderConfirmation } from "../src/ubereats.js";

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
});

test("Uber Eats basket prepare uses createDraftOrderV2 shape without mutation", async () => {
  const prepared = await createUberEatsBasket({ item: { name: "Water", unitPrice: 4.45 }, quantity: 2, source: { storeUuid: "store-1", itemUuid: "water-1", sectionUuid: "s", subsectionUuid: "ss", rawPrice: 445 } }, { prepareOnly: true });
  assert.equal(prepared.mutated, false);
  assert.equal(prepared.payload.isMulticart, true);
  assert.equal(prepared.payload.shoppingCartItems[0].quantity, 2);
  assert.equal(prepared.payload.shoppingCartItems[0].price, 445);
});

test("Uber Eats final order requires a stable confirmation fingerprint", () => {
  const first = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  const second = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.total, 18.09);
});
