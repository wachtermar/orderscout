# OrderScout

One CLI and ChatGPT app for ordering across Just Eat, Glovo, and Uber Eats in Spain.

Tell ChatGPT what you need. OrderScout searches anything the enabled platforms make available—restaurant meals, groceries, supermarket products, pharmacy and convenience items, drinks, and household supplies—then compares price, quantity, fees, memberships, ratings, and delivery time. It can prepare the selected basket or cross the guarded purchase boundary only after exact approval.

> “Find a healthy, tasty dinner for two under €30. I care more about ratings than speed.”

> “Find the cheapest delivered option for everything on this grocery list.”

> “Which pharmacy or convenience store can deliver sunscreen fastest?”

> “Find the cheapest way to get at least 20 litres of still water. Search all my apps and do not order.”

> “I only use Just Eat and Uber Eats, and I have Uber One.”

> “Add the first choice to my basket, then open it so I can pay myself.”

OrderScout is an unofficial community project. It is not made, approved, or supported by Just Eat Takeaway.com, Glovo, or Uber.

## Use it in ChatGPT Work

This is the family-friendly route. You do not need to know any commands after installation.

1. Open the ChatGPT desktop app.
2. Choose Work or Codex.
3. Start a new chat.
4. Ask for a meal, groceries, pharmacy products, household supplies, or any other available delivery in normal language.

If OrderScout is not installed, paste this into a Work chat:

> Install OrderScout from https://github.com/wachtermar/orderscout. Install its CLI, add its plugin marketplace, install the OrderScout plugin, run its checks, and tell me when to restart ChatGPT. Do not place any order.

