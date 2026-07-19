import { authStatus } from "./auth.js";
import { requestJson } from "./lib.js";

const OIDC_METADATA = "https://auth.just-eat.es/.well-known/openid-configuration";

async function check(name, action) {
  const startedAt = Date.now();
  try {
    const details = await action();
    return { name, ok: true, latencyMs: Date.now() - startedAt, ...details };
  } catch (error) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: { code: error.code ?? "UNEXPECTED_ERROR", message: error.message },
    };
  }
}

export async function runDoctor({ fetchImpl = fetch, version = null } = {}) {
  const checks = await Promise.all([
    check("discovery-api", async () => {
      const url = new URL("https://i18n.api.just-eat.io/autocomplete/addresses/es");
      url.searchParams.set("input", "Madrid");
      url.searchParams.set("type", "any");
      url.searchParams.set("limit", "1");
      const payload = await requestJson(url, {}, fetchImpl);
      return { reachable: Array.isArray(payload.data) };
    }),
    check("menu-cdn", async () => {
      const response = await fetchImpl("https://menu-globalmenucdn.justeat-int.com/robots.txt", {
        signal: AbortSignal.timeout(10_000),
      });
      return { reachable: response.status < 500, status: response.status };
    }),
    check("oauth", async () => {
      const metadata = await requestJson(OIDC_METADATA, {}, fetchImpl);
      return { issuer: metadata.issuer, pkce: metadata.code_challenge_methods_supported?.includes("S256") ?? false };
    }),
  ]);
  const authenticationStatus = await authStatus().catch((error) => ({
    authenticated: false,
    error: { code: error.code ?? "INVALID_AUTH", message: error.message },
  }));
  const authentication = {
    authenticated: authenticationStatus.authenticated,
    source: authenticationStatus.source ?? null,
    expired: authenticationStatus.expired ?? null,
    expiresAt: authenticationStatus.expiresAt ?? null,
    ...(authenticationStatus.error ? { error: authenticationStatus.error } : {}),
  };
  return {
    ok: checks.every((entry) => entry.ok),
    version,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    authentication,
    checks,
  };
}

export function agentContext() {
  return {
    name: "justeat-es-cli",
    market: "ES",
    output: { success: "JSON on stdout", failure: "JSON on stderr" },
    authentication: {
      command: "justeat auth login",
      method: "official OAuth authorization-code flow with PKCE in the system browser",
      agentTools: ["justeat_auth_login"],
      agentMethod: "native system-browser OAuth with automatic callback detection; no terminal, automated browser, password, cookie, callback, or access-token sharing",
    },
    capabilities: {
      read: ["location autocomplete", "restaurant discovery", "menus", "saved account addresses", "recommendations", "checkout quotes"],
      mutations: ["explicit basket creation", "explicit checkout JSON Patch", "fingerprint-confirmed payment request"],
      externalHandoff: ["official restorable group-basket URL for manual browser checkout"],
      unsupported: ["storing payment credentials", "bypassing payment authentication", "bypassing bot protection"],
    },
    safety: {
      mutatesWithoutExplicitFlag: false,
      canSubmitOrders: true,
      submitsWithoutFingerprint: false,
      placementEnvironmentGate: "JUSTEAT_ENABLE_ORDER_PLACEMENT=1",
      agentFlagConfirmsPurchases: false,
    },
    examples: [
      "justeat search --open --limit 10 --agent",
      "justeat menu <slug> --search agua --agent",
      "justeat recommend 'cheap 6 litres of water' --agent",
      "justeat account addresses --agent",
    ],
  };
}
