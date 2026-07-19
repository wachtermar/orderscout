# Changelog

This project follows Semantic Versioning. It is currently pre-1.0; command and normalized response changes may occur between minor releases and will be listed here.

## 0.1.0 - 2026-07-19

- Added one `pide` CLI and MCP server for Just Eat, Glovo, and Uber Eats in Spain.
- Added direct search, menu, basket, and checkout adapters for all three providers.
- Added official native-browser login handoff for Glovo and Uber Eats with provider-domain-only cookie import; Playwright is not used.
- Retained Just Eat's official OAuth authorization-code flow with PKCE.
- Added account and membership selection so unused providers are excluded.
- Added cross-provider ranking by delivered price, ETA, ratings, quantity, and request-specific quality signals.
- Added metric water-pack parsing, still/sparkling filtering, and quantity calculation.
- Added ChatGPT Work/Codex plugin, skill, and repository marketplace.
- Added guarded, fingerprint-confirmed final-submit adapters for Just Eat and Uber Eats; Glovo stops at official checkout until its payment protocol is verified safely.
- Added 43 non-purchasing tests, dependency audit, CI, release publishing workflow, and public documentation.
