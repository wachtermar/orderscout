import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeMenu,
  normalizeRestaurants,
  normalizeSavedAddresses,
  normalizeSlug,
  parseArgs,
  requestJson,
} from "../src/lib.js";

test("parseArgs supports flags, booleans, and positionals", () => {
  assert.deepEqual(parseArgs(["search", "28001", "--open", "--limit=3"]), {
    positionals: ["search", "28001"],
    flags: { open: true, limit: "3" },
  });
});

test("normalizeSlug accepts search result slugs and menu URLs", () => {
  assert.equal(normalizeSlug("burger-king-goya-madrid"), "burger-king-goya-madrid");
  assert.equal(
    normalizeSlug("https://www.just-eat.es/restaurants-burger-king-goya-madrid/menu"),
    "burger-king-goya-madrid",
  );
});

test("normalizeRestaurants filters, sorts, and limits", () => {
  const payload = {
    restaurants: [
      { id: "1", name: "Pizza One", uniqueName: "pizza-one", cuisines: [{ name: "Pizza" }], rating: { starRating: 4.1 } },
      { id: "2", name: "Pizza Two", uniqueName: "pizza-two", cuisines: [{ name: "Pizza" }], rating: { starRating: 4.8 } },
      { id: "3", name: "Sushi", uniqueName: "sushi", cuisines: [{ name: "Japonesa" }], rating: { starRating: 5 } },
    ],
  };
  const result = normalizeRestaurants(payload, { cuisine: "pizza", sort: "rating", limit: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "2");
  assert.equal(result[0].menuUrl, "https://www.just-eat.es/restaurants-pizza-two/menu");
});

test("normalizeMenu joins category item IDs to product records", () => {
  const result = normalizeMenu({
    slug: "demo",
    manifest: {
      RestaurantId: "7",
      MenuVersion: "v1",
      RestaurantInfo: { Name: "Demo" },
      Menus: [{ ServiceTypes: ["Delivery"], Categories: [{ Id: "c", Name: "Pizza", ItemIds: ["i"] }] }],
    },
    items: { Items: [{ Id: "i", Name: "Margherita", Variations: [{ Id: "v", BasePrice: 9.5 }] }] },
    details: { ModifierGroups: [], ModifierSets: [], DealGroups: [] },
  });
  assert.equal(result.categories[0].items[0].name, "Margherita");
  assert.equal(result.categories[0].items[0].variations[0].price, 9.5);
});

test("normalizeSavedAddresses accepts the account API's PascalCase shape", () => {
  const result = normalizeSavedAddresses([{
    AddressId: "a1",
    AddressName: "Casa",
    City: "Barcelona",
    ZipCode: "08001",
    Line1: "Carrer de prova, 1",
    Geolocation: { Latitude: 41.38, Longitude: 2.17 },
  }]);
  assert.deepEqual(result[0], {
    index: 0,
    id: "a1",
    name: "Casa",
    city: "Barcelona",
    postcode: "08001",
    lines: ["Carrer de prova, 1"],
    latitude: 41.38,
    longitude: 2.17,
    additionalInformation: {},
  });
});

test("requestJson never retries mutating requests automatically", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("failure", { status: 500 });
  };
  await assert.rejects(
    () => requestJson("https://example.test/basket", { method: "POST" }, fetchImpl),
    { code: "HTTP_ERROR" },
  );
  assert.equal(calls, 1);
});
