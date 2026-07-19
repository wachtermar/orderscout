# Pide ES

One ChatGPT app for Just Eat, Glovo, and Uber Eats in Spain.

Tell ChatGPT what you need. Pide ES searches the delivery accounts you use, compares price, quantity, fees, memberships, ratings, and delivery time, and can prepare the selected basket. You stay in control of checkout.

> “Find the cheapest way to get at least 20 litres of still water. Search all my apps and do not order.”

> “Find a healthy, tasty dinner for two under €30. I care more about ratings than speed.”

> “I only use Just Eat and Uber Eats, and I have Uber One.”

> “Add the first choice to my basket, then open it so I can pay myself.”

Pide ES is an unofficial community project. It is not made, approved, or supported by Just Eat Takeaway.com, Glovo, or Uber.

## Use it in ChatGPT Work

This is the family-friendly route. You do not need to know any commands after installation.

1. Open the ChatGPT desktop app.
2. Choose Work or Codex.
3. Start a new chat.
4. Ask for food, water, groceries, or another delivery in normal language.

If Pide ES is not installed, paste this into a Work chat:

> Install Pide ES from https://github.com/wachtermar/pide-es. Install its CLI, add its plugin marketplace, install the Pide ES plugin, run its checks, and tell me when to restart ChatGPT. Do not place any order.

The computer needs [Node.js 20 or newer](https://nodejs.org/) once. Restart ChatGPT after installation and begin a new Work chat.

### Signing in—no Terminal

- Just Eat opens its official OAuth page in your normal browser.
- Glovo and Uber Eats open their official login page in normal Chrome.
- Enter passwords and verification codes only on the official website.
- Return to ChatGPT and say, “I finished signing in.”
- Pide imports only cookies valid for that provider domain, verifies the account, and stores the session in an owner-only local file.

Never paste a password, cookie, token, or login URL into chat. Pide does not use Playwright for Glovo or Uber Eats. Their browser is used only for official sign-in and, if requested, for viewing checkout; searches and basket work happen through direct CLI adapters.

The current plugin is local to ChatGPT Work/Codex on desktop. It is not an ordinary mobile ChatGPT skill yet; a hosted MCP service would be required for phone-only use.

## What Pide compares

Only providers enabled for your household are searched. For example, if you use Just Eat and Uber Eats with Uber One, Glovo is excluded and eligible Uber One savings are considered.

| Goal | How it is ranked |
| --- | --- |
| Cheapest | Current delivered total after fees, discounts, and membership benefits |
| Fastest | Displayed delivery estimate |
| Best | Rating confidence plus request-specific quality signals |
| Value | A balance of total price, ETA, ratings, quantity, and preferences |

Search-card prices are estimates. Pide only calls a provider the exact cheapest after comparing at least two current checkout quotes.

For water, Pide understands bottle sizes, multipacks, total litres, still versus sparkling, and price per litre. For meals, “healthy” and “tasty” are transparent ranking signals—not medical or nutritional claims.

## Will it accidentally order?

Searching, opening a menu, creating a basket, reading checkout, and opening the official checkout page do not place an order.

Programmatic placement has two locks:

1. A dry run returns the current exact order and a short confirmation fingerprint.
2. The same process must separately enable final placement with `PIDE_ENABLE_ORDER_PLACEMENT=1`.

The fingerprint changes when the provider, basket, total, or payment request changes. An agent must ask for approval of the exact current order immediately before the second call. Ambiguous submit results are never retried automatically.

Uber Eats and Just Eat expose guarded final-submit adapters. Glovo currently stops at its official checkout handoff because its payment submission protocol has not been verified safely; the basket is still created directly and can be completed on Glovo. This limitation is deliberate and visible rather than pretending an order was placed.

## Helpful requests

| What you want | What to say |
| --- | --- |
| Configure apps | “I use Glovo and Uber Eats. I have Glovo Prime.” |
| Check login | “Am I logged in to all my delivery apps?” |
| Cheap water | “Find at least 12 L of still water at the lowest delivered price.” |
| Fast dinner | “Find a well-rated dinner that can arrive fastest.” |
| Dietary choice | “Find three vegetarian dinners under €20.” |
| Compare full totals | “Build temporary baskets and compare every fee. Do not order.” |
| Prepare only | “Put option 1 in my basket, but stop there.” |
| Manual checkout | “Open that same basket on the official website.” |

If an allergy is mentioned, Pide stops basket work until the merchant confirms it directly. Menu text is never proof of allergen safety. Pharmacy results describe availability, not medical advice.

## Install for developers

```bash
npm install --global github:wachtermar/pide-es
codex plugin marketplace add wachtermar/pide-es
codex plugin add pide-es@pide-es-marketplace
```

Restart ChatGPT desktop after installing the plugin.

For development:

```bash
git clone https://github.com/wachtermar/pide-es.git
cd pide-es
npm install
npm link
npm run check
```

The plugin is in [`plugins/pide-es`](plugins/pide-es), and its marketplace is [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json).

## CLI

```bash
# Account setup
pide accounts set --providers justeat,glovo,ubereats \
  --memberships '{"glovo":false,"ubereats":true}'

# Official native-browser login
pide auth login glovo
# Sign in on Glovo, then:
pide auth complete glovo --profile Default

pide auth login ubereats
# Sign in and choose the delivery address, then:
pide auth complete ubereats --profile Default

# Direct provider commands
pide glovo search "agua 6 x 1.5 L" --at "29603 Marbella"
pide glovo menu https://glovoapp.com/es/es/marbella/stores/example
pide ubereats search "healthy dinner"
pide ubereats menu <store-uuid>

# One cross-provider search
pide recommend "cheapest 20 litres of still water" \
  --providers justeat,glovo,ubereats --at "29603 Marbella"

# Prepare, create, and quote a selected offer
pide basket prepare <search-id> <offer-id>
pide basket create <search-id> <offer-id>
pide basket checkout <search-id> <offer-id>

# Open the same server-side basket for manual review
pide basket open <search-id> <offer-id>

# Dry-run the final purchase boundary
pide order place <search-id> <offer-id>
```

The original Just Eat-specific commands remain available under `pide justeat ...` and the legacy `justeat` executable.

## Direct adapter coverage

| Capability | Just Eat | Glovo | Uber Eats |
| --- | --- | --- | --- |
| Login/status/logout | OAuth + API | Native Chrome session + API | Native Chrome session + API |
| Search and menus | Direct | Direct | Direct |
| Saved account/address context | Direct | Direct | Session-backed direct API |
| Server-side basket | Direct | Direct | Direct |
| Checkout quote | Direct | Direct validation | Direct |
| Open same basket in official site | Yes | Yes | Yes |
| Guarded programmatic final submit | Yes | Checkout handoff | Yes |

Private state lives under `~/.config/pide-es-cli/` with owner-only permissions. Just Eat retains its existing state under `~/.config/justeat-es-cli/`. Never publish these directories. Raw provider responses may contain personal information.

## Project status

Pide ES is experimental pre-1.0 software built against private consumer APIs that may change without notice. Tests use synthetic responses and never call a final payment endpoint. Live smoke checks are read-only.

```bash
npm run check
npm run test:coverage
npm run pack:check
```

The design takes operational lessons from [`steipete/ordercli`](https://github.com/steipete/ordercli) and the [Domino's Printing Press CLI](https://github.com/mvanhorn/printing-press-library/tree/main/library/food-and-dining/dominos). The implementation is original; see [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT
