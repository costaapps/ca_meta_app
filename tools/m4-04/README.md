# M4.04 focused harness

This harness checks the exclusive WhatsApp adapter and its shared Graph/saga/status contracts with synthetic fixtures. It makes no network calls, opens no database connection, and uses no Meta credentials or production assets.

## Setup

Use the monorepo's pinned Node/npm engine from `package.json`, then install the lockfile once from the repository root:

```powershell
npm ci --ignore-scripts
```

## Run

From the repository root:

```powershell
npm run test:m4-04 --workspace=@ca-meta/api
```

The focused TypeScript project compiles the affected source and these test files: `m4-04-whatsapp-exclusive`, `m4-02-meta-graph`, `m4-03-onboarding-saga`, `m3-05-onboarding-status`, and `m3-05-onboarding-session`. The harness uses a private temporary directory under `apps/api/.test-runs/m4-04-*` and removes only that verified child directory in `finally`. No Docker or MySQL setup is needed.

## Coverage and limits

- Exclusive Cloud API route/body validation; Coexistence rejection before credentials; ambiguous registration POST is not retried; PIN echoes/fields are removed.
- Safe per-number readiness is restricted to internal phone asset refs, flow-bound reasons and timestamps; unresolved readiness pauses before subscriptions and remains resumable.
- Portal status returns only safe internal asset refs and state metadata.
- These are contract/fixture tests only. They do not prove provider grants, app review, token type/eligibility, a protected PIN source, Meta account behavior, webhooks, or live subscription success.
