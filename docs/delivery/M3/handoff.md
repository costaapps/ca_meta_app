# M3 handoff

## Current stage

M3.01/#25 has an implementation on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`. The current branch head in Git is the implementation source; this report does not embed its own commit hash. It is not yet integrated into `desktop/milestone-m3`; no package PR exists yet. The coordinator owns final candidate validation, reviews and GitHub operations.

The API worktree used Node `v24.22.2` and npm `11.19.1`. A lockfile install completed with 674 packages. The focused pre-commit checks were:

- `npm run typecheck:api` — passed after correcting tuple predicate types.
- `npm run build:api` — passed.
- `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` — passed.
- `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` — 11 passed, 0 failed, 0 skipped.

The new MariaDB assertions are in `apps/api/test/migrations.integration.spec.ts`, but were not run from this worktree. The coordinator prepared a local disposable MariaDB; only the coordinator will run that harness with its protected local credentials on the committed candidate. Do not run the broad API suite or Docker harness from this package agent.

## M3.01 implementation summary

- Adds Principal, Membership, and separate service-identity scope migration version 4, with kind checks, tenant/principal foreign keys and exact issuer/subject uniqueness.
- Adds server-derived tenant context resolution, membership revalidation, context-reference hash comparison, tenant-scoped SQL predicates, resource-level role policy, and a separate service-scope authorizer.
- Adds focused synthetic coverage for stale context, membership revocation, tenant/asset/legacy-ID substitution, same external asset ID in two tenants, role limits, service scopes, and job tenant requirements.
- Leaves actual portal session persistence and HTTP route wiring to M3.04; Suite4 and production membership provisioning remain unconfirmed gates.

## Next action

The coordinator reviews the committed branch head, runs the focused MariaDB migration harness in the prepared disposable database, obtains independent source/security review, fixes blocking findings, then opens and squash-integrates the package PR into `desktop/milestone-m3` after real CI checks pass.
