# M3 handoff

## Current stage

M3.01/#25 has implementation commit `bd4d87f493c35f0b3da98efd8d06c92ebd48bdc3` on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`. Independent review rejected that SHA on two blockers; a focused corrective change is in progress and must be committed before the coordinator can validate it. It is not integrated into `desktop/milestone-m3`; no package PR exists. The coordinator owns MariaDB validation, repeated independent reviews and GitHub operations.

The API worktree used Node `v24.22.2` and npm `11.19.1`. A lockfile install completed with 674 packages. Original focused checks passed before review. The corrective work was also validated on Node `v24.22.2` / npm `11.19.1` with:

- `npm run typecheck:api` — passed after correcting tuple predicate types.
- `npm run build:api` — passed.
- `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` — passed.
- `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` — 11 passed, 0 failed, 0 skipped.

Corrective gate results after the review changes: `npm run typecheck:api` passed; `npm run build:api` passed; `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` passed; the same focused node command passed 14 tests, 0 failed, 0 skipped. These are local checks only. The MariaDB test is intentionally left for the coordinator on the committed candidate.

The new MariaDB assertions are in `apps/api/test/migrations.integration.spec.ts`, but were not run from this worktree. The coordinator prepared a local disposable MariaDB; only the coordinator will run that harness with its protected local credentials on the committed candidate. Do not run the broad API suite or Docker harness from this package agent.

The correction adds `IdentityAdministrationService` as an internal-only DI operation, no public controller, and `MysqlIdentityAdministrationRepository` transactionally provisions a tenant/principal/owner or grants/revokes membership with a dedicated append-only idempotency/audit ledger. First-tenant bootstrap remains blocked in a real deployment until a server-verified issuer assertion and explicit `PLATFORM_IDENTITY_ADMIN` authority are configured; Suite4's issuer/operator setup remains **Not confirmed**. The focused MariaDB scenario will assert bootstrap and grant replay, idempotency conflict, owner-only admin promotion, admin escalation denial, revocation, redacted audit columns and append-only triggers. The correction also runtime-brands verified sessions so `TenantContextService` rejects a structural DTO.

M3.04 handoff: `IdentityDeniedError` currently maps to HTTP 500 in the shared exception path; map `ACCESS_DENIED` and `CONTEXT_CHANGED` to their established safe response codes when controllers are wired.

## M3.01 implementation summary

- Adds Principal, Membership, and separate service-identity scope migration version 4, with kind checks, tenant/principal foreign keys and exact issuer/subject uniqueness.
- Adds server-derived tenant context resolution, membership revalidation, context-reference hash comparison, tenant-scoped SQL predicates, resource-level role policy, and a separate service-scope authorizer.
- Adds focused synthetic coverage for stale context, membership revocation, tenant/asset/legacy-ID substitution, same external asset ID in two tenants, role limits, service scopes, and job tenant requirements.
- Leaves actual portal session persistence and HTTP route wiring to M3.04; Suite4 and production membership provisioning remain unconfirmed gates.

## Next action

The coordinator reviews the committed branch head, runs the focused MariaDB migration harness in the prepared disposable database, obtains independent source/security review, fixes blocking findings, then opens and squash-integrates the package PR into `desktop/milestone-m3` after real CI checks pass.
