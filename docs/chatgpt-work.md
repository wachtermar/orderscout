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

Just Eat uses its official authorization-code OAuth flow with PKCE. Glovo and Uber Eats do not expose an equivalent consumer OAuth callback. In Work, their official pages stay inside the in-app browser, where passwords and verification codes remain isolated from the model. The skill never exports browser session material.

For Glovo and Uber Eats, Work mode reuses the in-app browser session instead of importing cookies from an external Chrome profile. The skill verifies only visible signed-in and address-selected state, records no address or secret, and normalizes visible offers into OrderScout's comparison engine. Standalone CLI users may still opt into native Chrome cookie import for direct Node HTTP adapters.

## Safety contract

Discovery and quotes are reads. Local search state and remote baskets are explicit writes. `orderscout_place_order` is destructive, preview-first, and requires a current fingerprint. The confirmed MCP call enables the provider placement gates only for its one child process, so a Work user does not need a terminal. Standalone CLI placement still requires the documented environment gate. Never enable placement persistently in a shared or unattended process.

The current stdio plugin is for desktop Work/Codex. A separate hosted MCP deployment with per-user authentication is required for ChatGPT web or mobile use.
