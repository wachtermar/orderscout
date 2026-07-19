import assert from "node:assert/strict";
import test from "node:test";
import { applyIntent, providerRoutes } from "../src/searches.js";
import { defaultAccounts, publicAccountStatus } from "../src/providers.js";
import { parseObjective } from "../src/ranking.js";

test("taste-focused requests use the quality objective", () => {
  assert.equal(parseObjective("healthy but very tasty"), "best");
});

test("a recorded Work browser session never replaces direct CLI provider routing", () => {
  const accounts = defaultAccounts();
  accounts.providers.ubereats.authenticated = true;
  accounts.providers.ubereats.transport = "browser";
  accounts.providers.ubereats.addressSelected = true;
  const uber = publicAccountStatus(accounts).providers.find((provider) => provider.id === "ubereats");
  assert.equal(uber.transport, "browser");
  assert.equal(uber.addressSelected, true);
  assert.equal(uber.authenticated, true);
  assert.deepEqual(providerRoutes(["justeat", "glovo", "ubereats"], accounts), {
    apiProviders: ["justeat", "glovo", "ubereats"],
    browserProviders: [],
  });
});

test("water intent computes packs and excludes sparkling water and soft drinks", () => {
  const offers = applyIntent([
    { item: { name: "Font Vella Agua 6 x 1.5 L", unitPrice: 4.45 }, pricing: { currency: "EUR" } },
    { item: { name: "Agua con gas 6 x 1 L", unitPrice: 3.5 }, pricing: { currency: "EUR" } },
    { item: { name: "Aquarius 1.5 L", unitPrice: 2.1 }, pricing: { currency: "EUR" } },
  ], "20 litros de agua sin gas");

  assert.equal(offers.length, 1);
  assert.equal(offers[0].quantity, 3);
  assert.equal(offers[0].package.packCount, 6);
  assert.equal(offers[0].suppliedLiters, 27);
  assert.equal(offers[0].pricing.subtotal, 13.35);
});

test("meal intent applies party size, total budget, and health signals", () => {
  const offers = applyIntent([
    { merchant: { name: "Poke", rating: 4.8 }, item: { name: "Poke de salmón y verduras", unitPrice: 13 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Pizza", rating: 4.9 }, item: { name: "Pizza frita", unitPrice: 9 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Chicken", rating: 4.9 }, item: { name: "Filete de pollo empanado", unitPrice: 4 }, pricing: { currency: "EUR" } },
    { merchant: { name: "Premium", rating: 5 }, item: { name: "Ensalada de pollo", unitPrice: 16 }, pricing: { currency: "EUR" } },
  ], "healthy tasty meal for two under €30");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].quantity, 2);
  assert.equal(offers[0].pricing.subtotal, 26);
  assert.ok(offers[0].signals.health > 0);
  assert.equal(offers[0].signals.taste, 96);
});
