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
The repository's candidate CI installs with `npm ci --ignore-scripts`; before running the test suite,
it explicitly runs `npm rebuild @pb33f/openapi-changes --workspace=@ca-meta/contracts`. The pinned
checker package's postinstall downloads its platform CLI, which `--ignore-scripts` intentionally
skips. Keep this scoped install step when changing the checker dependency; do not enable lifecycle
scripts for the full dependency tree.
The determinism test writes two uniquely named directories under the OS temporary directory and
removes only its own temporary root in `finally`. Generated-text checks ignore CRLF versus LF during
comparison but still reject content changes; the determinism test exercises both cases. API and
Angular consumers are separately checked with `npm test --workspace=@ca-meta/api`,
`npm run typecheck --workspace=@ca-meta/web`, and `npm test --workspace=@ca-meta/web`.

### Linux CI breaking-check evidence

The candidate CI's clean install originally skipped the install script required by
`@pb33f/openapi-changes`, so its JavaScript wrapper exited without useful output when the native CLI
was absent. The workflow now rebuilds only `@pb33f/openapi-changes` in the Contracts workspace after
`npm ci --ignore-scripts`; no global lifecycle-script allowance is enabled. npm emitted the following
warning during that targeted rebuild: `6 packages have install scripts not yet covered by allowScripts`.
The warning was left visible. The command targets the named checker package, and the subsequent
breaking comparison and route-removal sensitivity test both passed.

Validation ran in a disposable Linux x86_64 `node:24.22.1-bookworm` container (Node 24.22.1, npm
11.19.1), against the worktree based on `dc50be7796214c654bdf6185b211f4a6f5daedaa` containing the
workflow fix. The container used an anonymous volume for `node_modules` and was removed with
`docker run --rm`; `docker ps` was empty afterward. Commands and results:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; 683 packages installed. |
| `npm rebuild @pb33f/openapi-changes --workspace=@ca-meta/contracts` | Exit 0; the scoped checker install completed; npm warning above remained visible. |
| `npm test --workspace=@ca-meta/contracts` | Exit 0; generated checks, lint, breaking check and sensitivity, determinism, contract/runtime tests, and typecheck passed. |
| `npm test` | Exit 0; API 25 passed and the separate MariaDB integration test was skipped by its harness guard; Web 10 passed; Contracts passed again. |

The pinned npm package is governed by the root lockfile integrity, but its postinstall downloads a
platform release asset from the GitHub tag URL without checking an artifact digest. This fix makes
that install explicit and scoped; it does not add release-artifact checksum verification. The
container was Debian Bookworm rather than the CI runner's Ubuntu 24 image, so final PR CI remains the
runner-specific validation.

`fixtures/errors/` and `fixtures/events/` contain synthetic examples only. Event fixture payloads
are validated against the canonical M1.07 JSON Schemas. They are not Meta payloads or deployment
evidence.

## Final integrated validation

Independent validation ran on exact candidate code SHA
`2eb1a00c495527d845e2df334564a3c649550c7e`, based on the milestone head after M2.03 squash
`5956663454c6affeef1121bfca19a76e8049fd30` and lockfile reconciliation. Environment: Windows
PowerShell with a Git checkout using `core.autocrlf=true`, Node `v24.22.2`, npm `11.19.1`, Docker
Engine `28.3.0`, and Compose `2.38.1`.

| Command or gate | Result |
| --- | --- |
| `npm ci` | Exit 0; 680 packages, 684 audited |
| `npm run check:generated --workspace=@ca-meta/contracts` | Exit 0; 12 artifacts verified from CRLF checkout |
| `npm run check:generated --prefix tools/m1-07` | Exit 0; client and 53 compatibility rows verified |
| `npm run typecheck`, `npm run build`, `npm test`, `npm run lint` | Exit 0 |
| `npm run smoke:routes`, `npm run check:web-bundle` | Exit 0 |
| `npm test --workspace=@ca-meta/contracts`, `npm run build --workspace=@ca-meta/contracts`, `npm run lint --workspace=@ca-meta/contracts` | Exit 0 |
| `npm pack --dry-run --workspace=@ca-meta/contracts` | Exit 0; 21 files |
| `npm ci --prefix tools/m1-07`, `npm test --prefix tools/m1-07` | Exit 0; 56/57 packages audited, 0 audit findings |
| `npm ls @ca-meta/contracts ajv --workspaces` | Exit 0; workspace links and AJV 8.20.0 resolve |
| `git diff --check` | Exit 0; tracked worktree clean |

The root tests reported API 20 passed/6 skipped (five POSIX SIGTERM cases on Windows and the
separately tested MariaDB integration), Web 10 passed, and all 9 Contracts tests passed. M1.07
passed its generated-client, CSV CRLF/semantic-drift, Redocly, breaking, contract, behavior, and
TypeScript checks. The aggregate Angular build passed when run serially; an earlier concurrent build
hit transient memory pressure and was not reproduced. A separate run of the M2.03 MariaDB harness
on integrated SHA `1592e3fda6b5ae7360c77d254a22d5d85e3579c8` passed 21 tests/5 Windows skips and
removed its UUID-scoped container/network/volume; the EOL-only changes in `2eb1a00` do not alter
migration code. The pre-existing stopped `db-migrations-mariadb-1` container and its volume were
preserved.

`npm audit` found 39 advisories (1 low, 10 moderate, 26 high, 2 critical), compared with 40 on base
`01be7ffc549c502710e28a6358c20e13a3c9bbad` (1 low, 10 moderate, 26 high, 3 critical). The package
names matched except `tar` was absent from the candidate findings; no new advisory was found and no
audit fix was applied. Generated checks normalize only CRLF versus LF; dedicated probes confirm
semantic content changes still fail.