The computer needs [Node.js 20 or newer](https://nodejs.org/) once. Restart ChatGPT after installation and begin a new Work chat.

### Signing in—no Terminal

- Just Eat first reuses or refreshes its saved OAuth session. Only when a fresh login is required does it open the official OAuth page; the ChatGPT tool returns immediately, and you simply say when the page has finished.
- Glovo and Uber Eats first check whether any supported Chrome profile already contains a working provider session. OrderScout tries the profiles automatically and saves only a session that passes the provider's live account API. For Glovo it also imports the provider's refresh credential and device identity, so the 20-minute access token renews silently and the rotated login is saved owner-only.
- If no working session exists, ChatGPT opens the official site in normal Chrome. Sign in there, return to ChatGPT, and say, “I finished signing in.” There is no Terminal prompt, cookie copy, or profile-selection question.
- Enter passwords and verification codes only on the official website.
- The same automatic flow is available from the standalone CLI.

Never paste a password, cookie, token, or login URL into chat. ChatGPT's in-app browser does not expose a supported session-export API, so OrderScout does not pretend that a visible in-app sign-in authenticates its CLI. The in-app browser is used only for optional visual review of a CLI-created checkout; search, menus, baskets, quotes, and guarded placement remain CLI operations.

The current plugin is local to ChatGPT Work/Codex on desktop. It is not an ordinary mobile ChatGPT skill yet; a hosted MCP service would be required for phone-only use.

## What OrderScout compares

Every provider enabled for your household is searched concurrently on every request. Provider selection lives in account settings, so an agent cannot quietly search a convenient subset. For example, if you enable Just Eat and Uber Eats with Uber One, both are always attempted and Glovo is excluded. Failed sessions are shown in provider coverage instead of being silently omitted.

Glovo renews and persists its own session automatically before its short-lived access token expires. Uber Eats, and a legacy Glovo session imported before this support existed, make one safe automatic attempt to refresh from a verified native Chrome profile. A new Glovo login is required only when the provider revokes or expires the long-lived refresh credential. If a provider still cannot be verified, it remains an explicit failure; OrderScout never falls back to browser search.

| Goal | How it is ranked |
| --- | --- |
| Cheapest | Current delivered total after fees, discounts, and membership benefits |
| Fastest | Displayed delivery estimate |
| Best | Rating confidence plus request-specific quality signals |
| Value | A balance of total price, ETA, ratings, quantity, and preferences |

Search-card prices are estimates. OrderScout only calls a result the exact cheapest after obtaining a current checkout quote for the best suitable offer from every provider that returned a match. Checkout review records the normalized subtotal, every available fee, applied promotions or membership savings, and exact total back into the comparison; exact totals over a hard budget are disqualified.

Scheduled requests use the local Spain timezone and preserve the requested instant through search, basket creation, and checkout. A provider cannot win until both its exact delivered total and the requested delivery window are verified. If a provider cannot configure that slot, OrderScout tries its next suitable result and otherwise reports the comparison as provisional—never as a confirmed winner.

Provider-listed deals are retained: struck-through item prices and savings, percentage discounts, 2-for-1 listings, free delivery, merchant offers, and membership eligibility. Listed deals influence provisional value ranking, while only savings actually shown by checkout affect an exact comparison.

Product matching is general. Quantity-aware helpers add extra understanding where useful—for example bottle sizes, multipacks, total litres, still versus sparkling, and price per litre for water. Multi-person meal results contain explicit distinct dish lines, or one item explicitly sold for sharing; OrderScout does not multiply one ordinary dish by the party size. Breakfast searches require prepared breakfast dishes rather than raw egg packs or a keyword found in an unrelated product. “Healthy” and “tasty” remain transparent ranking signals, not medical or nutritional claims.

## Will it accidentally order?

Searching, opening a menu, creating a basket, reading checkout, and opening the official checkout page do not place an order.

Programmatic placement has two locks:

1. A dry run returns the current exact order and a short confirmation fingerprint.
2. The destructive ChatGPT tool enables placement only inside its fingerprint-confirmed second call. Standalone CLI users must separately set `ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1` (`JUSTEAT_ENABLE_ORDER_PLACEMENT=1` for the retained Just Eat adapter).

The fingerprint changes when the provider, basket, total, or payment request changes. An agent must ask for approval of the exact current order immediately before the second call. Ambiguous submit results are never retried automatically.

In ChatGPT Work, final review happens in the official in-app checkout. OrderScout shows a compact summary and, when it can safely crop private details, a checkout screenshot in chat. The user can change cart contents, address, delivery timing, tip, or saved payment method before approval. Every change invalidates the old quote, image, fingerprint, and approval and requires a fresh review.

Just Eat and Uber Eats expose guarded final-submit adapters. Glovo now has an explicitly experimental guarded adapter: it uses a submit action returned by checkout validation when available and otherwise uses an inferred fallback endpoint. A rejected Glovo request is reported for protocol correction; an ambiguous result is never retried and must be checked in active orders.

## Helpful requests

| What you want | What to say |
| --- | --- |
| Configure apps | “I use Glovo and Uber Eats. I have Glovo Prime.” |
| Check login | “Am I logged in to all my delivery apps?” |
| Fast dinner | “Find a well-rated dinner that can arrive fastest.” |
| Grocery list | “Find the cheapest delivered basket for milk, eggs, bananas, and detergent.” |
| Other products | “Find a phone charger I can get tonight.” |
| Pharmacy | “Which pharmacy can deliver SPF 50 sunscreen fastest?” |
| Bulk quantity | “Find at least 12 L of still water at the lowest delivered price.” |
| Dietary choice | “Find three vegetarian dinners under €20.” |
| Compare full totals | “Build temporary baskets and compare every fee. Do not order.” |
| Prepare only | “Put option 1 in my basket, but stop there.” |
| Manual checkout | “Open that same basket on the official website.” |

If an allergy is mentioned, OrderScout stops basket work until the merchant confirms it directly. Menu text is never proof of allergen safety. Pharmacy results describe availability, not medical advice.

## Install for developers

```bash
npm install --global github:wachtermar/orderscout
codex plugin marketplace add wachtermar/orderscout
codex plugin add orderscout@orderscout-marketplace
```

Restart ChatGPT desktop after installing the plugin.

For development:

```bash
git clone https://github.com/wachtermar/orderscout.git
cd orderscout
npm install
npm link
npm run check
```

The plugin is in [`plugins/orderscout`](plugins/orderscout), and its marketplace is [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json).

## CLI

```bash
# Account setup
orderscout accounts set --providers justeat,glovo,ubereats \
  --memberships '{"glovo":false,"ubereats":true}'

# Official native-browser login
orderscout auth login justeat
# Only if a browser was opened, finish there, then:
orderscout auth complete justeat

orderscout auth login glovo
# Sign in on Glovo, then:
orderscout auth complete glovo

orderscout auth login ubereats
# Sign in and choose the delivery address, then:
orderscout auth complete ubereats

# Direct provider commands
orderscout glovo search "healthy chicken dinner" --at "29603 Marbella"
orderscout glovo menu https://glovoapp.com/es/es/marbella/stores/example
orderscout ubereats search "phone charger"
orderscout ubereats menu <store-uuid>

# One cross-provider search
orderscout recommend "best-rated healthy dinner for two under €30" \
  --at "29603 Marbella"

# Prepare, create, and quote a selected offer
orderscout basket prepare <search-id> <offer-id>
orderscout basket create <search-id> <offer-id>
orderscout basket checkout <search-id> <offer-id>

# Open the same server-side basket for manual review
orderscout basket open <search-id> <offer-id>

# Dry-run the final purchase boundary
orderscout order place <search-id> <offer-id>
```

`basket prepare` is a local payload preview. `basket create` creates the provider draft, preserving every distinct meal line. `basket checkout` uses the provider's current checkout contract and automatically records normalized exact pricing. Glovo refuses to append comparison items when that store already has a non-empty unrelated basket.

The original Just Eat-specific commands remain available under `orderscout justeat ...` and the legacy `justeat` executable.

## Direct adapter coverage

| Capability | Just Eat | Glovo | Uber Eats |
| --- | --- | --- | --- |
| Login/status/logout | OAuth + API | Native Chrome session + API | Native Chrome session + API |
| Search and menus | Direct | Direct | Direct |
| Saved account/address context | Direct | Direct | Session-backed direct API |
| Server-side basket | Direct | Direct | Direct |
| Checkout quote | Direct | Direct validation | Direct |
| Open basket in official site | Yes | Verify selected cart | Yes |
| Guarded programmatic final submit | Yes | Experimental | Yes |

Private state lives under `~/.config/orderscout-cli/` with owner-only permissions. Just Eat retains its existing state under `~/.config/justeat-es-cli/`. Never publish these directories. Raw provider responses may contain personal information.

## Project status

OrderScout is experimental pre-1.0 software built against private consumer APIs that may change without notice. Tests use synthetic responses and never call a final payment endpoint. Live smoke checks are read-only.

```bash
npm run check
npm run test:coverage
npm run pack:check
```

The design takes operational lessons from [`steipete/ordercli`](https://github.com/steipete/ordercli) and the [Domino's Printing Press CLI](https://github.com/mvanhorn/printing-press-library/tree/main/library/food-and-dining/dominos). The implementation is original; see [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT
