---
name: order-justeat-es
description: Find, compare, and prepare Just Eat Spain delivery orders through the Just Eat MCP tools. Use for requests to order food, groceries, water, pharmacy products, healthy meals, budget meals, compare delivered prices, inspect menus, manage a basket, quote checkout, or explicitly place an approved order in Spain.
---

# Order with Just Eat Spain

Use the `justeat_*` MCP tools. Start with `justeat_context` and `justeat_auth_status`. Never ask for raw cookies or access tokens.

## Authentication

If authentication is required or expired, keep the user inside ChatGPT Work:

1. Tell the user that Just Eat will open in their normal system browser and that the tool will keep running while they authenticate.
2. Call `justeat_auth_login`. The user enters credentials and completes Turnstile only on Just Eat's pages. Do not ask for their password or take over credential entry.
3. Wait for the tool to observe the official OAuth callback and finish automatically. Do not ask the user to say “done,” copy a callback URL, or open Terminal.
4. Call `justeat_auth_status` and continue only when it reports authenticated.

Never ask the user to paste a password, cookie, callback URL, or access token. The tool uses the normal system browser, Just Eat's official authorization-code OAuth flow with PKCE, automatic local callback detection, and owner-only token storage. It must not automate credential entry or bypass an identity provider's browser-security checks.

## Discovery workflow

1. Use the authenticated saved address unless the user supplies another location. Never assume a city from stale browser state.
2. Call `justeat_recommend` with the user's complete intent. Preserve quantity, budget, health, taste, dietary, and timing constraints.
3. Present a short list with merchant, items, quantities, product subtotal, and scoring reasons.
4. If delivered price matters, call `justeat_compare_delivered_totals`. Explain that this creates temporary baskets but does not place an order.
5. For water, compare normalized volume and delivered cost. If a quoted basket misses the minimum, call `justeat_optimize_water`, preview the optimized basket, then create it only after selection.

Treat pharmacy availability and opening time as delivery availability, not medical advice. Do not infer allergen safety from menu text. If an allergy is mentioned, verify directly with the merchant before setting `allergenReviewed`.

## Basket and checkout workflow

1. Call `justeat_prepare_basket` and show the exact items, quantities, required modifiers, and notes.
2. Call `justeat_create_basket` only after the user selects that candidate.
3. Call `justeat_configure_preview` before `justeat_configure_checkout`. Do not expose personal address or phone fields beyond what the user needs to verify.
4. Call `justeat_quote` after every basket or checkout change.
5. Summarize merchant, items, quantity, address label, delivery time, subtotal, every fee, exact total, and payment method.

If the user asks to view the created basket or finish manually in the browser, call `justeat_open_basket`. This converts the API basket to Just Eat's official restorable group-basket mode and opens its trusted handoff URL. Do not use a plain merchant-page URL: the website cannot discover an API-created basket without the handoff. The handoff changes basket mode but never requests payment or places an order.

## Purchase boundary

Calling `justeat_place_preview` is safe: it never submits payment. Use it to obtain the confirmation fingerprint for the latest validated checkout.

Call `justeat_place_order` only when all of these are true:

- The user explicitly asks to place the order now.
- The user has approved the current exact total, merchant, items, delivery address, time, and payment method.
- The fingerprint comes from the current `justeat_place_preview` result.
- The server operator has independently enabled `JUSTEAT_ENABLE_ORDER_PLACEMENT=1`.

Never infer approval from words such as “best,” “cheap,” “healthy,” “order me,” a prior purchase, or a saved payment method. Never retry an `ORDER_STATUS_UNKNOWN` result; tell the user to inspect Just Eat order history.

If the user says not to place an order, stop after a quote or placement preview.
