import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBasketPayload,
  buildCheckoutPatch,
  buildPaymentRequest,
  compareCandidates,
  createBasket,
  createBrowserHandoff,
  placeOrder,
  normalizeCheckout,
  optimizeWaterBasket,
} from "../src/order.js";

process.env.JUSTEAT_CONFIG_DIR = await mkdtemp(join(tmpdir(), "justeat-order-test-"));

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "12345678-test-plan",
    recommendation: {
      location: { latitude: 36.51, longitude: -4.89, postcode: "29603" },
      candidates: [{
        restaurant: { slug: "test-store", name: "Test Store" },
        menuGroupId: "menu-group",
        item: { variationId: "water-variation", name: "Water" },
        quantity: 4,
        modifierGroups: [],
      }],
    },
    remote: null,
    ...overrides,
  };
}

test("buildBasketPayload creates the observed Just Eat basket schema", () => {
  const payload = buildBasketPayload(plan(), 0);
  assert.equal(payload.restaurantSeoName, "test-store");
  assert.equal(payload.products[0].productId, "water-variation");
  assert.equal(payload.products[0].quantity, 4);
  assert.deepEqual(payload.orderDetails.location.geoLocation, { latitude: 36.51, longitude: -4.89 });
});

test("required modifiers must be selected before basket creation", () => {
  const configured = plan();
  configured.recommendation.candidates[0].modifierGroups = [{
    id: "protein",
    name: "Choose protein",
    minChoices: 1,
    maxChoices: 1,
    choices: [{ id: "chicken", setId: "1", name: "Chicken", defaultChoices: 0 }],
  }];
  assert.throws(() => buildBasketPayload(configured), { code: "MODIFIERS_REQUIRED" });
  const payload = buildBasketPayload(configured, 0, { modifiers: { protein: ["chicken"] } });
  assert.deepEqual(payload.products[0].modifierGroups, [{
    modifierGroupId: "protein",
    modifiers: [{ modifierId: "chicken", quantity: 1 }],
  }]);
});

test("createBasket can be verified with an injected API without placing an order", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ basketId: "basket-123" });
  };
  const result = await createBasket(plan(), 0, { fetchImpl });
  assert.equal(result.plan.remote.basketId, "basket-123");
  assert.equal(requestBody.products[0].quantity, 4);
});

test("browser handoff converts a basket to an official restorable group basket", async () => {
  const created = plan({
    remote: { basketId: "basket-123", candidateIndex: 0, lastQuote: null },
  });
  let patch;
  const result = await createBrowserHandoff(created, {
    token: "test-token",
    fetchImpl: async (input, options) => {
      assert.equal(new URL(input).pathname, "/basket/basket-123");
      assert.equal(options.method, "PATCH");
      assert.equal(options.headers["content-type"], "application/json-patch+json");
      patch = JSON.parse(options.body);
      return Response.json({
        BasketId: "basket-123",
        BasketMode: "Group",
        GroupSummary: {
          GroupSummaryId: "basket-123",
          Status: "Open",
          Url: "https://www.just-eat.es/group-order/basket-123/join?restaurant=test-store&groupName=test",
        },
      });
    },
  });
  assert.deepEqual(patch, [{ op: "replace", path: "/BasketMode", value: "Group" }]);
  assert.equal(result.handoff.status, "Open");
  assert.equal(result.plan.remote.browserHandoff.mode, "Group");
});

test("payment placement is preview-first and fingerprint protected", async () => {
  const quoted = plan({
    remote: {
      basketId: "basket-123",
      lastQuote: {
        id: "checkout-123",
        total: 12.34,
        currency: "EUR",
        payment: { methods: [{ type: "Cash", id: "cash" }] },
      },
    },
  });
  const payment = buildPaymentRequest(quoted);
  assert.equal(payment.checkoutId, "checkout-123");
  const preview = await placeOrder(quoted);
  assert.equal(preview.submitted, false);
  assert.equal(preview.requiresConfirmation, payment.fingerprint);
  await assert.rejects(() => placeOrder(quoted, { confirm: "wrong" }), { code: "CONFIRMATION_MISMATCH" });

  process.env.JUSTEAT_ENABLE_ORDER_PLACEMENT = "1";
  try {
    await assert.rejects(
      () => placeOrder(quoted, {
        confirm: payment.fingerprint,
        fetchImpl: async () => { throw new Error("connection lost"); },
      }),
      { code: "ORDER_STATUS_UNKNOWN" },
    );
  } finally {
    delete process.env.JUSTEAT_ENABLE_ORDER_PLACEMENT;
  }
});

