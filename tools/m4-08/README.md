# M4.08 Facebook Pages focused harness

From the repository root, run:

```sh
node tools/m4-08/run-focused-test.mjs
```

The harness uses the pinned root `package-lock.json` TypeScript and Node test runner, compiles only the Facebook Pages/M4.11 package surface and the two focused unit specs into an operating-system temporary directory, runs the Facebook Pages suite plus the M4.11 subscription regression suite, and removes temporary output in `finally`. No database, Meta account, credentials, HTTP transport, Sandbox, or network access is required. A fresh checkout should run `npm ci` first.

The synthetic cases cover exact Facebook variant gating, complete cursor pagination before persistence, per-Page credential routing to the vault-owned store port, zero Pages without asset persistence, incomplete pagination and repeated-cursor refusal, Page tasks not becoming operation grants, exact M4.11 Page catalog and selection queries, explicit selection through M4.11 bindings, and a failed Page subscription remaining partial without invoking the WhatsApp provider. All provider calls are local fakes; fixtures use synthetic IDs and token-shaped strings.

The harness does not prove the production credential enrollment adapter, current Login for Business scopes or grants, Page token expiry, Page Webhooks endpoint/field semantics, App Review, callback routing or external provider behavior. Those facts remain **Not confirmed**. This implementer did not execute the harness, build, typecheck or any other validation by coordinator instruction; the coordinator must record results on the integrated candidate SHA.
