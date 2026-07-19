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
    description: "Live-verify all three provider sessions through their CLI account APIs and return enabled accounts and detected memberships. This is authoritative for login claims and never exposes credentials.",
    inputSchema: objectSchema(), annotations: readOnly, command: () => ["accounts", "status"],
  },
  {
    name: "orderscout_justeat_auth_status",
    description: "Check the Just Eat OAuth session without exposing its access token.",
    inputSchema: objectSchema(), annotations: readOnly, command: () => ["justeat", "auth", "status", "--agent"],
  },
  {
    name: "orderscout_justeat_auth_login",
    description: "Reuse or refresh the saved Just Eat session when possible. Only if that fails, open Just Eat's official OAuth page and return immediately instead of leaving the tool call waiting. If a browser was opened, call orderscout_justeat_auth_complete after the user says the official page finished.",
    inputSchema: objectSchema(), annotations: remoteWrite, command: () => ["auth", "login", "justeat", "--agent"],
  },
  {
    name: "orderscout_justeat_auth_complete",
    description: "Complete a pending Just Eat OAuth login by reading the official callback from the native browser and verify the new session. Never requests a password, cookie, callback URL, or token in chat.",
    inputSchema: objectSchema(), annotations: remoteWrite, command: () => ["auth", "complete", "justeat", "--agent"],
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
    description: "Start the OrderScout CLI login handoff for Glovo or Uber Eats. It opens the official provider page; the user handles credentials and verification there. After completion call orderscout_provider_auth_complete. The browser is never used for search, menu, cart, or checkout execution.",
    inputSchema: objectSchema({
      provider: { type: "string", enum: ["glovo", "ubereats"] },
    }, ["provider"]), annotations: remoteWrite,
    command: (input) => ["auth", "login", input.provider, "--agent"],
  },
  {
    name: "orderscout_provider_auth_complete",
    description: "Automatically scan supported native Chrome profiles for a current Glovo or Uber Eats session, import only provider-domain cookies, and save only a candidate that passes the direct account API. No terminal, profile name, cookie, token, or callback is requested.",
    inputSchema: objectSchema({ provider: { type: "string", enum: ["glovo", "ubereats"] } }, ["provider"]), annotations: remoteWrite,
    command: (input) => ["auth", "complete", input.provider, "--agent"],
  },
  {
    name: "orderscout_provider_auth_status",
    description: "Verify a Glovo or Uber Eats session through its direct account API without exposing credentials.",
    inputSchema: objectSchema({ provider: { type: "string", enum: ["glovo", "ubereats"] } }, ["provider"]), annotations: readOnly,
    command: (input) => ["auth", "status", input.provider, "--agent"],
  },
  {
    name: "orderscout_search_begin",
    description: "Directly and concurrently search every provider enabled in OrderScout account settings—never a caller-selected subset—then rank any deliverable item. Natural-language dates such as tomorrow at 10am become a timezone-aware requestedAt timestamp and meal occasions such as breakfast constrain both provider queries and dishes. Deals and memberships are retained. Multi-person meals contain distinct dish lines or a genuine sharing item. It never creates a basket.",
    inputSchema: objectSchema({
      intent: string("Complete natural-language request including quantity, budget, dietary needs, and cheapest/fastest/best preference."),
      objective: { type: "string", enum: ["cheapest", "fastest", "best", "value"] },
      at: string("Optional non-sensitive location hint. Prefer each provider's already selected saved address."),
    }, ["intent"]), annotations: localWrite,
    command: (input) => ["search", "begin", input.intent, "--agent", ...(input.objective ? ["--objective", input.objective] : []), ...(input.at ? ["--at", input.at] : [])],
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
    description: "Rank all collected offers and return explicit status for every configured provider, promotion and membership signals, structured fulfilment, exact-price coverage, and winnerReady. For scheduled requests, winnerReady stays false until the requested slot and current exact delivered total are both verified for every provider that returned a suitable match. Never call an unready result the winner.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID.") }, ["searchId"]), annotations: readOnly,
    command: (input) => ["search", "results", input.searchId, "--agent"],
  },
  {
    name: "orderscout_record_checkout_quote",
    description: "Record an externally obtained exact final review-screen subtotal, itemized fees, discounts, and total. Normal CLI checkout review records its normalized quote automatically. This never submits checkout.",
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
    description: "Preview the direct-provider basket payload, every meal line, required modifier groups, and selected comparison defaults. Glovo uses disclosed minimum-price required defaults unless explicit choices are supplied. No basket is changed and no exact checkout total is available yet.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID."), customizations: { type: "object", description: "Optional provider customization selections keyed by item and modifier-group IDs.", additionalProperties: true } }, ["searchId", "offerId"]), annotations: readOnly,
    command: (input) => ["basket", "prepare", input.searchId, input.offerId, ...(input.customizations ? ["--customizations", JSON.stringify(input.customizations)] : []), "--agent"],
  },
  {
    name: "orderscout_create_basket",
    description: "Create the selected provider basket directly with every distinct meal line and required modifier selection. For scheduled Just Eat requests it configures only a provider-returned available delivery window. Never configures payment or places an order.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID."), customizations: { type: "object", description: "Optional provider customization selections keyed by item and modifier-group IDs.", additionalProperties: true } }, ["searchId", "offerId"]), annotations: remoteWrite,
    command: (input) => ["basket", "create", input.searchId, input.offerId, ...(input.customizations ? ["--customizations", JSON.stringify(input.customizations)] : []), "--agent"],
  },
  {
    name: "orderscout_checkout_review_task",
    description: "Read the selected provider's current checkout quote directly, including scheduled-slot availability, subtotal, each fee, applied discounts, and total, then attach verified data to the comparison. A requested schedule failure is explicit and cannot become a winner. It never submits checkout.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: localWrite,
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
    description: "Return the trusted official checkout URL for the already-created basket without opening an external browser. In ChatGPT Work, navigate the existing in-app Browser tab to this URL for visual review and edits. Never presses the final purchase button.",
    inputSchema: objectSchema({ searchId: string("OrderScout search ID."), offerId: string("Offer ID.") }, ["searchId", "offerId"]), annotations: remoteWrite,
    command: (input) => ["basket", "open", input.searchId, input.offerId, "--no-open", "--agent"],
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
  const env = placementEnvironment(name, input, process.env);
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...tool.command(input)], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env });
  if (stderr?.trim()) process.stderr.write(stderr);
  const structured = stdout.trim() ? JSON.parse(stdout) : null;
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError: false };
}

export function placementEnvironment(name, input = {}, base = {}) {
  return name === "orderscout_place_order" && Boolean(input.confirm)
    ? { ...base, ORDERSCOUT_ENABLE_ORDER_PLACEMENT: "1", JUSTEAT_ENABLE_ORDER_PLACEMENT: "1" }
    : base;
}

export async function handleOrderScoutMcpMessage(message) {
  const id = message.id ?? null;
  if (message.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "orderscout", version: "0.1.1" } } };
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
