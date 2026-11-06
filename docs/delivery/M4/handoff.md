# M4 handoff

## Current checkpoint

- Milestone: M4, target `desktop/milestone-m4`; integration worktree `C:\Users\user\.codex\worktrees\m4-milestone\ca_meta_app`.
- `develop` start SHA: `b35e0ddae5ce09df2ca2ce09785be4332e653803`; M3 PR #127 is merged there.
- M4.01 / #42 was integrated by package PR #128, squash commit `65233723351432d5f49306666f7fe777f7ead8b3`; source candidate `513cddccb8dc5728f5d48fa1c3cd392b0a26284d`.
- Package PR #128 targets `desktop/milestone-m4`; all applicable status checks passed. Code/security reviews found no blockers. Focused API tests passed 10/10 on implementation SHA `95f2acaa9d43827b060a685972f7956bde147b50`; on final contract candidate `513cddc`, M1.07 contract tests passed 8/8 and generated checks passed.
- Delivery progress and this handoff are updated after integration. No other M4 package branch exists yet.

## Environment and evidence

- Local Node used: `v24.22.1`; npm `11.19.1` launched directly using the Corepack cached CLI. `npm ci --ignore-scripts` succeeded in the M4.01 package worktree; npm reported 47 lockfile audit findings. No audit fixes were applied.
- Docker CLI/Compose are installed, but Docker Desktop daemon is unavailable. Official portable MariaDB 11.8.9 ZIP is prepared at `C:\Users\user\AppData\Local\ca-meta-m4\mariadb-11.8.9`, SHA256 `830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5`. No portable server, service, data directory or test database has been initialized or started. Use a dedicated new data path and port if local persistence tests require it.
- `gh` is absent; use the native GitHub connector. GitHub Project #12 is not exposed. Do not close issues unless the prompt or an external gate explicitly requires it.
- Official source review says Graph v27.0 was announced while an available changelog snapshot still showed v26.0. Endpoint compatibility and app-specific verified version remain **Not confirmed**.
- Real app IDs and mode provenance, grants, App Review, Sandbox, Coexistence eligibility, production callbacks and live behavior remain **Not confirmed**. Do not make Meta calls or use real credentials.

## Exact next action

Start M4.02 / #44 on branch `desktop/m4-02` from the now-updated milestone branch. Implement the internal Graph transport with a fixed environment/app/variant version and host/path policy, bounded request and response sizes/timeouts, credential handle resolution without token return/logging, normalized Graph errors (including HTTP 200 with an error), safe pagination/checkpoints, explicit retry/concurrency budgets, and no blind retry for ambiguous POST outcomes. Do not accept arbitrary browser-provided Graph URLs.

Run its one focused gate, `npm run test:m4-02 --workspace=@ca-meta/api`, on the exact candidate; rerun M3.08 only if its resolver contract changes. Follow with independent code/security review and the package PR to `desktop/milestone-m4`. Keep all shared registrations and progress updates serial. The consolidated M4 PR must target `develop` and remain open for human acceptance.
