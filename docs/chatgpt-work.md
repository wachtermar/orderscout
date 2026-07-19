# ChatGPT Work integration
The `orderscout` plugin packages one skill and one local MCP server. It covers anything offered by the providers, including restaurant meals, groceries, pharmacy and convenience items, household supplies, and drinks. The skill defines the comparison, privacy, allergen, basket, and purchase rules. The MCP server exposes direct adapters as typed tools with correct read, write, and destructive annotations.

## Components

- `plugins/orderscout/.codex-plugin/plugin.json`: plugin metadata.
- `plugins/orderscout/.mcp.json`: launches `orderscout mcp` through `npx` over stdio, without relying on a machine-specific global npm PATH.
- `plugins/orderscout/skills/order-with-orderscout/SKILL.md`: agent workflow and safety contract.
- `.agents/plugins/marketplace.json`: repository marketplace.
- `src/orderscout-mcp.js`: MCP JSON-RPC server.
- `src/glovo.js`, `src/ubereats.js`, and the retained Just Eat modules: direct provider adapters.

## Install

```bash
npm install --global github:wachtermar/orderscout
codex plugin marketplace add wachtermar/orderscout
codex plugin add orderscout@orderscout-marketplace
```

Restart ChatGPT desktop and start a new Work task.

## Login without a terminal

Just Eat uses its official authorization-code OAuth flow with PKCE. Glovo and Uber Eats do not expose an equivalent consumer OAuth callback. Their tools therefore open the official page in native Chrome, wait for the user to finish sign-in, then import only cookies valid for that provider domain. Passwords and verification codes stay on the provider page; cookie values are never returned to the model.

The imported sessions are used by direct Node HTTP adapters. Playwright is not an execution dependency. Native browser checkout opening is optional and never submits payment.

## Safety contract

Discovery and quotes are reads. Local search state and remote baskets are explicit writes. `orderscout_place_order` is destructive, preview-first, requires a current fingerprint, and remains disabled unless `ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1`. Never enable placement in a shared or unattended process.

The current stdio plugin is for desktop Work/Codex. A separate hosted MCP deployment with per-user authentication is required for ChatGPT web or mobile use.
