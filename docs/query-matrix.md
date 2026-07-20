# Query matrix

OrderScout separates semantic judgment from deterministic safety. The model interprets the request and selects grounded catalog candidates; the CLI guarantees provider coverage, paging, quantities, basket compatibility, pricing facts, eligibility gates, and the final purchase boundary.

The repeatable matrix in `test/query-matrix.test.js` exercises both sides of that contract without contacting a provider. It includes:

- 1,596 generated food requests across 57 dishes and cuisines, English and Spanish party-size language, mixed adults and children, couples, families, and groups from one to twenty people;
- 244 generated shop requests covering grocery, pharmacy and personal care, household, pet, electronics, drinks, and restricted-product discovery;
- budget phrases before and after the amount, euros written as symbols or words, and decimal budgets;
- still and sparkling water, litres, millilitres, centilitres, bottles, units, and aggregate pack quantities;
- cheapest, fastest, best-rated, quality, popularity, and balanced-value objectives;
- vegan, vegetarian, pescatarian, halal, kosher, gluten-free, lactose-free, dairy-free, nut-free, keto, low-carb, and pork-free constraints;
- relative dates, weekdays, ISO dates, Spanish numeric dates, named months, 12/24-hour clocks, noon, midnight, and Spain timezone conversion;
- one through twelve independent shopping lines, candidate paging over hundreds of records, same-store selection, quantities, deals, memberships, exact totals, hard budgets, scheduled fulfilment, and fail-closed invalid bundles;
- the invariant that an uninspected LLM candidate pool can never become a false “no match.”

`test/agent-scenario-corpus.test.js` adds 456 realistic whole-request scenarios spanning meals for one to twelve people, groceries, pharmacies and personal care, drinks, household goods, restricted catalogs, multiple independent items, hard budgets, deals, and scheduled delivery. Every scenario is exercised through a three-provider selection-and-exact-quote pipeline (1,368 provider paths), with human-labelled semantic and safety oracles instead of production keyword filters.

Run it with:

```bash
npm run test:matrix
```

The full synthetic suite uses provider-shaped fixtures and never opens a browser, creates a provider basket, or calls payment:

```bash
npm run check
```

Live validation is intentionally bounded. A useful smoke run checks one representative request at a time, verifies that every enabled account was attempted, inspects candidate pages, and waits between broad searches. Replaying hundreds of live searches would trigger provider throttling and would test abuse resistance rather than product correctness. `RATE_LIMITED`, partial catalog coverage, and upstream failures remain explicit; they are never converted into absence claims or silent provider omission.

No finite matrix can prove that private consumer APIs or arbitrary language will work forever. A newly observed provider shape or failed user phrasing should become a minimized fixture and a permanent regression case before release.
