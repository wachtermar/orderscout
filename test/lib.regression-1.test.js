import assert from "node:assert/strict";
import test from "node:test";
import { resolveSavedLocation } from "../src/lib.js";

// Regression: ISSUE-001 — Just Eat rejected saved addresses containing apartment metadata
// Found by /qa on 2026-07-21
// Report: .gstack/qa-reports/qa-report-orderscout-2026-07-21.md
test("saved-address resolution retries without secondary address lines after provider 404", async () => {
  const payload = Buffer.from(JSON.stringify({ sub: "test", exp: 4_102_444_800 })).toString("base64url");
  const token = `header.${payload}.signature`;
  const autocompleteInputs = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/consumer/me/address")) {
      return Response.json({ Addresses: [{
        AddressId: 7,
        City: "Marbella",
        ZipCode: "29603",
        Line1: "Test street 1",
        Line2: "Apartment 2G",
        Line3: "Block 5",
        Line4: "Door 15",
      }] });
    }
    if (parsed.pathname.endsWith("/autocomplete/addresses/es")) {
      const input = parsed.searchParams.get("input");
      autocompleteInputs.push(input);
      if (input.includes("Apartment 2G")) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ session: "session", data: [{ id: "place", description: "Test street 1, Marbella" }] });
    }
    return Response.json({
      features: [{
        geometry: { coordinates: [-4.8396582, 36.5126806] },
        properties: { structuredAddress: { postcode: "29603", city: "Marbella" } },
      }],
    });
  };

  const location = await resolveSavedLocation(token, 0, fetchImpl);

  assert.deepEqual(autocompleteInputs, [
    "Test street 1, Apartment 2G, Block 5, Door 15, 29603, Marbella",
    "Test street 1, 29603, Marbella",
  ]);
  assert.deepEqual(
    { latitude: location.latitude, longitude: location.longitude, postcode: location.postcode, city: location.city },
    { latitude: 36.5126806, longitude: -4.8396582, postcode: "29603", city: "Marbella" },
  );
});
