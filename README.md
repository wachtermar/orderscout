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
- In ChatGPT Work, Glovo and Uber Eats use the browser already inside the app. Existing sign-ins and selected addresses stay in that browser; OrderScout does not open Chrome or guess a profile.
- The standalone CLI can still use normal Chrome as an optional direct-API session source.
- Enter passwords and verification codes only on the official website.
- Return to ChatGPT and say, “I finished signing in.”
- In standalone CLI mode only, an explicit Chrome import stores only provider-domain cookies in an owner-only local file.

Never paste a password, cookie, token, or login URL into chat. OrderScout never exports the Work browser's cookies, local storage, passwords, tokens, or session data. In Work, the skill operates the visible official provider UI and sends only normalized offer and checkout facts to the comparison engine.

The current plugin is local to ChatGPT Work/Codex on desktop. It is not an ordinary mobile ChatGPT skill yet; a hosted MCP service would be required for phone-only use.

## What OrderScout compares

Only providers enabled for your household are searched. For example, if you use Just Eat and Uber Eats with Uber One, Glovo is excluded and eligible Uber One savings are considered.

| Goal | How it is ranked |
| --- | --- |
| Cheapest | Current delivered total after fees, discounts, and membership benefits |
| Fastest | Displayed delivery estimate |
| Best | Rating confidence plus request-specific quality signals |
| Value | A balance of total price, ETA, ratings, quantity, and preferences |

Search-card prices are estimates. OrderScout only calls a provider the exact cheapest after comparing at least two current checkout quotes.

Product matching is general. Quantity-aware helpers add extra understanding where useful—for example bottle sizes, multipacks, total litres, still versus sparkling, and price per litre for water. For meals, “healthy” and “tasty” are transparent ranking signals, not medical or nutritional claims.

## Will it accidentally order?

Searching, opening a menu, creating a basket, reading checkout, and opening the official checkout page do not place an order.

Programmatic placement has two locks:

1. A dry run returns the current exact order and a short confirmation fingerprint.
2. The destructive ChatGPT tool enables placement only inside its fingerprint-confirmed second call. Standalone CLI users must separately set `ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1` (`JUSTEAT_ENABLE_ORDER_PLACEMENT=1` for the retained Just Eat adapter).

The fingerprint changes when the provider, basket, total, or payment request changes. An agent must ask for approval of the exact current order immediately before the second call. Ambiguous submit results are never retried automatically.

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
orderscout auth complete glovo --profile Default

orderscout auth login ubereats
# Sign in and choose the delivery address, then:
orderscout auth complete ubereats --profile Default

# Direct provider commands
orderscout glovo search "healthy chicken dinner" --at "29603 Marbella"
orderscout glovo menu https://glovoapp.com/es/es/marbella/stores/example
orderscout ubereats search "phone charger"
orderscout ubereats menu <store-uuid>

# One cross-provider search
orderscout recommend "best-rated healthy dinner for two under €30" \
  --providers justeat,glovo,ubereats --at "29603 Marbella"

# Prepare, create, and quote a selected offer
orderscout basket prepare <search-id> <offer-id>
orderscout basket create <search-id> <offer-id>
orderscout basket checkout <search-id> <offer-id>

# Open the same server-side basket for manual review
orderscout basket open <search-id> <offer-id>

# Dry-run the final purchase boundary
orderscout order place <search-id> <offer-id>
```

The original Just Eat-specific commands remain available under `orderscout justeat ...` and the legacy `justeat` executable.

## Direct adapter coverage

| Capability | Just Eat | Glovo | Uber Eats |
| --- | --- | --- | --- |
| Login/status/logout | OAuth + API | Native Chrome session + API | Native Chrome session + API |
| Search and menus | Direct | Direct | Direct |
| Saved account/address context | Direct | Direct | Session-backed direct API |
| Server-side basket | Direct | Direct | Direct |
| Checkout quote | Direct | Direct validation | Direct |
| Open same basket in official site | Yes | Yes | Yes |
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
