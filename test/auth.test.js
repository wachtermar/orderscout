import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const configDirectory = await mkdtemp(join(tmpdir(), "justeat-auth-test-"));
process.env.JUSTEAT_CONFIG_DIR = configDirectory;
const {
  authPaths,
  authStatus,
  completeOfficialBrowserLogin,
  completeOfficialEmailCode,
  loginWithOfficialSite,
  loginWithSystemBrowser,
  requestOfficialEmailCode,
  saveAuth,
  startOfficialBrowserLogin,
} = await import("../src/auth.js");

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("saved OAuth authentication uses an owner-only file", async () => {
  const token = fakeJwt({ sub: "test", tenant: ["es"], role: "Registered", exp: Math.floor(Date.now() / 1000) + 3600 });
  const saved = await saveAuth(token);
  const status = await authStatus();
  const fileStatus = await stat(authPaths.authFile);
  assert.equal(saved.authenticated, true);
  assert.equal(status.source, "official-oauth");
  assert.equal(fileStatus.mode & 0o777, 0o600);
});

test("email OTP login completes authorization-code PKCE without a browser", async () => {
  const token = fakeJwt({ sub: "oauth-user", tenant: ["es"], exp: Math.floor(Date.now() / 1000) + 3600 });
  let state;
  let sawChallenge = false;
  let sawVerifier = false;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/connect/authorize") {
      state = url.searchParams.get("state");
      sawChallenge = url.searchParams.get("code_challenge_method") === "S256"
        && Boolean(url.searchParams.get("code_challenge"));
      const returnUrl = `/connect/authorize/callback?state=${encodeURIComponent(state)}`;
      return new Response(null, {
        status: 302,
        headers: { location: `https://auth.just-eat.es/account/login?ReturnUrl=${encodeURIComponent(returnUrl)}` },
      });
    }
    if (url.pathname === "/account/login") return new Response("login", { status: 200 });
    if (url.pathname.endsWith("/credentials/email/validate")) {
      return Response.json({ target: "masked@example.com", validatedReturnUrl: "/after-email" });
    }
    if (url.pathname.endsWith("/credentials/otp/validate")) {
      assert.equal(JSON.parse(options.body).otp, "123456");
      return Response.json({ validatedReturnUrl: "/continue" });
    }
    if (url.pathname === "/continue") {
      return new Response(null, {
        status: 302,
        headers: { location: `https://www.just-eat.es/account/oauth-callback?code=test-code&state=${state}` },
      });
    }
    if (url.pathname === "/connect/token") {
      const form = new URLSearchParams(options.body);
      sawVerifier = form.get("grant_type") === "authorization_code" && Boolean(form.get("code_verifier"));
      return Response.json({ access_token: token, refresh_token: "refresh-token" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await loginWithOfficialSite({
    email: "person@example.com",
    getOtp: async () => "123456",
    fetchImpl,
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.source, "official-oauth");
  assert.equal(sawChallenge, true);
  assert.equal(sawVerifier, true);
});

test("MCP-friendly email login persists protected pending state across calls", async () => {
  const token = fakeJwt({ sub: "work-user", tenant: ["es"], exp: Math.floor(Date.now() / 1000) + 3600 });
  let state;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/connect/authorize") {
      state = url.searchParams.get("state");
      const returnUrl = `/connect/authorize/callback?state=${encodeURIComponent(state)}`;
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://auth.just-eat.es/account/login?ReturnUrl=${encodeURIComponent(returnUrl)}`,
          "set-cookie": "flow=session; Secure; HttpOnly",
        },
      });
    }
    if (url.pathname === "/account/login") return new Response("login", { status: 200 });
    if (url.pathname.endsWith("/credentials/email/validate")) {
      assert.equal(JSON.parse(options.body).email, "work@example.com");
      return Response.json({ target: "w***@example.com", validatedReturnUrl: "/after-email" });
    }
    if (url.pathname.endsWith("/credentials/otp/validate")) {
      assert.match(options.headers.cookie, /flow=session/);
      assert.equal(JSON.parse(options.body).otp, "654321");
      return Response.json({ validatedReturnUrl: "/continue" });
    }
    if (url.pathname === "/continue") {
      return new Response(null, {
        status: 302,
        headers: { location: `https://www.just-eat.es/account/oauth-callback?code=work-code&state=${state}` },
      });
    }
    if (url.pathname === "/connect/token") {
      return Response.json({ access_token: token, refresh_token: "work-refresh" });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const started = await requestOfficialEmailCode({ email: "work@example.com", fetchImpl });
  assert.equal(started.codeSent, true);
  assert.equal(started.target, "w***@example.com");
  assert.equal((await stat(authPaths.pendingFile)).mode & 0o777, 0o600);

  const completed = await completeOfficialEmailCode({ otp: "654321", fetchImpl });
  assert.equal(completed.authenticated, true);
  await assert.rejects(stat(authPaths.pendingFile), { code: "ENOENT" });
});

test("ChatGPT Work browser login starts and completes without a terminal", async () => {
  const token = fakeJwt({ sub: "browser-user", tenant: ["es"], exp: Math.floor(Date.now() / 1000) + 3600 });
  let authorizationUrl;
  const started = await startOfficialBrowserLogin({
    openUrl: (url) => { authorizationUrl = new URL(url); },
  });
  assert.equal(started.opened, true);
  assert.equal(authorizationUrl.origin, "https://auth.just-eat.es");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const state = authorizationUrl.searchParams.get("state");

  const completed = await completeOfficialBrowserLogin({
    getCurrentUrl: async () => `https://www.just-eat.es/account/oauth-callback?code=browser-code&state=${state}`,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.pathname, "/connect/token");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("code"), "browser-code");
      assert.ok(form.get("code_verifier"));
      return Response.json({ access_token: token, refresh_token: "browser-refresh" });
    },
  });
  assert.equal(completed.authenticated, true);
  await assert.rejects(stat(authPaths.pendingFile), { code: "ENOENT" });
});

test("system browser login observes the callback and completes in one call", async () => {
  const token = fakeJwt({ sub: "native-user", tenant: ["es"], exp: Math.floor(Date.now() / 1000) + 3600 });
  let authorizationUrl;
  let polls = 0;
  const completed = await loginWithSystemBrowser({
    pollIntervalMs: 1,
    openUrl: (url) => { authorizationUrl = new URL(url); },
    getCurrentUrl: async () => {
      polls += 1;
      if (polls === 1) return null;
      const state = authorizationUrl.searchParams.get("state");
      return `https://www.just-eat.es/account/oauth-callback?code=native-code&state=${state}`;
    },
    fetchImpl: async (input, options) => {
      assert.equal(new URL(input).pathname, "/connect/token");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("code"), "native-code");
      assert.ok(form.get("code_verifier"));
      return Response.json({ access_token: token, refresh_token: "native-refresh" });
    },
  });
  assert.equal(polls, 2);
  assert.equal(completed.authenticated, true);
});
