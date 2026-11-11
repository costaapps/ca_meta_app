# M4.02 focused Graph client proof

This focused gate first runs the API's normal Nest build, which compiles the root `ApiModule` integration and registered providers, then invokes Node's built-in test runner with the repository-pinned TypeScript compiler. The harness compiles the Graph client dependencies and `apps/api/test/m4-02-meta-graph.spec.ts` into an OS temporary directory, runs that single compiled test file, then deletes the temporary directory in a `finally` block.

From the repository root, run:

```sh
npm run test:m4-02 --workspace=@ca-meta/api
```

The repository's delivery profile is Node `>=24.15.0 <25` and npm `>=11.19.1 <12`; record the exact versions used with the result. The harness requires dependencies from the checked-in `package-lock.json` (`npm ci` when preparing a fresh disposable environment); it uses no database, Docker service, Meta host, app credential or customer fixture. Every provider response and credential is synthetic and in-process. There is no network client injected into the tests.

The harness TypeScript output is isolated outside the worktree and removed after success or failure. The route matrix fixtures cover exclusive-only WABA discovery and the separately typed Facebook `GET /me/accounts` Page discovery path. The latter fixes its projection, paginates all pages before invoking one vault-owned batch consumer, and returns only Page metadata plus opaque credential refs. Raw Page tokens never enter the generic collection result, errors, metrics or public DTOs. This command is the focused M4.02 acceptance gate; it includes the full API build so Nest module integration is covered once on the candidate SHA without running the broad API test suite.
