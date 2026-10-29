# Git workflow context — reconciled 2026-10-29

This page is historical context for repository hygiene, not a live branch or release ledger. The active Desktop rules are in [AGENTS.md](../../../AGENTS.md), the [execution contract](../../../docs/codex-desktop/execution-contract.md), and the [SDD playbook](../../../docs/meta-v2/sdd-playbook.md).

## Earlier snapshot and corrections

Older notes recorded `feat/separating-meta-app-connections`, a different remote name, an untracked `backend/`, feature-by-topic branch examples, and a rule that no commit or PR could occur without another approval. Those statements describe an earlier documentation checkout and do not govern the Desktop milestone workflow.

The M1 baseline inventory reviewed four PHP files that are versioned in the repository: `backend/connect_whatsapp.php`, `connect_facebook.php`, `connect_instagram.php`, and `meta_auth_helper.php`. It explicitly does not establish which source is deployed behind `msg4.app/meta/auth`, how Hostinger rewrites requests, or what other consumers use. Local `backend/connect.php` and `backend/connect_old.php` remain sensitive references and must not be opened, copied, committed, or rewritten. See [the baseline inventory](../../../docs/baseline/inventory.md) and [baseline evidence](../../../docs/meta-v2/01-baseline-evidence.md).

## Current Desktop branch and review discipline

- Verify `develop` and record its exact SHA before beginning a new milestone. Start `desktop/milestone-mN` from that SHA and give each work package its own `desktop/mN-XX` branch/worktree.
- Package PRs target the milestone branch and merge only by squash after applicable checks/reviews. The final milestone PR targets `develop` and needs human acceptance; accepted-on-milestone is not a release or issue closure.
- Use configured Git identity. Do not force-push, bypass protections, fabricate approval, or discard uncommitted work.
- The principal coordinates native subagents, environment, evidence, tests, integration and user updates. One writer owns each worktree; review and validation use the exact candidate SHA.

## Releases and local references

A planned branch, tag, generated image or milestone PR does not prove deployment. No release version is assigned by the planning docs; release tags follow an approved release artifact and environment. Real deployment, data migration, credential import, messages, production subscription changes, and PHP retirement stay behind explicit gates.

`connect.php` and `connect_old.php` are excluded from implementation evidence. Document versioned source behavior separately from operational behavior; mark the latter **Not confirmed** until verified through an authorized, sanitized source.
