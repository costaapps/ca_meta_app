# M1.07 OpenAPI and event contract harness

This package owns the proposed OpenAPI 3.1 contract, inbox/outbox JSON Schemas, safe error catalog, baseline compatibility map and generated public TypeScript client. It does not implement an API server or change the current Angular/PHP runtime. [`docs/meta-v2/contracts/openapi.yaml`](../../docs/meta-v2/contracts/openapi.yaml) is the sole canonical contract source; validation and client generation read it directly.

All sample identifiers/content are synthetic. The host is `api.example.invalid`. This package makes no claim about deployed PHP rewrite behavior, Suite4 issuer/cookies, Meta grants or callback semantics, provider idempotency, app review, eligibility or production traffic; those remain **Not confirmed**. The internal service route is omitted from generated public TypeScript types.

## Environment and reproducible commands

Requirements: Node.js `>=22.12.0 <25`, npm `>=10 <12`, Python 3 with the standard library for the endpoint matrix generator. The package lock records exact npm transitive versions. It writes no database and calls no provider/API.

From the repository root in PowerShell:

```powershell
Set-Location tools/m1-07
npm ci
npm run generate
npm test
npm run clean
```

`generate` creates the public TypeScript client from the canonical YAML while excluding internal-only operations, and regenerates one compatibility row for each sanitized baseline matrix row. `test` runs OpenAPI lint, breaking-change comparison against the frozen initial v1 contract, JSON Schema/example validation, secret-field and tenant-boundary checks, idempotency/UNKNOWN fixtures, public-client TypeScript compilation, and compile-time proof that internal paths are not exposed. `clean` removes only this package's temporary test directory; generated source artifacts remain reviewable and are not deleted.

Run a single validation stage with `npm run lint`, `npm run test:contract`, `npm run test:behavior`, or `npm run typecheck`.

## Proposed operational rules

- Portal entry ticket exchange is separate from provider callback/Embedded Signup authorization-code submission.
- Tenant/principal/config are resolved by current server session and membership. `company_uuid` is never a source of authority.
- Public routes are enumerated in OpenAPI; every other operation inherits portal session security or declares the internal service security requirement. Internal services use a narrow tenant+asset+operation allowlist.
- Cursor pagination is opaque and tenant-bound. Bounded mutations use `Idempotency-Key` scoped by tenant+operation+key and a payload hash. Reuse with the same body returns the recorded outcome; changed body returns 409 without another side effect.
- Mutable configuration uses ETag/`If-Match`; asynchronous work returns `202` and `Location`. HTTP 200, redirect, provider callback, code exchange or popup completion does not establish `READY`; status is read from the server and derived from current policy/evidence.
- External effects have bounded adapter retries. Ambiguous outcomes, especially message sends, become `UNKNOWN` and require reconciliation before another attempt. No exactly-once provider guarantee is assumed.
- Inbox/outbox events carry actor, correlation/causation, schema and aggregate versions, and UTC timestamps. They carry references/allowlisted metadata, never unbounded message content.

## Evidence limits and next gates

This harness validates the proposed contract and local deterministic behavior only. Before implementation, M2 must ratify controller/DTO choices and tenant authorization; M3/M4 must verify the Suite4 issuer and browser origin/cookie contract, provider permissions/callback/event schemas, provider idempotency and reconciliation support, and actual flow eligibility in an authorized non-production environment. Do not use this harness to infer real grants or report a production-ready integration.
