import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CliError } from "./lib.js";
import { atomicPrivateWrite, providerPaths } from "./providers.js";

const SESSIONS_DIRECTORY = join(providerPaths.configDirectory, "sessions");
const LEGACY_SESSIONS_DIRECTORY = join(providerPaths.legacyConfigDirectory, "sessions");
const CHROME_DEPENDENCIES_DIRECTORY = join(providerPaths.configDirectory, "chrome-cookie-runtime");
const CHROME_DEPENDENCY_MANIFEST = Object.freeze({
  private: true,
  type: "module",
  dependencies: { "chrome-cookies-secure": "3.0.2", "classic-level": "3.0.0" },
  overrides: { tar: "7.5.20", "@tootallnate/once": "2.0.1" },
});
const execFileAsync = promisify(execFile);
const LOGIN_URLS = Object.freeze({
  glovo: "https://glovoapp.com/es/login",
  ubereats: "https://www.ubereats.com/es",
});
const TARGET_URLS = Object.freeze({
  glovo: "https://glovoapp.com/",
  ubereats: "https://www.ubereats.com/",
});

function sessionPath(provider, directory = SESSIONS_DIRECTORY) {
  if (!TARGET_URLS[provider]) throw new CliError(`Browser-session login is not supported for ${provider}`, "AUTH_METHOD_UNSUPPORTED");
  return join(directory, `${provider}.json`);
}

function launchChrome(url) {
  const commands = process.platform === "darwin"
    ? [["open", ["-a", "Google Chrome", url]], ["open", [url]]]
    : process.platform === "win32"
      ? [["cmd", ["/c", "start", "chrome", url]], ["cmd", ["/c", "start", "", url]]]
      : [["google-chrome", [url]], ["chromium", [url]], ["xdg-open", [url]]];
  const [command, args] = commands[0];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function beginBrowserLogin(provider) {
  const url = LOGIN_URLS[provider];
  if (!url) throw new CliError(`Use the ${provider} adapter's OAuth login`, "AUTH_METHOD_UNSUPPORTED");
  launchChrome(url);
  return {
    provider,
    opened: true,
    url,
    next: `Sign in on the official ${provider === "glovo" ? "Glovo" : "Uber Eats"} page in Chrome, select your delivery address, then ask the agent to finish ${provider} login.`,
    security: "OrderScout imports only cookies valid for the provider domain. It never imports browsing history or cookies for other sites.",
  };
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

function chromeRoots() {
  return process.platform === "darwin"
    ? [join(homedir(), "Library/Application Support/Google/Chrome"), join(homedir(), "Library/Application Support/Microsoft Edge"), join(homedir(), "Library/Application Support/Chromium")]
    : process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Google/Chrome/User Data"), join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Microsoft/Edge/User Data")]
      : [join(homedir(), ".config/google-chrome"), join(homedir(), ".config/chromium"), join(homedir(), ".config/microsoft-edge")];
}

export async function discoverChromeProfiles({ roots = chromeRoots() } = {}) {
  const profiles = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || (!/^Profile \d+$/.test(entry.name) && entry.name !== "Default")) continue;
      for (const name of ["Network/Cookies", "Cookies"]) {
        const cookiePath = join(root, entry.name, name);
        const details = await stat(cookiePath).catch(() => null);
        if (!details?.isFile()) continue;
        profiles.push({ profile: entry.name, cookiePath, modifiedAt: details.mtime.toISOString(), modifiedAtMs: details.mtimeMs });
        break;
      }
    }
  }
  return profiles.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .map(({ modifiedAtMs: _modifiedAtMs, ...profile }) => profile);
}

