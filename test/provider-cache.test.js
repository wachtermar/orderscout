import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedProviderRead, providerCacheInternals } from "../src/provider-cache.js";

test("provider reads persist and reuse fresh catalog data", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  let calls = 0;
  const options = { configDirectory, ttlMs: 60_000, now: Date.parse("2026-07-21T10:00:00Z") };
  const first = await cachedProviderRead("glovo-menu", { store: "one" }, async () => ({ products: [1] }), { ...options });
  const second = await cachedProviderRead("glovo-menu", { store: "one" }, async () => { calls += 1; return { products: [2] }; }, { ...options, now: options.now + 1_000 });
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.deepEqual(second.value, { products: [1] });
  assert.equal(calls, 0);
  const path = providerCacheInternals.cachePath("glovo-menu", { store: "one" }, options);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("provider reads refresh expired entries and never cache failures", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  const key = { store: "two" };
  await cachedProviderRead("uber-menu", key, async () => ({ value: 1 }), { configDirectory, ttlMs: 1_000, now: 1_000 });
  let calls = 0;
  const refreshed = await cachedProviderRead("uber-menu", key, async () => { calls += 1; return { value: 2 }; }, { configDirectory, ttlMs: 1_000, now: 2_001 });
  assert.equal(refreshed.cache.hit, false);
  assert.equal(calls, 1);
  await assert.rejects(() => cachedProviderRead("failed", "key", async () => { throw new Error("nope"); }, { configDirectory, ttlMs: 1_000 }));
  await cachedProviderRead("failed", "key", async () => { calls += 1; return { ok: true }; }, { configDirectory, ttlMs: 1_000 });
  assert.equal(calls, 2);
});

test("concurrent identical reads share one upstream request", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  let calls = 0;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const loader = async () => { calls += 1; started(); await gate; return { ok: true }; };
  const one = cachedProviderRead("menu", { id: 1 }, loader, { configDirectory, ttlMs: 60_000 });
  const two = cachedProviderRead("menu", { id: 1 }, loader, { configDirectory, ttlMs: 60_000 });
  await began;
  assert.equal(calls, 1);
  release();
  assert.deepEqual((await Promise.all([one, two])).map((entry) => entry.value), [{ ok: true }, { ok: true }]);
});

test("an expired read can fall back to recent stale data after a transient failure", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  await cachedProviderRead("menu", "store", async () => ({ products: [1] }), { configDirectory, ttlMs: 1_000, now: 1_000 });
  const fallback = await cachedProviderRead("menu", "store", async () => {
    throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
  }, { configDirectory, ttlMs: 1_000, staleIfErrorMs: 10_000, now: 3_000 });
  assert.deepEqual(fallback.value, { products: [1] });
  assert.deepEqual(fallback.cache, {
    hit: true, stale: true, ageMs: 2_000, writtenAt: "1970-01-01T00:00:01.000Z", fallbackErrorCode: "NETWORK_ERROR",
  });
});

test("stale data never hides an expired login", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  await cachedProviderRead("menu", "store", async () => ({ products: [1] }), { configDirectory, ttlMs: 1_000, now: 1_000 });
  await assert.rejects(() => cachedProviderRead("menu", "store", async () => {
    throw Object.assign(new Error("login"), { code: "AUTH_EXPIRED" });
  }, { configDirectory, ttlMs: 1_000, staleIfErrorMs: 10_000, now: 3_000 }), { code: "AUTH_EXPIRED" });
});

test("stale data never hides a permanent provider rejection", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "orderscout-provider-cache-"));
  await cachedProviderRead("menu", "store", async () => ({ products: [1] }), { configDirectory, ttlMs: 1_000, now: 1_000 });
  await assert.rejects(() => cachedProviderRead("menu", "store", async () => {
    throw Object.assign(new Error("gone"), { code: "MENU_NOT_FOUND", details: { status: 404 } });
  }, { configDirectory, ttlMs: 1_000, staleIfErrorMs: 10_000, now: 3_000 }), { code: "MENU_NOT_FOUND" });
});
