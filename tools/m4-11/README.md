# M4.11 focused subscription proof

The single focused command compiles the subscription package and runs its synthetic Node tests plus the gated MariaDB migration/store fixture. The compiler output goes into an OS temporary directory that the harness removes in a `finally` block.

From the repository root, run:

```sh
node tools/m4-11/run-focused-test.mjs
```

Dependencies come from the checked-in root `package-lock.json`; a fresh disposable checkout should run `npm ci` first. The compiler is the repository-pinned TypeScript package. The harness requires Node `>=24.15.0 <25` and npm `>=11.19.1 <12`; record the exact versions with gate evidence.

Without `M2_DURABLE_WORK_TEST=1`, the MariaDB case is reported as skipped. To enable it, use only the repository's disposable M2/M3 MariaDB profile and provide its existing migration and API database environment configuration. The fixture deploys the registered migration set to that profile. It inserts generated, synthetic tenant/app/authorization/asset rows and a credential metadata row marked `SYNTHETIC_FIXTURE_ONLY`; it creates no credential secret or token, calls no Meta endpoint, drops no schema, and truncates no data. Keep the database profile disposable. The test's UUID-scoped rows and append-only audit events remain in that profile until the profile is discarded by its owner.

The MariaDB fixture resolves four synthetic WhatsApp phone assets through verified `PHONE_TO_ACCOUNT` relations to one synthetic WABA. One phone has two distinct eligible synthetic authorization grants. The real catalog must reject that phone without a selector and resolve either grant only by its internal authorization UUID. The fixture upserts the four base bindings concurrently, adds the second grant, repeats all five bindings concurrently, and removes only the selected grant. `ensureBinding` uses a new QueryRunner per attempt and retries only `ER_LOCK_DEADLOCK` or `ER_LOCK_WAIT_TIMEOUT`, up to four attempts total with 20/40/60 ms delays after rollback and release. It checks one target, five unique bindings after retries, and four remaining bindings (three phones plus the other grant for the selected phone) with `desired_state=SUBSCRIBED`. The fixture instantiates only the catalog and SQL store; no Graph client or HTTP transport is involved.

The synthetic unit suite also covers app-level Webhooks state separation, unconfirmed asset fields, fail-closed identity and browser-supplied provider IDs, retry/backoff, the Graph adapter's catalog-derived WABA ID with read-after-write verification, and rejection of an unconfirmed nested GET response shape before any write. All identifiers and credential metadata are synthetic.

This harness does not prove Meta grants, live Graph version behavior, real response shapes, external unsubscribe semantics, app-level Webhooks mutation behavior, or Sandbox certification. The adapter currently accepts only string items or items with a top-level `id`; nested shapes such as `whatsapp_business_api_data.id` fail closed until an official response example or app-specific evidence confirms their interpretation. Those provider details remain **Not confirmed**.
