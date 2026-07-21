# Changelog

This project follows Semantic Versioning. It is currently pre-1.0; command and normalized response changes may occur between minor releases and will be listed here.

## 0.1.20 - 2026-07-21

- Add owner-only persistent menu caching for Just Eat, Glovo, and Uber Eats, plus in-process coalescing for identical concurrent reads.
- Reuse an identical completed search for two minutes so an accidental duplicate Work tool call cannot repeat the complete provider crawl.
- Stop ordinary grocery and meal searches from querying unrelated age-restricted Glovo catalogs, and stop retrying Glovo 429 responses immediately.
- Stop retrying Just Eat 429 responses, retry one transient Glovo read failure only, and allow recent cached catalogs to cover transient network/429/5xx failures while marking coverage partial.
- Cap Uber Eats global discovery at six calls, prioritizing merchant discovery before representative product terms and bounded complete-menu expansion.
- Expose menu and discovery cache hits in provider coverage metadata while keeping remote checkout authoritative for current availability and exact totals.
- Derive a conservative per-line catalog query when a human CLI user supplies shopping items without agent-authored retrieval vocabulary.

## 0.1.17 - 2026-07-21

- Replace Uber Eats' 12–48-query synonym fan-out with a rate-aware representative plan that keeps at least one focused query per shopping line.
- Reduce the default Uber full-menu expansion from 60 stores to an adaptive 12–24, run search queries sequentially, and stagger menu requests instead of bursting them four at a time.
- Expose the selected query budget and deferred vocabulary in provider metadata, with deterministic coverage tests for two-line and six-line shopping requests.

## 0.1.16 - 2026-07-21

- Reject immediate-delivery candidates that provider discovery already marks unavailable instead of letting the model select a closed merchant.
- Treat a disabled Glovo `STANDARD` delivery selector as `CHECKOUT_UNAVAILABLE`, even when Glovo returns complete basket lines and a price-bearing checkout template.
- Require a current place-order action and verified immediate-delivery selector before describing a Glovo checkout total as orderable.

## 0.1.15 - 2026-07-21

- Request Uber Eats' official cart-item checkout payload and reject `INVALID_BASKET`, disabled-cart warnings, and unmet merchant minimums instead of presenting a price-bearing but unorderable response as an exact total.
- Replace Uber Eats' nondeterministic generic checkout URL with a structured multicart handoff that identifies the exact draft, merchant, and expected lines for ChatGPT Work browser review.
- Require the Work skill to retry the next suitable provider bundle after checkout validation or remote-line failure, add the reported water-plus-snack conversation to the live three-provider canary suite, and pace the full live matrix to avoid manufacturing provider cooldown failures.

## 0.1.14 - 2026-07-21

- Keep the ChatGPT Work plugin's suggested prompts within Codex's supported maximum of three entries and add a manifest contract test for the prompt count and length limits.

## 0.1.13 - 2026-07-20

- Verify every Uber Eats draft line and scheduled delivery window against the remote cart, use the current two-step create/update scheduling contract, and distinguish provider payload rejection from expired authentication.
- Stop treating a closed Glovo store's next opening time as proof of schedulability; require current store status and checkout-verified requested windows.
- Scan up to 120 discovered Glovo merchants instead of silently truncating common searches at 60, and attach the persisted retry time to partial or rate-limited provider status.
- Fix Just Eat saved-address geocoding, independent per-line modifiers, scalar modifier choices, multi-line merchant anchoring, remote checkout-line verification, and sanitized merchant-unavailable diagnostics.
- Preserve search completion state and verified baskets across quote recording, expand provider-specific discovery aliases, and document lexical AND candidate narrowing.
- Add a privacy-safe production canary suite spanning 12 real-user verticals, retain the 456-request deterministic corpus, and require an exact CLI version match in the Work skill to stop stale MCP processes.

## 0.1.12 - 2026-07-20

- Resolve Glovo's authoritative store and address IDs from the current store page before catalog selection and basket creation, instead of trusting stale search-card `shop_id` values.
- Send numeric store, address, and category IDs exactly as required by Glovo's current cart contract.
- Live-verify the reported Padthaiwok basket with two customized mains, two drinks, all required selections, and an exact €23.80 delivered total without submitting an order.

## 0.1.11 - 2026-07-20

- Match Glovo's current customization payload so required choices such as protein, heat level, and drinks are accepted with configured products.
- Verify every requested product and quantity against Glovo's returned basket before checkout pricing, and roll back a newly created partial basket instead of quoting it.
- Reject previously recorded partial Glovo baskets before checkout validation and invalidate stale exact totals after any failed re-quote.
- Return and persist Glovo's configured choices with comparison quotes so agents can disclose the exact protein, heat, drink, and other required selections.
- Preserve selected candidate identities through bundle normalization for reliable basket diagnostics.

## 0.1.10 - 2026-07-20

