# Authentication
## Just Eat

`orderscout auth login justeat` uses Just Eat Spain's official OAuth authorization-code flow with PKCE. Tokens are stored under `~/.config/justeat-es-cli/` with owner-only permissions and refreshed when supported.

## Glovo and Uber Eats

These consumer sites do not expose a public CLI/device OAuth flow. ChatGPT Work therefore reuses its existing in-app browser session and records only visible authentication and address-selected booleans. It never exports browser secrets. The standalone CLI can optionally use the native-Chrome session-import pattern:

```bash
orderscout auth login glovo
orderscout auth complete glovo --profile Default

orderscout auth login ubereats
orderscout auth complete ubereats --profile Default
```

In standalone mode, the login command opens the official provider page in normal Chrome. The complete command reads Chrome's encrypted cookie database using the OS credential store, selects only cookies applicable to `glovoapp.com` or `ubereats.com`, saves them under `~/.config/orderscout-cli/sessions/` with mode `0600`, and verifies the account through the direct API.

In ChatGPT Work, the skill claims an already-open Glovo or Uber Eats tab when possible. If the visible UI already has a delivery address selected, it preserves it. Otherwise the user selects one on the official page. No terminal, external Chrome profile, pasted callback, password, cookie, or token is required.

Use `orderscout auth status <provider>` to verify and `orderscout auth logout <provider>` to remove local state. Revoking local state does not necessarily revoke other provider sessions; use the official account security page when compromise is suspected.
