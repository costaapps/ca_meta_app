# M3 handoff

## Current stage

M3.01/#25 preserves implementation commit `bd4d87f493c35f0b3da98efd8d06c92ebd48bdc3` and has corrective code commits `a7339237ba794395b85245254d118117bdff4f18` and `e66f3bc44e15b5be558dce8d8965bef7fa7bf81a` on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`. These address the review blockers. The package is not integrated into `desktop/milestone-m3`; no PR exists. The coordinator owns MariaDB validation, repeated independent reviews and GitHub operations.

The API worktree used Node `v24.22.2` and npm `11.19.1`. A lockfile install completed with 674 packages. Original focused checks passed before review. The corrective work was also validated on Node `v24.22.2` / npm `11.19.1` with:

- `npm run typecheck:api` — passed after correcting tuple predicate types.
- `npm run build:api` — passed.
- `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` — passed.
- `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` — 11 passed, 0 failed, 0 skipped.

Corrective gate results on code SHA `a7339237ba794395b85245254d118117bdff4f18` after the review changes: `npm run typecheck:api` passed; `npm run build:api` passed; `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` passed; `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` passed 14 tests, 0 failed, 0 skipped. The runtime path prepended for each command was `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` (Node `v24.22.2`, npm `11.19.1`). These are local checks only. The MariaDB test is intentionally left for the coordinator on the committed candidate.

P1 follow-up code SHA `e66f3bc44e15b5be558dce8d8965bef7fa7bf81a` adds runtime allowlisting of grant roles at service and repository boundaries, rejects grant-based owner/admin demotions, makes `AuthorizedTenantScope` runtime opaque with a private context resolver mint, constrains persisted role JSON, and creates the legacy IdDatabase/IdCompany/environment mapping in the bootstrap transaction. On this source SHA, API typecheck/build and test TypeScript compile passed; the two focused test files passed 14/14. MariaDB was not run and remains for the coordinator.

The new MariaDB assertions are in `apps/api/test/migrations.integration.spec.ts`, but were not run from this worktree. The coordinator prepared a local disposable MariaDB; only the coordinator will run that harness with its protected local credentials on the committed candidate. Do not run the broad API suite or Docker harness from this package agent.

The correction adds `IdentityAdministrationService` as an internal-only DI operation, no public controller, and `MysqlIdentityAdministrationRepository` transactionally provisions tenant/principal/owner/legacy mapping or grants/revokes membership with a dedicated append-only idempotency/audit ledger. `AuthorizedTenantScope` is runtime opaque and minted only by context resolution; membership grants validate assignable roles at service and repository boundaries, and storage CHECKs reject unrecognized persisted roles. Existing owner/admin memberships cannot be demoted through grant operations. First-tenant bootstrap remains blocked in a real deployment until a server-verified issuer assertion and explicit `PLATFORM_IDENTITY_ADMIN` authority are configured; Suite4's issuer/operator setup and production catalog authorization for legacy mappings remain **Not confirmed**. The focused MariaDB scenario asserts these constraints, replay/idempotency, revocation and append-only audit triggers. The correction also runtime-brands verified sessions so `TenantContextService` rejects a structural DTO.

M3.04 handoff: `IdentityDeniedError` currently maps to HTTP 500 in the shared exception path; map `ACCESS_DENIED` and `CONTEXT_CHANGED` to their established safe response codes when controllers are wired.

M3.10 handoff: authorization denials currently roll back and do not persist a safe security event; add the denial event path required by the accepted identity contract, with no cross-tenant identifiers.

## M3.01 implementation summary

- Adds Principal, Membership, and separate service-identity scope migration version 4, with kind checks, tenant/principal foreign keys and exact issuer/subject uniqueness.
- Adds server-derived tenant context resolution, membership revalidation, context-reference hash comparison, tenant-scoped SQL predicates, resource-level role policy, and a separate service-scope authorizer.
- Adds focused synthetic coverage for stale context, membership revocation, tenant/asset/legacy-ID substitution, same external asset ID in two tenants, role limits, service scopes, and job tenant requirements.
- Leaves actual portal session persistence and HTTP route wiring to M3.04; Suite4 and production membership provisioning remain unconfirmed gates.

## Next action

The coordinator reviews the committed branch head, runs the focused MariaDB migration harness in the prepared disposable database, obtains independent source/security review, fixes blocking findings, then opens and squash-integrates the package PR into `desktop/milestone-m3` after real CI checks pass.
