# API contracts

OrderScout uses private consumer contracts observed in the providers' current Spain web applications. They may change without notice. The normalized CLI output—not raw upstream JSON—is the supported project interface.

| Provider | Read contracts | Write contracts |
| --- | --- | --- |
| Just Eat | discovery, menus, account, checkout | OAuth, basket, checkout patch, guarded payment |
| Glovo | store-wall search, server-rendered menus, profile, addresses, baskets, validation | basket create/update; experimental guarded final submit; official checkout handoff |
| Uber Eats | search feed, store/menu item, profile, drafts, checkout presentation | draft order create/update and guarded checkout submission |

Glovo requests include current web client, device, language, city, and delivery-coordinate headers. Uber Eats uses same-origin `_p/api` operations with a provider-domain cookie session and static CSRF placeholder. Just Eat retains its OAuth bearer flow.

Read operations use bounded timeouts. Mutations are not retried automatically. A network or upstream failure at a final-submit boundary becomes `ORDER_STATUS_UNKNOWN`; callers must inspect official active orders rather than risk a duplicate.

Glovo final submission first uses a checkout-provided submit action. When none is present, the experimental fallback is `POST /v1/authenticated/customers/orders` with basket and checkout-session identifiers; `ORDERSCOUT_GLOVO_ORDER_PATH` can override that path during live protocol verification. The normal fingerprint and environment gate still apply.

OrderScout does not bypass authentication, CAPTCHA, bot protection, payment authentication, rate limits, or access controls.
