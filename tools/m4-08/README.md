# M4.08 Facebook Pages focused harness

From the repository root, run:

```sh
node tools/m4-08/run-focused-test.mjs
```

The harness uses the pinned root `package-lock.json` TypeScript and Node test runner, compiles only the Facebook Pages/M4.11 package surface and the two focused unit specs into an operating-system temporary directory, runs the Facebook Pages suite plus the M4.11 subscription regression suite, and removes temporary output in `finally`. No database, Meta account, real credential, HTTP transport, Sandbox, or network access is required. A fresh checkout should run `npm ci` first.

The synthetic cases cover exact Facebook variant gating, safe typed Graph discovery with the batch token callback restricted to a fake vault port, opaque per-Page credential refs, complete discovery before Page asset persistence, zero Pages without asset persistence, partial-result refusal, Page tasks not becoming operation grants, exact M4.11 Page catalog/selection behavior, and a failed Page subscription remaining partial without invoking the WhatsApp provider. Portal authorization and CSRF are enforced by the route/service wiring; the harness does not currently simulate an authenticated HTTP request. All provider calls are local fakes; fixtures use synthetic IDs and token-shaped strings.

The official discovery shape is documented in Meta's [Facebook API collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api): `GET /me/accounts?fields=name,access_token,tasks` with cursor pagination. This confirms Page discovery metadata and Page-token behavior only; app-specific Login for Business grants and Page `subscribed_apps` endpoint/permissions/fields remain **Not confirmed**.

The harness does not prove the runtime user-token resolver context, production credential enrollment adapter, current Login for Business scopes or grants, Page token expiry, Page Webhooks endpoint/field semantics, App Review, callback routing or external provider behavior. Those facts remain **Not confirmed**. This implementer did not execute the harness, build, typecheck or any other validation by coordinator instruction; the coordinator must record results on the integrated candidate SHA.
