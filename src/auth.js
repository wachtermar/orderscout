import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CliError, decodeToken } from "./lib.js";

const CONFIG_DIRECTORY = process.env.JUSTEAT_CONFIG_DIR
  || join(homedir(), ".config", "justeat-es-cli");
const AUTH_FILE = join(CONFIG_DIRECTORY, "auth.json");
const AUTH_PENDING_FILE = join(CONFIG_DIRECTORY, "auth-pending.json");
const AUTH_ORIGIN = "https://auth.just-eat.es";
const CLIENT_ID = "consumer_web_je";
const REDIRECT_URI = "https://www.just-eat.es/account/oauth-callback";
const SCOPES = "openid profile mobile_scope jet:internal offline_access";
const execFileAsync = promisify(execFile);

async function ensureConfigDirectory() {
  await mkdir(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
  await chmod(CONFIG_DIRECTORY, 0o700);
}

export async function saveAuth(token, options = {}) {
  const status = decodeToken(token);
  const source = options.source ?? "official-oauth";
  await ensureConfigDirectory();
  await writeFile(AUTH_FILE, `${JSON.stringify({
    token,
    ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
    capturedAt: new Date().toISOString(),
    source,
  }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(AUTH_FILE, 0o600);
  return { ...status, source, authFile: AUTH_FILE };
}

export async function loadAuth() {
  if (process.env.JUSTEAT_TOKEN) {
    return { token: process.env.JUSTEAT_TOKEN, source: "environment" };
  }
  try {
    const stored = JSON.parse(await readFile(AUTH_FILE, "utf8"));
    if (!stored.token) throw new Error("missing token");
    return {
      token: stored.token,
      refreshToken: stored.refreshToken,
      source: stored.source ?? "official-oauth",
      capturedAt: stored.capturedAt,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new CliError("Saved authentication is unreadable; run `justeat auth login` again", "INVALID_AUTH");
  }
}

function oauthHeaders(extra = {}) {
  return {
    "accept-tenant": "es",
    "accept-language": "es-ES,es;q=0.9",
    "x-csrf": "1",
    "x-jet-application": "OneWeb",
    ...extra,
  };
}

async function refreshAuth(auth, fetchImpl = fetch) {
  if (!auth.refreshToken) return null;
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  });
  const response = await fetchImpl(`${AUTH_ORIGIN}/connect/token`, {
    method: "POST",
    headers: oauthHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: form,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) return null;
  await saveAuth(payload.access_token, {
    refreshToken: payload.refresh_token ?? auth.refreshToken,
    source: "official-oauth",
  });
  return payload.access_token;
}

export async function getAuthToken({ required = false, fetchImpl = fetch } = {}) {
  const auth = await loadAuth();
  if (!auth) {
    if (!required) return null;
    throw new CliError("Run `justeat auth login` first", "AUTH_REQUIRED");
  }
  const status = decodeToken(auth.token);
  if (status.expired) {
    const refreshed = await refreshAuth(auth, fetchImpl);
    if (refreshed) return refreshed;
    throw new CliError("The Just Eat session expired; run `justeat auth login` again", "AUTH_EXPIRED", {
      expiresAt: status.expiresAt,
    });
  }
  return auth.token;
}

export async function authStatus({ fetchImpl = fetch, refresh = true } = {}) {
  const auth = await loadAuth();
  if (!auth) return { authenticated: false, source: null };
  let status = decodeToken(auth.token);
  let refreshed = false;
  if (status.expired && refresh && auth.refreshToken) {
    const token = await refreshAuth(auth, fetchImpl).catch(() => null);
    if (token) {
      status = decodeToken(token);
      refreshed = true;
    }
  }
  return {
    ...status,
    authenticated: status.authenticated && status.expired !== true,
    source: auth.source,
    capturedAt: refreshed ? (await loadAuth()).capturedAt ?? null : auth.capturedAt ?? null,
    refreshed,
  };
}

export async function logout() {
  const environmentOverride = Boolean(process.env.JUSTEAT_TOKEN);
  try {
    await unlink(AUTH_FILE);
    return { authenticated: environmentOverride, removed: true, environmentOverride };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { authenticated: environmentOverride, removed: false, environmentOverride };
    }
    throw new CliError("Saved authentication could not be removed", "INVALID_AUTH", {
      cause: error.message,
    });
  }
}

class CookieJar {
  constructor(cookies = {}) {
    this.cookies = new Map(Object.entries(cookies));
  }

  ingest(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie")?.split(/,(?=\s*[^;,=]+=[^;,]+)/) ?? []);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  serialize() {
    return Object.fromEntries(this.cookies);
  }
}

function oauthError(payload, fallback) {
  return payload?.errors?.[0]?.description || payload?.error_description || payload?.error || fallback;
}

function absoluteAuthUrl(value) {
  return new URL(value, AUTH_ORIGIN);
}

function createAuthorizationRequest() {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const url = new URL(`${AUTH_ORIGIN}/connect/authorize`);
  for (const [key, value] of Object.entries({
    client_id: CLIENT_ID,
    response_type: "code",
    response_mode: "query",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    acr_values: "tenant:es",
  })) url.searchParams.set(key, value);
  return { url, verifier, state };
}

async function exchangeAuthorizationCallback(callbackValue, authorization, fetchImpl = fetch) {
  let callbackUrl;
  try {
    callbackUrl = new URL(String(callbackValue).trim());
  } catch {
    throw new CliError("Paste the complete Just Eat callback URL", "AUTH_CALLBACK_INVALID");
  }
  const expected = new URL(REDIRECT_URI);
  if (callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname) {
    throw new CliError("The callback URL is not from Just Eat", "AUTH_CALLBACK_INVALID");
  }
  if (callbackUrl.searchParams.get("state") !== authorization.state) {
    throw new CliError("OAuth state validation failed", "AUTH_STATE_MISMATCH");
  }
  const code = callbackUrl.searchParams.get("code");
  if (!code) {
    throw new CliError(callbackUrl.searchParams.get("error_description") || "Authorization was denied", "AUTH_DENIED");
  }
  const response = await fetchImpl(`${AUTH_ORIGIN}/connect/token`, {
    method: "POST",
    headers: oauthHeaders({ "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: authorization.verifier,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 200 || !payload.access_token) {
    throw new CliError(oauthError(payload, "Just Eat rejected the authorization code"), "AUTH_TOKEN_REJECTED", {
      status: response.status,
    });
  }
  return saveAuth(payload.access_token, {
    refreshToken: payload.refresh_token,
    source: "official-oauth",
  });
}

export function openSystemUrl(url) {
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const [command, args] = commands[process.platform] ?? ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function loginWithNativeBrowser({ getCallbackUrl, fetchImpl = fetch } = {}) {
  if (typeof getCallbackUrl !== "function") {
    throw new CliError("Callback URL input is required", "AUTH_INPUT_REQUIRED");
  }
  const authorization = createAuthorizationRequest();
  try {
    openSystemUrl(authorization.url.toString());
  } catch (error) {
    throw new CliError("The system browser could not be opened", "BROWSER_UNAVAILABLE", { cause: error.message });
  }
  const callbackUrl = await getCallbackUrl();
  return exchangeAuthorizationCallback(callbackUrl, authorization, fetchImpl);
}

async function currentMacBrowserCallback() {
  if (process.platform !== "darwin") {
    throw new CliError("Automatic browser callback capture is currently supported on macOS; provide the final callback URL instead", "BROWSER_CAPTURE_UNSUPPORTED");
  }
  const scripts = [
    `if application "Safari" is running then
      tell application "Safari"
        repeat with browserWindow in windows
          repeat with browserTab in tabs of browserWindow
            set candidate to URL of browserTab
            if candidate starts with "${REDIRECT_URI}" then return candidate
          end repeat
        end repeat
      end tell
    end if`,
    ...["Google Chrome", "Brave Browser", "Microsoft Edge", "Arc"].map((browser) => `if application "${browser}" is running then
      tell application "${browser}"
        repeat with browserWindow in windows
          repeat with browserTab in tabs of browserWindow
            set candidate to URL of browserTab
            if candidate starts with "${REDIRECT_URI}" then return candidate
          end repeat
        end repeat
      end tell
    end if`),
  ];
  const expected = new URL(REDIRECT_URI);
  for (const script of scripts) {
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { encoding: "utf8" });
      const value = stdout.trim();
      if (!value) continue;
      const url = new URL(value);
      if (url.origin === expected.origin && url.pathname === expected.pathname) return url.toString();
    } catch {
      // Try the next supported browser. macOS may also deny automation permission.
    }
  }
  throw new CliError("Finish the Just Eat login in the browser, then try again. If browser access is denied, provide the final Just Eat callback URL in chat.", "AUTH_BROWSER_NOT_READY");
}

export async function startOfficialBrowserLogin({ timeoutMs = 10 * 60_000, openUrl = openSystemUrl } = {}) {
  const authorization = createAuthorizationRequest();
  const pending = {
    schemaVersion: 1,
    kind: "browser",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    authorization: { verifier: authorization.verifier, state: authorization.state },
  };
  await savePendingLogin(pending);
  try {
    openUrl(authorization.url.toString());
  } catch (error) {
    throw new CliError("The system browser could not be opened", "BROWSER_UNAVAILABLE", { cause: error.message });
  }
  return {
    opened: true,
    expiresAt: pending.expiresAt,
    next: "Complete the Just Eat login in the browser, return to ChatGPT, and say done.",
  };
}

export async function completeOfficialBrowserLogin({ callbackUrl, getCurrentUrl = currentMacBrowserCallback, fetchImpl = fetch } = {}) {
  const pending = await loadPendingLogin("browser");
  const value = callbackUrl || await getCurrentUrl();
  const result = await exchangeAuthorizationCallback(value, pending.authorization, fetchImpl);
  await unlink(AUTH_PENDING_FILE).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return result;
}

export async function loginWithSystemBrowser({
  timeoutMs = 10 * 60_000,
  pollIntervalMs = 50,
  openUrl = openSystemUrl,
  getCurrentUrl = currentMacBrowserCallback,
  fetchImpl = fetch,
  reuseExisting = true,
} = {}) {
  if (reuseExisting) {
    const existing = await authStatus({ fetchImpl });
    if (existing.authenticated) {
      return {
        ...existing,
        opened: false,
        reused: true,
        next: "Already signed in; no browser login was needed.",
      };
    }
  }
  const authorization = createAuthorizationRequest();
  try {
    openUrl(authorization.url.toString());
  } catch (error) {
    throw new CliError("The system browser could not be opened", "BROWSER_UNAVAILABLE", { cause: error.message });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const callbackUrl = await getCurrentUrl();
      if (callbackUrl) return exchangeAuthorizationCallback(callbackUrl, authorization, fetchImpl);
    } catch (error) {
      if (error?.code !== "AUTH_BROWSER_NOT_READY") throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }
  }
  throw new CliError("Login timed out; start the login again", "AUTH_TIMEOUT");
}

function flowRequester({ jar, deadline, fetchImpl }) {
  return async (url, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError("Login timed out; start the login again", "AUTH_TIMEOUT");
    const cookie = jar.header();
    const response = await fetchImpl(url, {
      ...options,
      redirect: "manual",
      headers: {
        ...options.headers,
        ...(cookie ? { cookie } : {}),
      },
      signal: options.signal ?? AbortSignal.timeout(remaining),
    });
    jar.ingest(response.headers);
    return response;
  };
}

async function beginOfficialEmailFlow({ email, fetchImpl = fetch, timeoutMs = 10 * 60_000 }) {
  if (!email) throw new CliError("An email address is required", "AUTH_INPUT_REQUIRED");
  const authorization = createAuthorizationRequest();
  const jar = new CookieJar();
  const deadline = Date.now() + timeoutMs;
  const request = flowRequester({ jar, deadline, fetchImpl });

  const authorizationResponse = await request(authorization.url);
  const loginLocation = authorizationResponse.headers.get("location");
  if (authorizationResponse.status < 300 || authorizationResponse.status >= 400 || !loginLocation) {
    throw new CliError("Just Eat did not start the authorization flow", "AUTH_PROTOCOL_ERROR");
  }
  const loginUrl = absoluteAuthUrl(loginLocation);
  if (loginUrl.origin !== AUTH_ORIGIN || loginUrl.pathname !== "/account/login") {
    throw new CliError("Just Eat rejected the CLI OAuth client", "AUTH_CLIENT_REJECTED");
  }
  const returnUrl = loginUrl.searchParams.get("ReturnUrl");
  if (!returnUrl) throw new CliError("Just Eat omitted the authorization return URL", "AUTH_PROTOCOL_ERROR");
  await request(loginUrl);

  const validateEmailResponse = await request(`${AUTH_ORIGIN}/applications/authenticationservice/credentials/email/validate`, {
    method: "POST",
    headers: oauthHeaders({
      "content-type": "application/json",
      origin: AUTH_ORIGIN,
      referer: loginUrl.toString(),
      "x-jet-captcha": "",
    }),
    body: JSON.stringify({ email, returnUrl }),
  });
  const emailPayload = await validateEmailResponse.json().catch(() => ({}));
  if (validateEmailResponse.status !== 200 || !emailPayload.validatedReturnUrl) {
    throw new CliError(oauthError(emailPayload, "Just Eat rejected the email login request"), "AUTH_EMAIL_REJECTED", {
      status: validateEmailResponse.status,
    });
  }

  return {
    schemaVersion: 1,
    kind: "email",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(deadline).toISOString(),
    authorization: { verifier: authorization.verifier, state: authorization.state },
    validatedReturnUrl: emailPayload.validatedReturnUrl,
    cookies: jar.serialize(),
    target: emailPayload.target ?? email,
  };
}

async function finishOfficialEmailFlow(pending, otp, fetchImpl = fetch) {
  const code = String(otp ?? "").trim();
  if (!code) throw new CliError("A verification code is required", "AUTH_OTP_REQUIRED");
  const deadline = Date.parse(pending?.expiresAt);
  if (pending?.schemaVersion !== 1 || !pending.authorization?.verifier
    || !pending.authorization?.state || !pending.validatedReturnUrl
    || !Number.isFinite(deadline)) {
    throw new CliError("The pending login is invalid; start the login again", "AUTH_PENDING_INVALID");
  }
  if (deadline <= Date.now()) throw new CliError("Login timed out; start the login again", "AUTH_TIMEOUT");
  const jar = new CookieJar(pending.cookies);
  const request = flowRequester({ jar, deadline, fetchImpl });

  const validateOtpResponse = await request(`${AUTH_ORIGIN}/applications/authenticationservice/credentials/otp/validate`, {
    method: "POST",
    headers: oauthHeaders({
      "content-type": "application/json",
      origin: AUTH_ORIGIN,
      referer: `${AUTH_ORIGIN}/account/mfa`,
    }),
    body: JSON.stringify({ otp: code, returnUrl: pending.validatedReturnUrl }),
  });
  const otpPayload = await validateOtpResponse.json().catch(() => ({}));
  if (validateOtpResponse.status !== 200 || !otpPayload.validatedReturnUrl) {
    throw new CliError(oauthError(otpPayload, "Just Eat rejected the verification code"), "AUTH_OTP_REJECTED", {
      status: validateOtpResponse.status,
    });
  }

  let continuation = absoluteAuthUrl(otpPayload.validatedReturnUrl);
  let callbackUrl;
  for (let redirectCount = 0; redirectCount < 10; redirectCount += 1) {
    const response = await request(continuation);
    const location = response.headers.get("location");
    if (!location) break;
    const next = new URL(location, continuation);
    if (next.origin === new URL(REDIRECT_URI).origin && next.pathname === new URL(REDIRECT_URI).pathname) {
      callbackUrl = next;
      break;
    }
    if (next.origin !== AUTH_ORIGIN) break;
    continuation = next;
  }
  if (!callbackUrl) throw new CliError("Just Eat did not return an authorization code", "AUTH_PROTOCOL_ERROR");
  return exchangeAuthorizationCallback(callbackUrl, pending.authorization, fetchImpl);
}

async function savePendingLogin(pending) {
  await ensureConfigDirectory();
  await writeFile(AUTH_PENDING_FILE, `${JSON.stringify(pending, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(AUTH_PENDING_FILE, 0o600);
}

async function loadPendingLogin(expectedKind) {
  try {
    const pending = JSON.parse(await readFile(AUTH_PENDING_FILE, "utf8"));
    if (expectedKind && pending.kind !== expectedKind) {
      throw new CliError(`A different login method is pending; start the ${expectedKind} login again`, "AUTH_PENDING_MISMATCH");
    }
    return pending;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === "ENOENT") {
      throw new CliError("No login is waiting for a verification code; request a code first", "AUTH_PENDING_REQUIRED");
    }
    throw new CliError("The pending login is unreadable; request a new code", "AUTH_PENDING_INVALID");
  }
}

export async function requestOfficialEmailCode({ email, fetchImpl = fetch, timeoutMs = 10 * 60_000 } = {}) {
  const pending = await beginOfficialEmailFlow({ email, fetchImpl, timeoutMs });
  await savePendingLogin(pending);
  return {
    codeSent: true,
    target: pending.target,
    expiresAt: pending.expiresAt,
    next: "Provide the Just Eat verification code to complete login.",
  };
}

export async function completeOfficialEmailCode({ otp, fetchImpl = fetch } = {}) {
  const pending = await loadPendingLogin("email");
  const result = await finishOfficialEmailFlow(pending, otp, fetchImpl);
  await unlink(AUTH_PENDING_FILE).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return result;
}

export async function loginWithOfficialSite({ email, getOtp, fetchImpl = fetch, timeoutMs = 10 * 60_000 } = {}) {
  if (!email || typeof getOtp !== "function") {
    throw new CliError("Email and OTP input are required for login", "AUTH_INPUT_REQUIRED");
  }
  const pending = await beginOfficialEmailFlow({ email, fetchImpl, timeoutMs });
  const otp = await getOtp({ email: pending.target });
  return finishOfficialEmailFlow(pending, otp, fetchImpl);
}

export async function openOfficialCheckout(slug) {
  const url = `https://www.just-eat.es/restaurants-${slug}/menu`;
  try {
    openSystemUrl(url);
  } catch (error) {
    throw new CliError("The system browser could not be opened", "BROWSER_UNAVAILABLE", { cause: error.message });
  }
  return { opened: true, restaurantSlug: slug, submittedByCli: false };
}

export const authPaths = {
  configDirectory: CONFIG_DIRECTORY,
  authFile: AUTH_FILE,
  pendingFile: AUTH_PENDING_FILE,
};
