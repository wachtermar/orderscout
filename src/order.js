import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, requestJson } from "./lib.js";

const API_BASE = "https://i18n.api.just-eat.io";

function stateDirectory() {
  return process.env.JUSTEAT_CONFIG_DIR || join(homedir(), ".config", "justeat-es-cli");
}

function plansDirectory() {
  return join(stateDirectory(), "plans");
}

function validatePlanId(value) {
  const id = String(value ?? "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new CliError("A valid plan ID is required");
  return id;
}

async function ensurePlansDirectory() {
  await mkdir(plansDirectory(), { recursive: true, mode: 0o700 });
  await chmod(stateDirectory(), 0o700);
  await chmod(plansDirectory(), 0o700);
}

export async function savePlan(recommendation) {
  const id = randomUUID();
  const plan = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    recommendation,
    remote: null,
  };
  await writePlan(plan);
  return plan;
}

export async function writePlan(plan) {
  await ensurePlansDirectory();
  const path = join(plansDirectory(), `${validatePlanId(plan.id)}.json`);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return plan;
}

export async function loadPlan(id) {
  const planId = validatePlanId(id);
  try {
    const plan = JSON.parse(await readFile(join(plansDirectory(), `${planId}.json`), "utf8"));
    if (plan.schemaVersion !== 1 || plan.id !== planId) throw new Error("schema mismatch");
    return plan;
  } catch (error) {
    if (error?.code === "ENOENT") throw new CliError(`Order plan not found: ${planId}`, "PLAN_NOT_FOUND");
    if (error instanceof CliError) throw error;
    throw new CliError(`Order plan is unreadable: ${planId}`, "INVALID_PLAN");
  }
}

function normalizeModifierSelections(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new CliError("--modifiers must be a JSON object keyed by modifier group ID");
  }
}

function selectedModifierGroups(candidate, selectionValue) {
  const selections = normalizeModifierSelections(selectionValue);
  return (candidate.modifierGroups ?? []).map((group) => {
    const requested = Array.isArray(selections[group.id]) ? selections[group.id] : [];
    const defaults = group.choices.filter((choice) => choice.defaultChoices > 0).map((choice) => choice.id);
    const selectedIds = requested.length ? requested : defaults;
    if (selectedIds.length < group.minChoices || selectedIds.length > group.maxChoices) {
      throw new CliError(`Modifier group "${group.name ?? group.id}" requires ${group.minChoices}-${group.maxChoices} choices`, "MODIFIERS_REQUIRED", {
        group,
      });
    }
    const choices = selectedIds.map((id) => group.choices.find((choice) => choice.id === id || choice.setId === id));
    if (choices.some((choice) => !choice)) {
      throw new CliError(`Unknown choice in modifier group "${group.name ?? group.id}"`, "INVALID_MODIFIER", { group });
    }
    return {
      modifierGroupId: group.id,
      modifiers: choices.map((choice) => ({ modifierId: choice.id, quantity: 1 })),
    };
  });
}

export function buildBasketPayload(plan, candidateIndex = 0, options = {}) {
  if (plan.recommendation.intent?.allergyMentioned && !options.allergenReviewed) {
    throw new CliError("This request mentions an allergy; verify with the restaurant, then pass --allergen-reviewed", "ALLERGEN_REVIEW_REQUIRED");
  }
  const candidate = plan.recommendation.candidates?.[candidateIndex];
  if (!candidate) throw new CliError(`Candidate ${candidateIndex} does not exist`, "CANDIDATE_NOT_FOUND");
  const location = plan.recommendation.location;
  if (!Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) {
    throw new CliError("The order plan has no usable delivery coordinates", "INVALID_LOCATION");
  }
  const lines = options.lines ?? [{ candidateIndex, quantity: options.quantity ?? candidate.quantity ?? 1 }];
  const restaurantSlug = candidate.restaurant.slug;
  const products = lines.map((line) => {
    const lineCandidate = plan.recommendation.candidates?.[line.candidateIndex];
    if (!lineCandidate) throw new CliError(`Candidate ${line.candidateIndex} does not exist`, "CANDIDATE_NOT_FOUND");
    if (lineCandidate.restaurant.slug !== restaurantSlug) {
      throw new CliError("A Just Eat basket can contain products from only one restaurant", "MIXED_RESTAURANTS");
    }
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new CliError("Basket quantities must be integers between 1 and 99");
    }
    const modifierValue = options.lineModifiers?.[line.candidateIndex] ?? options.modifiers;
    return {
      date: new Date().toISOString(),
      productId: lineCandidate.item.variationId,
      quantity,
      customerNotes: options.note || undefined,
      modifierGroups: selectedModifierGroups(lineCandidate, modifierValue),
      dealGroups: [],
    };
  });
  return {
    deals: [],
    products,
    orderDetails: {
      location: {
        zipCode: location.postcode ?? null,
        geoLocation: {
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
        },
      },
    },
    menuGroupId: candidate.menuGroupId,
    restaurantSeoName: candidate.restaurant.slug,
    serviceType: "delivery",
    consents: [],
  };
}

