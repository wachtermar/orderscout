import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("./orderscout.js", import.meta.url));

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description) => ({ type: "string", description });
const boolean = (description) => ({ type: "boolean", description });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const remoteWrite = { ...localWrite };
const purchaseWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const ORDERSCOUT_MCP_TOOLS = [
  {
    name: "orderscout_context",
    description: "Return OrderScout providers, account configuration, comparison rules, and purchase boundaries. Call first.",
    inputSchema: objectSchema(), annotations: readOnly, command: () => ["context"],
  },
  {
    name: "orderscout_accounts_status",
    description: "Show which of Just Eat, Glovo, and Uber Eats are enabled, authenticated, and have a declared or detected membership. Never exposes credentials.",
    inputSchema: objectSchema(), annotations: readOnly, command: () => ["accounts", "status"],
  },
  {
    name: "orderscout_justeat_auth_status",
    description: "Check the Just Eat OAuth session without exposing its access token.",
    inputSchema: objectSchema(), annotations: readOnly, command: () => ["justeat", "auth", "status", "--agent"],
  },
  {
    name: "orderscout_justeat_auth_login",
    description: "Open Just Eat's official OAuth page in the normal system browser and complete login automatically after the official callback. Never request a password, cookie, callback URL, or token in chat.",
    inputSchema: objectSchema(), annotations: remoteWrite, command: () => ["justeat", "auth", "work-login", "--agent"],
  },
  {
    name: "orderscout_accounts_configure",
    description: "Set the providers the user says they have and optional memberships. Disabled providers are excluded from every search.",
    inputSchema: objectSchema({
      providers: { type: "array", items: { type: "string", enum: ["justeat", "glovo", "ubereats"] }, minItems: 1 },
      accounts: { type: "object", additionalProperties: { type: "boolean" } },
      memberships: { type: "object", description: "Membership booleans keyed by glovo or ubereats.", additionalProperties: { type: "boolean" } },
    }, ["providers"]), annotations: localWrite,
    command: (input) => ["accounts", "set", "--providers", input.providers.join(","), "--accounts", JSON.stringify(input.accounts ?? {}), "--memberships", JSON.stringify(input.memberships ?? {})],
  },
  {
    name: "orderscout_provider_auth_login",
    description: "Open Glovo or Uber Eats on the official site in native Chrome. The user signs in there; no terminal, password, or cookie is requested in chat. Call orderscout_provider_auth_complete after the user says sign-in is finished.",
    inputSchema: objectSchema({
      provider: { type: "string", enum: ["glovo", "ubereats"] },
    }, ["provider"]), annotations: remoteWrite,
    command: (input) => ["auth", "login", input.provider, "--agent"],
  },
  {
    name: "orderscout_provider_auth_complete",
    description: "Finish Glovo or Uber Eats login by importing only that provider's domain cookies from native Chrome, then verify the account through the direct API. Never returns cookie values.",
    inputSchema: objectSchema({ provider: { type: "string", enum: ["glovo", "ubereats"] }, profile: string("Chrome profile name; normally Default.") }, ["provider"]), annotations: remoteWrite,
    command: (input) => ["auth", "complete", input.provider, "--profile", input.profile ?? "Default", "--agent"],
  },
  {
    name: "orderscout_provider_auth_status",
    description: "Verify a Glovo or Uber Eats session through its direct account API without exposing credentials.",
    inputSchema: objectSchema({ provider: { type: "string", enum: ["glovo", "ubereats"] } }, ["provider"]), annotations: readOnly,
    command: (input) => ["auth", "status", input.provider, "--agent"],
  },
  {
    name: "orderscout_search_begin",
    description: "Search all enabled Just Eat, Glovo, and Uber Eats accounts directly for restaurant meals, groceries, pharmacy or convenience products, household supplies, drinks, or any other available item, then rank matching offers. It never creates a basket.",
    inputSchema: objectSchema({
      intent: string("Complete natural-language request including quantity, budget, dietary needs, and cheapest/fastest/best preference."),
      providers: { type: "array", items: { type: "string", enum: ["justeat", "glovo", "ubereats"] } },
      objective: { type: "string", enum: ["cheapest", "fastest", "best", "value"] },
      at: string("Optional non-sensitive location hint. Prefer each provider's already selected saved address."),
    }, ["intent"]), annotations: localWrite,
    command: (input) => ["search", "begin", input.intent, "--agent", ...(input.providers ? ["--providers", input.providers.join(",")] : []), ...(input.objective ? ["--objective", input.objective] : []), ...(input.at ? ["--at", input.at] : [])],
  },
  {
    name: "orderscout_ingest_offers",
    description: "Advanced/testing tool to ingest normalized offers into a comparison. Normal searches call every provider adapter directly and do not require this tool.",
    inputSchema: objectSchema({
      searchId: string("OrderScout search ID."),
      provider: { type: "string", enum: ["glovo", "ubereats"] },
      offers: { type: "array", items: { type: "object", additionalProperties: true } },
      complete: boolean("Whether discovery for this provider is complete."),
    }, ["searchId", "provider", "offers"]), annotations: localWrite,
    command: (input) => ["search", "ingest", input.searchId, input.provider, "--json", JSON.stringify(input.offers), "--complete", String(input.complete ?? true), "--agent"],
  },
  {
    name: "orderscout_provider_error",
    description: "Mark one provider unavailable without blocking results from other enabled providers.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), provider: { type: "string", enum: ["justeat", "glovo", "ubereats"] }, message: string("Short error without personal data.") }, ["searchId", "provider", "message"]),
    annotations: localWrite, command: (input) => ["search", "error", input.searchId, input.provider, "--message", input.message, "--agent"],
  },
  {
    name: "orderscout_results",
    description: "Rank all collected offers. Exact cheapest is awarded only after at least two final checkout totals are recorded.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID.") }, ["searchId"]), annotations: readOnly,
    command: (input) => ["search", "results", input.searchId, "--agent"],
  },
  {
    name: "orderscout_record_checkout_quote",
    description: "Record the exact final review-screen subtotal, itemized fees, discounts, and total for one offer. Reading a quote is safe and does not submit checkout.",
    inputSchema: objectSchema({
      searchId: string("OrderScout search ID."), offerId: string("Offer ID."),
      pricing: { type: "object", properties: {
        currency: { type: "string", enum: ["EUR"] }, subtotal: { type: "number" },
        fees: { type: "object", additionalProperties: { type: ["number", "null"] } },
        discount: { type: "number" }, total: { type: "number" },
      }, required: ["subtotal", "total"], additionalProperties: false },
    }, ["searchId", "offerId", "pricing"]), annotations: localWrite,
    command: (input) => ["quote", "record", input.searchId, input.offerId, "--json", JSON.stringify(input.pricing), "--agent"],
  },
  {
    name: "orderscout_prepare_basket",
    description: "Preview the exact direct-provider basket payload for the selected offer. No basket is changed.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: readOnly,
    command: (input) => ["basket", "prepare", input.searchId, input.offerId, "--agent"],
  },
  {
    name: "orderscout_create_basket",
    description: "Create the selected provider basket directly. Never configures payment or places an order.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: remoteWrite,
    command: (input) => ["basket", "create", input.searchId, input.offerId, "--agent"],
  },
  {
    name: "orderscout_checkout_review_task",
    description: "Read the selected provider's current checkout quote directly, including fees and total. It does not submit checkout.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: readOnly,
    command: (input) => ["basket", "checkout", input.searchId, input.offerId, "--agent"],
  },
  {
    name: "orderscout_open_offer",
    description: "Open the trusted official provider offer in the native system browser. Never adds an item or orders.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: remoteWrite,
    command: (input) => ["offer", "open", input.searchId, input.offerId, "--agent"],
  },
  {
    name: "orderscout_open_basket",
    description: "Open the already-created provider basket in official native-browser checkout for manual review. Never presses the final purchase button.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: remoteWrite,
    command: (input) => ["basket", "open", input.searchId, input.offerId, "--agent"],
  },
  {
    name: "orderscout_place_order",
    description: "Guarded final purchase boundary. With no confirmation it returns a fingerprint and exact total; only a second call with that fingerprint can submit, and server-side placement must also be explicitly enabled. Never call without action-time user approval.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID."), confirm: string("Exact fingerprint returned by the immediately preceding dry run, only after explicit approval.") }, ["searchId", "offerId"]), annotations: purchaseWrite,
    command: (input) => ["order", "place", input.searchId, input.offerId, ...(input.confirm ? ["--confirm", input.confirm] : []), "--agent"],
  },
];

function toolByName(name) { return ORDERSCOUT_MCP_TOOLS.find((tool) => tool.name === name); }

export async function executeOrderScoutMcpTool(name, input = {}) {
  const tool = toolByName(name);
  if (!tool) throw new Error(`Unknown OrderScout tool: ${name}`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...tool.command(input)], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (stderr?.trim()) process.stderr.write(stderr);
  const structured = stdout.trim() ? JSON.parse(stdout) : null;
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false };
}

export async function handleOrderScoutMcpMessage(message) {
  const id = message.id ?? null;
  if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "orderscout", version: "0.1.0" } } };
  if (message.method === "notifications/initialized") return null;
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: ORDERSCOUT_MCP_TOOLS.map(({ command, ...tool }) => tool) } };
  if (message.method === "tools/call") {
    try { return { jsonrpc: "2.0", id, result: await executeOrderScoutMcpTool(message.params?.name, message.params?.arguments ?? {}) }; }
    catch (error) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ error: { code: error.code ?? "TOOL_FAILED", message: error.message } }) }], isError: true } }; }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
}

export async function runOrderScoutMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try { response = await handleOrderScoutMcpMessage(JSON.parse(line)); }
    catch (error) { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }; }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
