# Live provider canaries

The normal test suite is deterministic and never contacts a delivery provider. It covers 456 human request scenarios across 1,368 provider paths, but it cannot prove that an undocumented provider contract still matches production.

Run the default read-only smoke set against the currently configured accounts:

```bash
npm run test:live
```

The default checks live authentication, the MCP/CLI workflow version, all enabled providers, address parity returned by search, and three representative provider searches. It prints only provider states, counts, and stable error codes—never addresses, cookies, account details, catalog contents, or payment data.

Run all food, scheduled, grocery, pharmacy, household, electronics, pet, gift, and group-order scenarios:

```bash
npm run test:live -- --all
```

Run one scenario by stable ID:

```bash
npm run test:live -- --scenario=scheduled-breakfast-two
```

Search canaries are provider reads plus local owner-only search snapshots. They never create a provider basket or place an order. Provider rate limits are valid live failures and are reported with their cooldown instead of being treated as expired authentication.

Draft-basket comparison is separately gated because it can alter provider cart state. First create a reviewed search whose candidates have been selected for every matching provider, then opt in explicitly:

```bash
ORDERSCOUT_LIVE_DRAFTS=1 \
ORDERSCOUT_LIVE_SEARCH_ID=<reviewed-search-id> \
npm run test:live -- --scenario=healthy-dinner-two
```

This calls the normal comparison quote path, verifies remote lines and exact checkout totals, and never calls an order-placement command. Do not run it against carts you need to preserve.