function apiHeaders(token, contentType = "application/json") {
  return {
    "content-type": contentType,
    "accept-tenant": "es",
    "accept-language": "es-ES",
    "x-language-code": "es",
    "x-country-code": "ES",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function basketIdFrom(payload) {
  return payload?.basketId ?? payload?.BasketId ?? payload?.id ?? payload?.data?.id ?? payload?.data?.basketId;
}

export async function createBasket(plan, candidateIndex, options = {}) {
  const payload = buildBasketPayload(plan, candidateIndex, options);
  const response = await requestJson(`${API_BASE}/basket`, {
    method: "POST",
    headers: apiHeaders(options.token),
    body: JSON.stringify(payload),
  }, options.fetchImpl);
  const basketId = basketIdFrom(response);
  if (!basketId) throw new CliError("Just Eat created a basket without returning its ID", "BASKET_PROTOCOL_ERROR");
  const updated = {
    ...plan,
    remote: {
      basketId,
      candidateIndex,
      createdAt: new Date().toISOString(),
      lastQuote: null,
    },
  };
  await writePlan(updated);
  return { plan: updated, payload, response };
}

export async function createBrowserHandoff(plan, options = {}) {
  const basketId = plan.remote?.basketId;
  if (!basketId) throw new CliError("Create the selected basket before opening it in the browser", "BASKET_REQUIRED");
  if (!options.token) throw new CliError("Authentication is required to create a browser basket handoff", "AUTH_REQUIRED");

  const response = await requestJson(`${API_BASE}/basket/${encodeURIComponent(basketId)}`, {
    method: "PATCH",
    headers: apiHeaders(options.token, "application/json-patch+json"),
    body: JSON.stringify([{ op: "replace", path: "/BasketMode", value: "Group" }]),
  }, options.fetchImpl);
  const summary = response?.GroupSummary ?? response?.groupSummary;
  const value = summary?.Url ?? summary?.url;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("Just Eat did not return a valid browser handoff URL", "BASKET_HANDOFF_ERROR");
  }
  const expectedPath = `/group-order/${encodeURIComponent(basketId)}/join`;
  if (url.origin !== "https://www.just-eat.es" || url.pathname !== expectedPath) {
    throw new CliError("Just Eat returned an untrusted browser handoff URL", "BASKET_HANDOFF_ERROR");
  }

  const candidateIndex = plan.remote?.candidateIndex ?? 0;
  const expectedRestaurant = plan.recommendation.candidates?.[candidateIndex]?.restaurant?.slug;
  if (expectedRestaurant && url.searchParams.get("restaurant") !== expectedRestaurant) {
    throw new CliError("The browser handoff belongs to a different merchant", "BASKET_HANDOFF_ERROR");
  }
  const handoff = {
    mode: response?.BasketMode ?? response?.basketMode ?? "Group",
    status: summary?.Status ?? summary?.status ?? null,
    groupId: summary?.GroupSummaryId ?? summary?.groupSummaryId ?? basketId,
    url: url.toString(),
    createdAt: new Date().toISOString(),
  };
  const updated = { ...plan, remote: { ...plan.remote, browserHandoff: handoff } };
  await writePlan(updated);
  return { plan: updated, handoff };
}

export function optimizeWaterBasket(plan, candidateIndex = 0) {
  const selected = plan.recommendation.candidates?.[candidateIndex];
  if (!selected?.package || !plan.remote?.lastQuote) {
    throw new CliError("Water optimization requires a quoted water candidate", "QUOTE_REQUIRED");
  }
  if (plan.remote.candidateIndex !== candidateIndex) {
    throw new CliError("The saved quote belongs to a different candidate", "STALE_QUOTE", {
      quotedCandidate: plan.remote.candidateIndex,
      requestedCandidate: candidateIndex,
    });
  }
  const normalized = normalizeCheckout(plan.remote.lastQuote);
  const minimumCents = normalized.minimumOrderValueCents
    ?? plan.optimization?.minimumOrderValueCents
    ?? 0;
  const targetMilliliters = Math.round(Number(plan.recommendation.intent?.targetLiters ?? selected.requestedLiters) * 1_000);
  const items = (plan.recommendation.candidates ?? []).filter((candidate) =>
    candidate.restaurant.slug === selected.restaurant.slug && candidate.package && candidate.item?.unitPrice > 0)
    .map((candidate) => ({
      candidateIndex: candidate.index,
      cost: Math.round(candidate.item.unitPrice * 100),
      milliliters: Math.round(candidate.package.totalLiters * 1_000),
      name: candidate.item.name,
    }));
  if (!items.length) throw new CliError("No compatible water products are available", "CANDIDATE_NOT_FOUND");
  const maxCost = Math.max(...items.map((item) => item.cost));
  const costCap = Math.max(minimumCents, Math.min(...items.map((item) =>
    Math.ceil(targetMilliliters / item.milliliters) * item.cost))) + maxCost * 2;
  const minimumItemCost = Math.min(...items.map((item) => item.cost));
  const volumeCap = targetMilliliters + Math.max(...items.map((item) => item.milliliters))
    * (Math.ceil(minimumCents / minimumItemCost) + 2);
  const states = Array.from({ length: costCap + 1 }, () => new Map());
  states[0].set(0, new Map());
  for (let cost = 0; cost <= costCap; cost += 1) {
    for (const [milliliters, currentCounts] of states[cost]) {
      for (const item of items) {
        const nextCost = cost + item.cost;
        const nextMilliliters = milliliters + item.milliliters;
        if (nextCost > costCap || nextMilliliters > volumeCap || states[nextCost].has(nextMilliliters)) continue;
        const counts = new Map(currentCounts);
        counts.set(item.candidateIndex, (counts.get(item.candidateIndex) ?? 0) + 1);
        states[nextCost].set(nextMilliliters, counts);
      }
    }
  }
  const winners = [];
  for (let cost = minimumCents; cost <= costCap; cost += 1) {
    for (const [milliliters, counts] of states[cost]) {
      if (milliliters >= targetMilliliters) winners.push({ cost, milliliters, counts });
    }
  }
  winners.sort((left, right) => left.milliliters - right.milliliters || left.cost - right.cost);
  const winner = winners[0];
  if (!winner) throw new CliError("Could not satisfy the quantity and minimum-order constraints", "OPTIMIZATION_FAILED");
  const lines = [...winner.counts].map(([index, quantity]) => ({ candidateIndex: index, quantity }));
  return {
    restaurant: selected.restaurant,
    targetLiters: targetMilliliters / 1_000,
    suppliedLiters: winner.milliliters / 1_000,
    subtotalCents: winner.cost,
    subtotal: winner.cost / 100,
    minimumOrderValueCents: minimumCents,
    lines: lines.map((line) => ({
      ...line,
      item: plan.recommendation.candidates[line.candidateIndex].item,
      package: plan.recommendation.candidates[line.candidateIndex].package,
    })),
  };
}

export async function saveOptimization(plan, optimization) {
  const updated = { ...plan, optimization: { createdAt: new Date().toISOString(), ...optimization } };
  await writePlan(updated);
  return updated;
}

export async function getCheckout(plan, options = {}) {
  const basketId = plan.remote?.basketId;
  if (!basketId) throw new CliError("Prepare the plan with `order prepare --create` first", "BASKET_REQUIRED");
  const quote = await requestJson(`${API_BASE}/checkout/es/${encodeURIComponent(basketId)}`, {
    headers: apiHeaders(options.token),
  }, options.fetchImpl);
  const updated = {
    ...plan,
    remote: { ...plan.remote, lastQuote: quote, quotedAt: new Date().toISOString() },
  };
  await writePlan(updated);
  return { plan: updated, quote };
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function normalizeCheckout(quote) {
  const lineItems = quote?.purchase?.lineItems ?? [];
  const amountForTag = (tag) => cents(lineItems.find((item) => item.tags?.includes(tag))?.price?.amount);
  const subtotalCents = cents(lineItems.find((item) => item.type === "subtotal")?.price?.amount);
  const totalCents = cents(quote?.purchase?.total?.price?.amount ?? quote?.total);
  const minimumIssue = quote?.issues?.find((issue) => issue.code === "MINIMUM_ORDER_VALUE_NOT_MET");
  return {
    currency: quote?.currency ?? "EUR",
    subtotalCents,
    deliveryFeeCents: amountForTag("deliveryFee"),
    serviceFeeCents: amountForTag("serviceFee"),
    bagFeeCents: amountForTag("bagFee"),
    totalCents,
    total: totalCents === null ? null : totalCents / 100,
    formattedTotal: quote?.purchase?.total?.price?.formattedAmount ?? null,
    isFulfillable: quote?.isFulfillable ?? false,
    minimumOrderValueCents: cents(minimumIssue?.minimumOrderValue),
    additionalSpendRequiredCents: cents(minimumIssue?.additionalSpendRequired),
    issues: (quote?.issues ?? []).map((issue) => ({ code: issue.code, ...issue })),
    paymentMethods: quote?.payment?.methods ?? [],
  };
}

export async function compareCandidates(plan, options = {}) {
  const limit = Number(options.limit ?? 3);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new CliError("--top must be an integer between 1 and 10");
  }
  const selected = [];
  const seenRestaurants = new Set();
  for (const candidate of plan.recommendation.candidates ?? []) {
    if (seenRestaurants.has(candidate.restaurant.slug)) continue;
    selected.push(candidate);
    seenRestaurants.add(candidate.restaurant.slug);
    if (selected.length >= limit) break;
  }
  if (!selected.length) throw new CliError("The plan has no candidates", "CANDIDATE_NOT_FOUND");
  if (!options.create) {
    return {
      created: false,
      candidates: selected.map((candidate) => ({
        candidateIndex: candidate.index,
        restaurant: candidate.restaurant,
        item: candidate.item,
        quantity: candidate.quantity,
        itemTotal: candidate.itemTotal,
      })),
    };
  }
  const comparisons = [];
  for (const candidate of selected) {
    try {
      const payload = buildBasketPayload(plan, candidate.index, options);
      const basket = await requestJson(`${API_BASE}/basket`, {
        method: "POST",
        headers: apiHeaders(options.token),
        body: JSON.stringify(payload),
      }, options.fetchImpl);
      const basketId = basketIdFrom(basket);
      if (!basketId) throw new CliError("Basket ID missing", "BASKET_PROTOCOL_ERROR");
      const quote = await requestJson(`${API_BASE}/checkout/es/${encodeURIComponent(basketId)}`, {
        headers: apiHeaders(options.token),
      }, options.fetchImpl);
      comparisons.push({
        candidateIndex: candidate.index,
        restaurant: candidate.restaurant,
        item: candidate.item,
        quantity: candidate.quantity,
        basketId,
        quote: normalizeCheckout(quote),
        rawQuote: options.raw ? quote : undefined,
      });
    } catch (error) {
      comparisons.push({
        candidateIndex: candidate.index,
        restaurant: candidate.restaurant,
        item: candidate.item,
        error: { code: error.code ?? "QUOTE_FAILED", message: error.message },
      });
    }
  }
  comparisons.sort((left, right) => {
    if (left.error && !right.error) return 1;
    if (!left.error && right.error) return -1;
    const leftRequired = (left.quote?.totalCents ?? Infinity) + (left.quote?.additionalSpendRequiredCents ?? 0);
    const rightRequired = (right.quote?.totalCents ?? Infinity) + (right.quote?.additionalSpendRequiredCents ?? 0);
    return leftRequired - rightRequired;
  });
  const updated = {
    ...plan,
    comparisons: { createdAt: new Date().toISOString(), results: comparisons },
  };
  await writePlan(updated);
  return { created: true, comparisons };
}

export async function patchCheckout(plan, patch, options = {}) {
  const basketId = plan.remote?.basketId;
  if (!basketId) throw new CliError("Prepare the plan before updating checkout", "BASKET_REQUIRED");
  if (!Array.isArray(patch) || patch.some((entry) => !entry?.op || !entry?.path)) {
    throw new CliError("Checkout patch must be a JSON Patch array", "INVALID_CHECKOUT_PATCH");
  }
  return requestJson(`${API_BASE}/checkout/es/${encodeURIComponent(basketId)}`, {
    method: "PATCH",
    headers: apiHeaders(options.token),
    body: JSON.stringify(patch),
  }, options.fetchImpl);
}

function valueFrom(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
  }
  return null;
}

