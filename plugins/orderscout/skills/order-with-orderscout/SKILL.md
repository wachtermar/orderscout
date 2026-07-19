---
name: order-with-orderscout
description: Find, compare, prepare, and safely place deliveries across Just Eat, Glovo, and Uber Eats in Spain. Use for requests involving restaurant food, groceries, supermarket products, pharmacy or convenience items, water, household supplies, cheap or fast delivery, best-rated options, fees, memberships, account setup, baskets, checkout, or ordering anything offered by these platforms.
---

# Order with OrderScout

Use only the `orderscout_*` tools for provider account verification, search, menus, baskets, checkout quotes, comparison, and guarded order placement. All three providers have direct CLI adapters. Never use the Browser as a fallback execution engine for these operations and never scrape or ingest provider offers from visible pages.

The Browser is limited to two handoffs: the user completing login on an official provider page opened by an OrderScout auth tool, and optional visual review or manual editing of an already-prepared official checkout. Never inspect or export browser cookies, local storage, passwords, tokens, profiles, or session stores.

## Accounts and login

1. Call `orderscout_context` and `orderscout_accounts_status`. The status tool live-verifies every provider through the CLI and is authoritative for login claims.
2. Save providers and memberships stated by the user with `orderscout_accounts_configure`. Account settings are the only provider-selection source: include every enabled provider in every search and exclude disabled providers. Never narrow the search tool to a convenient subset.
3. Verify every enabled account with the relevant live auth-status tool before claiming it is logged in. A saved `authenticated` value, visible browser session, or selected address is not proof that the CLI is authenticated.
4. For Just Eat, call `orderscout_justeat_auth_status` first. Status refreshes a saved OAuth session when possible. Call `orderscout_justeat_auth_login` only when status remains unauthenticated. If it returns `opened: true`, tell the user to finish on the official page and return; after they say it is finished, call `orderscout_justeat_auth_complete`. The start call returns immediately and never leaves chat waiting on the browser.
5. For Glovo or Uber Eats, call `orderscout_provider_auth_status`. Status and read-only search retry once by refreshing a verified provider session from supported native Chrome profiles when the saved CLI session expired. If status remains unauthenticated, call `orderscout_provider_auth_complete`; if it reports that no verified session exists, call `orderscout_provider_auth_login`, tell the user to finish sign-in on the official page opened in Chrome, and wait for the user to say it is finished. Then call `orderscout_provider_auth_complete` and `orderscout_provider_auth_status`. Never ask which Chrome profile they used and do not claim success unless the final direct API verification succeeds.

Never ask for account credentials in chat. Never expose saved session material.

## Search and compare

1. Call `orderscout_search_begin` with the complete intent, objective, and a location only when the adapters cannot use a saved address. Do not select providers in the search call; the CLI fans out to every enabled account.
2. The tool converts conversational intent into bounded provider-appropriate queries and calls every enabled provider's CLI adapter concurrently. It expands store-only results through direct menu APIs and continues when one provider fails.
3. Inspect `coverage`. Do not present a cross-provider result until `allConfiguredAttempted` is true. State any provider in `failedProviders`; never silently omit it or replace it with browser search.
4. Call `orderscout_results` and show a compact provider-labelled shortlist.

Preserve quantity, budget, timing, diet, taste, health, and still/sparkling constraints. For water, parse the entire pack expression and meet or exceed requested litres. For meals, describe health and taste as ranking signals, not medical facts.

For two or more people, prefer offers with `composition.kind: distinct-dishes` and show every line. A valid result contains different mains with quantity 1 each, or one item explicitly sold for that party size. Never silently turn a single ordinary dish into quantity N. Do not present sides, sauces, drinks, or appetizers as a complete meal. If no complete composition is available from a merchant, omit it instead of improvising.

Retain provider-listed item discounts, original prices, 2-for-1 or percentage promotions, free delivery, and membership eligibility. A listed promotion is a candidate signal, not guaranteed savings. Distinguish `listed deal—validate checkout` from an exact discount that the checkout actually applied. Never invent a discount amount from a text-only promotion.

Rank cheapest by delivered checkout total after applied discounts and membership savings, fastest by displayed ETA, best by rating confidence plus request-specific quality signals, and default requests by balanced value. Do not call a result exact-cheapest until `exactPriceCoverage.missingQuoteProviders` is empty: every provider that returned a suitable offer must have a current exact checkout quote.

## Baskets and exact totals

