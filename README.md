# Just Eat Spain for ChatGPT

Tell ChatGPT what you want to eat or drink. It can search Just Eat Spain, compare the **real delivered price**, prepare a basket, and open that basket on Just Eat so you can finish yourself.

You can speak normally:

> Find the cheapest way to get at least 20 litres of still water delivered. Include every fee, but do not order.

> Find me a healthy, tasty dinner under €20. Show me the best three choices.

> Add option 1 to my basket, but do not place the order.

> Open my Just Eat basket so I can check out myself.

This is an unofficial community project. It is not made, approved, or supported by Just Eat Takeaway.com.

## Use it in the ChatGPT app

This section is for anyone—even if you have never used Terminal or installed a developer tool.

### If Just Eat Spain is already installed

1. Open the **ChatGPT desktop app**.
2. Choose **Work** (or **Codex**), not ordinary Chat mode.
3. Start a **new chat**.
4. Ask for what you want in your own words.

That is all. You do not need to know any commands.

If ChatGPT needs you to sign in, it opens Just Eat's real login page in your normal browser. Sign in there and return to ChatGPT. Never paste your Just Eat password, cookies, login link, or access token into chat.

### If it is not installed yet

Paste this whole sentence into a **Work** chat on the desktop app:

> Install the Just Eat Spain plugin from https://github.com/wachtermar/justeat-cli for me. Install its CLI from the same GitHub repository, add its plugin marketplace, install the plugin, run its doctor check, and tell me when to restart ChatGPT. Do not place any order.

ChatGPT will do the setup work and tell you if it needs permission. After it finishes, restart the app and begin a new Work chat.

