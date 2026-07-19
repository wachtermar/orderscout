import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./lib.js";

export const PROVIDERS = Object.freeze({
  justeat: {
    id: "justeat",
    name: "Just Eat",
    transport: "api",
    membership: null,
    origin: "https://www.just-eat.es",
  },
  glovo: {
    id: "glovo",
    name: "Glovo",
    transport: "api",
    membership: "Glovo Prime",
    origin: "https://glovoapp.com",
  },
  ubereats: {
    id: "ubereats",
    name: "Uber Eats",
    transport: "api",
    membership: "Uber One",
    origin: "https://www.ubereats.com",
  },
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

const CONFIG_ROOT = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const LEGACY_CONFIG_DIRECTORY = join(CONFIG_ROOT, "pide-es-cli");
const CONFIG_DIRECTORY = process.env.ORDERSCOUT_CONFIG_DIR ?? process.env.PIDE_CONFIG_DIR
  ?? join(CONFIG_ROOT, "orderscout-cli");
const ACCOUNTS_FILE = join(CONFIG_DIRECTORY, "accounts.json");
const LEGACY_ACCOUNTS_FILE = join(LEGACY_CONFIG_DIRECTORY, "accounts.json");
const SEARCHES_DIRECTORY = join(CONFIG_DIRECTORY, "searches");

const defaultAccount = (provider) => ({
  enabled: true,
  hasAccount: null,
  authenticated: null,
  membership: PROVIDERS[provider].membership ? { active: false, declared: false } : null,
  transport: PROVIDERS[provider].transport,
  addressSelected: null,
  checkedAt: null,
});

export function defaultAccounts() {
  return {
    version: 1,
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, defaultAccount(id)])),
  };
}

async function atomicPrivateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export async function loadAccounts() {
  let stored;
  try {
    stored = JSON.parse(await readFile(ACCOUNTS_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      stored = JSON.parse(await readFile(LEGACY_ACCOUNTS_FILE, "utf8"));
      await atomicPrivateWrite(ACCOUNTS_FILE, stored);
    } catch (legacyError) {
      if (legacyError.code !== "ENOENT") throw legacyError;
      return defaultAccounts();
    }
  }
  const defaults = defaultAccounts();
  for (const id of PROVIDER_IDS) {
    defaults.providers[id] = {
      ...defaults.providers[id],
      ...(stored.providers?.[id] ?? {}),
      membership: PROVIDERS[id].membership
        ? { ...defaults.providers[id].membership, ...(stored.providers?.[id]?.membership ?? {}) }
        : null,
    };
  }
  return defaults;
}

export async function configureAccounts({ enabledProviders, accounts, memberships } = {}) {
  const config = await loadAccounts();
  if (enabledProviders) {
    const enabled = new Set(parseProviderList(enabledProviders));
    for (const id of PROVIDER_IDS) config.providers[id].enabled = enabled.has(id);
  }
  for (const [id, hasAccount] of Object.entries(accounts ?? {})) {
    assertProvider(id);
    config.providers[id].hasAccount = Boolean(hasAccount);
    if (!hasAccount) config.providers[id].authenticated = false;
  }
  for (const [id, active] of Object.entries(memberships ?? {})) {
    assertProvider(id);
    if (!PROVIDERS[id].membership) throw new CliError(`${PROVIDERS[id].name} has no supported membership setting`);
    config.providers[id].membership = { active: Boolean(active), declared: true };
  }
  await atomicPrivateWrite(ACCOUNTS_FILE, config);
  return publicAccountStatus(config);
}

export async function recordProviderStatus(provider, { authenticated, membershipActive, transport, addressSelected } = {}) {
  assertProvider(provider);
  const config = await loadAccounts();
  if (transport !== undefined) {
    if (!["api", "browser"].includes(transport)) throw new CliError("Provider transport must be api or browser", "INVALID_PROVIDER_TRANSPORT");
    config.providers[provider].transport = transport;
  }
  if (authenticated !== undefined) {
    config.providers[provider].authenticated = Boolean(authenticated);
    config.providers[provider].hasAccount = Boolean(authenticated) || config.providers[provider].hasAccount;
  }
  if (addressSelected !== undefined) config.providers[provider].addressSelected = Boolean(addressSelected);
  if (membershipActive !== undefined && PROVIDERS[provider].membership) {
    config.providers[provider].membership = { active: Boolean(membershipActive), declared: false };
  }
  config.providers[provider].checkedAt = new Date().toISOString();
  await atomicPrivateWrite(ACCOUNTS_FILE, config);
  return publicAccountStatus(config);
}

export function publicAccountStatus(config) {
  return {
    providers: PROVIDER_IDS.map((id) => ({
      id,
      name: PROVIDERS[id].name,
      enabled: config.providers[id].enabled,
      hasAccount: config.providers[id].hasAccount,
      authenticated: config.providers[id].authenticated,
      transport: config.providers[id].transport ?? PROVIDERS[id].transport,
      addressSelected: config.providers[id].addressSelected ?? null,
      membership: PROVIDERS[id].membership
        ? { name: PROVIDERS[id].membership, active: config.providers[id].membership?.active ?? false,
          source: config.providers[id].membership?.declared ? "user" : "detected" }
        : null,
      checkedAt: config.providers[id].checkedAt,
    })),
  };
}

export function parseProviderList(value) {
  const values = Array.isArray(value) ? value : String(value).split(",");
  const normalized = values.map((entry) => String(entry).trim().toLowerCase().replace(/[ _-]/g, ""))
    .filter(Boolean).map((entry) => entry === "ubereat" || entry === "uber" ? "ubereats" : entry === "justeat" ? "justeat" : entry);
  for (const provider of normalized) assertProvider(provider);
  return [...new Set(normalized)];
}

export function assertProvider(provider) {
  if (!PROVIDERS[provider]) {
    throw new CliError(`Unknown provider ${provider}. Use: ${PROVIDER_IDS.join(", ")}`, "UNKNOWN_PROVIDER");
  }
}

export function searchId() {
  return createHash("sha256").update(`${Date.now()}:${cryptoRandom()}`).digest("hex").slice(0, 24);
}

function cryptoRandom() {
  return `${Math.random()}:${process.hrtime.bigint()}`;
}

export const providerPaths = { configDirectory: CONFIG_DIRECTORY, legacyConfigDirectory: LEGACY_CONFIG_DIRECTORY, accountsFile: ACCOUNTS_FILE, searchesDirectory: SEARCHES_DIRECTORY };
export { atomicPrivateWrite };
