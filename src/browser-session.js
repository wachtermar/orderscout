import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CliError } from "./lib.js";
import { atomicPrivateWrite, providerPaths } from "./providers.js";

const SESSIONS_DIRECTORY = join(providerPaths.configDirectory, "sessions");
const LEGACY_SESSIONS_DIRECTORY = join(providerPaths.legacyConfigDirectory, "sessions");
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

async function cookieFileFrom(value = "Default") {
  if (value.includes("/") || value.includes("\\")) {
    const candidate = isAbsolute(value) ? value : resolve(value);
    if (await isFile(candidate)) return candidate;
    for (const name of ["Network/Cookies", "Cookies"]) {
      if (await isFile(join(candidate, name))) return join(candidate, name);
    }
    throw new CliError(`No Chrome Cookies database found under ${candidate}`, "COOKIE_DATABASE_NOT_FOUND");
  }
  const roots = process.platform === "darwin"
    ? [join(homedir(), "Library/Application Support/Google/Chrome"), join(homedir(), "Library/Application Support/Microsoft Edge"), join(homedir(), "Library/Application Support/Chromium")]
    : process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Google/Chrome/User Data"), join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Microsoft/Edge/User Data")]
      : [join(homedir(), ".config/google-chrome"), join(homedir(), ".config/chromium"), join(homedir(), ".config/microsoft-edge")];
  for (const root of roots) {
    for (const name of ["Network/Cookies", "Cookies"]) {
      const candidate = join(root, value, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  throw new CliError(`Chrome profile ${value} was not found`, "COOKIE_DATABASE_NOT_FOUND");
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

export async function importChromeSession(provider, { profile = "Default", cookiePath, timeout = 30_000, cookieReader, sessionsDirectory = SESSIONS_DIRECTORY } = {}) {
  const source = await cookieFileFrom(cookiePath || profile);
  const temporary = await mkdtemp(join(tmpdir(), "orderscout-cookies-"));
  try {
    await copyFile(source, join(temporary, "Cookies"));
    const read = cookieReader ?? (async (url, directory) => {
      const imported = await import("chrome-cookies-secure");
      const library = imported.default ?? imported;
      return Promise.race([
        library.getCookiesPromised(url, "puppeteer", directory),
        new Promise((_, reject) => setTimeout(() => reject(new CliError("Timed out reading Chrome cookies", "COOKIE_IMPORT_TIMEOUT")), timeout)),
      ]);
    });
    const cookies = await read(TARGET_URLS[provider], temporary);
    const header = cookieHeader(Array.isArray(cookies) ? cookies : []);
    if (!header) throw new CliError(`No ${provider} cookies were found in Chrome profile ${profile}`, "AUTH_COOKIES_NOT_FOUND");
    const session = {
      version: 1,
      provider,
      cookieHeader: header,
      cookieNames: header.split("; ").map((pair) => pair.slice(0, pair.indexOf("="))),
      importedAt: new Date().toISOString(),
      source: `chrome:${cookiePath ? basename(cookiePath) : profile}`,
    };
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    await atomicPrivateWrite(sessionPath(provider, sessionsDirectory), session);
    await chmod(sessionPath(provider, sessionsDirectory), 0o600);
    return { provider, authenticated: true, source: session.source, cookieCount: session.cookieNames.length, importedAt: session.importedAt };
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
