# M2.03 synthetic migration harness

The harness starts a fresh MariaDB 11.8.8 Compose project for each run. The project name, volume, credentials, generated init SQL, and loopback port are unique to the run. Cleanup targets only that project name. It does not inspect or stop any other Compose project, including the preserved `db-migrations-mariadb-1` container.

Prerequisites: Node 24.22.2, npm 11.19.1, Docker Engine, Docker Compose v2, and network access to the pinned MariaDB image on its first run. The PowerShell harness verifies those exact versions. It uses `%LOCALAPPDATA%\Codex\runtimes\node-v24.22.2` by default; set `M2_NODE_RUNTIME_DIR` to that runtime directory when it is elsewhere.

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File tools/m2-03/run-mariadb-tests.ps1
```

The script builds the API and test sources, creates separate least-privilege `ca_meta_api` and `ca_meta_migrator` users, runs unit and MariaDB integration checks, invokes the public `migrate:status` CLI, records sanitized evidence, and removes only its generated project and UUID volume in `finally`. It never writes credentials to the repository. Set `M2_03_KEEP_ENVIRONMENT=1` only when investigating locally; the script then prints the unique Compose project name and leaves that project/volume available for manual cleanup.

The migrator connection is configured only by `MIGRATION_DATABASE_*`. It must be different from `API_DATABASE_USER`; there is no fallback to runtime connection settings. The runtime account is tested for DML access and denied DDL. The migrator has database-scoped `SELECT`, `INSERT`, `UPDATE`, `CREATE`, `ALTER`, `INDEX`, and `REFERENCES` only, without global grants or `GRANT OPTION`. Migration connections force UTC and strict SQL mode; runtime write connections must use strict mode too so overlength string IDs fail instead of truncating.

Migration steps are individually journaled by checksum. DDL uses `CREATE TABLE IF NOT EXISTS` / explicit shape verification or a single additive `ALTER TABLE`. MariaDB implicitly commits DDL, so an interruption after DDL leaves `STARTED`; restart verifies the resulting schema and completes the step. Backfill updates and cursor advancement share an InnoDB transaction, allowing the next process to continue after a committed batch. The first additive name migration demonstrates expand, backfill, and validation. Switching consumers and contract/drop work are separate versioned changes and must wait until the minimum supported API baseline moves beyond N-1; this package deliberately keeps the old `display_name` column so both versions remain compatible.

The session `EXPLAIN` uses a test-only table derived from the accepted M1.05 session shape; M3 owns the persistent session schema. The local 11.8.8 fixture does not certify a deployed MariaDB version, production grants, backup/restore, online DDL duration, or production data shape. Those remain **Not confirmed**.
