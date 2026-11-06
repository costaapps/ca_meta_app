# M4.10 synthetic webhook harness

The harness uses the repository's pinned npm workspace dependencies and does not require a Meta app, credentials, database, or network access.

From the repository root, install the committed lockfile dependencies once with `npm ci`, then run:

```powershell
node tools/m4-10/run-focused-test.mjs
```

The script compiles the API and TypeScript fixtures into a uniquely named temporary directory under `apps/api/`, runs only `m4-10-meta-webhooks.spec.js`, and removes that directory in `finally`. It requires Node 24.15 or newer in the Node 24 line. The test suite uses synthetic secrets and payloads only.

The script was added as reproducible test evidence. It was not executed by the implementation agent; the milestone coordinator runs the focused gate on the integrated candidate SHA.

## Implementation map

- Raw body boundary and 256 KiB parser limit: `apps/api/src/http-boundaries.ts` and `apps/api/src/meta-webhooks/meta-webhook-validation.ts`.
- GET challenge uses the separate `verificationToken` provider method. POST verifies `X-Hub-Signature-256` over the exact raw bytes against up to three current/previous App Secret versions with `timingSafeEqual` before JSON parsing.
- Envelope, entries, changes, `messages`, `statuses`, and page `messaging` items have structural, UTF-8, depth, node-count, entry-count, and item-count bounds. Status identity includes the full normalized item, preserving distinct status transitions.
- Per-item routing is limited to opaque provider asset identifiers, app ID and runtime environment. The repository matches active, verified local catalog/authorization rows and quarantines unknown, missing, or conflicting identities with all tenant and asset columns null. It does not read tenant or phone-number text from provider payloads.
- Raw body bytes are held only by an injected protected-payload port. The fail-closed default has no key, secret, or retention policy; a configured adapter must return authenticated ciphertext metadata and its policy expiry. The worker purges expired payload records only after routed processing is terminal. Quarantined items remain replayable only while their evidence is retained; later replay attempts are audited as unavailable.
- Durable per-item rows use an app/environment/event uniqueness key, a unique-index race check before ACK, fenced leases, bounded retry/dead-letter state, and an append-only replay audit. Processing is a local idempotent port and does not call Meta.
- `MetaWebhooksModule.register(environment, metaAssetsModule, adapters)` and `META_WEBHOOKS_MIGRATION` are deliberately not added to `app.module.ts` or the central migration registry in this package branch. The module takes the already-instantiated `MetaAssetsModule` to reuse its shared durable-work database. The coordinator wires these after serial integration. The worker also needs an explicit runner registration with the platform worker lifecycle.

## M4.10 criterion evidence

The focused tests cover exact-byte HMAC and secret rotation, separate challenge token use, multiple message/status items, malformed and oversized envelopes, app/environment configuration conflicts, signature-before-parse order, ACK-after-persistence, unknown/conflicting asset quarantine, concurrent duplicate delivery, DB commit failure, and worker failure retry behavior. The harness does not require real Meta credentials or make network calls. These checks are authored but remain unrun on this branch by assignment; record the integrated SHA and actual gate result in the milestone handoff.

Meta's current callback retry window and product-specific subscription guarantees remain **Not confirmed**. This implementation defines only local queue retry and does not assume a universal 36-hour provider retry policy.
