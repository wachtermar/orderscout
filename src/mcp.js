import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const string = (description) => ({ type: "string", description });
const integer = (description, minimum = 0, maximum) => ({
  type: "integer",
  description,
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const boolean = (description) => ({ type: "boolean", description });
const number = (description) => ({ type: "number", description });

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const localWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const remoteWrite = { ...localWrite };

export const MCP_TOOLS = [
  {
    name: "justeat_context",
    description: "Return Just Eat Spain capabilities, authentication method, and purchase safety boundaries. Call this first.",
    inputSchema: objectSchema(),
    annotations: readOnly,
    command: () => ["context"],
  },
  {
    name: "justeat_auth_status",
    description: "Check whether a usable Just Eat account session exists. Never exposes the access token.",
    inputSchema: objectSchema(),
    annotations: readOnly,
    command: () => ["auth", "status"],
  },
  {
    name: "justeat_auth_login",
    description: "Log in from ChatGPT Work through Just Eat's official OAuth flow in the user's normal system browser. The user enters credentials only in that browser; the tool automatically detects the official callback and stores the resulting session. No Terminal, callback copying, password sharing, cookie import, automated browser, or second tool call is required. The call remains active until login succeeds or times out.",
    inputSchema: objectSchema({
      timeoutSeconds: integer("Seconds before the pending login expires.", 30, 3600),
    }),
    annotations: remoteWrite,
    command: (input) => withFlags(["auth", "work-login"], input, { timeoutSeconds: "timeout" }),
  },
  {
    name: "justeat_search",
    description: "Find delivery restaurants or grocery stores near a typed location, coordinates, or the authenticated user's saved address.",
    inputSchema: objectSchema({
      query: string("Location text. Omit to use a saved account address."),
      addressIndex: integer("Saved address index when query and coordinates are omitted."),
      latitude: number("Delivery latitude; longitude is also required."),
      longitude: number("Delivery longitude; latitude is also required."),
      postcode: string("Optional postcode accompanying coordinates."),
      name: string("Filter by merchant name."),
      cuisine: string("Filter by cuisine."),
      vertical: { type: "string", enum: ["all", "restaurants", "groceries"] },
      open: boolean("Return only merchants open now."),
      limit: integer("Maximum returned merchants.", 1, 100),
      sort: { type: "string", enum: ["recommended", "rating", "distance", "eta"] },
    }),
    annotations: readOnly,
    command: (input) => withFlags(["search", ...(input.query ? [input.query] : [])], input, {
      addressIndex: "address-index", latitude: "lat", longitude: "lon", postcode: "postcode",
      name: "name", cuisine: "cuisine", vertical: "vertical", open: "open", limit: "limit", sort: "sort",
    }),
  },
  {
    name: "justeat_menu",
    description: "Read and optionally search a Just Eat merchant menu by slug or official menu URL.",
    inputSchema: objectSchema({
      target: string("Merchant slug or Just Eat menu URL."),
      search: string("Optional product search text."),
    }, ["target"]),
    annotations: readOnly,
    command: (input) => withFlags(["menu", input.target], input, { search: "search" }),
  },
  {
    name: "justeat_recommend",
    description: "Interpret a request such as cheap 6 litres of water or healthy tasty food, rank candidates, and save a local order plan. This does not create a remote basket or order.",
    inputSchema: objectSchema({
      intent: string("Natural-language order request."),
      at: string("Typed delivery location. Omit to use a saved account address."),
      addressIndex: integer("Saved address index when at and coordinates are omitted."),
      latitude: number("Delivery latitude; longitude is also required."),
      longitude: number("Delivery longitude; latitude is also required."),
      postcode: string("Optional postcode accompanying coordinates."),
      stores: integer("Maximum stores whose menus are evaluated.", 1, 30),
      limit: integer("Maximum recommendations.", 1, 50),
      vertical: { type: "string", enum: ["all", "restaurants", "groceries"] },
      includeClosed: boolean("Include currently closed merchants."),
    }, ["intent"]),
    annotations: localWrite,
    command: (input) => withFlags(["recommend", input.intent], input, {
      at: "at", addressIndex: "address-index", latitude: "lat", longitude: "lon",
      postcode: "postcode", stores: "stores", limit: "limit", vertical: "vertical",
      includeClosed: "include-closed",
    }),
  },
  {
    name: "justeat_plan_show",
    description: "Read a previously generated recommendation and its current basket or quote state.",
    inputSchema: objectSchema({ planId: string("Order plan ID.") }, ["planId"]),
    annotations: readOnly,
    command: ({ planId }) => ["order", "show", planId],
  },
  {
    name: "justeat_compare",
    description: "Preview candidates from distinct merchants without creating remote baskets. Use delivered-total comparison when price including fees matters.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      top: integer("Number of distinct merchants to compare.", 1, 10),
    }, ["planId"]),
    annotations: readOnly,
    command: (input) => withFlags(["order", "compare", input.planId], input, { top: "top" }),
  },
  {
    name: "justeat_compare_delivered_totals",
    description: "Create temporary remote baskets for selected merchants and compare checkout totals including fees. This does not place an order.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      top: integer("Number of distinct merchants to quote.", 1, 10),
      allergenReviewed: boolean("True only after allergens were verified directly with the merchant."),
    }, ["planId"]),
    annotations: remoteWrite,
    command: (input) => withFlags(["order", "compare", input.planId, "--create"], input, {
      top: "top", allergenReviewed: "allergen-reviewed",
    }),
  },
  {
    name: "justeat_prepare_basket",
    description: "Preview the exact basket payload for one candidate or a saved water optimization. No remote basket is created.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      candidate: integer("Candidate index.", 0),
      optimized: boolean("Use the saved water optimization."),
      quantity: integer("Item quantity.", 1, 99),
      note: string("Optional merchant note."),
      modifiers: { type: "object", description: "Modifier choice IDs keyed by modifier group ID." },
      allergenReviewed: boolean("True only after allergens were verified directly with the merchant."),
    }, ["planId"]),
    annotations: readOnly,
    command: (input) => basketCommand(input, false),
  },
  {
    name: "justeat_create_basket",
    description: "Create the explicitly selected remote Just Eat basket. This does not configure checkout, request payment, or place an order.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      candidate: integer("Candidate index.", 0),
      optimized: boolean("Use the saved water optimization."),
      quantity: integer("Item quantity.", 1, 99),
      note: string("Optional merchant note."),
      modifiers: { type: "object", description: "Modifier choice IDs keyed by modifier group ID." },
      allergenReviewed: boolean("True only after allergens were verified directly with the merchant."),
    }, ["planId"]),
    annotations: remoteWrite,
    command: (input) => basketCommand(input, true),
  },
  {
    name: "justeat_optimize_water",
    description: "Optimize a quoted water basket to satisfy requested volume and merchant minimum-order constraints.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      candidate: integer("Quoted candidate index.", 0),
    }, ["planId"]),
    annotations: localWrite,
    command: (input) => withFlags(["order", "optimize", input.planId], input, { candidate: "candidate" }),
  },
  {
    name: "justeat_quote",
    description: "Read the current checkout quote, fees, fulfilment issues, total, and payment methods for a created basket.",
    inputSchema: objectSchema({ planId: string("Order plan ID.") }, ["planId"]),
    annotations: readOnly,
    command: ({ planId }) => ["order", "quote", planId],
  },
  {
    name: "justeat_open_basket",
    description: "Open a created API basket in the user's normal browser for manual review or checkout. Converts it to Just Eat's official group-basket mode so the website can restore the exact basket, then opens Just Eat's trusted handoff URL. Never requests payment or places an order.",
    inputSchema: objectSchema({ planId: string("Order plan ID.") }, ["planId"]),
    annotations: remoteWrite,
    command: ({ planId }) => ["order", "open", planId],
  },
  {
    name: "justeat_configure_preview",
    description: "Preview the checkout patch made from the authenticated account and saved delivery address. Personal fields may be present in the result.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      addressIndex: integer("Saved delivery address index."),
      scheduled: string("Optional ISO delivery time; omit for ASAP."),
    }, ["planId"]),
    annotations: readOnly,
    command: (input) => withFlags(["order", "configure", input.planId], input, {
      addressIndex: "address-index", scheduled: "scheduled",
    }),
  },
  {
    name: "justeat_configure_checkout",
    description: "Apply the authenticated user's selected saved address and contact fields to checkout. This does not request payment or place an order.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      addressIndex: integer("Saved delivery address index."),
      scheduled: string("Optional ISO delivery time; omit for ASAP."),
    }, ["planId"]),
    annotations: remoteWrite,
    command: (input) => withFlags(["order", "configure", input.planId, "--apply"], input, {
      addressIndex: "address-index", scheduled: "scheduled",
    }),
  },
  {
    name: "justeat_place_preview",
    description: "Validate the latest checkout and return its exact total, payment summary, and one-time confirmation fingerprint. Never submits payment.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      methods: { type: "array", description: "Optional payment method objects when the quote does not select one.", items: { type: "object" } },
      returnUrl: string("Official HTTPS return URL after payment."),
    }, ["planId"]),
    annotations: readOnly,
    command: (input) => placeCommand(input, false),
  },
  {
    name: "justeat_place_order",
    description: "FINAL PURCHASE ACTION. Submit payment only after the user explicitly approves the current exact total and method and supplies the current preview fingerprint. The server must also have JUSTEAT_ENABLE_ORDER_PLACEMENT=1.",
    inputSchema: objectSchema({
      planId: string("Order plan ID."),
      confirmationFingerprint: string("Exact fingerprint returned by justeat_place_preview after explicit user approval."),
      methods: { type: "array", description: "Optional payment method objects matching the approved preview.", items: { type: "object" } },
      returnUrl: string("Official HTTPS return URL after payment."),
    }, ["planId", "confirmationFingerprint"]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    command: (input) => placeCommand(input, true),
  },
];

