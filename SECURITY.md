# Security policy

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication bypasses, or vulnerabilities that could affect delivery customers. Use [GitHub private vulnerability reporting](https://github.com/wachtermar/orderscout/security/advisories/new).

## Credential handling

OrderScout account configuration, provider sessions, and searches are stored under `~/.config/orderscout-cli/` with owner-only permissions (`0600`). Just Eat OAuth state remains under `~/.config/justeat-es-cli/`. Glovo and Uber Eats login imports only cookies valid for the selected provider domain from a native Chrome profile after explicit user action. OrderScout never asks for cookie values in chat and does not store payment credentials.

Uber Eats and experimental Glovo order submission are disabled unless the caller supplies both `ORDERSCOUT_ENABLE_ORDER_PLACEMENT=1` and the fingerprint for the current validated request. Just Eat retains its `JUSTEAT_ENABLE_ORDER_PLACEMENT=1` gate and the same fingerprint rule. Never put either gate in a persistent profile or unattended agent. A fresh quote and explicit human approval are required for every order.

Before attaching logs to an issue, remove tokens, authorization codes, email addresses, phone numbers, physical addresses, coordinates, basket/order IDs, confirmation fingerprints, payment methods, and upstream responses containing personal data.

If local authentication may have been exposed, run `orderscout auth logout <provider>` (or `orderscout justeat auth logout`) and revoke active sessions on the provider site.