async function cookieFileFrom(value = "Default", roots = chromeRoots()) {
  if (value.includes("/") || value.includes("\\")) {
    const candidate = isAbsolute(value) ? value : resolve(value);
    if (await isFile(candidate)) return candidate;
    for (const name of ["Network/Cookies", "Cookies"]) {
      if (await isFile(join(candidate, name))) return join(candidate, name);
    }
    throw new CliError(`No Chrome Cookies database found under ${candidate}`, "COOKIE_DATABASE_NOT_FOUND");
  }
  for (const root of roots) {
    for (const name of ["Network/Cookies", "Cookies"]) {
      const candidate = join(root, value, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  throw new CliError(`Chrome profile ${value} was not found`, "COOKIE_DATABASE_NOT_FOUND");
}

async function withTimeout(promise, timeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CliError("Timed out reading Chrome cookies", "COOKIE_IMPORT_TIMEOUT")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureChromeDependencies() {
  const manifestPath = join(CHROME_DEPENDENCIES_DIRECTORY, "package.json");
  const expected = JSON.stringify(CHROME_DEPENDENCY_MANIFEST);
  const current = await readFile(manifestPath, "utf8").catch(() => "");
  const installedCookies = await readFile(join(CHROME_DEPENDENCIES_DIRECTORY, "node_modules/chrome-cookies-secure/package.json"), "utf8").then(JSON.parse).catch(() => null);
  const installedLevel = await readFile(join(CHROME_DEPENDENCIES_DIRECTORY, "node_modules/classic-level/package.json"), "utf8").then(JSON.parse).catch(() => null);
  let currentManifest = null;
  try { currentManifest = JSON.parse(current); } catch { /* reinstall invalid or missing state */ }
  if (JSON.stringify(currentManifest) !== expected || installedCookies?.version !== "3.0.2" || installedLevel?.version !== "3.0.0") {
    await mkdir(CHROME_DEPENDENCIES_DIRECTORY, { recursive: true, mode: 0o700 });
    await chmod(CHROME_DEPENDENCIES_DIRECTORY, 0o700);
    await atomicPrivateWrite(manifestPath, CHROME_DEPENDENCY_MANIFEST);
    try {
      await execFileAsync("npm", ["install", "--silent", "--no-progress", "--no-fund", "--no-audit"], {
        cwd: CHROME_DEPENDENCIES_DIRECTORY,
        timeout: 120_000,
        env: { ...process.env, npm_config_loglevel: "error" },
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      throw new CliError("Could not install the protected Chrome session reader", "COOKIE_READER_INSTALL_FAILED", { cause: error.message });
    }
  }
}

async function chromeCookieLibrary() {
  await ensureChromeDependencies();
  const modulePath = join(CHROME_DEPENDENCIES_DIRECTORY, "node_modules/chrome-cookies-secure/index.js");
  const imported = await import(pathToFileURL(modulePath).href);
  return imported.default ?? imported;
}

async function chromeStorageLibrary() {
  await ensureChromeDependencies();
  const modulePath = join(CHROME_DEPENDENCIES_DIRECTORY, "node_modules/classic-level/index.js");
  return import(pathToFileURL(modulePath).href);
}

function cookieHeader(cookies) {
  const seen = new Set();
  return cookies.flatMap((cookie) => {
    const name = String(cookie?.name ?? "");
    const value = String(cookie?.value ?? "");
    if (!name || !value || seen.has(name)) return [];
    seen.add(name);
    return [`${name}=${value}`];
  }).join("; ");
}

function chromeProfileDirectory(cookiePath) {
  const parent = dirname(cookiePath);
  return basename(parent) === "Network" ? dirname(parent) : parent;
}

function decodeChromeStorageValue(value) {
  if (!Buffer.isBuffer(value) || value.length === 0) return null;
  if (value[0] === 1) return value.subarray(1).toString("utf8");
  if (value[0] === 0) return value.subarray(1).toString("utf16le");
  return value.toString("utf8");
}

async function readChromeStorage(cookiePath, origin, keys, storageReader) {
  const profileDirectory = chromeProfileDirectory(cookiePath);
  if (storageReader) return storageReader({ origin, keys, profileDirectory });
  const source = join(profileDirectory, "Local Storage", "leveldb");
  if (!(await stat(source).catch(() => null))?.isDirectory()) return {};
  const temporary = await mkdtemp(join(tmpdir(), "orderscout-local-storage-"));
  try {
    await cp(source, temporary, { recursive: true });
    const { ClassicLevel } = await chromeStorageLibrary();
    const database = new ClassicLevel(temporary, { keyEncoding: "buffer", valueEncoding: "buffer", createIfMissing: false });
    try {
      const values = {};
      const prefix = `_${new URL(origin).origin}\0\x01`;
      for (const key of keys) {
        const value = await database.get(Buffer.from(`${prefix}${key}`, "utf8")).catch((error) => {
          if (error.code === "LEVEL_NOT_FOUND") return null;
          throw error;
        });
        if (value) values[key] = decodeChromeStorageValue(value);
      }
      return values;
    } finally {
      await database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function glovoDeviceUrn(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.urn === "string" ? parsed.urn : null;
  } catch { return null; }
}

async function readChromeSession(provider, { profile, cookiePath, timeout, cookieReader, storageReader } = {}) {
  const source = await cookieFileFrom(cookiePath || profile);
  const temporary = await mkdtemp(join(tmpdir(), "orderscout-cookies-"));
  try {
    await copyFile(source, join(temporary, "Cookies"));
    const read = cookieReader ?? (async (url, directory) => {
      const library = await chromeCookieLibrary();
      return withTimeout(library.getCookiesPromised(url, "puppeteer", directory), timeout);
    });
    const cookies = await read(TARGET_URLS[provider], temporary);
    const header = cookieHeader(Array.isArray(cookies) ? cookies : []);
    if (!header) throw new CliError(`No ${provider} cookies were found in Chrome profile ${profile}`, "AUTH_COOKIES_NOT_FOUND");
    const storage = provider === "glovo"
      ? await readChromeStorage(source, TARGET_URLS.glovo, ["glovo_refresh_token", "glv_device"], storageReader)
      : {};
    return {
      version: 2,
      provider,
      cookieHeader: header,
      cookieNames: header.split("; ").map((pair) => pair.slice(0, pair.indexOf("="))),
      ...(storage.glovo_refresh_token ? { refreshToken: storage.glovo_refresh_token } : {}),
      ...(glovoDeviceUrn(storage.glv_device) ? { deviceUrn: glovoDeviceUrn(storage.glv_device) } : {}),
      importedAt: new Date().toISOString(),
      source: `chrome:${profile ?? basename(cookiePath)}`,
      sourceProfile: profile ?? basename(chromeProfileDirectory(source)),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function saveChromeSession(provider, session, sessionsDirectory = SESSIONS_DIRECTORY) {
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(sessionPath(provider, sessionsDirectory), session);
  await chmod(sessionPath(provider, sessionsDirectory), 0o600);
}

export async function importChromeSession(provider, {
  profile = "auto", cookiePath, timeout = 30_000, cookieReader, sessionsDirectory = SESSIONS_DIRECTORY,
  storageReader, verify, profileRoots,
} = {}) {
  const candidates = profile === "auto" && !cookiePath
    ? await discoverChromeProfiles({ roots: profileRoots })
    : [{ profile: cookiePath ? undefined : profile, cookiePath: cookiePath ?? await cookieFileFrom(profile, profileRoots) }];
  if (!candidates.length) throw new CliError("No supported Chrome profiles were found", "COOKIE_DATABASE_NOT_FOUND");
  const failures = [];
  for (const candidate of candidates) {
    try {
      const session = await readChromeSession(provider, {
        profile: candidate.profile,
        cookiePath: candidate.cookiePath,
        timeout,
        cookieReader,
        storageReader,
      });
      const verified = verify ? await verify(session) : null;
      await saveChromeSession(provider, session, sessionsDirectory);
      return {
        provider,
        authenticated: true,
        source: session.source,
        profile: candidate.profile,
        cookieCount: session.cookieNames.length,
        persistent: provider !== "glovo" || Boolean(session.refreshToken),
        importedAt: session.importedAt,
        verified,
      };
    } catch (error) {
      failures.push({ profile: candidate.profile, code: error.code ?? "AUTH_VERIFICATION_FAILED" });
      if (profile !== "auto" || cookiePath) throw error;
    }
  }
  throw new CliError(`No Chrome profile contains a verified ${provider} session`, "AUTH_SESSION_NOT_FOUND", { attempts: failures });
}

export async function persistBrowserSession(provider, session, { sessionsDirectory = SESSIONS_DIRECTORY } = {}) {
  if (!session?.cookieHeader) throw new CliError(`Cannot save an empty ${provider} session`, "INVALID_AUTH");
  await saveChromeSession(provider, session, sessionsDirectory);
  return session;
}

export async function withBrowserSessionLock(provider, task, { sessionsDirectory = SESSIONS_DIRECTORY, timeout = 25_000 } = {}) {
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  const lockPath = `${sessionPath(provider, sessionsDirectory)}.refresh.lock`;
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const details = await stat(lockPath).catch(() => null);
      if (details && Date.now() - details.mtimeMs > 60_000) await unlink(lockPath).catch(() => {});
      if (Date.now() - startedAt >= timeout) throw new CliError(`Timed out renewing the ${provider} session`, "AUTH_REFRESH_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await task(); }
  finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

export async function loadBrowserSession(provider) {
  const environment = process.env[`ORDERSCOUT_${provider.toUpperCase()}_COOKIE`] ?? process.env[`PIDE_${provider.toUpperCase()}_COOKIE`];
  if (environment) return { version: 1, provider, cookieHeader: environment, source: "environment" };
  try {
    const stored = JSON.parse(await readFile(sessionPath(provider), "utf8"));
    if (!stored.cookieHeader) throw new Error("missing cookie header");
    return stored;
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        const stored = JSON.parse(await readFile(sessionPath(provider, LEGACY_SESSIONS_DIRECTORY), "utf8"));
        if (!stored.cookieHeader) throw new Error("missing cookie header");
        await mkdir(SESSIONS_DIRECTORY, { recursive: true, mode: 0o700 });
        await atomicPrivateWrite(sessionPath(provider), stored);
        return { ...stored, migratedFrom: "pide-es-cli" };
      } catch (legacyError) {
        if (legacyError.code === "ENOENT") return null;
        throw new CliError(`Saved ${provider} session is unreadable; sign in again`, "INVALID_AUTH");
      }
    }
    throw new CliError(`Saved ${provider} session is unreadable; sign in again`, "INVALID_AUTH");
  }
}

export async function logoutBrowserSession(provider) {
  const remove = async (file) => {
    try { await unlink(file); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const removed = (await Promise.all([
    remove(sessionPath(provider)),
    remove(sessionPath(provider, LEGACY_SESSIONS_DIRECTORY)),
  ])).some(Boolean);
  const authenticated = Boolean(process.env[`ORDERSCOUT_${provider.toUpperCase()}_COOKIE`] ?? process.env[`PIDE_${provider.toUpperCase()}_COOKIE`]);
  return { provider, authenticated, removed };
}

export const browserSessionPaths = { sessionsDirectory: SESSIONS_DIRECTORY, sessionPath };
export const browserSessionInternals = { dependencyManifest: CHROME_DEPENDENCY_MANIFEST, decodeChromeStorageValue, chromeProfileDirectory };
