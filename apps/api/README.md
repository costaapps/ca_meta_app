# Nest API workspace

The API is an independent NestJS 12 application. It has no Meta integration, identity/session
flow, business module, migration, or startup database side effect. /health is process liveness;
/ready checks only the essential MariaDB connection. Success returns { "status": "ok" }.
Dependency failure returns HTTP 503 with the canonical OpenAPI Unavailable ErrorEnvelope.
Business routes use /api/v1 and are denied by the global guard unless a route is explicitly
marked public. The only production public routes in this package are the two OpenAPI health routes.

## Toolchain and commands

Use Node 24.22.2 and npm 11.19.1, matching ADR-001 and the M1.04 Nest toolchain. The root npm
lockfile contains the API dependencies while Angular retains its separate TypeScript 5.9 toolchain.

From the repository root:

    npm run build:api
    npm run typecheck:api
    npm run test:api

The test command builds with Nest CLI, compiles strict TypeScript tests and runs Node's built-in
test runner. Tests use fake database-readiness and logging adapters; they do not require MariaDB
or call Meta. Request timing and readiness cache time use the injected monotonic clock; tests use
a deterministic fake.

## Required runtime configuration

Startup requires every field below. There are no DB credentials, host, port, environment, proxy,
or allowed-host defaults, and .env files are not loaded implicitly. Configuration failures log
only invalid or missing field names.

| Variable | Validation |
|---|---|
| NODE_ENV | development, test, staging, or production |
| API_PORT | Explicit TCP port 1–65535; 0 only for development/test ephemeral binding |
| API_BIND_ADDRESS | Explicit IPv4 or IPv6 address; tests must bind loopback |
| API_ALLOWED_HOSTS | Required comma-separated exact DNS host/IP allowlist; no wildcard or port |
| API_TRUSTED_PROXIES | none or a comma-separated list of specific IP/CIDR values |
| API_PLATFORM_IDENTITY_ADMIN_IDENTITIES_JSON | Optional JSON array of exact `{ "issuer", "subject" }` pairs; empty/unset denies platform identity administration |
| API_DATABASE_HOST | Explicit host/IP; tests accept only 127.0.0.1 or ::1 |
| API_DATABASE_PORT | Explicit TCP port 1–65535 |
| API_DATABASE_NAME | 1–64 letters, digits, or underscores |
| API_DATABASE_USER | 1–64 letters, digits, or underscores |
| API_DATABASE_PASSWORD | Non-blank; valid leading/trailing whitespace is preserved and never logged |
| API_DATABASE_CONNECT_TIMEOUT_MS | 100–5000 milliseconds |

API_ALLOWED_HOSTS is fail-closed in every environment: list only exact hosts assigned to that
environment. An incoming Host may include its request port; the middleware compares the parsed
host against the explicit allowlist. Configure no placeholder production domain. Example used by
local tests and harnesses only: 127.0.0.1,localhost.

API_TRUSTED_PROXIES=none disables Express proxy trust. Wildcard ranges such as 0.0.0.0/0,
::/0, expanded unspecified IPv6, and IPv4-mapped IPv6 ranges covering all IPv4 are rejected.
Configure only specific ingress addresses controlled by the deployment operator.

M3.01 exposes identity provisioning only as an internal service, with no public controller. Creating
the first tenant requires a session assertion verified by a trusted server adapter and an exact pair
in `API_PLATFORM_IDENTITY_ADMIN_IDENTITIES_JSON`; an empty setting fails closed. Tenant membership
changes require a current verified portal session and live owner/admin membership. The initial
operator identity, trusted issuer, and production configuration procedure are **Not confirmed**. Bootstrap writes the opaque legacy `IdDatabase + IdCompany + environment` mapping with the tenant and owner membership in one transaction; production ownership/authorization for that mapping is **Not confirmed**.

Requests accept X-Request-Id only when it is a UUID v4; otherwise the server generates one.
Every response returns X-Request-Id; error responses also return the canonical OpenAPI error
envelope. A readiness 503 body is exactly:

    {
      "code": "DEPENDENCY_UNAVAILABLE",
      "safeMessage": "The operation could not be confirmed yet.",
      "requestId": "<response X-Request-Id>",
      "retryable": true,
      "action": "CHECK_STATUS"
    }

Logs contain request ID, route template, method, status and duration, but never headers, request
bodies, query strings, database details or exception messages.

## Readiness bounds and shutdown

MariaDB connect uses the configured API_DATABASE_CONNECT_TIMEOUT_MS. The subsequent ping has
the same cancelable deadline and destroys its connection if it expires. A check therefore has a
bounded connection plus ping budget of at most approximately twice that configured value.
Concurrent /ready requests share one database check; its result is cached for 250 ms on the
monotonic clock so public bursts cannot create a connection per request. The cache applies to
both available and unavailable results.

