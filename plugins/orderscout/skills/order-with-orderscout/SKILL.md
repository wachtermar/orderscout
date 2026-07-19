---
name: order-with-orderscout
description: Find, compare, prepare, and safely place deliveries across Just Eat, Glovo, and Uber Eats in Spain. Use for requests involving restaurant food, groceries, supermarket products, pharmacy or convenience items, water, household supplies, cheap or fast delivery, best-rated options, fees, memberships, account setup, baskets, checkout, or ordering anything offered by these platforms.
---

# Order with OrderScout

Use the `orderscout_*` tools as the comparison and safety engine. In ChatGPT Work desktop, use the bundled in-app Browser for Glovo and Uber Eats authentication and for any provider operation backed by that browser session. Do not launch external Chrome, guess profiles, or import cookies in Work. The standalone CLI may use its native Chrome session-import fallback.

Never inspect or export browser cookies, local storage, passwords, tokens, profiles, or session stores. The in-app Browser keeps authentication isolated; OrderScout records only that the visible provider UI was verified and whether a delivery address is selected.

## Accounts and login

1. Call `orderscout_context` and `orderscout_accounts_status`.
2. Save providers and memberships stated by the user with `orderscout_accounts_configure`. Exclude disabled providers from every search.
3. Verify enabled accounts with the relevant auth-status tool and the account's recorded `transport`.
4. For Just Eat, call `orderscout_justeat_auth_status` first. Status refreshes a saved OAuth session when possible. Call `orderscout_justeat_auth_login` only when status remains unauthenticated. If it returns `opened: true`, tell the user to finish on the official page and return; after they say it is finished, call `orderscout_justeat_auth_complete`. The start call returns immediately and never leaves chat waiting on the browser.
5. In ChatGPT Work, use the in-app Browser for Glovo and Uber Eats. Claim an already-open official provider tab when available; otherwise open the official provider page in a new in-app tab. Inspect only visible page state.
6. If the visible UI is signed in, preserve any already-selected address. Do not ask the user to select it again. Call `orderscout_provider_browser_session` with the visible authentication and address-selected booleans. Never include the address itself.
7. If sign-in is required, show the in-app browser and ask the user to finish passwords, verification codes, or CAPTCHA on the official page. After the user says it is done, re-inspect the same tab and record the browser session. Do not call `orderscout_provider_auth_login` or `orderscout_provider_auth_complete` in Work; those are standalone CLI fallbacks only.

Never ask for account credentials in chat. Never expose saved session material.

## Search and compare

1. Call `orderscout_search_begin` with the complete intent, enabled providers, objective, and a location only when neither the API nor visible browser UI has a selected address.
2. The tool searches providers whose account transport is `api`. It returns `browserProviders` for providers verified in the Work browser.
3. For every browser provider, reuse its official in-app tab, use the site's visible search UI, and collect a compact set of visible matching offers. Do not inspect hidden session state or protected network credentials.
4. Normalize visible offers with provider, merchant, item, quantity, displayed price, ETA, rating, URL, and `source.adapter: "work-browser"`, then call `orderscout_ingest_offers` for that provider.
5. Call `orderscout_results` and show a compact provider-labelled shortlist. Continue when one provider fails.

Preserve quantity, budget, timing, diet, taste, health, and still/sparkling constraints. For water, parse the entire pack expression and meet or exceed requested litres. For meals, describe health and taste as ranking signals, not medical facts.

Rank cheapest by delivered checkout total, fastest by displayed ETA, best by rating confidence plus request-specific quality signals, and default requests by balanced value. Do not call a result exact-cheapest until at least two providers have current exact quotes.

## Baskets and exact totals

- Do not modify a non-empty unrelated cart without explaining the conflict and receiving approval.
- For API-backed offers, call `orderscout_prepare_basket` before mutation, resolve required modifiers, then call `orderscout_create_basket` and `orderscout_checkout_review_task`.
- For `source.adapter: "work-browser"` offers, reuse the provider tab and add the selected item through the visible official UI. Resolve modifiers with the user and do not replace a conflicting cart without approval.
- Read the browser checkout's visible subtotal, fees, discount, total, ETA, address-selected state, and payment-method summary without exposing private details.
- Record its subtotal, fees, discount, and total with `orderscout_record_checkout_quote`, then call `orderscout_results` again.
- Only count Prime or Uber One savings when the provider quote shows them.
- For API baskets, call `orderscout_open_basket` when the user wants official manual checkout. For Work-browser baskets, keep the existing checkout tab as the handoff instead of opening another browser.

Verify provider, merchant, item, quantity, modifiers, address label, ETA, subtotal, every fee, discount, total, and payment-method summary. Do not repeat full addresses or payment details in chat.

## Purchase boundary

Search, comparison, basket creation, quote retrieval, and opening checkout are not purchase approval.

Before any final order, whether through the API or visible browser UI:

1. Obtain a fresh exact checkout quote.
2. Summarize provider, merchant, items, quantities, modifiers, address label, ETA, all fees, discounts, exact total, and payment method.
3. Ask for explicit approval of that exact current order.
4. First call `orderscout_place_order` without `confirm`; it must return a fingerprint and must not submit.
5. For API-backed orders, only after action-time approval call it again with that exact fingerprint. For Work-browser orders, ask for action-time approval of the exact visible checkout and only then click the single final purchase control through the Browser. Any order or quote change invalidates approval.

Glovo final submission is experimental. Prefer the submit action returned by its current checkout validation response; otherwise use the documented fallback endpoint. Apply the same fresh-quote, fingerprint, environment-gate, and no-retry rules. If Glovo rejects the request, report the sanitized protocol error and offer official checkout. If the outcome is ambiguous, inspect active orders and never retry automatically.

Never retry an ambiguous submit. Check official active orders instead. If the user says not to order, stop at the requested comparison, basket, or review stage. Never infer approval from “order me,” “best,” “cheapest,” a saved card, or an earlier order.

## Safety

Do not infer allergen safety from menu text. If an allergy is mentioned, stop basket work until the merchant confirms it. Treat pharmacy results as availability, not medical advice. Do not bypass CAPTCHA, bot protection, rate limits, account controls, or provider security checks.
