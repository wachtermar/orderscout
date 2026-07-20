#!/usr/bin/env node
import {
  CliError,
  accountGet,
  autocomplete,
  discoverRestaurants,
  fetchMenu,
  filterMenu,
  hasUsableCoordinates,
  normalizeMenu,
  normalizeRestaurants,
  normalizeSavedAddresses,
  normalizeSlug,
  parseArgs,
  resolveLocation,
  resolveSavedLocation,
} from "./lib.js";
import {
  authStatus,
  completeOfficialBrowserLogin,
  completeOfficialEmailCode,
  getAuthToken,
  loginWithNativeBrowser,
  loginWithSystemBrowser,
  loginWithOfficialSite,
  logout,
  openOfficialCheckout,
  openSystemUrl,
  requestOfficialEmailCode,
  startOfficialBrowserLogin,
} from "./auth.js";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { agentContext, runDoctor } from "./doctor.js";
import { errorEnvelope, exitCodeFor, writeOutput } from "./output.js";
import { recommend } from "./recommend.js";
import {
  buildBasketPayload,
  buildCheckoutPatch,
  compareCandidates,
  createBasket,
  createBrowserHandoff,
  getCheckout,
  getAvailableFulfilmentTimes,
  loadPlan,
  normalizeCheckout,
  optimizeWaterBasket,
  patchCheckout,
  placeOrder,
  savePlan,
  saveOptimization,
  selectFulfilmentWindow,
} from "./order.js";
import { runMcpServer } from "./mcp.js";

const HELP = `justeat — agent-friendly Just Eat Spain discovery and ordering CLI

Usage:
  justeat doctor
  justeat context
  justeat location <query> [--limit 10] [--raw]
  justeat search [query] [--address-index 0] [--limit 20] [--name text] [--cuisine pizza]
                       [--open] [--sort recommended|rating|distance|eta]
                       [--pickup] [--vertical all|restaurants|groceries] [--raw]
  justeat search --lat 40.42 --lon -3.68 [the same filters]
  justeat menu <slug-or-url> [--search text] [--raw]
  justeat recommend <intent> [--at address] [--stores 12] [--limit 10] [--include-closed]
  justeat order show <plan-id>
  justeat order prepare <plan-id> [--candidate 0|--optimized] [--lines JSON] [--modifiers JSON] [--line-modifiers JSON] [--create]
  justeat order quote <plan-id>
  justeat order open <plan-id>
  justeat order compare <plan-id> [--top 3] [--create]
  justeat order optimize <plan-id> [--candidate 0]
  justeat order configure <plan-id> [--address-index 0] [--scheduled ISO] [--apply]
  justeat order patch <plan-id> --patch JSON [--apply]
  justeat order place <plan-id> [--methods JSON] [--confirm fingerprint]
  justeat checkout <slug-or-url>
  justeat auth login
  justeat auth login --direct-email you@example.com [--timeout 600]
  justeat auth request-code --email you@example.com [--timeout 600]
  justeat auth complete-code --code 123456
  justeat auth browser-start [--timeout 600]
  justeat auth browser-complete [--callback-url URL]
  justeat auth work-login [--timeout 600]
  justeat auth status|logout
  justeat account me|addresses
  justeat mcp

Global flags:
  --agent       Compact, non-interactive JSON (never confirms purchases)
  --compact     Compact JSON
  --select PATH Select a dotted output path; comma separates multiple paths
  --quiet       Suppress successful output
  --help        Show help
  --version     Show version

Output is JSON on stdout. Errors are stable JSON on stderr.
Login opens Just Eat OAuth in the system browser and completes PKCE from the callback URL.
`;

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

function numberFlag(flags, key) {
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) throw new CliError(`--${key} must be a number`);
  return value;
}

