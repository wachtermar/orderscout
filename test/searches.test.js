import assert from "node:assert/strict";
import test from "node:test";
import { applyIntent } from "../src/searches.js";

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
