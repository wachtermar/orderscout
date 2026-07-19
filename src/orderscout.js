#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openSystemUrl } from "./auth.js";
import { beginBrowserLogin, importChromeSession, loadBrowserSession, logoutBrowserSession } from "./browser-session.js";
import {
  createGlovoBasket, glovoAddresses, glovoBaskets, glovoCheckoutUrl, glovoMe, glovoMenu, placeGlovoOrder, quoteGlovoBasket, searchGlovo,
} from "./glovo.js";
import { CliError, parseArgs, resolveLocation } from "./lib.js";
import { errorEnvelope, exitCodeFor, writeOutput } from "./output.js";
import { PROVIDERS, configureAccounts, loadAccounts, parseProviderList, publicAccountStatus, recordProviderStatus } from "./providers.js";
import {
  ingestOffers, loadSearch, recordProviderError, recordQuote, searchResults, startSearch,
} from "./searches.js";
import { runOrderScoutMcpServer } from "./orderscout-mcp.js";
import {
  createUberEatsBasket, placeUberEatsOrder, quoteUberEatsBasket, searchUberEats, uberEatsCarts, uberEatsMe, uberEatsMenu,
} from "./ubereats.js";

const execFileAsync = promisify(execFile);
const JUSTEAT_CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const HELP = `orderscout — compare Just Eat, Glovo, and Uber Eats in Spain

Usage:
  orderscout context
  orderscout auth login|complete|status|logout <provider> [--profile Default]
  orderscout accounts status
  orderscout accounts set --providers justeat,glovo,ubereats [--accounts JSON] [--memberships JSON]
  orderscout accounts record <provider> --authenticated true [--membership true]
  orderscout recommend <what you want> [--providers list] [--at location] [--objective cheapest|fastest|best|value]
  orderscout search begin <what you want> [the same flags]
  orderscout search ingest <search-id> <provider> --json '[normalized offers]'
  orderscout search error <search-id> <provider> --message text
  orderscout search results <search-id>
  orderscout quote record <search-id> <offer-id> --json '{"subtotal":10,"fees":{"delivery":2},"total":12}'
  orderscout basket prepare|create|checkout|open <search-id> <offer-id>
  orderscout order place <search-id> <offer-id> [--confirm fingerprint]
  orderscout offer open <search-id> <offer-id>
  orderscout justeat <existing justeat command...>
  orderscout mcp

All three providers use direct HTTP adapters. Glovo and Uber Eats login opens the official site in native
Chrome and imports only that provider's domain cookies after sign-in; Playwright is not used. Search, menu,
basket, and checkout operations run directly through each provider adapter. No search or quote places an order.
`;

function jsonFlag(flags, key, fallback = undefined) {
  if (flags[key] === undefined) return fallback;
  try { return JSON.parse(String(flags[key])); }
  catch { throw new CliError(`--${key} must be valid JSON`); }
}

function booleanFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  if (flags[key] === true || flags[key] === "true" || flags[key] === "1") return true;
  if (flags[key] === false || flags[key] === "false" || flags[key] === "0") return false;
  throw new CliError(`--${key} must be true or false`);
}