export function buildCheckoutPatch(profile, address, options = {}) {
  const firstName = valueFrom(profile, ["firstName", "FirstName", "givenName", "GivenName"]);
  const lastName = valueFrom(profile, ["lastName", "LastName", "familyName", "FamilyName"]);
  const phoneNumber = valueFrom(profile, ["phoneNumber", "PhoneNumber", "phone", "Phone"]);
  const lines = address?.lines ?? [
    valueFrom(address, ["line1", "Line1"]),
    valueFrom(address, ["line2", "Line2"]),
    valueFrom(address, ["line3", "Line3"]),
  ].filter(Boolean);
  const locality = valueFrom(address, ["city", "City", "locality", "Locality"]);
  const postalCode = valueFrom(address, ["postcode", "PostCode", "zipCode", "ZipCode"]);
  const latitude = Number(valueFrom(address, ["latitude", "Latitude"]));
  const longitude = Number(valueFrom(address, ["longitude", "Longitude"]));
  const required = { firstName, lastName, phoneNumber, lines: lines?.length ? lines : null, locality, postalCode };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new CliError("Account details are incomplete for checkout", "CHECKOUT_DETAILS_REQUIRED", { missing });
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new CliError("Saved address has no checkout coordinates", "INVALID_LOCATION");
  }
  return [
    { op: "add", path: "/customer", value: { firstName, lastName, phoneNumber } },
    {
      op: "add",
      path: "/fulfilment/location",
      value: {
        address: { lines, locality, postalCode },
        geolocation: { latitude, longitude },
      },
    },
    {
      op: "add",
      path: "/fulfilment/time",
      value: options.scheduled
        ? { asap: false, scheduled: options.scheduled }
        : { asap: true, scheduled: null },
    },
  ];
}

