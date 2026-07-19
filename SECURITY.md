# Security policy

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication bypasses, or vulnerabilities that could affect Just Eat customers. Use [GitHub private vulnerability reporting](https://github.com/wachtermar/justeat-cli/security/advisories/new) so the maintainer can respond without exposing details publicly.

## Credential handling

OAuth tokens and private order plans are stored under `~/.config/justeat-es-cli/` with owner-only permissions (`0600`). `JUSTEAT_TOKEN` can provide an ephemeral environment override. Plans may contain precise coordinates and raw checkout responses. The CLI does not request passwords, import browser cookies, or store payment credentials.

Order submission is disabled unless the caller supplies both `JUSTEAT_ENABLE_ORDER_PLACEMENT=1` and the fingerprint for the current validated payment request. Never place either in a persistent shell profile, shared agent configuration, repository secret, or unattended automation environment. A fresh quote and explicit human approval are required for every order.

Before attaching logs to an issue, remove tokens, authorization codes, email addresses, phone numbers, physical addresses, coordinates, basket/order IDs, confirmation fingerprints, payment methods, and upstream responses containing personal data.

If a local token may have been exposed, run `justeat auth logout` and revoke active sessions in your Just Eat account.
