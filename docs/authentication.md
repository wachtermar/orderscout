# Authentication

## Recommended flow

`justeat auth login` creates an OAuth authorization request with PKCE and opens it in the operating system's default browser. The user completes Just Eat's official login and anti-bot checks. The CLI never receives the password or browser cookies.

Just Eat's consumer web OAuth client has a registered HTTPS callback rather than a CLI loopback callback. After login, copy the complete final callback URL from the address bar and paste it into the CLI. The CLI validates the origin, path, and OAuth state before exchanging its short-lived code using the locally retained PKCE verifier.

```bash
justeat auth login
justeat auth status
justeat auth logout
```

The experimental `--direct-email` flow talks to the same official authentication endpoints but is often rejected because interactive Turnstile verification is required. It is not intended for unattended authentication.

## Storage and automation

Tokens are stored under `~/.config/justeat-es-cli/` with owner-only permissions and refreshed when the issuer permits it. Set `JUSTEAT_CONFIG_DIR` to relocate that state. Set `JUSTEAT_TOKEN` for an ephemeral, non-persistent override in an automation environment.

Never commit tokens or copy account responses into test fixtures.
