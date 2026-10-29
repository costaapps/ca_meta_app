# Public contract workspace

`docs/meta-v2/contracts/` is the canonical HTTP and event contract. This workspace generates its
public OpenAPI types, stable error-code/action/policy constants, and runtime JSON Schema validators
from that source. The package's `openapi.yaml` is a deterministic public export: internal-only
operations, request schemas, security schemes, and error codes remain in the canonical source but
are omitted from the package artifacts. The error catalog is filtered to public codes; M1.07
inbox/outbox schemas are copied from their canonical sources. Never add server-only persistence
models, credentials, or internal service authorization types to this public surface.

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

## Sanitized export verification

Validation snapshot for public-export filtering, recorded 2026-10-29 on Windows PowerShell with
Node.js `v24.22.2` and npm `11.19.1`:

| Command | Exit |
| --- | ---: |
| `npm run generate --workspace=@ca-meta/contracts` | 0 |
| `npm run check:generated --workspace=@ca-meta/contracts` | 0 |
| `npm run test:determinism --workspace=@ca-meta/contracts` | 0 |
| `npm run lint --workspace=@ca-meta/contracts` | 0 |
| `npm test --workspace=@ca-meta/contracts` | 0 |
| `npm run generate:client --prefix tools/m1-07` | 0 |
| `npm test --prefix tools/m1-07` | 0 |
| `npm pack --dry-run --workspace=@ca-meta/contracts` | 0 |
| `git diff --check` and `git show --check HEAD` | 0 |

The determinism and contract tests assert that the canonical OpenAPI and catalog retain internal-only
codes while the public OpenAPI, error catalog, TypeScript types, runtime constants, policies, and
validators omit them. The M1.07 public-client generator and typecheck apply the same exclusion. The
package test also runs stale-generation, canonical and public OpenAPI lint, frozen-baseline
compatibility, breaking-check sensitivity, contract and runtime fixture validation, and TypeScript
checks. The root `npm ci` and integrated workspace matrix are deferred until the M2.03 squash is
incorporated and the root lockfile is reconciled; rerun the integrated matrix on the final milestone
head.