JSON and form bodies are limited to 65,536 bytes. DTO validation rejects unknown fields. HTTP
headers, request, keep-alive timeouts are fixed in the bootstrap. On SIGTERM or SIGINT, the API
stops admitting requests, returns a safe 503 envelope to new requests while draining, waits for
both response transport and handler work to settle, then closes the listener. A client disconnect
or an already-finished response does not release a still-running handler. GracefulExpressAdapter
uses server.close() without destroying open sockets.

Promise handlers settle when their Promise resolves or rejects, including after a client disconnect.
Observable handlers remain leased if their `complete` or `error` is emitted after the request signal
aborts; this includes `takeUntil(signal)` completion. They must use
`getRequestWorkContext(request).signal` to cancel and clean up, then call
`acknowledgeCancellation()` only after cleanup finishes. The method returns false before the signal
is aborted. RxJS `unsubscribe` and `finalize` are not cleanup acknowledgements.

The interceptor classifies handlers from `design:returntype` metadata on the controller prototype:
Observable return types require the post-cleanup acknowledgement after abort; Promise and synchronous
types such as the `/health` `Object` return settle normally. Handlers with no return-type metadata
fail closed and require acknowledgement after abort. Use `@RequireCancellationAcknowledgement()`
for `Promise<Observable<...>>`, type-only/erased Observable returns, or any dynamic handler that may
resolve to an Observable. The method decorator is exported from
`src/common/http/request-drain.interceptor.js`.

If a handler keeps running, shutdown waits and emits an `api.shutdown_waiting` warning with the
number of active handlers every 30 seconds. The warning timer is referenced so the process stays
alive until the handler settles or acknowledges cleanup.

The in-memory close test runs on the host OS. POSIX SIGTERM subprocess cases run in an isolated Linux
container. Windows skips those cases; the Linux runner executes them without skips, including
client abort plus `takeUntil(signal)` and delayed cleanup acknowledgement.

Run the isolated Linux signal-drain suite from PowerShell:

    .\tools\m2-02\run-sigterm-drain-linux.ps1

An optional `-TestName` parameter selects a literal test-name fragment, for example:

    .\tools\m2-02\run-sigterm-drain-linux.ps1 -TestName 'Observable takeUntil completion'

The runner pins the Node 24.22.2 bookworm image digest recorded by M1.04, creates two UUID-named
Docker dependency volumes, runs npm ci in a network-enabled container, then runs tests in a separate
`--network none` container. Its finally block removes only those two volume names. This provides
subprocess/SIGTERM evidence on Linux without changing the host's node_modules.

## MariaDB readiness integration harness

The integration harness uses one uniquely named Compose project, a MariaDB 11.8.8 image pinned to
the M1.04 digest, synthetic per-run database credentials, and a local ephemeral host port. It
creates no schema or migration. The script checks /ready while the database is up, stopped, and
restarted. On outage it validates the exact canonical 503 ErrorEnvelope; /health remains 200.
It preserves the unrelated stopped db-migrations-mariadb-1 container.

Build first, then run from the repository root in PowerShell 7:

    npm run build:api
    .\tools\m2-02\run-mariadb-readiness.ps1

The script uses the explicit Node 24.22.2 runtime path from the M2 Desktop environment. Before
starting MariaDB, it boots the API once with invalid configuration and confirms that the process
exits while naming API_PORT without printing a synthetic password marker. It sets the local-only
Host allowlist explicitly. It then generates a UUID Compose project name and does cleanup only
with docker compose --project-name <that UUID> down --volumes --remove-orphans; it removes its
own temporary log directory after verifying that the path is under the system temporary directory
and carries that run's UUID. On successful readiness checks it sends a graceful signal and waits
for process exit; forced termination is only a failure-cleanup fallback. If execution is
interrupted before finally, use the printed run ID with the same Compose file to clean only that
project. Never substitute a shared or fixed Compose project name.

On failure, the script prints the UUID-scoped temporary log path and preserves its sanitized API
stdout/stderr logs for diagnosis. Verify that exact path is beneath the system temporary directory
and matches the printed UUID before deleting any retained files.

Expected result:

    M2.02 MariaDB readiness PASS: initial HTTP 200; outage HTTP 503 with canonical Unavailable ErrorEnvelope; /health 200 while DB was stopped; recovered HTTP 200.

The harness proves local connectivity and sanitized readiness behavior against the pinned MariaDB
image only. It does not prove deployment topology, production credentials, migrations, provider
health, or Meta access.