async function runLegacyJustEat(args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(process.execPath, [JUSTEAT_CLI, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch (error) {
    if (allowFailure) return { error: parseChildError(error) };
    if (error.stderr) process.stderr.write(error.stderr);
    throw new CliError("Just Eat adapter failed", "JUSTEAT_ADAPTER_FAILED", { message: error.message });
  }
}

function parseChildError(error) {
  try { return JSON.parse(String(error.stderr).trim()).error ?? { message: error.message }; }
  catch { return { code: "JUSTEAT_ADAPTER_FAILED", message: error.message }; }
}

function justEatOffers(result) {
  return (result.candidates ?? []).map((candidate, index) => ({
    provider: "justeat",
    merchant: {
      id: candidate.restaurant?.id,
      name: candidate.restaurant?.name,
      rating: candidate.restaurant?.rating,
      ratingCount: candidate.restaurant?.ratingCount,
    },
    item: {
      id: candidate.item?.id,
      name: candidate.item?.name,
      description: candidate.item?.description,
      unitPrice: candidate.item?.unitPrice,
    },
    quantity: candidate.quantity,
    package: candidate.package,
    suppliedLiters: candidate.suppliedLiters,
    etaMinutes: candidate.restaurant?.etaMinutes,
    available: candidate.restaurant?.open || candidate.restaurant?.preorder,
    pricing: {
      currency: candidate.item?.currency ?? "EUR",
      subtotal: candidate.itemTotal,
      total: candidate.estimatedDeliveredTotal,
      exact: false,
    },
    signals: {
      health: candidate.ranking?.healthScore,
      taste: candidate.ranking?.tasteScore,
    },
    url: candidate.restaurant?.slug ? `https://www.just-eat.es/restaurants-${candidate.restaurant.slug}/menu` : null,
    source: { planId: result.planId, candidateIndex: index, adapter: "justeat-api" },
  }));
}

async function collectJustEat(searchId, intent, flags) {
  const args = ["recommend", intent, "--agent"];
  for (const [flag, value] of [["at", flags.at], ["stores", flags.stores], ["limit", flags.limit], ["vertical", flags.vertical]]) {
    if (value !== undefined) args.push(`--${flag}`, String(value));
  }
  const result = await runLegacyJustEat(args, { allowFailure: true });
  if (result.error) return recordProviderError(searchId, "justeat", result.error.message ?? result.error.code);
  return ingestOffers(searchId, "justeat", justEatOffers(result));
}

async function collectGlovo(searchId, intent, flags) {
  try {
    let location;
    if (flags.at) location = await resolveLocation(String(flags.at));
    else {
      const addresses = await glovoAddresses();
      location = addresses.find((address) => address.isDefault) ?? addresses[0];
      if (!location) throw new CliError("Glovo has no usable saved delivery address; pass --at once", "LOCATION_REQUIRED");
    }
    const result = await searchGlovo(intent, location, { limit: flags.limit });
    return ingestOffers(searchId, "glovo", result.offers);
  } catch (error) {
    return recordProviderError(searchId, "glovo", error.message ?? error.code);
  }
}

async function collectUberEats(searchId, intent, flags) {
  try {
    const result = await searchUberEats(intent, { limit: flags.limit });
    return ingestOffers(searchId, "ubereats", result.offers);
  } catch (error) {
    return recordProviderError(searchId, "ubereats", error.message ?? error.code);
  }
}

export async function runOrderScout(argv) {
  const { positionals, flags } = parseArgs(argv);
  if (flags.agent) flags.compact = true;
  const [command, ...rest] = positionals;
  if (flags.version) return process.stdout.write(`${packageJson.version}\n`);
  if (!command || command === "help" || flags.help) return process.stdout.write(HELP);

  if (command === "mcp") return runOrderScoutMcpServer();
  if (command === "context") {
    const accounts = publicAccountStatus(await loadAccounts());
    return writeOutput({
      name: "OrderScout",
      country: "ES",
      providers: Object.values(PROVIDERS),
      accounts,
      comparison: ["exact delivered total", "fees", "membership benefits", "promotions", "ETA", "ratings", "quantity", "health/taste signals"],
      priceRule: "A provider can only win an exact cheapest comparison after its final checkout total is recorded.",
      purchaseBoundary: "Search, ingest, compare, quote recording, and browser opening never place an order. Final purchase remains provider-specific and requires exact human confirmation.",
    }, flags);
  }

  if (command === "auth") {
    const [action, provider] = rest;
    if (!provider || !PROVIDERS[provider]) throw new CliError("Use `orderscout auth login|complete|status|logout justeat|glovo|ubereats`");
    if (provider === "justeat") {
      const legacyAction = action === "login" ? "work-login" : action;
      return writeOutput(await runLegacyJustEat(["auth", legacyAction, "--agent"]), flags);
    }
    if (action === "login") return writeOutput(beginBrowserLogin(provider), flags);
    if (action === "complete") {
      const imported = await importChromeSession(provider, { profile: flags.profile ?? "Default", cookiePath: flags["cookie-path"], timeout: Number(flags.timeout ?? 30_000) });
      const profile = provider === "glovo" ? await glovoMe() : await uberEatsMe();
      await recordProviderStatus(provider, { authenticated: true, membershipActive: profile.membershipActive });
      return writeOutput({ ...imported, profile: { id: profile.id, name: profile.name, email: profile.email }, membershipActive: profile.membershipActive ?? null }, flags);
    }
    if (action === "status") {
      const stored = await loadBrowserSession(provider);
      if (!stored) return writeOutput({ provider, authenticated: false, source: null }, flags);
      try {
        const profile = provider === "glovo" ? await glovoMe() : await uberEatsMe();
        await recordProviderStatus(provider, { authenticated: true, membershipActive: profile.membershipActive });
        return writeOutput({ provider, ...profile, source: stored.source, importedAt: stored.importedAt ?? null }, flags);
      } catch (error) {
        await recordProviderStatus(provider, { authenticated: false });
        return writeOutput({ provider, authenticated: false, source: stored.source, error: { code: error.code, message: error.message } }, flags);
      }
    }
    if (action === "logout") {
      const result = await logoutBrowserSession(provider);
      await recordProviderStatus(provider, { authenticated: false });
      return writeOutput(result, flags);
    }
    throw new CliError("Use `orderscout auth login|complete|status|logout <provider>`");
  }

  if (command === "accounts") {
    const [action, provider] = rest;
    if (!action || action === "status") return writeOutput(publicAccountStatus(await loadAccounts()), flags);
    if (action === "set") {
      const enabledProviders = flags.providers ? parseProviderList(flags.providers) : undefined;
      return writeOutput(await configureAccounts({
        enabledProviders,
        accounts: jsonFlag(flags, "accounts", {}),
        memberships: jsonFlag(flags, "memberships", {}),
      }), flags);
    }
    if (action === "record") {
      return writeOutput(await recordProviderStatus(provider, {
        authenticated: booleanFlag(flags, "authenticated"),
        membershipActive: booleanFlag(flags, "membership"),
      }), flags);
    }
    throw new CliError("Use `orderscout accounts status|set|record`");
  }

  if (command === "recommend" || command === "search") {
    const action = command === "recommend" ? "begin" : rest[0];
    const args = command === "recommend" ? rest : rest.slice(1);
    if (action === "begin") {
      const intent = args.join(" ");
      const started = await startSearch(intent, {
        providers: flags.providers,
        objective: flags.objective,
        locationHint: flags.at,
      });
      let result = started;
      if (!flags["skip-api"]) {
        if (started.apiProviders.includes("justeat")) await collectJustEat(started.search.id, intent, flags);
        if (started.apiProviders.includes("glovo")) await collectGlovo(started.search.id, intent, flags);
        if (started.apiProviders.includes("ubereats")) await collectUberEats(started.search.id, intent, flags);
        result = { ...started, results: await searchResults(started.search.id) };
      }
      return writeOutput(result, flags);
    }
    if (action === "ingest") {
      const [searchId, provider] = args;
      return writeOutput(await ingestOffers(searchId, provider, jsonFlag(flags, "json"), {
        complete: booleanFlag(flags, "complete") ?? true,
      }), flags);
    }
    if (action === "error") {
      const [searchId, provider] = args;
      return writeOutput(await recordProviderError(searchId, provider, flags.message ?? "Provider search failed"), flags);
    }
    if (action === "results" || action === "show") return writeOutput(await searchResults(args[0]), flags);
    throw new CliError("Use `orderscout search begin|ingest|error|results`");
  }

  if (command === "quote" && rest[0] === "record") {
    return writeOutput(await recordQuote(rest[1], rest[2], jsonFlag(flags, "json")), flags);
  }

  if (command === "basket") {
    const [action, searchId, offerId] = rest;
    if (!["prepare", "create", "checkout", "open"].includes(action)) throw new CliError("Use `orderscout basket prepare|create|checkout|open`");
    const search = await loadSearch(searchId);
    const offer = search.offers.find((entry) => entry.id === offerId);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    if (action === "open") {
      if (offer.provider === "justeat") {
        if (!offer.source?.planId) throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
        return writeOutput(await runLegacyJustEat(["order", "open", offer.source.planId, "--agent"]), flags);
      }
      const url = offer.provider === "glovo" ? glovoCheckoutUrl(offer)
        : offer.provider === "ubereats" ? "https://www.ubereats.com/checkout?mod=checkout"
          : null;
      if (!url) throw new CliError("This provider has no basket handoff", "BASKET_HANDOFF_REQUIRED");
      await openSystemUrl(url);
      return writeOutput({ provider: offer.provider, opened: true, url, submitted: false }, flags);
    }
    if (offer.provider === "glovo") {
      if (action === "checkout") {
        const baskets = await glovoBaskets();
        const basket = baskets.baskets.find((entry) => String(entry.storeId) === String(offer.source?.storeId));
        if (!basket) throw new CliError("Create this Glovo basket before requesting checkout", "BASKET_REQUIRED");
        return writeOutput(await quoteGlovoBasket(basket.basketId ?? basket.id), flags);
      }
      return writeOutput(await createGlovoBasket(offer, { prepareOnly: action === "prepare", customizations: jsonFlag(flags, "customizations") }), flags);
    }
    if (offer.provider === "ubereats") {
      if (action === "checkout") {
        const carts = await uberEatsCarts();
        const draft = carts.draftOrders.find((entry) => String(entry.storeUuid ?? entry.storeUUID) === String(offer.source?.storeUuid));
        const id = draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid;
        if (!id) throw new CliError("Create this Uber Eats basket before requesting checkout", "BASKET_REQUIRED");
        return writeOutput(await quoteUberEatsBasket(id), flags);
      }
      return writeOutput(await createUberEatsBasket(offer, { prepareOnly: action === "prepare", customizations: jsonFlag(flags, "customizations") }), flags);
    }
    const source = offer.source;
    if (!source?.planId || !Number.isInteger(source.candidateIndex)) {
      throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
    }
    if (action === "checkout") {
      const quote = await runLegacyJustEat(["order", "quote", source.planId, "--agent"]);
      return writeOutput({ provider: "justeat", offerId, quote, submitted: false }, flags);
    }
    const args = ["order", "prepare", source.planId, "--candidate", String(source.candidateIndex), "--agent"];
    if (action === "create") args.push("--create");
    const result = await runLegacyJustEat(args);
    return writeOutput({ provider: "justeat", offerId, action, result, submitted: false }, flags);
  }

  if (command === "order" && rest[0] === "place") {
    const search = await loadSearch(rest[1]);
    const offer = search.offers.find((entry) => entry.id === rest[2]);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    if (offer.provider === "ubereats") {
      const carts = await uberEatsCarts();
      const draft = carts.draftOrders.find((entry) => String(entry.storeUuid ?? entry.storeUUID) === String(offer.source?.storeUuid));
      const id = draft?.uuid ?? draft?.draftOrderUUID ?? draft?.draftOrderUuid;
      if (!id) throw new CliError("Create this Uber Eats basket first", "BASKET_REQUIRED");
      const quoted = await quoteUberEatsBasket(id);
      return writeOutput(await placeUberEatsOrder(id, quoted.quote, { confirm: flags.confirm }), flags);
    }
    if (offer.provider === "glovo") {
      const baskets = await glovoBaskets();
      const basket = baskets.baskets.find((entry) => String(entry.storeId) === String(offer.source?.storeId));
      const basketId = basket?.basketId ?? basket?.id;
      if (!basketId) throw new CliError("Create this Glovo basket first", "BASKET_REQUIRED");
      const quoted = await quoteGlovoBasket(basketId);
      return writeOutput(await placeGlovoOrder(offer, { basketId, ...quoted.quote }, { confirm: flags.confirm }), flags);
    }
    const source = offer.source;
    if (!source?.planId) throw new CliError("Just Eat offer is missing its source plan", "SOURCE_PLAN_MISSING");
    return writeOutput(await runLegacyJustEat([
      "order", "place", source.planId,
      ...(flags.confirm ? ["--confirm", String(flags.confirm)] : []),
      "--agent",
    ]), flags);
  }

  if (command === "glovo") {
    const [action, ...args] = rest;
    if (action === "me") return writeOutput(await glovoMe({ raw: Boolean(flags.raw) }), flags);
    if (action === "addresses") return writeOutput({ addresses: await glovoAddresses() }, flags);
    if (action === "baskets") return writeOutput(await glovoBaskets(), flags);
    if (action === "search") {
      const intent = args.join(" ");
      const location = flags.at ? await resolveLocation(String(flags.at)) : (await glovoAddresses()).find((entry) => entry.isDefault) ?? (await glovoAddresses())[0];
      if (!location) throw new CliError("Pass --at or save an address in Glovo", "LOCATION_REQUIRED");
      return writeOutput(await searchGlovo(intent, location, { raw: Boolean(flags.raw), limit: flags.limit }), flags);
    }
    if (action === "menu") return writeOutput(await glovoMenu(args[0]), flags);
    throw new CliError("Use `orderscout glovo me|addresses|search|menu|baskets`");
  }

  if (command === "ubereats") {
    const [action, ...args] = rest;
    if (action === "me") return writeOutput(await uberEatsMe(), flags);
    if (action === "carts") return writeOutput(await uberEatsCarts(), flags);
    if (action === "search") return writeOutput(await searchUberEats(args.join(" "), { raw: Boolean(flags.raw), limit: flags.limit }), flags);
    if (action === "menu") return writeOutput(await uberEatsMenu(args[0], { raw: Boolean(flags.raw) }), flags);
    throw new CliError("Use `orderscout ubereats me|search|menu|carts`");
  }

  if (command === "offer" && rest[0] === "open") {
    const search = await loadSearch(rest[1]);
    const offer = search.offers.find((entry) => entry.id === rest[2]);
    if (!offer) throw new CliError("Offer not found", "OFFER_NOT_FOUND");
    if (!offer.url) throw new CliError("Offer has no trusted provider URL", "OFFER_URL_MISSING");
    await openSystemUrl(offer.url);
    return writeOutput({ opened: true, browserActionRequired: false, provider: offer.provider, url: offer.url, submitted: false }, flags);
  }

  if (command === "justeat") {
    const result = await execFileAsync(process.execPath, [JUSTEAT_CLI, ...rest, ...Object.entries(flags).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)])], {
      encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }

  throw new CliError(`Unknown command ${command}`);
}

function isMainModule() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainModule()) {
  runOrderScout(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify(errorEnvelope(error))}\n`);
    process.exitCode = exitCodeFor(error);
  });
}
