#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarios = JSON.parse(await readFile(resolve(root, "test/fixtures/live-scenarios.json"), "utf8"));
const all = process.argv.includes("--all");
const requested = process.argv.find((value) => value.startsWith("--scenario="))?.split("=")[1];
const selected = requested
  ? scenarios.filter(({ id }) => id === requested)
  : all ? scenarios : scenarios.slice(0, 3);
// A full three-provider search expands many merchant catalogs. Keep the live
// matrix human-paced by default so one test run does not turn its own traffic
// into provider cooldown failures. Developers may override this for a single
// targeted scenario.
const pauseMilliseconds = Math.max(0, Number(process.env.ORDERSCOUT_LIVE_PAUSE_MS ?? 65_000));

if (!selected.length) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: "Unknown live scenario", requested })}\n`);
  process.exit(2);
}

function run(args, timeout = 240_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["src/orderscout.js", ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    const errors = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out: ${args.slice(0, 3).join(" ")}`));
    }, timeout);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      let payload;
      try { payload = JSON.parse(stdout || stderr); }
      catch { payload = { error: { code: "INVALID_OUTPUT", message: (stderr || stdout).slice(-500) } }; }
      resolveRun({ code, payload });
    });
  });
}

function providerSummary(payload) {
  const statuses = payload.search?.providerStatus ?? payload.providerStatus ?? {};
  return Object.fromEntries(Object.entries(statuses).map(([provider, status]) => [provider, {
    state: status.state,
    offerCount: status.offerCount ?? 0,
    partial: Boolean(status.partial ?? status.discovery?.partial ?? status.state === "partial"),
    error: status.errorCode ?? status.error?.code ?? null,
    retryAt: status.errorDetails?.retryAt ?? status.discovery?.cooldown?.retryAt
      ?? status.error?.details?.retryAt ?? null,
  }]));
}

const context = await run(["context", "--agent"]);
const accounts = await run(["accounts", "status", "--agent"]);
const accountRows = accounts.payload.providers ?? [];
const report = {
  version: context.payload.version ?? null,
  workflowContract: context.payload.workflowContract ?? null,
  accounts: Object.fromEntries(accountRows.map((account) => [account.id, {
    enabled: account.enabled,
    authenticated: account.authenticated,
    persistent: account.persistent ?? null,
    addressSelected: account.addressSelected ?? null,
  }])),
  searches: [],
  drafts: null,
};

for (const [scenarioIndex, scenario] of selected.entries()) {
  const args = [
    "search", "begin", scenario.request,
    "--agent", "--semantic-mode", "llm", "--objective", scenario.objective,
    "--discovery-queries", JSON.stringify(scenario.discoveryQueries),
    "--catalog-queries", JSON.stringify(scenario.catalogQueries),
    "--shopping-items", JSON.stringify(scenario.shoppingItems),
    "--external-research", scenario.externalDimensions ? "required" : "not_needed",
    ...(scenario.externalDimensions ? ["--external-dimensions", JSON.stringify(scenario.externalDimensions)] : []),
  ];
  const outcome = await run(args);
  const payload = outcome.payload;
  const candidatePool = payload.candidatePool ?? payload.results?.candidatePool ?? {};
  report.searches.push({
    id: scenario.id,
    ok: outcome.code === 0,
    searchId: payload.searchId ?? payload.search?.id ?? null,
    providers: providerSummary(payload),
    candidateCount: candidatePool.total ?? candidatePool.count ?? null,
    allConfiguredAttempted: payload.coverage?.allConfiguredAttempted
      ?? payload.results?.coverage?.allConfiguredAttempted ?? null,
    addressParity: payload.coverage?.deliveryLocation?.status
      ?? payload.results?.coverage?.deliveryLocation?.status ?? null,
    error: payload.error?.code ?? null,
  });
  if (scenarioIndex < selected.length - 1 && pauseMilliseconds > 0) {
    await new Promise((resolvePause) => setTimeout(resolvePause, pauseMilliseconds));
  }
}

if (process.env.ORDERSCOUT_LIVE_DRAFTS === "1") {
  const searchId = process.env.ORDERSCOUT_LIVE_SEARCH_ID;
  if (!searchId) {
    report.drafts = { ok: false, error: "ORDERSCOUT_LIVE_SEARCH_ID is required when draft canaries are enabled" };
  } else {
    const outcome = await run(["comparison", "quote", searchId, "--agent"]);
    report.drafts = {
      ok: outcome.code === 0,
      searchId,
      error: outcome.payload.error?.code ?? null,
      submitted: false,
    };
  }
}

const enabled = Object.values(report.accounts).filter((account) => account.enabled);
const authOk = accounts.code === 0 && enabled.length > 0 && enabled.every((account) => account.authenticated);
const searchesOk = report.searches.every((search) => search.ok
  && Object.keys(search.providers).length === enabled.length
  && Object.values(search.providers).every((provider) => provider.state === "complete" && !provider.partial));
const draftsOk = !report.drafts || report.drafts.ok;
report.ok = context.code === 0 && authOk && searchesOk && draftsOk;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
