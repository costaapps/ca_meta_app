# M3 handoff

## Current stage

M3.01/#25 preserves implementation commit `bd4d87f493c35f0b3da98efd8d06c92ebd48bdc3` and has corrective commits `a7339237ba794395b85245254d118117bdff4f18`, `e66f3bc44e15b5be558dce8d8965bef7fa7bf81a`, `a35303834d8564c8bfca49555b7a3cb10783f8ec`, and `37aa2077d7f4a25eada346e1ba792725252a3b6a` on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`; subsequent commits contain only documentation/evidence updates. Source and security reviews found no remaining code blocker; they record production job authorization as pending M3.08. The package is not integrated into `desktop/milestone-m3` and no PR exists. GitHub operations remain with the coordinator.

The API worktree used Node `v24.22.2` and npm `11.19.1`. A lockfile install completed with 674 packages. Original focused checks passed before review. The corrective work was also validated on Node `v24.22.2` / npm `11.19.1` with:

- `npm run typecheck:api` — passed after correcting tuple predicate types.
- `npm run build:api` — passed.
- `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` — passed.
- `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` — 11 passed, 0 failed, 0 skipped.

Corrective gate results on code SHA `a7339237ba794395b85245254d118117bdff4f18` after the review changes: `npm run typecheck:api` passed; `npm run build:api` passed; `npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json` passed; `node --test apps/api/dist-test/test/m3-01-identity.spec.js apps/api/dist-test/test/migration-unit.spec.js` passed 14 tests, 0 failed, 0 skipped. The runtime path prepended for each command was `C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2` (Node `v24.22.2`, npm `11.19.1`). These are local checks only. The MariaDB test is intentionally left for the coordinator on the committed candidate.

P1 follow-up code SHA `e66f3bc44e15b5be558dce8d8965bef7fa7bf81a` adds runtime allowlisting of grant roles at service and repository boundaries, rejects grant-based owner/admin demotions, makes `AuthorizedTenantScope` runtime opaque with a private context resolver mint, constrains persisted role JSON, and creates the legacy IdDatabase/IdCompany/environment mapping in the bootstrap transaction. On this source SHA, API typecheck/build and test TypeScript compile passed; the two focused test files passed 14/14. MariaDB was not run and remains for the coordinator.

The new MariaDB assertions are in `apps/api/test/migrations.integration.spec.ts`. The coordinator ran the focused harness against disposable MariaDB 11.8.8 on candidate SHA `a35303834d8564c8bfca49555b7a3cb10783f8ec`; result: 1 passed, 0 failed. The later provenance-only source commit changes no migrations or SQL and is covered by the required PR CI. Do not run the broad API suite or Docker harness from this package agent.

The correction adds `IdentityAdministrationService` as an internal-only DI operation, no public controller, and `MysqlIdentityAdministrationRepository` transactionally provisions tenant/principal/owner/legacy mapping or grants/revokes membership with a dedicated append-only idempotency/audit ledger. `AuthorizedTenantScope` is runtime opaque and minted only by context resolution; membership grants validate assignable roles at service and repository boundaries, and storage CHECKs reject unrecognized persisted roles. Existing owner/admin memberships cannot be demoted through grant operations. First-tenant bootstrap remains blocked in a real deployment until a server-verified issuer assertion and explicit `PLATFORM_IDENTITY_ADMIN` authority are configured; Suite4's issuer/operator setup and production catalog authorization for legacy mappings remain **Not confirmed**. The focused MariaDB scenario asserts these constraints, replay/idempotency, revocation and append-only audit triggers. The correction also runtime-brands verified sessions so `TenantContextService` rejects a structural DTO.

Provenance correction `37aa2077d7f4a25eada346e1ba792725252a3b6a` keeps the identity repository token out of `IdentityModule.exports`; membership listing derives the principal only from a runtime-verified portal session. Service-scope resolution accepts only a runtime `WeakSet`-verified service credential capability; callers cannot pass principal/tenant IDs or mint the service scope. Job context resolution accepts only a runtime capability issued by `PersistedJobContextVerifier` after its trusted store loads the persisted job row. Focused tests reject copied session DTOs, raw service identity inputs, forged service scopes, and raw job IDs. M3.08 still needs to wire its trusted service credential verifier; external credential format/issuer is **Not confirmed**. The implementation agent ran API typecheck, API build, API test TypeScript compile, and the M3.01 + migration-unit focused tests on Node `v24.22.2` / npm `11.19.1`; all passed, with 14 tests passing. This follow-up changed no migrations or database repository behavior. MariaDB was last validated by the coordinator on `a35303834d8564c8bfca49555b7a3cb10783f8ec` and was not rerun for this provenance-only correction.

M3.04 handoff: `IdentityDeniedError` currently maps to HTTP 500 in the shared exception path; map `ACCESS_DENIED` and `CONTEXT_CHANGED` to their established safe response codes when controllers are wired.

M3.10 handoff: authorization denials currently roll back and do not persist a safe security event; add the denial event path required by the accepted identity contract, with no cross-tenant identifiers.

## M3.02 / #38 candidate handoff