test("normalizeCheckout exposes delivered total, fees, and minimum-order constraints", () => {
  const result = normalizeCheckout({
    currency: "EUR",
    purchase: {
      lineItems: [
        { type: "subtotal", price: { amount: 445 } },
        { type: "fee", tags: ["deliveryFee"], price: { amount: 399 } },
        { type: "fee", tags: ["serviceFee"], price: { amount: 75 } },
      ],
      total: { price: { amount: 919, formattedAmount: "€ 9,19" } },
    },
    isFulfillable: false,
    issues: [{ code: "MINIMUM_ORDER_VALUE_NOT_MET", minimumOrderValue: 1000, additionalSpendRequired: 555 }],
  });
  assert.equal(result.total, 9.19);
  assert.equal(result.deliveryFeeCents, 399);
  assert.equal(result.serviceFeeCents, 75);
  assert.equal(result.additionalSpendRequiredCents, 555);
});

test("buildCheckoutPatch maps account details to the checkout JSON Patch schema", () => {
  const patch = buildCheckoutPatch(
    { FirstName: "Ada", LastName: "Lovelace", PhoneNumber: "+34123456789" },
    { lines: ["Calle Test, 1"], city: "Marbella", postcode: "29603", latitude: 36.5, longitude: -4.8 },
  );
  assert.deepEqual(patch.find((entry) => entry.path === "/customer"), {
    op: "add",
    path: "/customer",
    value: { firstName: "Ada", lastName: "Lovelace", phoneNumber: "+34123456789" },
  });
  assert.deepEqual(patch.find((entry) => entry.path === "/fulfilment/time").value, {
    asap: true, scheduled: null,
  });
});

test("compareCandidates ranks validated delivered totals", async () => {
  const comparisonPlan = plan();
  comparisonPlan.recommendation.candidates.push({
    ...comparisonPlan.recommendation.candidates[0],
    index: 1,
    restaurant: { slug: "second-store", name: "Second Store" },
    item: { variationId: "second-water", name: "Second Water" },
  });
  comparisonPlan.recommendation.candidates[0].index = 0;
  let basketNumber = 0;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/basket") {
      basketNumber += 1;
      return Response.json({ basketId: `basket-${basketNumber}` });
    }
    const amount = url.pathname.endsWith("basket-1") ? 1_200 : 900;
    return Response.json({
      currency: "EUR",
      purchase: { lineItems: [], total: { price: { amount } } },
      issues: [],
      isFulfillable: true,
    });
  };
  const result = await compareCandidates(comparisonPlan, { create: true, limit: 2, fetchImpl });
  assert.equal(result.comparisons[0].restaurant.slug, "second-store");
  assert.equal(result.comparisons[0].quote.total, 9);
});

test("optimizeWaterBasket satisfies litres and minimum subtotal at lowest cost", () => {
  const waterPlan = plan({
    recommendation: {
      intent: { kind: "water", targetLiters: 6 },
      location: { latitude: 36.51, longitude: -4.89, postcode: "29603" },
      candidates: [
        {
          index: 0,
          restaurant: { slug: "test-store", name: "Test Store" },
          menuGroupId: "menu-group",
          item: { variationId: "pack", name: "9L pack", unitPrice: 4.45 },
          quantity: 1,
          package: { totalLiters: 9 },
          modifierGroups: [],
        },
        {
          index: 1,
          restaurant: { slug: "test-store", name: "Test Store" },
          menuGroupId: "menu-group",
          item: { variationId: "bottle", name: "1.5L bottle", unitPrice: 1.8 },
          quantity: 4,
          package: { totalLiters: 1.5 },
          modifierGroups: [],
        },
      ],
    },
    remote: {
      basketId: "basket-123",
      candidateIndex: 0,
      lastQuote: {
        currency: "EUR",
        purchase: { lineItems: [], total: { price: { amount: 919 } } },
        issues: [{ code: "MINIMUM_ORDER_VALUE_NOT_MET", minimumOrderValue: 1000, additionalSpendRequired: 555 }],
      },
    },
  });
  const optimized = optimizeWaterBasket(waterPlan, 0);
  assert.equal(optimized.subtotal, 10.8);
  assert.equal(optimized.suppliedLiters, 9);
  assert.deepEqual(optimized.lines.map(({ candidateIndex, quantity }) => ({ candidateIndex, quantity })), [
    { candidateIndex: 1, quantity: 6 },
  ]);
  const payload = buildBasketPayload(waterPlan, 1, { lines: optimized.lines });
  assert.equal(payload.products[0].quantity, 6);
});
