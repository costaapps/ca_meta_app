# M4 progress

## Execution snapshot

- Develop start SHA: `b35e0ddae5ce09df2ca2ce09785be4332e653803` (M3 consolidated PR #127 is merged there).
- Milestone branch: `desktop/milestone-m4`, integration worktree: `C:\Users\user\.codex\worktrees\m4-milestone\ca_meta_app`.
- M4.01 / #42 package PR #128 was squash-merged into the milestone branch. Package candidate: `513cddccb8dc5728f5d48fa1c3cd392b0a26284d`; squash commit: `65233723351432d5f49306666f7fe777f7ead8b3`.
- M4.01 focused API validation passed on implementation SHA `95f2acaa9d43827b060a685972f7956bde147b50`: Node `v24.22.1`, npm `11.19.1`, `npm run test:m4-01 --workspace=@ca-meta/api` (API build + 10 tests). Final contract-only changes were validated on `513cddc`: from `tools/m1-07`, `npm run test:contract` (8 passed) and `npm run check:generated` (generated client and 53 compatibility rows current).
- Code and security reviewers found no implementation blockers. Code review confirmed all five bootstrap examples match the runtime manifest. All applicable GitHub checks on #128 passed: baseline, plan, M1.07 contract, desktop candidate, M2.08 images/security/MariaDB and orchestrator; `structure` was skipped by workflow.
- Environment: Node `v24.22.1`, npm `11.19.1`; root `npm ci --ignore-scripts` succeeded in the package worktree and reported 47 audit findings (1 low, 20 moderate, 24 high, 2 critical). No audit fix was run. Docker CLI is installed but Docker Desktop daemon is unavailable. A portable official MariaDB 11.8.9 ZIP is prepared outside the repository at `C:\Users\user\AppData\Local\ca-meta-m4\mariadb-11.8.9` (SHA256 `830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5`); no server/data was initialized or started.
- `gh` CLI is absent; use the native GitHub connector. GitHub Project #12 is not exposed by the current connector; issue and PR state are accessible.
- Real Meta app IDs/mode provenance, grants, verified Graph/SDK/Embedded Signup versions, App Review, Sandbox assets and Coexistence eligibility remain **Not confirmed**. No real credentials are configured; product actions stay disabled until evidence is supplied.

## Package table

| Package / issue | Etapa | Candidato | Última evidência | PR | Próxima ação |
|---|---|---|---|---|---|
| M4.01 / #42 | integrated | `513cddc` | focused API 10/10 on `95f2aca`; contract 8/8 and generated checks on candidate; static/security reviews clear; all applicable CI passed | #128 squash-merged as `6523372` | Keep real Meta app/version/review/Sandbox evidence **Not confirmed**; do not enable real product actions |
| M4.02 / #44 | pending | not created | M3.08 / M2.05 dependencies integrated; planning brief prepared | not created | Start Graph client package on `desktop/m4-02` |
| M4.03 / #45 | pending | not created | Dependency graph only | not created | Start after M4.02 integration |
| M4.04 / #48 | pending | not created | Dependency graph only | not created | Start after M4.03 and M4.11 |
| M4.05 / #49 | pending | not created | Dependency graph only | not created | Start after M4.03 |
| M4.06 / #52 | pending | not created | Dependency graph only | not created | Start after M4.05 and M4.11 |
| M4.07 / #53 | pending | not created | Dependency graph only | not created | Start after M4.06 and M4.10 |
| M4.08 / #50 | pending | not created | Dependency graph only | not created | Start after M4.03 and M4.11 |
| M4.09 / #51 | pending | not created | Dependency graph only | not created | Start after M4.03 and M4.11 |
| M4.10 / #46 | pending | not created | Dependency graph only | not created | Start after M4.02 |
| M4.11 / #47 | pending | not created | Dependency graph only | not created | Start after M4.02 |
| M4.12 / #54 | pending | not created | Dependency graph only | not created | Start after channel packages and M4.10 |
| M4.13 / #55 | pending | not created | Dependency graph only | not created | Start after M4.10–M4.12 |
| M4.14 / #57 | pending | not created | Dependency graph only | not created | Certify fixtures, then record external Sandbox gaps exactly |