function findValue(object, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], object);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function parseMethods(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new CliError("--methods must be a JSON payment-method object or array");
  }
}

export function buildPaymentRequest(plan, options = {}) {
  const quote = plan.remote?.lastQuote;
  if (!quote) throw new CliError("Run `justeat order quote <plan-id>` immediately before placement", "QUOTE_REQUIRED");
  const checkoutId = findValue(quote, ["id", "checkoutId", "data.id", "data.checkoutId"])
    ?? plan.remote?.basketId;
  const total = Number(findValue(quote, [
    "purchase.total.price.amount", "total", "totals.total", "data.total", "data.totals.total",
  ]));
  const currency = findValue(quote, ["currency", "totals.currency", "data.currency", "data.totals.currency"]) ?? "EUR";
  const methods = parseMethods(options.methods)
    ?? findValue(quote, ["payment.methods", "payments.methods", "selectedPaymentMethods", "data.payment.methods"]);
  if (!checkoutId || !Number.isFinite(total) || !Array.isArray(methods) || !methods.length) {
    throw new CliError("The validated checkout does not contain a complete payment request; pass --methods JSON if needed", "PAYMENT_DETAILS_REQUIRED", {
      hasCheckoutId: Boolean(checkoutId),
      hasTotal: Number.isFinite(total),
      methodCount: Array.isArray(methods) ? methods.length : 0,
    });
  }
  const request = {
    checkoutId,
    body: {
      currency,
      total,
      methods,
      returnUrl: options.returnUrl ?? "https://www.just-eat.es/order-confirmation",
    },
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);
  return { ...request, fingerprint };
}

