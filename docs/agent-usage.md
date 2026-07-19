# Agent usage

Start each environment with:

```bash
justeat context --agent
justeat doctor --agent
```

`--agent` selects compact JSON and avoids interactive login. It never confirms purchases.

## Recommended workflow

1. If authentication is absent, tell the user to run `justeat auth login` in a terminal.
2. Convert the user's request into a recommendation plan.
3. Present the top candidates and the scoring reasons.
4. Compare delivered totals when price matters. This creates remote baskets only with `--create`.
5. Preview basket construction, including all required modifiers.
6. If a water quote misses the minimum order, run `order optimize`, preview `--optimized`, then create that basket.
7. Create the selected basket only after the candidate is chosen.
8. Preview checkout account/address fields, then apply them explicitly.
9. If the user wants manual browser checkout, call `justeat_open_basket`; do not merely open the merchant menu page.
9. Requote and present restaurant, items, quantity, address, timing, fees, total, and payment method.
10. Run `order place` without confirmation to receive the current fingerprint.
11. Only after explicit human approval may the exact fingerprint be supplied with the placement environment gate enabled.

```bash
justeat recommend "cheap 6 litres of water" --agent
justeat order compare <plan-id> --top 3 --create --agent
justeat order prepare <plan-id> --candidate 0 --agent
justeat order prepare <plan-id> --candidate 0 --create --agent
justeat order configure <plan-id> --address-index 0 --agent
justeat order configure <plan-id> --address-index 0 --apply --agent
justeat order quote <plan-id> --agent
justeat order place <plan-id> --agent
```

Never infer approval from “best”, “cheap”, “healthy”, `--agent`, a prior purchase, or the presence of a saved payment method. Approval must concern the current validated checkout and fingerprint.

If the request mentions an allergy, do not infer safety from menu text. Basket preparation requires `--allergen-reviewed`, which may be used only after direct verification with the restaurant.

## Output contract

Success goes only to stdout. Errors go only to stderr:

```json
{"error":{"code":"AUTH_REQUIRED","message":"Run `justeat auth login` first"}}
```

Exit status `2` is usage, `3` authentication, `4` upstream HTTP, `5` network, `6` rate limiting, and `7` an ambiguous final payment outcome. On `7`, never retry automatically; inspect Just Eat order history. Other failures use `1`.

Normal quote output contains totals, fee amounts, fulfilment state, and issue codes. `--raw` can contain names, phone numbers, addresses, coordinates, and payment state; do not use it unless necessary and never include it in public logs.
