# M3 progress

## Execution snapshot

- Develop baseline: 89f44ced872226afecc71b195b8c0e0cd6311179 (M2 consolidated PR #105).
- Milestone branch: desktop/milestone-m3. The last package squash is 43307aaddeb9647ac0e963e1baf8bc131104b240 (PR #126); the consolidated acceptance surface is [PR #127](https://github.com/costaapps/ca_meta_app/pull/127), targeting develop.
- All 12 planned packages are squash-integrated, including the M3.01 job-authorization follow-up. There are 14 package PRs total because M3.03 and M3.01 each needed a follow-up. PR #127 is the final delivery surface; its current head and checks in GitHub are authoritative. Do not merge it or close M3 issues before user acceptance.
- Integration worktree: C:\Users\user\.codex\worktrees\m3-milestone-integration\ca_meta_app.
- Runtime used for local package work: Windows PowerShell, Node v24.22.2, npm 11.19.1. The current integration phase relies on hosted exact-head checks; no broad local suite is planned.
- Project #12 is not exposed by the connected GitHub tools.
- Keep all M3 issues open until acceptance. Do not merge the final consolidated PR to develop or start M4.

## Package evidence

| Package / issue | Package PR and milestone squash | Exact candidate evidence | State and limitations |
|---|---|---|---|
| M3.01 / #25 | [#108](https://github.com/costaapps/ca_meta_app/pull/108) → b58ffdb1f3720b18035e1cdfa507980613a96323; [#126](https://github.com/costaapps/ca_meta_app/pull/126) → 43307aaddeb9647ac0e963e1baf8bc131104b240 | Follow-up candidate `751f66950ef2b844fe376b1f34abf9c40ba9330d`: candidate run 41889618976 and orchestrator run 41889619058 passed. Source/security reviews passed. MariaDB artifact 13351749641 includes the M3.01 authorization fixture with zero failures. | Requires the exact persisted job claim, current SERVICE grant, canonical payload and tenant-owned resource. OUTBOX, projection and history fail closed pending reviewed mappings. Production proof provisioning is Not confirmed; a runtime brand check in DurableWorker remains a P2 advisory. #25 remains open for broader acceptance. |
| M3.02 / #38 | [#112](https://github.com/costaapps/ca_meta_app/pull/112) → 5f33621e8db79f1b245d2424f67e5f5d0533060a | Candidate run 41118993946 passed. | M1.06 Docker harness could not start because Docker Engine was unavailable. Real Suite4 issuer and browser/cookie behavior are Not confirmed. |
| M3.03 / #31 | [#114](https://github.com/costaapps/ca_meta_app/pull/114) → 8fdb29b327f68a193b48e15ff8cb8e1457b8ce9c; [#123](https://github.com/costaapps/ca_meta_app/pull/123) → e467e844c5bec0e195f1bc6d2902d7c27f2c0a0a | Follow-up candidate run 41842707483 and exact-head source/security reviews passed. | Fake transport and synthetic proof only. Real email identity-proof source, delivery provider and real delivery remain Not confirmed. |
| M3.04 / #27 | [#110](https://github.com/costaapps/ca_meta_app/pull/110) → c217285e3a4bbee96d0506d5acf8852dd0027cdb | Candidate run 41105079814 passed. | Production issuer/session behavior remains Not confirmed. |
| M3.05 / #41 | [#115](https://github.com/costaapps/ca_meta_app/pull/115) → 1698badc50a2a7f955c76fd7cd84c187a36d87bb | Candidate run 41652171122 passed. | Real Suite4 origin, browser embedding and OAuth provider behavior remain Not confirmed. |
| M3.06 / #28 | [#113](https://github.com/costaapps/ca_meta_app/pull/113) → 051ff7dce8882ac684d6ee713d628e09232b1567 | Candidate and MariaDB runs 41120545306 and 41120545261 passed. | Real Meta assets and grants are Not confirmed. |
| M3.07 / #32 | [#118](https://github.com/costaapps/ca_meta_app/pull/118) → 979c67c8447e1e2bfdde36f0eb5fdefba3a089a9 | Candidate run 41656977383 passed. | Synthetic keys and ciphertext only; production key management is Not confirmed. |
| M3.08 / #34 | [#119](https://github.com/costaapps/ca_meta_app/pull/119) → 9e4ba55b566640dc1573fa22abc69dae85b2a2fb | Candidate run 41660069105 passed. | Credential resolver is tenant/asset/operation scoped. Worker identity and active-claim integration is covered by M3.01 PR #126. Live provider scopes are Not confirmed. |
| M3.09 / #37 | [#122](https://github.com/costaapps/ca_meta_app/pull/122) → d7bfe0a753f31a80e571a57715d0864279ac2684 | Candidate run 41726383969 passed. | Real token-family expiry/revocation semantics remain Not confirmed. |
| M3.10 / #35 | [#121](https://github.com/costaapps/ca_meta_app/pull/121) → b647b195a63abcaf3b2ffc75fb938cc35077d776 | Candidate run 41674154923 passed; exact-source and security reviews passed. | Approved retention durations, provider deletion and backup policy remain Not confirmed. |
| M3.11 / #39 | [#124](https://github.com/costaapps/ca_meta_app/pull/124) → c4e0ec51b406e50c9906042c6a1c98d415d31d84 | Candidate run 41853698109 passed; planning and orchestrator runs passed. | Synthetic metadata-only dry-run; legacy source schema and real credentials remain Not confirmed. |
| M3.12 / #40 | [#125](https://github.com/costaapps/ca_meta_app/pull/125) → 1b98a855a1ae725bec5c7d6186bb6861a2825c81 | Final candidate run 41867590069 passed all jobs. Contract run 41867590172, planning audit 41867590071 and orchestrator run 41867590066 passed. Exact-head source/security reviews passed. | Catalog uses local tenant-scoped data; real Graph/provider refresh is unavailable and not claimed. |

## Validation notes

- Package PR bodies link the exact source SHA, hosted workflow run IDs, independent reviews and package-specific local evidence. Candidate results apply only to the listed SHA.
- M3.01 follow-up candidate retries 41887207244, 41887803425 and 41888476792 exposed, respectively, API type narrowing, test fixture typing, and an active unbound asset row in the new MariaDB fixture. These were corrected on the final candidate SHA `751f669`; all hosted candidate, image, security, MariaDB and orchestrator jobs then passed on run 41889618976 / 41889619058.
- The old Trivy artifact 13230734415 reported two HIGH findings in the web Alpine base. The final M3.12 candidate image/security workflow passed; do not transfer the earlier artifact finding to the final candidate.
- The old API JUnit artifact 13232145002 contained a migration preflight failure that did not reproduce in later exact-head candidate runs. Its cause remains Not confirmed.
- No production PHP/rewrite equivalence, Suite4 issuer, real Meta grant, real email delivery, staging, DNS/TLS or production import has been established by this checkout.

## Consolidated delivery

PR [#127](https://github.com/costaapps/ca_meta_app/pull/127) consolidates desktop/milestone-m3 into develop with the issue-to-package evidence table, decisions, and external limits. Before any readiness or acceptance claim, confirm its current head SHA and required check conclusions on GitHub. Keep the PR unmerged and all M3 issues open until the user accepts it.
