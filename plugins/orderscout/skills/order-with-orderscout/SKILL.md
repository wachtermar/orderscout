---
name: order-with-orderscout
description: Find, compare, prepare, and safely place deliveries across Just Eat, Glovo, and Uber Eats in Spain. Use for requests involving restaurant food, groceries, supermarket products, pharmacy or convenience items, water, household supplies, cheap or fast delivery, best-rated options, fees, memberships, account setup, baskets, checkout, or ordering anything offered by these platforms.
---

# Order with OrderScout

Use only the `orderscout_*` tools. All three providers have direct CLI adapters for account status, search, menus, baskets, and checkout quotes. Do not use a browser to perform provider operations. Login may open the provider's official page in native Chrome, and opening a prepared basket may open official checkout for manual review.

## Accounts and login

1. Call `orderscout_context` and `orderscout_accounts_status`.
2. Save providers and memberships stated by the user with `orderscout_accounts_configure`. Exclude disabled providers from every search.
3. Verify enabled accounts with the relevant auth-status tool.
4. For Just Eat, call `orderscout_justeat_auth_status` first. Status refreshes a saved OAuth session when possible. Call `orderscout_justeat_auth_login` only when status remains unauthenticated. If it returns `opened: true`, tell the user to finish on the official page and return; after they say it is finished, call `orderscout_justeat_auth_complete`. The start call returns immediately and never leaves chat waiting on the browser.
5. For Glovo or Uber Eats, call `orderscout_provider_auth_login`. Tell the user to sign in and select the delivery address in the official Chrome page. After the user says it is complete, call `orderscout_provider_auth_complete`. This imports only cookies valid for that provider domain and verifies them through the account API. There is no terminal step and the user never pastes cookies, tokens, URLs, passwords, or OTPs into chat.

Never ask for account credentials in chat. Never expose saved session material.

## Search and compare

1. Call `orderscout_search_begin` with the complete intent, enabled providers, objective, and a location only when the adapters cannot use a saved address.
2. The tool directly searches every enabled provider and continues when one provider fails.
3. Call `orderscout_results` and show a compact provider-labelled shortlist.

Preserve quantity, budget, timing, diet, taste, health, and still/sparkling constraints. For water, parse the entire pack expression and meet or exceed requested litres. For meals, describe health and taste as ranking signals, not medical facts.

Rank cheapest by delivered checkout total, fastest by displayed ETA, best by rating confidence plus request-specific quality signals, and default requests by balanced value. Do not call a result exact-cheapest until at least two providers have current exact quotes.

## Baskets and exact totals

- Do not modify a non-empty unrelated cart without explaining the conflict and receiving approval.
- Call `orderscout_prepare_basket` before mutation. Resolve required modifiers with the user.
- Call `orderscout_create_basket` after the user selects an offer or asks for an exact delivered-price comparison.
- Call `orderscout_checkout_review_task` to fetch the provider's direct checkout quote without submitting.
- Record its subtotal, fees, discount, and total with `orderscout_record_checkout_quote`, then call `orderscout_results` again.
- Only count Prime or Uber One savings when the provider quote shows them.
- Call `orderscout_open_basket` when the user wants to inspect or manually finish the same server-side cart on the official site.

Verify provider, merchant, item, quantity, modifiers, address label, ETA, subtotal, every fee, discount, total, and payment-method summary. Do not repeat full addresses or payment details in chat.

## Purchase boundary

Search, comparison, basket creation, quote retrieval, and opening checkout are not purchase approval.

Before `orderscout_place_order`:

1. Obtain a fresh exact checkout quote.
2. Summarize provider, merchant, items, quantities, modifiers, address label, ETA, all fees, discounts, exact total, and payment method.
3. Ask for explicit approval of that exact current order.
4. First call `orderscout_place_order` without `confirm`; it must return a fingerprint and must not submit.
5. Only after action-time approval, call it again with that exact fingerprint. Any order or quote change invalidates approval.

Glovo final submission is experimental. Prefer the submit action returned by its current checkout validation response; otherwise use the documented fallback endpoint. Apply the same fresh-quote, fingerprint, environment-gate, and no-retry rules. If Glovo rejects the request, report the sanitized protocol error and offer official checkout. If the outcome is ambiguous, inspect active orders and never retry automatically.

Never retry an ambiguous submit. Check official active orders instead. If the user says not to order, stop at the requested comparison, basket, or review stage. Never infer approval from “order me,” “best,” “cheapest,” a saved card, or an earlier order.

## Safety

Do not infer allergen safety from menu text. If an allergy is mentioned, stop basket work until the merchant confirms it. Treat pharmacy results as availability, not medical advice. Do not bypass CAPTCHA, bot protection, rate limits, account controls, or provider security checks.
