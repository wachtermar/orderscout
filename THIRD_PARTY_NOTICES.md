# Third-party notices

This project is an independent implementation and contains no source code copied from the projects below.
Their public CLI design informed parts of this project's command and safety model:

- `steipete/ordercli` (MIT): provider separation, JSON output, authentication fallbacks, redaction, and explicit confirmation boundaries.
- `mvanhorn/printing-press-library/.../dominos` (Apache-2.0): agent context, diagnostics, structured output, rate-limit handling, and dry-run-oriented ordering workflows.

The owner-only native Chrome session runtime installs these pinned MIT-licensed packages on demand:

- `chrome-cookies-secure` 3.0.2: decrypt provider-domain cookies through the operating-system credential store.
- `classic-level` 3.0.0: read the two Glovo provider keys required for persistent session renewal from a copied Chrome local-storage database.

Just Eat, Glovo, Uber, and related marks belong to their respective owners. This project is not affiliated with or endorsed by any provider.
