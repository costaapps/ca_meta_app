# M3 progress

## Execution point

- Starting `develop` SHA: `89f44ced872226afecc71b195b8c0e0cd6311179` (M2 consolidated PR #105 is merged to `develop`).
- Integration branch: `desktop/milestone-m3`, created from that SHA.
- Current package worktree: `C:\Users\user\.codex\worktrees\m3-01-tenancy-identity\ca_meta_app`, branch `desktop/m3-01`.
- Runtime: Windows PowerShell, Node `v24.22.2`, npm `11.19.1`.
- GitHub connector: authenticated as `eduardomatuella-costaapps`; `gh` CLI unavailable. Project #12 is not exposed by the connector.
- External evidence remains **Not confirmed** for Suite4 issuer/membership, real browser embed/cookie behavior, Meta grants/assets and staging/DNS/TLS. Local fixtures do not certify those integrations.

## Package table

| Package / issue | Stage | Candidate | Last evidence | Package PR / squash | Next action |
|---|---|---|---|---|---|
| M3.01 / #25 | Source and security review passed; production job adapter pending M3.08 | Source SHA `37aa2077d7f4a25eada346e1ba792725252a3b6a` on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`; later commits contain only reviewed documentation/evidence updates; preserves original implementation commit `bd4d87f493c35f0b3da98efd8d06c92ebd48bdc3` and corrections | On Node `v24.22.2` / npm `11.19.1`: API typecheck/build, test TypeScript compile, and 14 focused identity + migration-unit tests passed on source SHA `37aa207`. MariaDB migration/admin integration passed 1/1 on `a35303834d8564c8bfca49555b7a3cb10783f8ec`; later source changes were provenance-only and did not alter migration/SQL. Independent review on source at `a9888a2` found no code blocker; job adapter/active-claim verification remains pending M3.08. CI remains required on the PR SHA. | Not created | Open the package PR, wait for required CI, then squash to `desktop/milestone-m3`; keep #25 open until M3.08 closes the job authorization criterion |
| M3.02 / #38 | Runtime wiring, pre-auth, strict ticket validation and exact retry recovery implemented locally; candidate awaits final exact-SHA reviews and package PR CI | Code/test SHA `20792590b51ce18a831692d1a3426e0434cd35cf` on `desktop/m3-02`, based on `desktop/milestone-m3` SHA `c217285e3a4bbee96d0506d5acf8852dd0027cdb` | Node `v24.22.2` / npm `11.19.1`: test TypeScript compile passed; focused API run 73 passed, 0 failed, 5 Windows-only POSIX SIGTERM skips; API lint and both OpenAPI generation/lint/breaking/contract gates passed. Fresh disposable MariaDB `11.8.8` on loopback applied migrations and passed the opt-in concurrency/recovery/revocation/cleanup spec 1/1. M1.06 runner did not reach the harness because Docker Engine was unavailable; `node --check` passed for the two touched files. External Suite4 behavior remains **Not confirmed**. | Not created | Obtain exact-SHA source/security review, push branch, create package PR, wait for required CI, then squash to `desktop/milestone-m3` |
| M3.03 / #31 | Not started | — | — | — | Wait for M3.01 and M3.04; implement one-use link with local fake mail transport |
| M3.04 / #27 | Not started | — | — | — | Wait for M3.01; implement persisted sessions, CSRF, CORS, quotas and wire tenant context |
| M3.05 / #41 | Not started | — | — | — | Wait for M3.02 and M3.04; implement embed handshake and OAuth return |
| M3.06 / #28 | Not started | — | — | — | Wait for M3.01; implement authorization, assets, grants and tenant constraints |
| M3.07 / #32 | Not started | — | — | — | Wait for M3.06; implement encrypted vault and resumable key rotation |
| M3.08 / #34 | Not started | — | — | — | Wait for M3.06 and M3.07; implement tenant/app/asset/operation credential resolver plus service credential and active job-claim context verification |
| M3.09 / #37 | Not started | — | — | — | Wait for M3.08; implement family-specific token health and reauthorization |
| M3.10 / #35 | Not started | — | — | — | Wait for M3.01, M3.06 and M3.07; implement redaction, audit and retention |
| M3.11 / #39 | Not started | — | — | — | Wait for M3.06–M3.09; implement synthetic dry-run and quarantine only |
| M3.12 / #40 | Not started | — | — | — | Wait for M3.06, M3.08, M3.09; implement sanitized paginated catalog |

The status `implemented locally` is not acceptance on the milestone branch or delivery in `develop`.
