# Changelog

This project follows Semantic Versioning. It is currently pre-1.0; command and normalized response changes may occur between minor releases and will be listed here.

## 0.1.2 - 2026-07-20

- Preserve provider-verified scheduled fulfilment from Glovo and Uber Eats checkout instead of overwriting it with stale search-time state.
- Fix npm 12 bin metadata and attach installable tarballs directly to GitHub releases without requiring npm-registry ownership.

## 0.1.1 - 2026-07-20

- Parse natural-language scheduled requests into a timezone-aware provider target and require every compared provider to verify that exact slot before confirming a winner.
- Add breakfast-specific discovery and reject raw groceries, non-food keyword matches, and unrelated dishes; multi-person results retain distinct dish lines.
- Repair current Glovo basket customizations and checkout-template quoting, including scheduled slots, small-order fees, free fees, and exact delivered totals.
- Repair Just Eat scheduled-window configuration and validate only provider-returned fulfilment windows.
- Add Uber Eats scheduled availability checks and explicitly keep quotes provisional when the consumer API cannot persist the requested slot.
- Make `winnerReady` a hard exact-total and scheduled-time gate, retain listed promotions, and pin the Work plugin to the `v0.1.1` CLI release to prevent stale `npx` cache reuse.

## 0.1.0 - 2026-07-19

- Renamed the project and command to the descriptive OrderScout / `orderscout` identity.
- Added one CLI and MCP server for restaurant meals, groceries, pharmacy and convenience products, household supplies, water, and anything else offered by Just Eat, Glovo, and Uber Eats in Spain.
- Added direct search, menu, basket, and checkout adapters for all three providers.
- Added official native-browser login handoff for Glovo and Uber Eats with provider-domain-only cookie import; Playwright is not used.
- Retained Just Eat's official OAuth authorization-code flow with PKCE.
- Added account and membership selection so unused providers are excluded.
- Added cross-provider ranking by delivered price, ETA, ratings, quantity, and request-specific quality signals.
- Added metric water-pack parsing, still/sparkling filtering, and quantity calculation.
- Added ChatGPT Work/Codex plugin, skill, and repository marketplace.
- Added guarded, fingerprint-confirmed final-submit adapters for Just Eat and Uber Eats plus an experimental Glovo adapter ready for live protocol verification.
- Added 43 non-purchasing tests, dependency audit, CI, release publishing workflow, and public documentation.