export async function placeOrder(plan, options = {}) {
  const payment = buildPaymentRequest(plan, options);
  if (!options.confirm) {
    const normalized = normalizeCheckout(plan.remote.lastQuote);
    return {
      submitted: false,
      requiresConfirmation: payment.fingerprint,
      checkoutId: payment.checkoutId,
      totalCents: payment.body.total,
      total: normalized.total,
      formattedTotal: normalized.formattedTotal,
      currency: payment.body.currency,
      methods: payment.body.methods.map((method) => ({ type: method.type ?? null, id: method.id ?? null })),
      warning: "This is the final purchase boundary. Re-run with --confirm <fingerprint> only after the user approves the exact total and method.",
    };
  }
  if (options.confirm !== payment.fingerprint) {
    throw new CliError("Confirmation fingerprint does not match the current validated checkout", "CONFIRMATION_MISMATCH", {
      expected: payment.fingerprint,
    });
  }
  if (process.env.JUSTEAT_ENABLE_ORDER_PLACEMENT !== "1") {
    throw new CliError("Order placement is disabled; set JUSTEAT_ENABLE_ORDER_PLACEMENT=1 after explicit user approval", "ORDER_PLACEMENT_DISABLED");
  }
  let response;
  try {
    response = await requestJson(`${API_BASE}/checkout/es/${encodeURIComponent(payment.checkoutId)}/payments`, {
      method: "POST",
      headers: apiHeaders(options.token),
      body: JSON.stringify(payment.body),
      retries: 0,
    }, options.fetchImpl);
  } catch (error) {
    if (error.code === "NETWORK_ERROR" || error.name === "TimeoutError"
      || (error.code === "HTTP_ERROR" && error.details?.status >= 500)) {
      throw new CliError("The payment request outcome is unknown; do not retry automatically—check Just Eat order history", "ORDER_STATUS_UNKNOWN", {
        checkoutId: payment.checkoutId,
      });
    }
    throw error;
  }
  return { submitted: true, response };
}

export const orderPaths = { stateDirectory, plansDirectory };