The computer needs [Node.js 20 or newer](https://nodejs.org/) once. If ChatGPT says Node.js is missing, ask: **“Please install Node.js 20 or newer for me, then continue.”**

> **Current limitation:** this local plugin works in Work/Codex in the ChatGPT desktop app. It does not work in ordinary Chat mode or the mobile app. A hosted ChatGPT app is still needed for true phone and web-only use.

## What happens when you ask

ChatGPT follows a simple, visible flow:

1. It uses your saved Just Eat delivery address—never a guessed city.
2. It searches products or meals matching your request.
3. It compares quantities, ratings, minimum orders, delivery fees, service fees, and the final total.
4. It shows you the choices before changing a basket.
5. It creates a basket only after you choose.
6. If you ask, it opens that same basket on the official Just Eat website for manual checkout.

For water, it understands packs, bottle sizes, litres, and price per litre. For meals, it can balance your budget, restaurant ratings, taste words, dietary requests, and simple health signals. Meal and water “health” scores are explanations, not medical or nutritional advice.

## Will it accidentally order?

No final order is placed during searching, comparing, adding to a basket, quoting, or opening the basket.

Placing an order has two separate locks:

- You must approve the current restaurant, items, address, delivery time, payment method, fees, and exact total.
- The person running the CLI must separately enable order placement with `JUSTEAT_ENABLE_ORDER_PLACEMENT=1`.

Any basket change invalidates the old confirmation. The project’s tests never submit a payment request. Payment details are not requested or stored by this CLI.

## Helpful things to ask

| What you want | Example request |
| --- | --- |
| Cheap water | “Get me at least 12 L of still water for the lowest delivered price.” |
| Dinner ideas | “Find a tasty, healthy dinner for two under €30.” |
| A dietary option | “Find a vegetarian dinner with good ratings. Show me three options.” |
| Delivery tomorrow | “How many pharmacies around me can deliver tomorrow?” |
| Compare full prices | “Compare the final total including all fees for the best three.” |
| Prepare, not purchase | “Add the first choice to my basket, but do not order.” |
| Finish yourself | “Open my basket on Just Eat so I can check it and pay myself.” |
| Check login | “Am I logged in to Just Eat?” |

If you mention an allergy, ChatGPT stops basket preparation until the restaurant confirms it. A menu description alone is never treated as proof that food is allergen-safe.

## Setup for developers

The family instructions above are the intended experience. These commands are only for developers or for manual setup.

Requires Node.js 20 or newer. The CLI has no runtime dependencies.

```bash
npm install --global github:wachtermar/justeat-cli
codex plugin marketplace add wachtermar/justeat-cli
codex plugin add justeat-es@justeat-es-marketplace
justeat doctor
```

Restart the ChatGPT desktop app and start a new Work or Codex chat.

To develop from a checkout instead:

```bash
git clone https://github.com/wachtermar/justeat-cli.git
cd justeat-cli
npm install
npm link
npm run check
```

The plugin lives in [`plugins/justeat-es`](plugins/justeat-es), and its repository marketplace is [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json). See [ChatGPT Work integration](docs/chatgpt-work.md) for architecture and local-development details.

## CLI examples

```bash
# Sign in through Just Eat's official page in your normal browser
justeat auth login

# Use the first saved delivery address
justeat recommend "cheap 6 litres of water"
justeat recommend "healthy tasty food under 18 EUR"

# Compare the real delivered totals; --create makes temporary baskets
justeat order compare <plan-id> --top 3 --create

# Prepare and create the selected basket
justeat order prepare <plan-id> --candidate 0
justeat order prepare <plan-id> --candidate 0 --create
justeat order quote <plan-id>

# Restore that API-created basket in the normal browser
justeat order open <plan-id>
```

`order open` uses Just Eat's official group-basket handoff. Opening only a restaurant page is not enough because the website cannot otherwise discover a basket created through the API.

### Final order boundary

`order place` is preview-first and does not submit anything:

```bash
justeat order place <plan-id>
```

It returns the current exact total and a short confirmation fingerprint. Only an exact, current confirmation plus the independent server setting can submit:

```bash
JUSTEAT_ENABLE_ORDER_PLACEMENT=1 \
  justeat order place <plan-id> --confirm <current-fingerprint>
```

Never retry an ambiguous final payment result. Check the official Just Eat order history instead.

## Commands and private data

| Command | Purpose |
| --- | --- |
| `doctor` | Check discovery, menu, OAuth, runtime, and local login health |
| `recommend <request>` | Find and rank products or meals from natural language |
| `auth login\|status\|logout` | Manage the official OAuth session |
| `account addresses` | Read saved delivery addresses |
| `search` / `menu` | Discover restaurants and inspect normalized menus |
| `order compare` | Validate delivered totals across candidates |
| `order prepare` / `quote` | Create and inspect a basket safely |
| `order open` | Restore the basket in the normal browser |
| `order place` | Preview first; submit only through both confirmation locks |
| `mcp` | Run the ChatGPT Work/Codex tool server |

Authentication uses Just Eat's official authorization-code OAuth flow with PKCE. It does not use Playwright, import browser cookies, or ask ChatGPT to handle passwords. Tokens and private recommendation plans are stored under `~/.config/justeat-es-cli/` with owner-only permissions. Do not publish that directory; `--raw` output may contain personal data. See [authentication details](docs/authentication.md).

## Project status

This is an experimental pre-1.0 client for private consumer APIs, which can change without notice. Today it supports Just Eat Spain. Recommendations are heuristic, checkout totals should always be reviewed, and service availability still depends on Just Eat and each merchant.

```text
intent → search → ranked choices → delivered-total comparison
       → basket → checkout quote → human review → optional submission
```

Tests use synthetic HTTP responses and never place an order. CI covers Node.js 20, 22, and 24.

```bash
npm run check
npm run test:coverage
npm run pack:check
```

The design draws operational lessons from [`steipete/ordercli`](https://github.com/steipete/ordercli) and the [Domino's Printing Press CLI](https://github.com/mvanhorn/printing-press-library/tree/main/library/food-and-dining/dominos); this implementation is original. More detail: [agent usage](docs/agent-usage.md), [API contracts](docs/api-contracts.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT
