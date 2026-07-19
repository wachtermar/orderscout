# API contracts

The CLI uses consumer contracts observed in Just Eat Spain's current web application. They are private implementation details and can change without notice.

| Capability | Contract | Mutation |
| --- | --- | --- |
| Address autocomplete | `GET i18n.api.just-eat.io/autocomplete/addresses/es` | No |
| Restaurant discovery | `GET i18n.api.just-eat.io/discovery/es/restaurants/enriched` | No |
| Account and saved addresses | `GET i18n.api.just-eat.io/applications/international/consumer/me...` | No |
| Static menus | `GET menu-globalmenucdn.justeat-int.com/...` | No |
| OAuth/OIDC | `auth.just-eat.es` authorization code + PKCE | Token grant |
| Basket creation | `POST i18n.api.just-eat.io/basket` | Yes |
| Basket updates | `PUT/PATCH i18n.api.just-eat.io/basket/{id}` | Yes |
| Checkout validation | `GET i18n.api.just-eat.io/checkout/es/{basketId}` | No |
| Checkout details | `PATCH i18n.api.just-eat.io/checkout/es/{basketId}` | Yes |
| Available times | `GET i18n.api.just-eat.io/checkout/es/{basketId}/fulfilment/availabletimes` | No |
| Payment/order boundary | `POST i18n.api.just-eat.io/checkout/es/{checkoutId}/payments` | Irreversible boundary |

Basket payloads include menu group, restaurant slug, service type, product or deal IDs, quantities, modifiers, notes, and delivery location. Checkout updates use JSON Patch. The final payment body contains the exact currency, total in minor units, payment methods, and return URL.

The normalized CLI response is the supported project interface. `--raw` is unstable and may contain personal information.

Idempotent reads time out and retry transient 5xx and 429 responses with bounded backoff. Mutating requests are never retried automatically. In particular, an ambiguous payment network failure becomes `ORDER_STATUS_UNKNOWN` and instructs the caller to inspect order history rather than risk a duplicate submission. The project does not bypass authentication, payment authentication, bot protection, rate limits, or access controls.
