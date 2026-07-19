# Authentication
## Just Eat

`orderscout auth login justeat` uses Just Eat Spain's official OAuth authorization-code flow with PKCE. Tokens are stored under `~/.config/justeat-es-cli/` with owner-only permissions and refreshed when supported.

## Glovo and Uber Eats

These consumer sites do not expose a public CLI/device OAuth flow. OrderScout follows the native-browser session-import pattern:

```bash
orderscout auth login glovo
orderscout auth complete glovo --profile Default

orderscout auth login ubereats
orderscout auth complete ubereats --profile Default
```

The login command opens the official provider page in normal Chrome. The complete command reads Chrome's encrypted cookie database using the OS credential store, selects only cookies applicable to `glovoapp.com` or `ubereats.com`, saves them under `~/.config/orderscout-cli/sessions/` with mode `0600`, and verifies the account through the direct API.

In ChatGPT Work these are separate tools: the user says when official sign-in is complete. No terminal, pasted callback, password, cookie, or token is required. Select the delivery address on Uber Eats before completing import because its search context is session-backed.

Use `orderscout auth status <provider>` to verify and `orderscout auth logout <provider>` to remove local state. Revoking local state does not necessarily revoke other provider sessions; use the official account security page when compromise is suspected.