- Do not modify a non-empty unrelated cart without explaining the conflict and receiving approval.
- `orderscout_prepare_basket` only previews a payload. Never describe it as a created or quoted basket.
- A hard delivered budget cannot be verified from search-card prices. When the request explicitly requires an all-in delivered limit or exact provider comparison, use an isolated draft basket for the best suitable offer from every provider that returned one. Call `orderscout_prepare_basket`, resolve required modifiers, then call `orderscout_create_basket` and `orderscout_checkout_review_task` through the CLI. Stop on `CART_CONFLICT`; never append comparison items to an unrelated cart.
- `orderscout_checkout_review_task` normalizes and records subtotal, fees, discount, and total automatically. Use `orderscout_record_checkout_quote` only for an exact quote obtained outside the normal CLI review.
- After quoting, call `orderscout_results` again. Exclude offers whose exact total exceeds the requested budget. Never substitute “about,” a fee guess, or the food subtotal when an exact quote failed.
- Only count promotions, Prime, or Uber One savings in an exact comparison when the provider quote shows that they were applied.
- In Work, call `orderscout_open_basket` only after the CLI created the basket. Navigate the in-app Browser to its trusted checkout URL for optional visual review or manual edits. Verify that the displayed merchant and every line match the selected basket; if a provider shows another active cart, stop and report the mismatch instead of implying that it synced. The Browser must not create the basket or replace CLI checkout quoting.

## Checkout review and changes

Before asking for purchase approval in ChatGPT Work:

1. Open or reuse the official checkout in the in-app Browser and read the current visible state.
2. Verify every cart line, quantity, modifier, substitution choice, address label, delivery timing, subtotal, each fee, discount, tip, exact total, and masked payment-method summary.
3. Show the user both a compact text summary and a checkout image in chat. Prefer a screenshot cropped to the cart and totals. Exclude or crop out the full street address, phone number, email, unmasked payment data, and unrelated page content. If safe cropping is not possible, show a text-only review and explain why.
4. Ask whether the user wants to change the cart, delivery address, delivery time, tip, or payment method before approval.

Cart, address, delivery timing, tip, and saved payment method may be changed through the visible official checkout UI. The user must personally enter a new address, card number, security code, password, OTP, or CAPTCHA. Do not save a new address or payment method without explicit action-time approval.

After any checkout change, discard the previous quote, screenshot, summary, fingerprint, and approval. Reload the final checkout state, obtain and record a fresh exact quote, create a new safe screenshot, and ask for approval again.

Verify provider, merchant, item, quantity, modifiers, address label, ETA, subtotal, every fee, discount, total, and payment-method summary. Do not repeat full addresses or payment details in chat.

When reporting a multi-person meal, list each distinct dish and quantity. Say `food subtotal` for estimates and `exact delivered total` only after checkout review returned `pricing.exact: true`.

## Purchase boundary

Search, comparison, basket creation, quote retrieval, and opening checkout are not purchase approval.

Before any final order, whether through the API or visible browser UI:

1. Obtain a fresh exact checkout quote after all requested edits.
2. Summarize provider, merchant, items, quantities, modifiers, address label, ETA, all fees, discounts, tip, exact total, and masked payment method, and show the safe checkout image when available.
3. Ask for explicit approval of that exact current order.
4. For standalone API placement, first call `orderscout_place_order` without `confirm`; it must return a fingerprint and must not submit. Only after action-time approval call it again with that exact fingerprint.
5. In ChatGPT Work, use the official in-app checkout as the final source of truth. Immediately before clicking the single final purchase control, re-check that the visible cart, address label, total, and masked payment method still match the approved summary. If anything differs, stop and repeat review. Any order, address, timing, tip, payment, or quote change invalidates approval.

Glovo final submission is experimental. Prefer the submit action returned by its current checkout validation response; otherwise use the documented fallback endpoint. Apply the same fresh-quote, fingerprint, environment-gate, and no-retry rules. If Glovo rejects the request, report the sanitized protocol error and offer official checkout. If the outcome is ambiguous, inspect active orders and never retry automatically.

Never retry an ambiguous submit. Check official active orders instead. If the user says not to order, stop at the requested comparison, basket, or review stage. Never infer approval from “order me,” “best,” “cheapest,” a saved card, or an earlier order.

## Safety

Do not infer allergen safety from menu text. If an allergy is mentioned, stop basket work until the merchant confirms it. Treat pharmacy results as availability, not medical advice. Do not bypass CAPTCHA, bot protection, rate limits, account controls, or provider security checks.
