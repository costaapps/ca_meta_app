# M1.06 — Identity and security harness

This local PoC exercises the proposed portal identity boundary with an ephemeral fake issuer and synthetic tenants. It is not a production backend and does not connect to Suite4, Meta, PHP, email, or any production database. Its MariaDB schema exists only inside one uniquely named Docker Compose project.

## Pinned runtime and setup

- Docker Desktop/Engine with Compose v2.
- Node `24.22.2` in the harness image, pinned by digest in `Dockerfile`.
- MariaDB `11.8.8`, pinned by digest in `compose.yml`.
- `mysql2` `3.24.6`, pinned in `package.json` and `package-lock.json`; the image installs with `npm ci`.
- RSA key pairs are generated in memory for each run. No private/public test key is committed or retained.
- There are no host database ports. Compose creates a private network and a project-specific disposable volume.

From the repository root in Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\m1-06\run.ps1
```

The runner creates a unique Compose project and an ephemeral database password in its process environment, validates the Compose file, builds/runs the harness, then removes that project's containers, network and volume with `down --volumes --remove-orphans`. It restores any pre-existing `M106_DB_PASSWORD` value and does not print the password. Cleanup is scoped to that generated project name.

The runner preserves a pre-existing password environment value and reports cleanup errors. It requires permission to run Docker locally; if Docker is unavailable, no service is started and there is no fallback to a shared database.

## What the harness checks

- `AC01`: `cUUID` without a session grants nothing; a tenant mismatch cannot select another tenant's asset; cookie shape is host-only/`Secure`/`HttpOnly`, and only a hash of the session secret is stored.
- `AC01`/`AC02`: each browser first starts a pre-auth challenge; the fake issuer signs that challenge into the ticket, while MariaDB stores its hash bound to the hash of that browser's `Secure`/`HttpOnly` pre-auth cookie. Exchange requires exact API Origin, allowed host Origin/entry mode, matching cookie+challenge, and atomically consumes challenge and `jti` before creating a session. Missing, transplanted, expired or replayed challenges fail; tests check failed attempts leave the `jti` unused. A suspended tenant grants no resource access; an existing session may only recover by switching with CSRF to a different active tenant with current membership.
- `AC02`: ticket signature, strict `RS256` allowlist, `kid` trust/rotation, issuer, audience, purpose, challenge, version, expiry/TTL/skew, future `iat`, signature tampering, blocked remote key URLs, current membership, tenant status, tenant-scoped membership revocation, current role over signed role claims, idle timeout, session Origin/CSRF/`Sec-Fetch-Site` checks and atomic one-use `jti`. `same-origin` is paired with the exact app Origin; `same-site` is paired only with a configured synthetic sibling Origin. Missing, invalid, `none`, `cross-site`, mismatched pairs and bad CSRF fail. A revoked source membership blocks source reads/writes; recovery to another active membership is CSRF/context-bound, rotates context, rejects unauthorized targets and stale-ref replay. Roles in the signed claim are deliberately not used; current membership is authoritative. Two concurrent exchanges of one ticket create at most one session under database uniqueness. A principal with active memberships in A/B keeps B access after only A is revoked.
- `AC03`: known/unknown addresses return the same public status/body; the fake token is exposed only through an in-process test outbox; GET/HEAD previews do not consume; explicit POST requires same-origin; tenant edits, sequential/concurrent replay and expiry fail. A process-local synthetic quota is exercised for response consistency; matching bodies do not prove timing non-enumeration or real/distributed rate limits.
- `AC04`: tenant switching revalidates membership and serializes concurrent tabs against a versioned `contextRef`; stale tabs fail and the saved onboarding remains bound to its starting tenant. The synthetic embed bridge validates exact origin, source object, schema/version, nonce/freshness/replay and exact target origin. Blocked third-party cookies select a top-level fallback while retaining CSRF.
- `AC05`: owner/admin/operator/viewer operations and a service identity are scoped by operation, tenant and asset. Allowed and denied decisions write a limited audit row without session/CSRF/ticket values.

Expected final marker: `M1.06 MariaDB identity/security harness PASS` and exit code 0. Failed assertions exit nonzero; the runner still attempts isolated cleanup.

## Limits and follow-up

The issuer/audience/keyset are fake. This test does not validate real JWKS distribution, issuer or membership APIs, Suite4 challenge claim/handoff support, preservation of the pre-auth cookie across top-level/embed navigation, Suite4 roles/tenant mapping, real browser `Sec-Fetch-Site` classifications or the actual same-site Origin allowlist, browser Origin/iframe/cookie behavior, iframe CSP/`frame-ancestors`, email scanner products, timing side channels, distributed/effective email quotas, provider webhook signatures, deployment behavior, production DDL, key custody, multi-region transactions or real grants. Those remain **Not confirmed** and are integration gates for M3.02. The harness is evidence for local contract logic and the MariaDB uniqueness/transaction behavior only.

The runner also compares each row in [`docs/baseline/endpoint-matrix.csv`](../../docs/baseline/endpoint-matrix.csv) with [`docs/meta-v2/endpoint-security-crosswalk.csv`](../../docs/meta-v2/endpoint-security-crosswalk.csv), requiring a one-to-one match across all 53 current matrix rows. The code glossary is in [`endpoint-security-crosswalk.md`](../../docs/meta-v2/endpoint-security-crosswalk.md).

The model intentionally does not implement an HTTP server, Angular changes, service credentials, Meta calls or email delivery. The only inbox token is an internal fake fixture value and is not included in the public response, logs or audit rows.
