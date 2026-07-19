# Agent usage
Call `pide_context` and `pide_accounts_status` first. Configure only accounts and memberships stated by the user. Verify authentication through provider status tools; if needed, use the official native-browser login/complete flow.

## Workflow

1. `pide_search_begin` directly searches every enabled provider.
2. `pide_results` returns normalized rankings and provisional-price warnings.
3. `pide_prepare_basket` previews the direct payload.
4. After selection, `pide_create_basket` performs the remote basket write.
5. `pide_checkout_review_task` reads the current quote.
6. Record exact pricing and re-rank.
7. Use `pide_open_basket` for manual official checkout.
8. A final order requires a fresh summary, explicit approval, a dry-run fingerprint, the matching second call, and the independent placement environment gate.

Never infer approval from “order me,” `--agent`, a previous purchase, or a saved card. Never retry an ambiguous submit. If an allergy is mentioned, require direct merchant confirmation before basket work.

Success is machine-readable JSON on stdout and errors are JSON on stderr. `--raw` may expose personal information and should not appear in public logs.
