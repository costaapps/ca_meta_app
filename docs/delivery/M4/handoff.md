# M4 handoff

## Current checkpoint

- Milestone: M4, target `desktop/milestone-m4`; integration worktree `C:\Users\user\.codex\worktrees\m4-milestone\ca_meta_app`.
- `develop` start SHA: `b35e0ddae5ce09df2ca2ce09785be4332e653803`; M3 PR #127 is merged there.
- M4.01 / #42 was integrated by package PR #128, squash commit `65233723351432d5f49306666f7fe777f7ead8b3`; source candidate `513cddccb8dc5728f5d48fa1c3cd392b0a26284d`.
- M4.02 / #44 package PR #129 candidate `18fc116b9165e8257e92aa30366cd7f1a3cf1431` passed its focused build + 20/20 synthetic tests on code SHA `89827d4fd59901f99c9893ed222b0e89d3b4d342`; the code/tests were unchanged on the final candidate. Governance and code/security reviews passed on `18fc116`. GitHub Desktop candidate, security, image and MariaDB run `42264487367`, planning run `42264487307`, and orchestrator run `42264487340` all passed. PR #129 was squash-integrated as `3b4e437919ccc720f4f8c781f8653b31d8353673`.
- Current milestone head at the start of M4.03 is `3b4e437919ccc720f4f8c781f8653b31d8353673`. The exclusive M4.03 worktree is `C:\Users\user\.codex\worktrees\m4-03\ca_meta_app`, branch `desktop/m4-03`; it was created from that head. Its implementation/tests are in progress and have not been run. The shared milestone integration worktree remains `C:\Users\user\.codex\worktrees\m4-milestone\ca_meta_app`.

## Environment and evidence

- Local Node used: `v24.22.1`; npm `11.19.1` launched directly using the Corepack cached CLI. `npm ci --ignore-scripts` succeeded in the M4.01 package worktree; npm reported 47 lockfile audit findings. No audit fixes were applied.
- Docker CLI/Compose are installed, but Docker Desktop daemon is unavailable. Portable MariaDB 11.8.9 (ZIP SHA256 `830c46727d9278eae212ae3eca44eeb9e71b2a68704e95f344a64fba7b1963f5`) is running on `127.0.0.1:3307` for synthetic tests, isolated as database `meta_m4_integration`. Start/stop scripts and credentials live outside the repository at `C:\Users\user\AppData\Local\ca-meta-m4\m4-integration-20261106`; do not print or commit credentials. The environment agent verified restart/login. Keep it while M4 integration tests need it; stop it only after the milestone work is done.
- `gh` is absent; use the native GitHub connector. GitHub Project #12 is not exposed. Do not close issues unless the prompt or an external gate explicitly requires it.
- Official source review says Graph v27.0 was announced while an available changelog snapshot still showed v26.0. Endpoint compatibility and app-specific verified version remain **Not confirmed**. M4.10's review of Meta's [Graph API Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/) docs/search content confirms GET verify-token/challenge and POST `X-Hub-Signature-256` with the app secret over the raw body; direct pages returned HTTP 429. Generic retry/ACK guidance is not assumed to apply to WhatsApp. M4.11's Meta-maintained [WhatsApp Cloud API Postman collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) confirms WABA subscription is separate from app webhook config and uses `POST /{WABA-ID}/subscribed_apps`; Page/Instagram subscription semantics and exact grants remain **Not confirmed** because official references returned HTTP 429.
- Real app IDs and mode provenance, grants, App Review, Sandbox, Coexistence eligibility, production callbacks and live behavior remain **Not confirmed**. Do not make Meta calls or use real credentials.

## Exact next action

Wait for the M4.03 implementer to provide the exact candidate SHA and focused command. Review the diff and criteria once, run one API focused test command plus the applicable MariaDB migration/integration fixture at that SHA, then request independent code/security reviews without duplicate suites. Open its package PR to `desktop/milestone-m4`, wait for required CI/protections, squash against the exact head and confirm the milestone commit. Then start M4.10 and M4.11 code in separate package worktrees, serializing shared `app.module.ts`, migration registry and traceability integration. Do not make real Meta calls. M4.02 and the research agents must not be rerun.
