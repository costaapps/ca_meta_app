# M6 execution handoff

Updated 2026-11-18 (America/Sao_Paulo).

## Git state

- Repository: `costaapps/ca_meta_app`.
- Base `develop`: `b54bde1ed170a4304e281383f70ded6ed0a4f5dc` (matches `origin/develop`).
- Integration branch: `desktop/milestone-m6` at `5365954f20426da2768c02705021144ce847e9df`, created from that base and pushed.
- Git identity is the configured user identity `Eduardo Matuella <eduardo.matuella@costaapps.com.br>`.

## Entry evidence

- PR #166 was read from GitHub and is `closed/merged`, base `develop`, merge commit `b54bde1...`; it consolidates M5.01–M5.10. Package PRs #152–#165 are merged into the M5 branch.
- M5 implementation is present on `develop`. Keep the M5 limitations from its handoff: PHP/Msg4 callers, real enterprise destinations, and actual shadow/pilot/cutover remain **Not confirmed**.
- Issues #66–#75 were fetched from GitHub. Their current bodies match the local M6 prompt criteria; all are open and in milestone 6.

## Worktrees and owners

| Package | Worktree | Owner | Current action |
|---|---|---|---|
| M6.01 / #69 | `C:\Users\user\.codex\worktrees\m6-01-ux\ca_meta_app` | `/root/m6_01` | Branch `desktop/m6-01` at `20eb9d6`; focused snapshot 99/99. Must rerun after Angular fix/current integration. |
| M6.02 / #70 | `C:\Users\user\.codex\worktrees\m6-02-security\ca_meta_app` | `/root/m6_02` | Uncommitted targeted Angular update and M6.02 harness; resume install/build/security run without repeating completed setup. |
| M6.03 / #66 | `C:\Users\user\.codex\worktrees\m6-03-load\ca_meta_app` | `/root/m6_03` | Uncommitted focused harness/spec; resume from existing files and any identified disposable DB process. |
| M6.04 / #67 | `C:\Users\user\.codex\worktrees\m6-04-telemetry\ca_meta_app` | `/root/m6_01` | Branch `desktop/m6-04` at integration base `5365954`; telemetry implementation newly resumed. |

Each task branch starts from the M6 integration base as it existed before the initial report commit. After an agent commits, update its branch against current `desktop/milestone-m6`, then review the resulting candidate before opening a package PR. The primary agent owns GitHub PR/squash mutations and final integration.

## Environment and services

- Node `v24.22.2` + npm `11.19.1` are installed in `C:\Users\user\AppData\Local\ca-meta-runtimes\node-v24.22.2-win-x64`; official ZIP SHA-256 was verified. Activate by prepending that directory to PowerShell `$env:PATH`.
- Root `npm ci --ignore-scripts` completed on the primary checkout in about 3 minutes. It reported 47 baseline audit findings (1 low, 20 moderate, 24 high, 2 critical); a separate `npm audit --omit=dev` found six high Angular runtime advisories on the base. M6.02 owns a targeted Angular 21 patch update; do not run blanket `npm audit fix`.
- Docker Desktop was started with `docker desktop start`; `docker info` confirms server 28.3.0. Use only named disposable test services and clean up only resources created by the relevant harness.
- `gh` CLI is absent; GitHub MCP reads and repository SSH push work. Do not install `gh` unless a concrete need arises.
- No tests had been run at handoff creation.

## Pending work

1. Finish M6.02–M6.04 implementations and focused checks; preserve the M6.01 evidence and rerun only after the security fix/current base lands.
2. Continue M6.05/M6.06 and local readiness/runbook portions of M6.07–M6.10 in isolated package branches.
3. Integrate eligible package PRs by squash into `desktop/milestone-m6`; revalidate affected checks on changed SHAs.
4. Run one cumulative validation against the integrated release candidate; create consolidated PR to `develop` for review.
5. Keep publication, real staging/production, real Meta changes, message delivery, canary, hypercare completion, PHP/Hostinger retirement, and issue closure out of scope without later concrete authorization and proof.