- Add an optional native-web research stage for qualitative requests such as spiciness, food quality, authenticity, outside ratings, popularity, portions, healthiness, and dietary fit.
- Add `search evidence` and `orderscout_record_external_evidence` for structured, source-linked LLM findings with public URLs, merchant-identity signals, item/merchant scope, confidence, and normalized rating scale/count.
- Reject ambiguous same-name evidence and block qualitative candidate selection until every requested dimension has a completed `found` or honest `not_found` research outcome.
- Keep provider APIs authoritative for current availability, menu contents, deals, ETA, fees, exact checkout totals, and all cart or order state; external evidence cannot mutate those fields.
- Update the ChatGPT Work workflow to research shortlisted candidates with native web search, cite used sources, and never use provider browser automation as a search backend.

## 0.1.9 - 2026-07-20

- Require explicit model selection or no-match review for every completed provider before a cross-provider winner can be confirmed.
- Quote selected Just Eat, Glovo, and Uber Eats baskets concurrently and require exact checkout totals for every matched provider.
- Verify delivery-location parity without exposing coordinates and keep login, provider retrieval, and basket execution on the CLI adapters.
- Expand the scenario corpus to 456 realistic requests across 1,368 provider paths and require provider-diverse exact-quote invariants.

## 0.1.8 - 2026-07-20

- Add a repeatable English/Spanish query matrix covering more than 1,800 food, grocery, pharmacy, drinks, household, scheduling, party-size, dietary, pricing, deal, paging, and bundle combinations.
- Expand party-size, cuisine, dietary, budget, water-pack, objective, date, and time parsing while retaining model-driven semantic selection for every agent request.
- Make candidate narrowing token-aware so `agua` does not retrieve `aguacate` and `ice` does not retrieve `rice`.
- Fix Uber Eats integer minor-unit prices below €1, which previously allowed raw `90` to become €90 instead of €0.90.
- Reuse Uber store menus across independent shopping-line queries, including same-store catalog expansion for multi-item lists, and pace provider query fan-out to reduce Glovo and Uber throttling.
- Distinguish upstream rate limits from expired authentication, preserve `RATE_LIMITED` and `retryAt` in provider status, prevent needless browser-session refreshes, and persist bounded provider cooldowns across chat turns.
- Apply the direct-merchant allergen-review gate to unified Just Eat, Glovo, and Uber Eats basket and placement tools.
- Document the generic LLM/CLI boundary, matrix scope, provider-throttling behavior, and live-test limits.

## 0.1.7 - 2026-07-20

- Remove semantic product and meal rejection from the ChatGPT/MCP ingest path so provider candidates reach model reasoning intact.
- Split multi-item requests into independent shopping-line intents and retrieval queries instead of requiring one product to satisfy every line simultaneously.
- Add paginated `search candidates` / `orderscout_candidates` interfaces with provider, merchant, and LLM-authored lexical narrowing.
- Add local `search select` / `orderscout_select_candidates` interfaces so the model maps candidates to requested lines with grounded reasons; deterministic code validates IDs, quantities, and same-basket compatibility only.
- Rank only model-selected bundles in agent mode and expose candidate-pool and selection-required state to prevent premature no-match claims.
- Return unfiltered normalized Just Eat menu candidates in agent mode and retain the Glovo catalog queries that returned each product.

## 0.1.6 - 2026-07-20

- Expand Glovo store-only search results into a bounded two-stage merchant-to-catalog search using the current store-menu, in-store search, and restriction contracts.
- Let ChatGPT supply separate merchant-discovery and catalog query plans while retaining deterministic fallback, strict required-form filtering, and LLM final reasoning.
- Parse current Glovo product tiles, preserve store availability and promotions, retry transient catalog throttling, and mark incomplete scans as partial instead of false no-match results.
- Preserve Glovo's 64-bit product identifiers losslessly so catalog results remain valid for later basket creation.
- Surface legal-age requirements as structured user actions, block restricted basket creation until explicit confirmation, and add a dedicated non-purchasing MCP/CLI confirmation step.
- Fix vape-liquid relevance so disposables do not qualify merely because their descriptions mention liquid.

## 0.1.5 - 2026-07-20

- Split arbitrary-product requests into required product concepts and optional preferences, then generate several bounded provider queries so decisive terms are not truncated.
- Replace substring matching with whole-token, bilingual concept matching and filter noisy Just Eat, Glovo, and Uber Eats responses through the same relevance gate.
- Prioritize product-relevant and retail merchants during Just Eat menu discovery, including a directly matching closed merchant beyond the normal open-store window.
- Expose available and unavailable-only provider coverage separately and rank preference matches only after product relevance is established.

## 0.1.4 - 2026-07-20

- Import Glovo's long-lived web refresh credential and stable device identity from the verified native Chrome profile.
- Renew Glovo's 20-minute access token before expiry, persist rotated credentials atomically, serialize concurrent rotation across CLI processes, and retry one rejected authenticated read without ever retrying a mutation.
- Report whether a verified Glovo login is persistent in CLI and Work account status.

## 0.1.3 - 2026-07-20

- Enrich Glovo search cards with current menu descriptions before health and breakfast ranking.
- Exclude hidden bacon, pancetta, and similar indulgent ingredients from healthy-breakfast candidates.

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
