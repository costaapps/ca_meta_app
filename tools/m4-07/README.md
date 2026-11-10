# M4.07 focused synthetic checks

This harness exercises the fail-closed Coexistence event-processing seam with generated IDs and fake scope/sink ports. It makes no Meta requests, sends no messages, and uses no customer data or credentials. It compiles only the webhook types, M4.07 processor, and focused test into a unique OS temporary directory, then removes that directory in `finally`.

## Requirements and setup

- Node.js `>=24.15 <25` and npm `>=11.19.1 <12`, matching the repository's API workspace.
- Install the repository's pinned dependencies from the root with `npm ci --ignore-scripts` if `node_modules/typescript/bin/tsc` is unavailable. This feature adds no package dependencies or lockfile changes.
- No database, queue, Docker service, provider account, or environment secrets are required.

## Run

From the repository root:

```powershell
node tools/m4-07/run-focused-test.mjs
```

The expected result is a successful strict TypeScript compile of the bounded project and passing `node:test` cases for explicit enablement, trusted phone scope, consent/retention gates, duplicate message identity, echo automation suppression, state-sync quarantine, safe failures, and fallback of non-Coexistence events.

## Cleanup and limits

The harness owns only its `ca-meta-m4-07-*` temporary directory and deletes it on success or failure. It does not modify the worktree. The fixture sink models the idempotency contract but does not prove a database transaction, production retention policy, event availability, live history synchronization, or Meta eligibility. Provider schemas, sync trigger/window, state-sync ownership route, consent semantics, and real Sandbox behavior remain **Not confirmed**; see the M4.07 spec and ADR-018.
