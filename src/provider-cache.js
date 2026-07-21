import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const inFlight = new Map();
const CONFIG_ROOT = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const CONFIG_DIRECTORY = process.env.ORDERSCOUT_CONFIG_DIR ?? process.env.PIDE_CONFIG_DIR
  ?? join(CONFIG_ROOT, "orderscout-cli");

async function atomicPrivateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function cacheId(key) {
  return createHash("sha256").update(JSON.stringify(stableValue(key))).digest("hex");
}

function cachePath(namespace, key, options = {}) {
  if (!/^[a-z0-9-]+$/.test(namespace)) throw new TypeError("Invalid provider cache namespace");
  const root = options.configDirectory ?? CONFIG_DIRECTORY;
  return join(root, "cache", namespace, `${cacheId(key)}.json`);
}

async function readEntry(namespace, key, options = {}) {
  try { return JSON.parse(await readFile(cachePath(namespace, key, options), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Cache read-only provider data. Failed loaders are never cached. The in-memory
 * promise also coalesces identical calls made concurrently in one CLI process.
 */
export async function cachedProviderRead(namespace, key, loader, options = {}) {
  const now = Number(options.now ?? Date.now());
  const ttlMs = Math.max(0, Number(options.ttlMs ?? 0));
  const enabled = options.enabled !== false && ttlMs > 0;
  const path = cachePath(namespace, key, options);
  let entry = null;
  let writtenAt = Number.NaN;
  if (enabled) {
    entry = await readEntry(namespace, key, options);
    writtenAt = Date.parse(entry?.writtenAt ?? "");
    if (Number.isFinite(writtenAt) && now - writtenAt <= ttlMs) {
      return { value: entry.value, cache: { hit: true, stale: false, ageMs: Math.max(0, now - writtenAt), writtenAt: entry.writtenAt } };
    }
  }

  const flightKey = `${path}:${enabled ? `${ttlMs}:${Math.max(0, Number(options.staleIfErrorMs ?? 0))}` : "off"}`;
  let pending = inFlight.get(flightKey);
  if (!pending) {
    pending = (async () => {
      try {
        const value = await loader();
        const currentWrittenAt = new Date(Number(options.now ?? Date.now())).toISOString();
        if (enabled) await atomicPrivateWrite(path, { version: 1, writtenAt: currentWrittenAt, value });
        return { value, cache: { hit: false, stale: false, ageMs: 0, writtenAt: currentWrittenAt } };
      } catch (error) {
        const staleIfErrorMs = Math.max(0, Number(options.staleIfErrorMs ?? 0));
        const ageMs = now - writtenAt;
        const transient = error?.code === "NETWORK_ERROR" || error?.code === "RATE_LIMITED"
          || Number(error?.details?.status ?? 0) >= 500;
        const mayFallback = transient && enabled && entry && Number.isFinite(writtenAt)
          && ageMs >= 0 && ageMs <= ttlMs + staleIfErrorMs
          && !["AUTH_EXPIRED", "AUTH_REQUIRED"].includes(error?.code);
        if (!mayFallback) throw error;
        return {
          value: entry.value,
          cache: {
            hit: true,
            stale: true,
            ageMs,
            writtenAt: entry.writtenAt,
            fallbackErrorCode: error?.code ?? "NETWORK_ERROR",
          },
        };
      }
    })();
    inFlight.set(flightKey, pending);
  }
  try { return await pending; }
  finally { if (inFlight.get(flightKey) === pending) inFlight.delete(flightKey); }
}

export const providerCacheInternals = { cacheId, cachePath, stableValue };
