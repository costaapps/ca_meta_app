# Git Workflow

## Current Repository Reality
- Remote configured locally:
  - `origin https://github.com/costaapps/msg4_Meta_Application.git`
- Active branch during documentation work:
  - `feat/separating-meta-app-connections`
- `backend/` is present locally but currently untracked.

Evidence:
- `git remote -v`
- `git branch -vv`
- `git status --short --branch`

## `.gitignore`
- Existing ignore rules cover build artifacts, caches, Node modules, and VS Code noise.
- It did not previously protect the local PHP files in `backend/`.
- This phase should add ignores for:
  - `backend/connect.php`
  - `backend/connect_old.php`

Reason:
- These files are operationally relevant for analysis but should not be committed automatically.

## Local-Only Files
- Treat `backend/connect.php` and `backend/connect_old.php` as local sensitive references.
- Document behavior, not raw secrets.
- Do not add them, commit them, or rewrite them without explicit approval.

## Commit Discipline
- Keep commits small and intention-revealing.
- Separate documentation, test repair, and feature work into different commits when implementation begins.
- In this phase, no commit, push, merge, or PR creation should occur without explicit user approval.

## Commit Message Style
- Conventional Commits are appropriate and match the repo history reasonably well.
- Recommended examples:
  - `docs(agent): add progressive project context`
  - `test(channels): rewrite stale Angular 21 specs`
  - `feat(auth): split facebook and instagram flows`

## Pull Requests
- PRs should call out:
  - affected Meta product surface
  - tenant and token implications
  - validation run results
  - any backend dependency or local-only assumption

## Releases And Rollback
- No release automation is visible in this repo.
- Rollback strategy should remain branch/tag based at the Git level and deployment-system based outside this repo.
- Future auth-flow separation should avoid bundling unrelated UI refactors in the same release slice.

## Documentation Expectations
- Any change to routes, backend contracts, auth flow, or tenant propagation should update:
  - `AGENTS.md` only if index-level guidance changes
  - the relevant file under `docs/agent-context/`

## Branching Guidance For Next Phases
- Prefer feature branches by problem area:
  - `feat/facebook-auth-split`
  - `feat/whatsapp-embedded-signup`
  - `fix/test-suite-angular21`
  - `docs/backend-contracts`
