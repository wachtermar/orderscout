# Authentication
## Just Eat

`orderscout auth login justeat` uses Just Eat Spain's official OAuth authorization-code flow with PKCE. Tokens are stored under `~/.config/justeat-es-cli/` with owner-only permissions and refreshed when supported.

## Glovo and Uber Eats

These consumer sites do not expose a public CLI/device OAuth flow, and ChatGPT's in-app browser does not expose a supported session-export API. OrderScout therefore uses a native-Chrome handoff for its direct adapters:

```bash
orderscout auth login glovo
orderscout auth complete glovo

orderscout auth login ubereats
orderscout auth complete ubereats
```

The complete command scans supported Chrome profiles automatically, reads their encrypted cookie databases using the OS credential store, selects only cookies applicable to `glovoapp.com` or `ubereats.com`, and tests each candidate against the direct account API. For Glovo it additionally reads only `glovo_refresh_token` and `glv_device` from that profile's `glovoapp.com` local storage. It saves only the verified provider session under `~/.config/orderscout-cli/sessions/` with mode `0600`.

Glovo's web access token lasts about 20 minutes. OrderScout renews it through Glovo's current `/oauth/refresh` contract before expiry, atomically saves the rotated access and refresh credentials, and retries one read request rejected with HTTP 401. Mutations are never retried. Normal token expiry therefore does not ask the user to sign in again. Reauthentication is needed only after provider logout, revocation, or expiry of the long-lived refresh credential.

On first use, the Chrome session reader is installed into an owner-only runtime under `~/.config/orderscout-cli/` with pinned build-chain security overrides. It is kept out of the global CLI dependency tree and reused on later logins.

In ChatGPT Work, the skill first runs completion silently, which reuses an already signed-in Chrome profile when available. Only if that fails does it open the official provider page in Chrome. The user signs in and selects an address there, returns to chat, and says they are finished. No terminal, profile name, pasted callback, cookie, or token is required.

Use `orderscout auth status <provider>` to verify and `orderscout auth logout <provider>` to remove local state. Revoking local state does not necessarily revoke other provider sessions; use the official account security page when compromise is suspected.
