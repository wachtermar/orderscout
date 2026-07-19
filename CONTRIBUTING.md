# Contributing

Contributions are welcome, especially sanitized fixtures for Spanish regions and provider response changes.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run check
npm run pack:check
```

Tests must not call live final-order endpoints. Add small synthetic responses or sanitized fixtures and inject a mock `fetch` implementation.

## Pull requests

- Keep stdout machine-readable. Human progress and diagnostics belong on stderr.
- Never commit access tokens, refresh tokens, cookies, addresses, payment data, browser profiles, or raw account responses.
- Preserve stable error codes and document new commands or flags.
- Any command capable of an external mutation must default to a preview and require a separate, explicit flag. Final payment additionally requires a current-checkout fingerprint and the placement environment gate. `--agent` must never imply purchase confirmation.
- Reverse-engineered endpoints must be used conservatively and must not attempt to bypass authentication, bot protection, rate limiting, or access controls.
