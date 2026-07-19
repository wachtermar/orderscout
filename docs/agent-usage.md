# Agent usage
Call `orderscout_context` and the live `orderscout_accounts_status` first. Configure only accounts and memberships stated by the user. For Glovo and Uber Eats, try `orderscout_provider_auth_complete` before opening a login page; it automatically discovers an already signed-in Chrome profile. If login is needed, open the official page, let the user finish, then complete and live-verify without asking for a terminal or profile name.

## Workflow

1. `orderscout_search_begin` directly searches every enabled provider.
2. `orderscout_results` returns normalized rankings and provisional-price warnings.
3. `orderscout_prepare_basket` previews the direct payload.
4. After selection, `orderscout_create_basket` performs the remote basket write.
5. `orderscout_checkout_review_task` reads the current quote.
6. Record exact pricing and re-rank.
7. Use `orderscout_open_basket` for manual official checkout.
8. A final order requires a fresh summary, explicit approval, a dry-run fingerprint, the matching second call, and the independent placement environment gate.

Never infer approval from “order me,” `--agent`, a previous purchase, or a saved card. Never retry an ambiguous submit. If an allergy is mentioned, require direct merchant confirmation before basket work.

Success is machine-readable JSON on stdout and errors are JSON on stderr. `--raw` may expose personal information and should not appear in public logs.
