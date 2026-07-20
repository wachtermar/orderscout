import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./lib.js";
import { assertProvider, atomicPrivateWrite, providerPaths } from "./providers.js";

const DEFAULT_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 30 * 60_000;
const ATTEMPT_WINDOW_MS = 60 * 60_000;

function statePath(provider, options = {}) {
  assertProvider(provider);
  return join(options.configDirectory ?? providerPaths.configDirectory, "cooldowns", `${provider}.json`);
}

function retryAfterMs(value, now) {
  if (value === null || value === undefined || value === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(String(value));
  return Number.isNaN(date) ? 0 : Math.max(0, date - now);
}

async function readState(provider, options = {}) {
  try { return JSON.parse(await readFile(statePath(provider, options), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function activeProviderCooldown(provider, options = {}) {
  const now = Number(options.now ?? Date.now());
  const state = await readState(provider, options);
  if (!state || Date.parse(state.retryAt) <= now) return null;
  return {
    provider,
    retryAt: state.retryAt,
    remainingSeconds: Math.max(1, Math.ceil((Date.parse(state.retryAt) - now) / 1_000)),
    attempt: state.attempt,
  };
}

export async function assertProviderAvailable(provider, options = {}) {
  const cooldown = await activeProviderCooldown(provider, options);
  if (!cooldown) return null;
  throw new CliError(
    `${provider} is cooling down after an upstream rate limit; retry after ${cooldown.retryAt}`,
    "RATE_LIMITED",
    { ...cooldown, source: "local-cooldown" },
  );
}

export async function recordProviderRateLimit(provider, options = {}) {
  const now = Number(options.now ?? Date.now());
  const previous = await readState(provider, options);
  const previousHit = Date.parse(previous?.lastHitAt ?? "");
  const attempt = Number.isFinite(previousHit) && now - previousHit < ATTEMPT_WINDOW_MS
    ? Math.max(1, Number(previous?.attempt ?? 1) + 1)
    : 1;
  const backoff = Math.min(MAX_DELAY_MS, DEFAULT_DELAY_MS * (2 ** (attempt - 1)));
  const delay = Math.max(backoff, retryAfterMs(options.retryAfter, now));
  const state = {
    version: 1,
    provider,
    attempt,
    lastHitAt: new Date(now).toISOString(),
    retryAt: new Date(now + delay).toISOString(),
  };
  await atomicPrivateWrite(statePath(provider, options), state);
  return state;
}

export async function clearProviderCooldown(provider, options = {}) {
  try { await unlink(statePath(provider, options)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export const providerCooldownInternals = { retryAfterMs, statePath };