async function run(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.agent) flags.compact = true;
  const [command, ...rest] = positionals;
  if (flags.version) {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (!command || command === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === "doctor") {
    writeOutput(await runDoctor({ version: packageJson.version }), flags);
    return;
  }

  if (command === "context" || command === "agent-context") {
    writeOutput(agentContext(), flags);
    return;
  }

  if (command === "mcp") {
    await runMcpServer();
    return;
  }

  if (command === "location") {
    const query = rest.join(" ");
    const result = await autocomplete(query, Number(flags.limit ?? 10));
    writeOutput(flags.raw ? result : {
      query,
      suggestions: (result.data ?? []).map(({ description, id, type, next }) =>
        ({ description, id, type, next })),
    }, flags);
    return;
  }

  if (command === "search") {
    let location;
    const query = rest.join(" ");
    if (flags.lat !== undefined || flags.lon !== undefined) {
      if (flags.lat === undefined || flags.lon === undefined) {
        throw new CliError("--lat and --lon must be supplied together");
      }
      location = {
        latitude: numberFlag(flags, "lat"),
        longitude: numberFlag(flags, "lon"),
        postcode: flags.postcode,
      };
    } else if (query) {
      location = await resolveLocation(query);
    } else {
      const token = await getAuthToken({ required: true });
      const addressIndex = Number(flags["address-index"] ?? 0);
      if (!Number.isInteger(addressIndex) || addressIndex < 0) {
        throw new CliError("--address-index must be a non-negative integer");
      }
      location = await resolveSavedLocation(token, addressIndex);
    }
    const options = {
      serviceType: flags.pickup ? "collection" : "delivery",
      vertical: flags.vertical,
      cuisine: flags.cuisine,
      name: flags.name,
      open: Boolean(flags.open),
      sort: flags.sort,
      limit: flags.limit,
      token: await getAuthToken(),
    };
    const result = await discoverRestaurants(location, options);
    writeOutput(flags.raw ? result : {
      location: {
        matched: location.matched,
        latitude: location.latitude,
        longitude: location.longitude,
        postcode: location.postcode ?? result.metaData?.postalCode,
        city: location.city ?? result.metaData?.area,
        canonicalName: location.canonicalName ?? result.metaData?.canonicalName,
      },
      totalAvailable: result.metaData?.resultCount ?? result.restaurants?.length ?? 0,
      returned: normalizeRestaurants(result, options),
    }, flags);
    return;
  }

  if (command === "menu") {
    const target = rest[0];
    const menu = await fetchMenu(target);
    const normalized = flags.raw ? menu : filterMenu(normalizeMenu(menu), flags.search);
    writeOutput(normalized, flags);
    return;
  }

  if (command === "recommend" || command === "plan") {
    const intent = rest.join(" ");
    if (!intent) throw new CliError("Describe what you want, for example `recommend 6 litres of water`");
    let location;
    if (flags.at) {
      location = await resolveLocation(String(flags.at));
    } else if (flags.lat !== undefined || flags.lon !== undefined) {
      if (flags.lat === undefined || flags.lon === undefined) {
        throw new CliError("--lat and --lon must be supplied together");
      }
      location = {
        latitude: numberFlag(flags, "lat"),
        longitude: numberFlag(flags, "lon"),
        postcode: flags.postcode,
      };
    } else {
      const token = await getAuthToken({ required: true });
      const addressIndex = Number(flags["address-index"] ?? 0);
      if (!Number.isInteger(addressIndex) || addressIndex < 0) {
        throw new CliError("--address-index must be a non-negative integer");
      }
      location = await resolveSavedLocation(token, addressIndex);
    }
    const token = await getAuthToken();
    let shoppingItems = [];
    if (flags["shopping-items"] !== undefined) {
      try { shoppingItems = JSON.parse(String(flags["shopping-items"])); }
      catch { throw new CliError("--shopping-items must be valid JSON", "INVALID_SHOPPING_ITEMS"); }
      if (!Array.isArray(shoppingItems) || shoppingItems.some((item) => !item || typeof item.intent !== "string")) {
        throw new CliError("--shopping-items must be an array of objects with intent", "INVALID_SHOPPING_ITEMS");
      }
    }
    const recommendation = await recommend(location, intent, {
      token,
      stores: flags.stores,
      limit: flags.limit,
      vertical: flags.vertical,
      open: Boolean(flags.open),
      includeClosed: Boolean(flags["include-closed"]),
      candidateMode: flags["candidate-mode"],
      shoppingIntents: shoppingItems.map((item) => item.intent),
    });
    const plan = await savePlan(recommendation);
    writeOutput({ planId: plan.id, ...recommendation }, flags);
    return;
  }

  if (command === "order" || command === "cart") {
    const [action, planId] = rest;
    if (action === "show") {
      writeOutput(await loadPlan(planId), flags);
      return;
    }
    if (action === "prepare") {
      const plan = await loadPlan(planId);
      const optimizedLines = flags.optimized ? plan.optimization?.lines : null;
      if (flags.optimized && !optimizedLines?.length) {
        throw new CliError("Run `justeat order optimize <plan-id>` first", "OPTIMIZATION_REQUIRED");
      }
      const candidateIndex = Number(flags.candidate ?? optimizedLines?.[0]?.candidateIndex ?? 0);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        throw new CliError("--candidate must be a non-negative integer");
      }
      let explicitLines;
      if (flags.lines !== undefined) {
        try { explicitLines = JSON.parse(String(flags.lines)); }
        catch { throw new CliError("--lines must be a JSON array", "INVALID_LINES"); }
        if (!Array.isArray(explicitLines) || !explicitLines.length) throw new CliError("--lines must be a non-empty JSON array", "INVALID_LINES");
      }
      let lineModifiers;
      if (flags["line-modifiers"] !== undefined) {
        try { lineModifiers = JSON.parse(String(flags["line-modifiers"])); }
        catch { throw new CliError("--line-modifiers must be a JSON object keyed by candidate index", "INVALID_MODIFIERS"); }
        if (!lineModifiers || typeof lineModifiers !== "object" || Array.isArray(lineModifiers)) {
          throw new CliError("--line-modifiers must be a JSON object keyed by candidate index", "INVALID_MODIFIERS");
        }
      }
      const options = {
        quantity: flags.quantity,
        note: flags.note,
        modifiers: flags.modifiers,
        lineModifiers,
        lines: explicitLines ?? optimizedLines,
        allergenReviewed: Boolean(flags["allergen-reviewed"]),
      };
      const payload = buildBasketPayload(plan, candidateIndex, options);
      if (!flags.create) {
        writeOutput({
          created: false,
          planId,
          candidateIndex,
          payload,
          next: flags.optimized
            ? `justeat order prepare ${planId} --optimized --create`
            : `justeat order prepare ${planId} --candidate ${candidateIndex} --create`,
        }, flags);
        return;
      }
      const result = await createBasket(plan, candidateIndex, {
        ...options,
        token: await getAuthToken(),
      });
      writeOutput({
        created: true,
        planId,
        basketId: result.plan.remote.basketId,
        candidateIndex,
        next: `justeat order quote ${planId}`,
      }, flags);
      return;
    }
    if (action === "quote") {
      const result = await getCheckout(await loadPlan(planId), { token: await getAuthToken() });
      writeOutput({
        planId,
        basketId: result.plan.remote.basketId,
        quote: flags.raw ? result.quote : normalizeCheckout(result.quote),
        remoteBasketVerification: result.remoteBasketVerification,
      }, flags);
      return;
    }
    if (action === "open") {
      const result = await createBrowserHandoff(await loadPlan(planId), {
        token: await getAuthToken({ required: true }),
      });
      if (!flags["no-open"]) openSystemUrl(result.handoff.url);
      writeOutput({
        opened: !flags["no-open"],
        url: result.handoff.url,
        planId,
        basketId: result.plan.remote.basketId,
        basketMode: result.handoff.mode,
        groupStatus: result.handoff.status,
        submitted: false,
      }, flags);
      return;
    }
    if (action === "compare") {
      const result = await compareCandidates(await loadPlan(planId), {
        limit: flags.top,
        create: Boolean(flags.create),
        raw: Boolean(flags.raw),
        allergenReviewed: Boolean(flags["allergen-reviewed"]),
        token: await getAuthToken(),
      });
      writeOutput({ planId, ...result }, flags);
      return;
    }
    if (action === "optimize") {
      const plan = await loadPlan(planId);
      const candidateIndex = Number(flags.candidate ?? plan.remote?.candidateIndex ?? 0);
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0) {
        throw new CliError("--candidate must be a non-negative integer");
      }
      const optimization = optimizeWaterBasket(plan, candidateIndex);
      await saveOptimization(plan, optimization);
      writeOutput({
        planId,
        optimization,
        next: `justeat order prepare ${planId} --optimized`,
      }, flags);
      return;
    }
    if (action === "configure") {
      const token = await getAuthToken({ required: true });
      const [profile, addressPayload] = await Promise.all([
        accountGet("me", token),
        accountGet("addresses", token),
      ]);
      const addressIndex = Number(flags["address-index"] ?? 0);
      const savedAddress = normalizeSavedAddresses(addressPayload)[addressIndex];
      if (!savedAddress) throw new CliError(`Saved address ${addressIndex} does not exist`, "ADDRESS_NOT_FOUND");
      const hasCoordinates = hasUsableCoordinates(savedAddress);
      const resolved = hasCoordinates ? null : await resolveSavedLocation(token, addressIndex);
      const address = resolved ? {
        ...savedAddress,
        latitude: resolved.latitude,
        longitude: resolved.longitude,
        postcode: savedAddress.postcode ?? resolved.postcode,
        city: savedAddress.city ?? resolved.city,
      } : savedAddress;
      const scheduledWindow = flags.scheduled
        ? selectFulfilmentWindow(await getAvailableFulfilmentTimes(await loadPlan(planId), { token }), flags.scheduled)
        : null;
      const patch = buildCheckoutPatch(profile, address, { scheduled: scheduledWindow });
      if (!flags.apply) {
        writeOutput({
          applied: false,
          planId,
          addressIndex,
          selectedWindow: scheduledWindow,
          patch,
          next: `justeat order configure ${planId} --address-index ${addressIndex} --apply`,
        }, flags);
        return;
      }
      const response = await patchCheckout(await loadPlan(planId), patch, { token });
      writeOutput({ applied: true, planId, selectedWindow: scheduledWindow, response, next: `justeat order quote ${planId}` }, flags);
      return;
    }
    if (action === "patch") {
      if (!flags.patch) throw new CliError("--patch must contain a JSON Patch array");
      let patch;
      try {
        patch = JSON.parse(String(flags.patch));
      } catch {
        throw new CliError("--patch must be valid JSON");
      }
      if (!flags.apply) {
        writeOutput({ applied: false, planId, patch, next: `justeat order patch ${planId} --patch '<json>' --apply` }, flags);
        return;
      }
      writeOutput({
        applied: true,
        response: await patchCheckout(await loadPlan(planId), patch, { token: await getAuthToken() }),
      }, flags);
      return;
    }
    if (action === "place") {
      const result = await placeOrder(await loadPlan(planId), {
        methods: flags.methods,
        returnUrl: flags["return-url"],
        confirm: flags.confirm === true ? "" : flags.confirm,
        token: await getAuthToken(),
      });
      writeOutput({ planId, ...result }, flags);
      return;
    }
    throw new CliError("Order command must be show, prepare, compare, optimize, quote, open, configure, patch, or place");
  }

  if (command === "checkout") {
    const slug = normalizeSlug(rest[0]);
    await openOfficialCheckout(slug);
    writeOutput({ opened: true, restaurantSlug: slug, submittedByCli: false }, flags);
    return;
  }

  if (command === "auth") {
    if (rest[0] === "status") {
      writeOutput(await authStatus(), flags);
      return;
    }
    if (rest[0] === "logout") {
      writeOutput(await logout(), flags);
      return;
    }
    if (rest[0] === "request-code") {
      if (!flags.email) throw new CliError("--email is required", "AUTH_INPUT_REQUIRED");
      const timeoutSeconds = Number(flags.timeout ?? 600);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
        throw new CliError("--timeout must be between 30 and 3600 seconds");
      }
      writeOutput(await requestOfficialEmailCode({
        email: String(flags.email),
        timeoutMs: timeoutSeconds * 1_000,
      }), flags);
      return;
    }
    if (rest[0] === "browser-start") {
      const timeoutSeconds = Number(flags.timeout ?? 600);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
        throw new CliError("--timeout must be between 30 and 3600 seconds");
      }
      writeOutput(await startOfficialBrowserLogin({ timeoutMs: timeoutSeconds * 1_000 }), flags);
      return;
    }
    if (rest[0] === "work-login") {
      const timeoutSeconds = Number(flags.timeout ?? 600);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
        throw new CliError("--timeout must be between 30 and 3600 seconds");
      }
      writeOutput(await loginWithSystemBrowser({
        timeoutMs: timeoutSeconds * 1_000,
      }), flags);
      return;
    }
    if (rest[0] === "browser-complete") {
      writeOutput(await completeOfficialBrowserLogin({ callbackUrl: flags["callback-url"] }), flags);
      return;
    }
    if (rest[0] === "complete-code") {
      if (!flags.code) throw new CliError("--code is required", "AUTH_OTP_REQUIRED");
      writeOutput(await completeOfficialEmailCode({ otp: String(flags.code) }), flags);
      return;
    }
    if (rest[0] === "login") {
      if (flags.agent || flags["no-input"]) {
        throw new CliError("Login is interactive; rerun `justeat auth login` in a terminal", "AUTH_INTERACTIVE_REQUIRED");
      }
      const timeoutSeconds = Number(flags.timeout ?? 600);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
        throw new CliError("--timeout must be between 30 and 3600 seconds");
      }
      if (!process.stdin.isTTY) {
        throw new CliError("Interactive login requires a terminal", "AUTH_TTY_REQUIRED");
      }
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        if (flags["direct-email"]) {
          process.stderr.write("Requesting a one-time code from Just Eat…\n");
          writeOutput(await loginWithOfficialSite({
            email: String(flags["direct-email"]),
            timeoutMs: timeoutSeconds * 1_000,
            getOtp: async ({ email: target }) => {
              process.stderr.write(`Just Eat sent a verification code to ${target}.\n`);
              return prompt.question("Verification code: ");
            },
          }), flags);
        } else {
          process.stderr.write("Complete login in your system browser. On the final page, copy the complete URL from the address bar.\n");
          writeOutput(await loginWithNativeBrowser({
            getCallbackUrl: () => prompt.question("Callback URL: "),
          }), flags);
        }
      } finally {
        prompt.close();
      }
      return;
    }
    throw new CliError("Auth command must be login, work-login, browser-start, browser-complete, request-code, complete-code, status, or logout");
  }

  if (command === "account") {
    writeOutput(await accountGet(rest[0], await getAuthToken({ required: true })), flags);
    return;
  }

  if (command === "addresses") {
    writeOutput(await accountGet("addresses", await getAuthToken({ required: true })), flags);
    return;
  }

  throw new CliError(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify(errorEnvelope(error), null, 2)}\n`);
  process.exitCode = exitCodeFor(error);
});
