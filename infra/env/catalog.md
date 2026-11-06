# Compose environment and secret catalog

The committed `*.example` files contain operational placeholders only. Copy the relevant example to a protected file outside the checkout, fill it for that environment, and pass it with `docker compose --env-file`. Never place production values in Git, command output, terminal transcripts, CI logs, or a public Compose config dump.

Compose secrets use host files referenced by path. They are mounted read-only under `/run/secrets`; the Compose model and container environment carry only the mount path, and the API/migration shell loads the bytes into the child process immediately before exec because the current application config contract accepts password environment variables. Use an external secret manager or a host-only file with access limited to the Docker operator and runtime. **Not confirmed:** a vault/KMS integration, host ownership/mode mapping for file-backed Compose secrets, or secret rotation automation.

| Variable / secret | Consumer | Source and rule |
|---|---|---|
| `CA_META_API_DB_PASSWORD_FILE` | Compose secret `api_database_password` | Host path to a protected runtime DB password file; mounted into API, worker, and dev DB initialization only. |
| `CA_META_MIGRATOR_DB_PASSWORD_FILE` | Compose secret `migration_database_password` | Host path to a separate protected migration-user password file; mounted only into migrate and dev DB initialization. |
| `CA_META_DEV_DB_ROOT_PASSWORD_FILE` | dev overlay | Host path to a disposable local MariaDB root password; dev/test only. |
| `NODE_ENV` | API, worker, migrate | One environment value shared by API/worker; `production`, `staging`, `development`, or `test`. |
| `API_PORT`, `API_BIND_ADDRESS` | API and worker | API listener settings. Worker receives the same validated domain config but runs no HTTP listener. |
| `API_TRUSTED_PROXIES` | API and worker | Explicitly trusted ingress CIDRs. Proxy CIDRs are **Not confirmed** until the target ingress is selected. |
| `API_PLATFORM_IDENTITY_ADMIN_IDENTITIES_JSON` | API and worker | Optional exact verified `(issuer, subject)` allowlist for platform identity administration; empty denies first-tenant provisioning. The real issuer and initial operator identity are **Not confirmed**. |
| `API_DATABASE_HOST`, `API_DATABASE_PORT`, `API_DATABASE_NAME` | API, worker, and migrate | The single DB endpoint is mapped to migration-client variable names inside Compose, preventing host/port/database divergence. Runtime user has only `SELECT, INSERT, UPDATE, DELETE` on the application database. |
| `API_DATABASE_USER`, `MIGRATION_DATABASE_USER` | API/worker and migrate | Separate least-privilege accounts on the shared endpoint. Runtime has `SELECT, INSERT, UPDATE, DELETE`; migrator has database-scoped DDL/DML grants and never uses `root`. |
| `API_ALLOWED_HOSTS` | API, worker, and API readiness healthcheck | Exact comma-separated public host allowlist. The API container healthcheck sends the first trimmed host as its `Host` header. |
| `API_ALLOWED_ORIGINS` | API and worker | Exact scheme/host/port browser-origin allowlist. Wildcards and opaque `null` origins are rejected; authenticated writes require same-origin Fetch Metadata. |
| `API_SUITE4_EMBED_ORIGINS` | API | Optional exact HTTPS Suite4 parent-origin list; empty disables `SUITE4_EMBED` pre-auth. This is distinct from the portal/app `API_ALLOWED_ORIGINS` and is **Not confirmed** until Suite4 owners provide production origins. |
| `API_PORTAL_SESSION_RECOVERY_KEY` | API and worker | Protected random key of at least 32 bytes used only to recover a lost exchange response for the same pre-auth browser binding. Keep stable across API replicas; rotate only under a reviewed session-recovery plan. |
| `API_PORTAL_SESSION_IDLE_TIMEOUT_SECONDS` | API and worker | Sliding idle timeout in seconds, defaults to the 30-minute proposal (`1800`); validated range 60 seconds–24 hours. This default is **Not confirmed** against Suite4/browser behavior. |
| `API_PORTAL_SESSION_ABSOLUTE_TIMEOUT_SECONDS` | API and worker | Absolute session lifetime in seconds, defaults to the 8-hour proposal (`28800`); validated range 5 minutes–30 days and must be at least the idle timeout. This default is **Not confirmed** against Suite4/browser behavior. |
| `API_PORTAL_ENTRY_TICKET_ISSUER`, `API_PORTAL_ENTRY_TICKET_AUDIENCE` | API and worker | Optional exact ticket issuer and audience; configure together with the public-key set or leave all three unset. The Suite4 values and trust contract are **Not confirmed**. |
| `API_PORTAL_ENTRY_TICKET_PUBLIC_KEYS_JSON` | API and worker | Optional static JSON map of unique `kid` values to RSA SPKI public PEM keys; public keys only, up to 20 overlapping keys. Never resolves token-provided URLs. |
| `API_PORTAL_ENTRY_TICKET_CLOCK_SKEW_SECONDS`, `API_PORTAL_ENTRY_TICKET_MAX_LIFETIME_SECONDS` | API and worker | Optional verifier bounds, default 5 seconds skew and 60 seconds maximum lifetime; range 0–5 and 1–60 seconds. |
| `MIGRATION_MIN_SUPPORTED_API_VERSION` | migrate | Migration runner compatibility floor; current migration definitions require `1`. This is distinct from release-lock schema bounds. |
| `WEB_PUBLISH_ADDRESS`, `WEB_PUBLISH_PORT` | web | Only host-published socket. Production defaults to all interfaces; the external firewall/TLS ingress is **Not confirmed**. Do not treat a loopback binding as a production security boundary. |
| `CA_META_WEB_IMAGE`, `CA_META_API_IMAGE` | prod overlay | Registry image references copied from one complete release lock and pinned as `repository@sha256:<64 hex>`. Exact registry namespace and published release digests are **Not confirmed** until M2.09. |
| `SOURCE_REVISION`, `SCHEMA_VERSION`, `SCHEMA_MIN_COMPATIBLE`, `SCHEMA_MAX_COMPATIBLE` | release lock | Commit SHA and schema bounds attached to the same image release. Current candidate is schema v3 and exact v3 compatibility; no v3 image digests are published by M2.07. |
| `WEB_PUBLIC_META_API_BASE_URL` | web | Public allowlisted same-origin path `/api` or `/api/v1`; contains no secret. |
| `WEB_SUITE4_EMBED_ORIGINS` | web | Public exact HTTPS Suite4 parent-origin list used both in embed message validation and Nginx `frame-ancestors`; empty emits `frame-ancestors 'none'`. It must match the API allowlist. |
| `WEB_PUBLIC_META_AUTHORIZATION_ORIGINS` | web | Public exact HTTPS origins allowed for server-provided provider authorization launch URLs; empty blocks popup launch. Actual provider origins/configuration are **Not confirmed**. |

For host-side secret files, provision a single random password per account, retain it in the approved secret store, and make the file readable by the Docker runtime without making it world-readable. File mode/ownership behavior varies by host and Compose implementation; confirm access in the target runtime before promotion. This work never generates or commits production passwords.
