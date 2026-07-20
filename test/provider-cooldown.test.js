import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeProviderCooldown, assertProviderAvailable, clearProviderCooldown, recordProviderRateLimit,
} from "../src/provider-cooldown.js";

test("provider cooldowns stop repeated upstream hammering and expire predictably", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-cooldown-"));
  const now = Date.parse("2026-07-20T16:00:00.000Z");
  const first = await recordProviderRateLimit("ubereats", { configDirectory, now });
  assert.equal(first.retryAt, "2026-07-20T16:05:00.000Z");
  assert.equal((await activeProviderCooldown("ubereats", { configDirectory, now })).remainingSeconds, 300);
  await assert.rejects(
    () => assertProviderAvailable("ubereats", { configDirectory, now: now + 1_000 }),
    (error) => error.code === "RATE_LIMITED" && error.details.source === "local-cooldown",
  );
  assert.equal(await activeProviderCooldown("ubereats", { configDirectory, now: now + 5 * 60_000 }), null);
  const second = await recordProviderRateLimit("ubereats", { configDirectory, now: now + 5 * 60_000 });
  assert.equal(second.retryAt, "2026-07-20T16:15:00.000Z");
  assert.equal((await stat(join(configDirectory, "cooldowns", "ubereats.json"))).mode & 0o777, 0o600);
  await clearProviderCooldown("ubereats", { configDirectory });
  assert.equal(await activeProviderCooldown("ubereats", { configDirectory, now }), null);
});

test("provider cooldown honors a longer Retry-After header", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-retry-after-"));
  const now = Date.parse("2026-07-20T16:00:00.000Z");
  const state = await recordProviderRateLimit("glovo", { configDirectory, now, retryAfter: "900" });
  assert.equal(state.retryAt, "2026-07-20T16:15:00.000Z");
});
