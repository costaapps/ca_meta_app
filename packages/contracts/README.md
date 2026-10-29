# Public contract workspace

`docs/meta-v2/contracts/` is the canonical HTTP and event contract. This workspace generates its
public OpenAPI types, stable error-code/action/policy constants, and runtime JSON Schema validators
from that source. The package's `openapi.yaml` is a deterministic public export: internal-only
operations, request schemas, and security schemes remain in the canonical source but are omitted
from the package artifact. The error catalog and M1.07 inbox/outbox schemas are copied from their
canonical sources. Never add server-only persistence models, credentials, or internal service
authorization types to this public surface.

## Setup and checks

Use the repository's Node 24.22.2 runtime and run `npm ci` from the repository root after the root
lockfile is current. In a clean checkout, run `npm run generate --workspace=@ca-meta/contracts`
once only when intentionally updating the canonical contract; CI uses `check:generated` to reject
stale copies and generated types.

Run `npm test --workspace=@ca-meta/contracts` for stale generation, Redocly, frozen-baseline
compatibility, breaking-check sensitivity, deterministic generation, documented error examples,
event fixtures, credential/tenant-field scans, runtime validation, and TypeScript consumer checks.
The determinism test writes two uniquely named directories under the OS temporary directory and
removes only its own temporary root in `finally`. API and Angular consumers are separately checked
with `npm test --workspace=@ca-meta/api`, `npm run typecheck --workspace=@ca-meta/web`, and
`npm test --workspace=@ca-meta/web`.

`fixtures/errors/` and `fixtures/events/` contain synthetic examples only. Event fixture payloads
are validated against the canonical M1.07 JSON Schemas. They are not Meta payloads or deployment
evidence.
