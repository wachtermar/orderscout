import assert from "node:assert/strict";
import test from "node:test";
import { collectUberStores, createUberEatsBasket, normalizeUberSearch, searchUberEats, uberEatsMe, uberEatsOrderConfirmation } from "../src/ubereats.js";

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

test("Uber Eats final order requires a stable confirmation fingerprint", () => {
  const first = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  const second = uberEatsOrderConfirmation("draft-1", { totalAmount: 1809, currencyCode: "EUR" });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.total, 18.09);
});
