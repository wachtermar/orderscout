import assert from "node:assert/strict";
import test from "node:test";
import { agentContext, runDoctor } from "../src/doctor.js";

test("agent context makes the purchase boundary explicit", () => {
  const context = agentContext();
  assert.equal(context.safety.canSubmitOrders, true);
  assert.equal(context.safety.submitsWithoutFingerprint, false);
  assert.equal(context.safety.agentFlagConfirmsPurchases, false);
  assert.ok(context.capabilities.unsupported.includes("storing payment credentials"));
});

test("doctor reports each upstream without throwing on partial failure", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.hostname === "i18n.api.just-eat.io") return Response.json({ data: [] });
    if (url.hostname === "menu-globalmenucdn.justeat-int.com") return new Response("", { status: 404 });
    if (url.hostname === "auth.just-eat.es") {
      return Response.json({ issuer: "https://auth.just-eat.es", code_challenge_methods_supported: ["S256"] });
    }
    throw new Error("unexpected host");
  };
  const result = await runDoctor({ fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.checks.length, 3);
  assert.equal(result.checks.find((entry) => entry.name === "oauth").pkce, true);
});