Follow-up starts from `desktop/m3-02` at `c9529070ba11cd7c8ec9e5982f422fcdc5d19869`; the package code commit SHA is included in the final handoff message to the coordinator. Runtime wiring still reuses the single `IdentityModule.register(environment)` instance. The top-level `POST /api/v1/auth/preauth` stays independent of Suite4 ticket configuration; `SUITE4_EMBED` is deferred to M3.05. Ticket exchange is always registered and returns a safe 503 without trusted server issuer/key configuration. Production origins remain exact HTTPS; the loopback exception is limited to `NODE_ENV=test`. Runtime cookie names preserve proposed v1 (`__Host-meta_portal`, `__Host-meta_preauth`); runtime requires/returns `sessionRef` while OpenAPI and generated clients keep it optional.

The security follow-up adds distributed IP-only `PORTAL_EXCHANGE_ATTEMPT` (20 per 60 seconds) before trusted key lookup/RSA and keeps actor+IP `PORTAL_EXCHANGE` after verification. Both stable limiter errors use safe 429 plus `Retry-After`. Entry tickets now require `typ=JWT`, `purpose=META_PORTAL_ENTRY`, integer `ver=1`, bounded non-empty `session_iss`, allowed role-array shape, and at most 5 seconds skew. `session_iss` format/meaning and Suite4 use remain **Not confirmed**; the claim is not identity or tenant authority. Bounded once-per-minute cleanup deletes expired JTI tombstones before expired pre-auth rows without JTI children and never deletes sessions. The opt-in MariaDB spec now covers exact same-browser response-loss recovery, no recovery with a different browser, an unused live ticket after membership revocation, and cleanup without session deletion.

Local checks on Windows PowerShell with Node `v24.22.2` / npm `11.19.1`:

- `npx tsc -p apps/api/tsconfig.test.json` — passed; includes the opt-in M3.02 database spec.
- `node --test apps/api/dist-test/test/m3-02-auth-exchange.spec.js apps/api/dist-test/test/m3-02-preauth.spec.js apps/api/dist-test/test/m3-04-session.spec.js apps/api/dist-test/test/api-boundaries.spec.js` — 73 passed, 0 failed, 5 skipped; skips are POSIX SIGTERM subprocess cases on Windows.
- `npm run lint --workspace=@ca-meta/api` — passed for 64 TypeScript source files.
- Both `check:generated`, `lint`, `check:breaking`, and `test:contract` commands for `tools/m1-07` and `@ca-meta/contracts` passed. The v1 breaking checks report no breaking changes. Canonical OpenAPI edits are descriptive retry/401 text only; schemas and `openapi-v1.baseline.yaml` are unchanged. Generated package OpenAPI and client descriptions are synchronized.
- `node --check tools/m1-06/src/security-model.mjs` and `node --check tools/m1-06/src/run.mjs` — passed.
- The single requested `tools/m1-06/run.ps1` attempt did not reach the harness: Docker CLI `28.3.0` exists, but `dockerDesktopLinuxEngine` is unavailable at `//./pipe/dockerDesktopLinuxEngine`; its scoped Compose cleanup also could not connect. No M1.06 database scenario executed. The coordinator confirmed `com.docker.service` is stopped and cannot be started in this environment. Do not retry Docker here.
- `apps/api/test/m3-02-db.integration.spec.ts` has not been run against MariaDB; the coordinator owns one disposable loopback run after reviewing this final candidate. It requires `M3_02_DB_TEST=1`; no runner/CI changes were made.

The package tests use synthetic keys, origins and memberships only. Real Suite4 issuer/key ownership/rotation, claims, membership mapping, browser handoff/cookies and production origins remain **Not confirmed**. Package PR/CI and milestone integration remain coordinator-owned.

## M3.01 implementation summary

- Adds Principal, Membership, and separate service-identity scope migration version 4, with kind checks, tenant/principal foreign keys and exact issuer/subject uniqueness.
- Adds server-derived tenant context resolution, membership revalidation, context-reference hash comparison, tenant-scoped SQL predicates, resource-level role policy, and a separate service-scope authorizer.
- Adds focused synthetic coverage for stale context, membership revocation, tenant/asset/legacy-ID substitution, same external asset ID in two tenants, role limits, service scopes, and job tenant requirements.
- Leaves actual portal session persistence and HTTP route wiring to M3.04; Suite4 and production membership provisioning remain unconfirmed gates.

## Next action

The coordinator obtained independent source/security review and ran the focused MariaDB integration on candidate `a353038`; no source or migration changes followed that database validation. Open the package PR after the remaining GitHub metadata check, wait for required CI, then squash-integrate to `desktop/milestone-m3`. Keep issue #25 open until M3.08 supplies active-claim job authorization and the remaining external gates are confirmed.

## Job authorization status

`PersistedJobContextVerifier` is currently an integration port plus synthetic test store. There is no production adapter that resolves an existing M2 `ClaimedJob` against its active persisted claim/lease; `ca_meta_jobs` and `ClaimedJob` carry no principal ID. M3.01 therefore does not claim production authorization of existing jobs. M3.08 must connect job ID + claim token to the authoritative active lease and an authenticated service identity before job authorization is considered complete. Until then, the M3.01 job criterion remains pending.