function withFlags(base, input, mapping) {
  const args = [...base];
  for (const [inputKey, flag] of Object.entries(mapping)) {
    const value = input[inputKey];
    if (value === undefined || value === null || value === false || value === "") continue;
    args.push(`--${flag}`);
    if (value !== true) args.push(typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return args;
}

function basketCommand(input, create) {
  return withFlags(["order", "prepare", input.planId, ...(create ? ["--create"] : [])], input, {
    candidate: "candidate", optimized: "optimized", quantity: "quantity", note: "note",
    modifiers: "modifiers", allergenReviewed: "allergen-reviewed",
  });
}

function placeCommand(input, submit) {
  return withFlags(["order", "place", input.planId], {
    ...input,
    confirm: submit ? input.confirmationFingerprint : undefined,
  }, { methods: "methods", returnUrl: "return-url", confirm: "confirm" });
}

export function buildCliArgs(toolName, input = {}) {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return [...tool.command(input), "--agent"];
}

export async function executeMcpTool(toolName, input = {}, options = {}) {
  const args = buildCliArgs(toolName, input);
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return JSON.parse(stdout);
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export async function handleMcpMessage(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "justeat-es", version: "0.3.4" },
        instructions: "Use read and preview tools first. Never call justeat_place_order without explicit approval of the current preview total, method, and fingerprint.",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS.map(({ command, ...tool }) => tool) },
    };
  }
  if (method === "tools/call") {
    try {
      const result = await executeMcpTool(params.name, params.arguments ?? {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        },
      };
    } catch (error) {
      const stderr = error?.stderr?.trim();
      let failure = { code: "TOOL_EXECUTION_ERROR", message: error.message };
      if (stderr) {
        try { failure = JSON.parse(stderr).error ?? failure; } catch { /* keep sanitized failure */ }
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: failure }) }],
          structuredContent: { error: failure },
          isError: true,
        },
      };
    }
  }
  if (method?.startsWith("notifications/")) return null;
  return jsonRpcError(id ?? null, -32601, `Method not found: ${method}`);
}

export async function runMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handleMcpMessage(JSON.parse(line));
    } catch (error) {
      response = jsonRpcError(null, -32700, "Parse error", error.message);
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
