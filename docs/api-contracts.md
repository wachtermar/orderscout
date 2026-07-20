# API contracts

OrderScout uses private consumer contracts observed in the providers' current Spain web applications. They may change without notice. The normalized CLI output—not raw upstream JSON—is the supported project interface.

| Provider | Read contracts | Write contracts |
| --- | --- | --- |
| Just Eat | discovery, menus, account, checkout | OAuth, basket, checkout patch, guarded payment |
| Glovo | store-wall merchant search, store-menu RSC, in-store catalog search, restrictions, profile, addresses, baskets, validation | basket create/update; experimental guarded final submit; official checkout handoff |
| Uber Eats | search feed, store/menu item, profile, drafts, checkout presentation | draft order create/update and guarded checkout submission |

Glovo requests include current web client, device, language, city, and delivery-coordinate headers. Store-wall results may contain only `STORE_CARD_V2` merchant cards; OrderScout expands relevant cards through `/v3/stores/:storeId/addresses/:addressId/node/store_menu` and the store's `/search` catalog index, parsing current `PRODUCT_TILE` and `RESTRICTED_PRODUCT_TILE` components. `/restrictions` is represented as structured eligibility state. OrderScout never sends the provider consent token until the user explicitly completes or confirms the legal-age control. Its short-lived bearer access token is renewed through the observed `/oauth/refresh` web contract with an owner-only saved refresh credential; rotated credentials are written atomically. Uber Eats uses same-origin `_p/api` operations with a provider-domain cookie session and static CSRF placeholder. Store-only search feeds are expanded through bounded `getStoreV1` menu requests, and logged-in state is verified through the current `getUserV1` contract. Just Eat retains its OAuth bearer flow.

Agent searches accept LLM-authored merchant-discovery queries, catalog queries, and separate shopping-line intents. Provider adapters retrieve and normalize candidate records without applying semantic product or meal rejection. `orderscout_candidates` exposes bounded pages with stable offer IDs and optional LLM-authored lexical narrowing; Glovo candidates also retain the catalog queries that returned each product. `orderscout_select_candidates` accepts the model's grounded line mapping and validates only IDs, quantities, and same-provider/same-merchant basket compatibility. Rankings consume these explicit selections. The deterministic relevance matcher remains available only for standalone non-agent CLI fallback behavior. Coverage distinguishes retrieved candidates, model-selected matches, availability, and incomplete provider scans.

Read operations use bounded timeouts. Mutations are not retried automatically. A network or upstream failure at a final-submit boundary becomes `ORDER_STATUS_UNKNOWN`; callers must inspect official active orders rather than risk a duplicate.

Glovo final submission first uses a checkout-provided submit action. When none is present, the experimental fallback is `POST /v1/authenticated/customers/orders` with basket and checkout-session identifiers; `ORDERSCOUT_GLOVO_ORDER_PATH` can override that path during live protocol verification. The normal fingerprint and environment gate still apply.

OrderScout does not bypass authentication, CAPTCHA, bot protection, payment authentication, rate limits, or access controls.
