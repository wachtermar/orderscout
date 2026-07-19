# ChatGPT Work integration

The `justeat-es` plugin combines a reusable skill with a local MCP server. The skill teaches the ordering workflow; the MCP server exposes the CLI as typed tools with accurate read, write, and destructive annotations.

## Components

- `plugins/justeat-es/.codex-plugin/plugin.json`: installable plugin metadata.
- `plugins/justeat-es/.mcp.json`: launches `justeat mcp` over stdio.
- `plugins/justeat-es/skills/order-justeat-es/SKILL.md`: discovery, checkout, privacy, allergen, and approval rules.
- `.agents/plugins/marketplace.json`: repository-local marketplace entry.
- `src/mcp.js`: dependency-free MCP JSON-RPC server.

## Local installation

Requires Node.js 20 or newer and the ChatGPT desktop app or Codex CLI.

```bash
npm install --global github:wachtermar/justeat-cli
codex plugin marketplace add wachtermar/justeat-cli
codex plugin add justeat-es@justeat-es-marketplace
```

Restart the ChatGPT desktop app and start a new Work task so the skill and MCP tools are loaded. For repository development, `npm install && npm link` remains available from a local checkout.

Terminal users can authenticate through the native browser:

```bash
justeat auth login
```

This opens the official OAuth authorization-code flow with PKCE in the native browser. The plugin never imports browser cookies or asks ChatGPT to hold an access token.

ChatGPT Work uses the same official OAuth authorization-code exchange without requiring Terminal:

1. `justeat_auth_login` opens Just Eat's official OAuth page in the user's normal system browser.
2. The user completes login and Turnstile only on Just Eat's pages while the tool remains active.
3. The tool detects the official callback, exchanges the code with PKCE, and stores the session with owner-only permissions.

The CLI does not automate the browser, so Google and other identity providers see the same ordinary browser the user already trusts. On macOS it briefly checks open browser-tab URLs locally only to recognize Just Eat's exact callback origin and path. Passwords, cookies, callback URLs, and access tokens are never requested in chat.

## Public distribution

The repository marketplace can be installed from GitHub after the repository is pushed. Until the npm package is released, install the CLI directly from the public GitHub repository as shown above. Keep the plugin and package versions aligned.

For ChatGPT Work on the web, deploy the same tool contract behind a streamable-HTTP MCP server, configure OAuth, add it as a developer-mode ChatGPT app, and point the plugin's `.app.json` at the resulting `plugin_asdk_app...` identifier. Do not publish a fake remote URL or embed shared Just Eat credentials. The current stdio transport is intended for local desktop and Codex use.

## Safety contract

Discovery and quotes are read-only. Recommendation plans mutate only private local state. Remote basket and checkout tools are explicit writes. `justeat_place_preview` never submits payment. `justeat_place_order` is marked destructive and still requires both the current fingerprint and `JUSTEAT_ENABLE_ORDER_PLACEMENT=1`.

Use `justeat_open_basket` when the user wants to inspect or finish a created basket manually. A normal API basket is not automatically visible to the website because the web client keeps its basket pointer in first-party browser storage. The tool uses Just Eat's authenticated group-basket conversion to obtain an official restorable URL, validates that URL, and opens it in the system browser. Opening the basket never submits checkout or payment.

Do not enable placement in a shared plugin process. Enable it only for a user-controlled process after confirming the exact current merchant, items, address, fulfilment time, fees, total, and payment method.
