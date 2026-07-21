import assert from "node:assert/strict";
import test from "node:test";
import { glovoCheckoutReview, glovoStoreCatalog } from "../src/glovo.js";
import { shoppingItemsFlag } from "../src/orderscout.js";
import { uberEatsMenu } from "../src/ubereats.js";

const glovoSession = {
  source: "verification",
  cookieHeader: `glovo_auth_info=${encodeURIComponent(JSON.stringify({ accessToken: "a".repeat(48) }))}`,
};

test("Glovo batches an atomic grocery list into bounded in-store catalog requests", async () => {
  const searchQueries = [];
  const store = {
    id: "45649",
    addressId: "89495",
    name: "Supermercado DIA",
    categories: ["Supermercado"],
    open: true,
    url: "https://glovoapp.com/es/es/marbella/stores/supermercado-dia",
  };
  const catalog = await glovoStoreCatalog(store, [
    "huevos", "tomates", "pimiento verde", "cebolla", "ajo", "aceite oliva", "comino",
  ], { latitude: 36.5, longitude: -4.8, cityCode: "MBA" }, {
    batchQueries: true,
    batchSize: 4,
    concurrency: 1,
    requestDelayMs: 0,
    session: glovoSession,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/node/store_menu")) return Response.json({ data: { elements: [] } });
      if (parsed.pathname.endsWith("/search")) {
        const query = parsed.searchParams.get("query");
        searchQueries.push(query);
        const products = query === "huevos tomates pimiento verde cebolla"
          ? ["Huevos", "Tomates", "Pimiento verde", "Cebolla"].map((name, index) => ({ id: `a${index}`, storeProductId: `a${index}`, name, price: 1 }))
          : query === "ajo aceite oliva comino"
            ? ["Ajo", "Aceite de oliva"].map((name, index) => ({ id: `b${index}`, storeProductId: `b${index}`, name, price: 1 }))
            : [{ id: "c1", storeProductId: "c1", name: "Comino molido", price: 1 }];
        return Response.json({ results: [{ products }] });
      }
      throw new Error(`Unexpected Glovo request: ${parsed.pathname}`);
    },
  });

  assert.deepEqual(searchQueries, [
    "huevos tomates pimiento verde cebolla",
    "ajo aceite oliva comino",
    "comino",
  ]);
  assert.deepEqual(catalog.fallbackQueries, ["comino"]);
  assert.equal(catalog.cache.requestCount, 3);
  assert.equal(catalog.products.length, 7);
  assert.deepEqual(catalog.products.at(-1).matchedQueries, ["comino"]);
});

test("Uber Eats follows the official grocery catalog offsets until the catalog is complete", async () => {
  const bodies = [];
  const menu = await uberEatsMenu("eroski-store", {
    fullCatalog: true,
    pageDelayMs: 0,
    cookieHeader: "sid=test",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if (body.catalogSectionOffset === undefined) {
        return Response.json({ data: {
          title: "Eroski",
          isGr: true,
          isOpen: true,
          isWithinDeliveryRange: true,
          storeSessionUuid: "session-1",
          catalogSectionPagingInfo: { offset: 8, isFirstPage: true },
          sections: [{ items: [{ uuid: "bread", title: "Pan", price: 100 }] }],
        } });
      }
      return Response.json({ data: {
        title: "Eroski",
        isGr: true,
        catalogSectionPagingInfo: { offset: null, isFirstPage: false },
        sections: [{ items: [
          { uuid: "bread", title: "Pan", price: 100 },
          { uuid: "eggs", title: "Huevos", price: 250 },
        ] }],
      } });
    },
  });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].catalogSectionOffset, 8);
  assert.equal(bodies[1].storeSessionUuid, "session-1");
  assert.deepEqual(menu.items.map((item) => item.uuid), ["bread", "eggs"]);
  assert.equal(menu.catalogPageCount, 2);
  assert.equal(menu.catalogComplete, true);
});

test("Uber Eats does not apply grocery pagination to restaurant menus", async () => {
  let calls = 0;
  const menu = await uberEatsMenu("restaurant-store", {
    fullCatalog: true,
    pageDelayMs: 0,
    cookieHeader: "sid=test",
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ data: {
        title: "Restaurant",
        isGr: false,
        catalogSectionPagingInfo: { offset: 8 },
        sections: [{ items: [{ uuid: "dish", title: "Shakshuka", price: 1_200 }] }],
      } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(menu.catalogPageCount, 1);
  assert.equal(menu.catalogComplete, true);
});

test("Glovo checkout review reports payment selection as the blocker, not authentication", () => {
  const review = glovoCheckoutReview({
    enabled: true,
    components: [
      { id: "deliveryAddress", type: "addressPicker", addressPickerData: { value: { label: "Casa" } } },
      { id: "schedulingTime", type: "timeSelector", timeSelectorData: { selectors: [
        { value: "STANDARD", label: "Estándar", disabled: false, description: "25 min" },
      ] } },
      { id: "paymentMethod", type: "paymentMethodPicker", paymentMethodPickerData: { required: true, cash: false } },
      { id: "placeOrder", type: "button", buttonData: { label: "Pagar y realizar pedido" } },
    ],
  }, { pricing: { currency: "EUR", total: 50.7, exact: true } });

  assert.deepEqual(review.address, { status: "configured", label: "Casa" });
  assert.equal(review.timing.status, "verified");
  assert.equal(review.payment.status, "unavailable");
  assert.equal(review.checkoutEnabled, true);
  assert.equal(review.purchaseApprovalReady, false);
  assert.deepEqual(review.missing, ["payment method summary"]);
});

test("Recipe requests preserve every atomic grocery line", () => {
  const items = Array.from({ length: 15 }, (_, index) => ({
    id: `ingredient-${index + 1}`,
    intent: `Ingredient ${index + 1}`,
    catalogQueries: [`ingredient ${index + 1}`],
  }));
  const parsed = shoppingItemsFlag({ "shopping-items": JSON.stringify(items) });
  assert.equal(parsed.length, 15);
  assert.deepEqual(parsed.map((item) => item.id), items.map((item) => item.id));
});
