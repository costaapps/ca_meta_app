# M4.11 focused subscription proof

The focused gate compiles the owned subscription package and its synthetic Node test into an OS temporary directory, runs only that compiled test file, and removes the temporary directory in a `finally` block. It does not connect to MariaDB, Meta, a browser, or a credentials store.

From the repository root, run:

```sh
node tools/m4-11/run-focused-test.mjs
```

Dependencies come from the checked in root `package-lock.json`; a fresh disposable checkout should run `npm ci` first. The compiler is the repository pinned TypeScript package. The harness requires Node `>=24.15.0 <25` and npm `>=11.19.1 <12`; record the exact versions used with the result.

The synthetic cases cover four phone assets that resolve to one WABA, per-target serialization/idempotency, disconnect with remaining consumers, desired/observed app webhook state separation, unconfirmed asset fields, fail-closed identity and browser supplied provider IDs, recovery after a backoff window, and the Graph adapter's catalog-derived WABA ID with read-after-write verification. Fixtures use fabricated UUIDs, object IDs, app IDs and credential handles only. They issue no HTTP calls.

This is the package focused test gate. It does not apply `META_SUBSCRIPTIONS_MIGRATION` or assert MariaDB DDL execution. The coordinator registers and validates the migration and module at the integrated candidate SHA.
