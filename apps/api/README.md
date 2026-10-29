# Nest API workspace

The API is an independent NestJS 12 application. It has no Meta integration, identity/session
flow, business module, migration, or startup database side effect. `/health` is process liveness;
`/ready` probes only the essential MariaDB connection and returns a minimal status. Business
routes use `/api/v1` and are denied by the global guard unless a route is explicitly marked
public. The only production public routes in this package are the two OpenAPI health routes.

## Toolchain and commands

Use Node 24.22.2 and npm 11.19.1, matching ADR-001 and the M1.04 Nest toolchain. The root npm
lockfile contains the API dependencies while Angular retains its separate TypeScript 5.9 toolchain.

From the repository root:

```powershell
npm run build:api
npm run typecheck:api
npm run test:api
```

The test command builds with Nest CLI, compiles strict TypeScript tests and runs Node's built-in
test runner. Tests use fake database-readiness and logging adapters; they do not require MariaDB
or call Meta. Request timing uses an injected monotonic clock; tests use a deterministic fake.

## Required runtime configuration

Startup requires every field below. There are no DB credentials, host, port, environment, or proxy
defaults, and `.env` files are not loaded implicitly. Configuration failures log only invalid or
missing field names.

| Variable | Validation |
|---|---|
| `NODE_ENV` | `development`, `test`, `staging`, or `production` |
| `API_PORT` | Explicit TCP port 1–65535; `0` only for development/test ephemeral binding |
| `API_BIND_ADDRESS` | Explicit IPv4 or IPv6 address; tests must bind loopback |
| `API_TRUSTED_PROXIES` | `none` or a comma-separated list of IP/CIDR values |
| `API_DATABASE_HOST` | Explicit host/IP; tests accept only `127.0.0.1` or `::1` |
| `API_DATABASE_PORT` | Explicit TCP port 1–65535 |
| `API_DATABASE_NAME` | 1–64 letters, digits, or underscores |
| `API_DATABASE_USER` | 1–64 letters, digits, or underscores |
| `API_DATABASE_PASSWORD` | Non-empty; never included in startup errors or logs |
| `API_DATABASE_CONNECT_TIMEOUT_MS` | 100–5000 milliseconds |

`API_TRUSTED_PROXIES=none` disables Express proxy trust. Configure only ingress addresses controlled
by the deployment operator. Requests accept `X-Request-Id` only when it is a UUID v4; otherwise the
server generates one. Every response returns `X-Request-Id`; error responses also return the
canonical OpenAPI error envelope body. Logs contain request ID, route template, method, status and
duration, but never headers, request bodies, query strings, database details or exception messages.

JSON and form bodies are limited to 65,536 bytes. DTO validation rejects unknown fields. HTTP
headers, request, keep-alive timeouts are fixed in the bootstrap; Node's HTTP server close waits
for in-flight requests and stops accepting new connections. The liveness handler never probes
MariaDB or Meta.

## MariaDB readiness integration harness

The integration harness uses one uniquely named Compose project, a MariaDB 11.8.8 image pinned to
the M1.04 digest, synthetic per-run database credentials, and a local ephemeral host port. It
creates no schema or migration. The script checks `/ready` while the database is up, stopped, and
restarted. It preserves the unrelated stopped `db-migrations-mariadb-1` container.

Build first, then run from the repository root in PowerShell 7:

```powershell
npm run build:api
.\tools\m2-02\run-mariadb-readiness.ps1
```

The script uses the explicit Node 24.22.2 runtime path from the M2 Desktop environment. Before
starting MariaDB, it boots the API once with invalid configuration and confirms that the process
exits while naming `API_PORT` without printing a synthetic password marker. It then generates a
UUID Compose project name and does cleanup only with `docker compose --project-name <that UUID>
down --volumes --remove-orphans`; it removes its own temporary log directory after verifying that
the path is under the system temporary directory and carries that run's UUID. If execution is
interrupted before `finally`, use the printed run ID with the same Compose file to clean only that
project. Never substitute a shared or fixed Compose project name.

On failure, the script prints the UUID-scoped temporary log path and preserves its sanitized API
stdout/stderr logs for diagnosis. Verify that exact path is beneath the system temporary directory
and matches the printed UUID before deleting any retained files.

Expected result:

```text
M2.02 MariaDB readiness PASS: /ready returned 200, 503, then 200.
```

The harness proves local connectivity and sanitized readiness behavior against the pinned MariaDB
image only. It does not prove deployment topology, production credentials, migrations, provider
health, or Meta access.
