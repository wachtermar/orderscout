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

Just Eat uses its official authorization-code OAuth flow with PKCE. Glovo and Uber Eats do not expose an equivalent consumer OAuth callback, and the Work in-app browser has no supported API for exporting its authenticated session to a local CLI.

For Glovo and Uber Eats, the plugin first automatically checks native Chrome profiles for an existing signed-in session. If none verifies, it opens the official page in Chrome for the user to sign in. The user only says “done”; the skill never asks for a terminal command or profile name. OrderScout stores verified provider session material owner-only and verifies it through the provider's direct account API. Glovo's refresh credential is imported once and then rotated and persisted silently by the CLI, so its normal 20-minute access-token expiry does not send the user through login again. The in-app browser remains available after basket creation for optional visual checkout review, but it is never the search or basket backend.

## Safety contract

The skill requires the current `llm-comparison-v4` tool contract, makes the model split distinct needs into shopping lines, and creates fair bounded merchant-discovery and catalog plans. Discovery fans out concurrently to every provider enabled in account settings. Just Eat scans every currently eligible area menu, Glovo loads complete menus for discovered merchants, and Uber Eats completes every planned search before prioritized complete-menu expansion. In agent mode the CLI does not apply semantic relevance filters: it stores normalized candidates, and the model pages through relevant subsets, reasons over product or dish meaning, assigns grounded request-fit evidence on one cross-provider scale, and submits one same-store selection or explicit no-match review for every provider. The CLI validates basket compatibility, address parity, and objective facts. Provider text is untrusted data, and incomplete scans stay partial rather than becoming false no-match claims.

When a request depends on qualitative claims outside provider fields, the skill uses ChatGPT's native web-search capability only after current app candidates are known. `orderscout_record_external_evidence` stores direct sources, structured paraphrased claims, rating scale/count, and strict merchant/locality identity signals on shortlisted candidates. Ambiguous same-name results do not satisfy the research gate, while an honest completed search may record `not_found`. External research is untrusted enrichment: it cannot modify current provider availability, menu data, deals, ETA, fees, or price, and it never turns browser automation into the provider backend.

Scheduled intent is carried as a timezone-aware requested instant, and Work cannot call a result the winner until every matching provider has both a verified requested slot and an exact checkout total. `orderscout_quote_comparison` creates isolated provider drafts and retrieves exact totals concurrently only after every enabled provider has been selected or explicitly reviewed; it never places an order. Restricted Glovo results carry a structured eligibility requirement. Work may open the trusted provider page, but the user must personally complete the official legal-age control; only then may the local confirmation tool unlock basket preparation for that store. Provider-listed promotions stay provisional until checkout confirms the applied saving. Remote baskets preserve distinct meal lines and must not overwrite or append to an unrelated cart. `orderscout_place_order` is destructive, preview-first, and requires a current fingerprint. The confirmed MCP call enables the provider placement gates only for its one child process, so a Work user does not need a terminal. Standalone CLI placement still requires the documented environment gate. Never enable placement persistently in a shared or unattended process.

Before purchase approval, Work opens the official checkout inside the in-app browser, verifies cart lines, quantities, modifiers, address label, timing, fees, discount, tip, total, and masked payment method, and shows a safely cropped checkout image when possible. Cart, address, timing, tip, and saved payment method can be changed in the official UI. Any change cancels the previous quote, screenshot, fingerprint, and approval and requires a fresh review.

The current stdio plugin is for desktop Work/Codex. A separate hosted MCP deployment with per-user authentication is required for ChatGPT web or mobile use.
