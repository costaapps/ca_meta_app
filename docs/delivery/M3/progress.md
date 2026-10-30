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
| M3.01 / #25 | P1 correction committed; integration/reviews pending | Tested code SHA `e66f3bc44e15b5be558dce8d8965bef7fa7bf81a` on `desktop/m3-01`, based on `89f44ced872226afecc71b195b8c0e0cd6311179`; preserves original implementation commit `bd4d87f493c35f0b3da98efd8d06c92ebd48bdc3` and first correction `a7339237ba794395b85245254d118117bdff4f18` | On Node `v24.22.2` / npm `11.19.1`: API typecheck/build, test TypeScript compile, and 14 focused tests passed after role/scope/mapping corrections. MariaDB and repeated independent reviews remain with the coordinator. | Not created | Coordinator runs the MariaDB migration harness and repeats reviews on the final HEAD |
| M3.02 / #38 | Not started | — | — | — | Wait for M3.01; implement ticket exchange against fake issuer, preserve real Suite4 gate |
| M3.03 / #31 | Not started | — | — | — | Wait for M3.01 and M3.04; implement one-use link with local fake mail transport |
| M3.04 / #27 | Not started | — | — | — | Wait for M3.01; implement persisted sessions, CSRF, CORS, quotas and wire tenant context |
| M3.05 / #41 | Not started | — | — | — | Wait for M3.02 and M3.04; implement embed handshake and OAuth return |
| M3.06 / #28 | Not started | — | — | — | Wait for M3.01; implement authorization, assets, grants and tenant constraints |
| M3.07 / #32 | Not started | — | — | — | Wait for M3.06; implement encrypted vault and resumable key rotation |
| M3.08 / #34 | Not started | — | — | — | Wait for M3.06 and M3.07; implement tenant/app/asset/operation credential resolver |
| M3.09 / #37 | Not started | — | — | — | Wait for M3.08; implement family-specific token health and reauthorization |
| M3.10 / #35 | Not started | — | — | — | Wait for M3.01, M3.06 and M3.07; implement redaction, audit and retention |
| M3.11 / #39 | Not started | — | — | — | Wait for M3.06–M3.09; implement synthetic dry-run and quarantine only |
| M3.12 / #40 | Not started | — | — | — | Wait for M3.06, M3.08, M3.09; implement sanitized paginated catalog |

The status `implemented locally` is not acceptance on the milestone branch or delivery in `develop`.
