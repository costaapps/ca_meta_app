# M4.11 focused subscription proof

The single focused command compiles the subscription package and runs its synthetic Node tests plus the gated MariaDB migration/store fixture. The compiler output goes into an OS temporary directory that the harness removes in a `finally` block.

From the repository root, run:

```sh
node tools/m4-11/run-focused-test.mjs
```

Dependencies come from the checked-in root `package-lock.json`; a fresh disposable checkout should run `npm ci` first. The compiler is the repository-pinned TypeScript package. The harness requires Node `>=24.15.0 <25` and npm `>=11.19.1 <12`; record the exact versions with gate evidence.

Without `M2_DURABLE_WORK_TEST=1`, the MariaDB case is reported as skipped. To enable it, use only the repository's disposable M2/M3 MariaDB profile and provide its existing migration and API database environment configuration. The fixture deploys the registered migration set to that profile. It inserts generated, synthetic tenant/app/authorization/asset rows and a credential metadata row marked `SYNTHETIC_FIXTURE_ONLY`; it creates no credential secret or token, calls no Meta endpoint, drops no schema, and truncates no data. Keep the database profile disposable. The test's UUID-scoped rows and append-only audit events remain in that profile until the profile is discarded by its owner.

The MariaDB fixture resolves four synthetic WhatsApp phone assets through verified `PHONE_TO_ACCOUNT` relations to one synthetic WABA, upserts all four bindings concurrently, repeats those upserts, and removes one consumer. It checks that one target and four bindings remain after the repeated upserts and that disconnecting one phone leaves three eligible bindings and `desired_state=SUBSCRIBED`. The fixture instantiates only the catalog and SQL store; no Graph client or HTTP transport is involved.

The synthetic unit suite also covers app-level Webhooks state separation, unconfirmed asset fields, fail-closed identity and browser-supplied provider IDs, retry/backoff, and the Graph adapter's catalog-derived WABA ID with read-after-write verification. All identifiers and credential metadata are synthetic.

This harness does not prove Meta grants, live Graph version behavior, real response shapes, external unsubscribe semantics, app-level Webhooks mutation behavior, or Sandbox certification. Those provider details remain **Not confirmed** pending official contract review and app-specific evidence.
