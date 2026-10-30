# M2.07 Compose harness

This harness provides an isolated, repeatable Docker Compose environment smoke without relying on an existing developer database or production configuration. It requires Docker Engine, Docker Compose 2.23.0+ and PowerShell 7+ on the host. Node 24.22.2/npm 11.19.1 and API/web dependencies are installed inside a dev image using the repository lockfile. The local database is MariaDB 11.8.8 pinned by digest; the API migrates the local database through schema v8. The separate release lock contract continues to require schema-v3 API compatibility. No extra PowerShell module or host npm install is required.

From the repository root on Windows:

```powershell
pwsh -NoProfile -File tools/m2-07/run-compose-smoke.ps1
```

The script creates a UUID Compose project (`m207-...`), three synthetic random DB passwords in a temporary folder, a project-prefixed MariaDB data volume, and a loopback-only dev web port. It validates a synthetic production lock/model in memory, checks that no secret bytes appear in the rendered model, and confirms the prod model has no local DB or internal published ports. It builds the dev image before any service starts, so the app-specific dependency volumes are seeded from the image. The first `up` then starts the database as a migration dependency while checking that an unavailable shared DB endpoint prevents API/worker startup. The harness then waits for web/API healthchecks, verifies the worker remains running and emits `worker.started` (the worker intentionally has no HTTP healthcheck), checks liveness/readiness ingress and internal ports, seeds a schema-v1 synthetic queued job, verifies the local migration ledger reaches v8, forces API/worker recreation, and restarts the isolated DB. Jobs are durable rows in MariaDB; there is no broker container. It never contacts Meta, a managed database, staging, or production. It performs no Docker Hub login or publication; a cache miss may pull the pinned public MariaDB image. The production firewall is not tested.

Web and API source bind mounts use app-specific child volumes for `/workspace/apps/web/node_modules` and `/workspace/apps/api/node_modules`, seeded from the dev image. After changing `package-lock.json`, stop the stack, rebuild the image, then remove only `<project>_dev_api_node_modules` and `<project>_dev_web_node_modules` before restarting; keep `<project>_dev_mariadb_data`. See the [Compose runbook](../../docs/runbooks/compose-environments.md) for the scoped commands.

API, worker, and migration share the project-scoped `dev_api_dist` volume. The migration uses `infra/dev/build-api.sh` and `apps/api/nest-cli.dev.json`: the script verifies that `dist` is the dedicated mount, removes only its children, and disables Nest's directory-removal behavior before compiling. The API watcher uses the same dev config without clearing the volume, so it and the worker consume the artifacts in that shared location.

Cleanup removes only the UUID project created by this process, including its named volumes, the unique image tag still pointing to the image ID it built, and the exact temporary directory created for this run. The script verifies the directory still matches its generated UUID path beneath the OS temp root before recursive deletion. `down --volumes --remove-orphans` appears only in this test cleanup. Use `-KeepEnvironment` to retain one identified harness stack and image; the script prints its project and cleanup command. Do not pass any production environment file to this script.

`infra/release-lock.env.example` is a template because M2.09 has not yet published image digests/provenance. A filled lock must pass this checker before production/staging promotion:

```powershell
pwsh -NoProfile -File tools/m2-07/check-release-lock.ps1 -Path C:\secure\ca-meta\release-lock.env
```

The checker requires separate digest-pinned web/API images, source SHA matching both image provenance fields, and a compatibility range containing schema v3. It checks lock structure and declared metadata; it cannot authenticate registry signatures/provenance, perform a pull, validate DNS/firewall/TLS, or prove a production restore. Read the operational steps in [the Compose environment runbook](../../docs/runbooks/compose-environments.md).

This subtask does not execute the harness. The coordinator runs the executable harness and records its command, result, environment and candidate SHA once after all M2 package edits are stable.

Compose behavior follows the official [startup-order](https://docs.docker.com/compose/how-tos/startup-order/), [secrets](https://docs.docker.com/reference/compose-file/secrets/), [service](https://docs.docker.com/reference/compose-file/services/), and [`config`](https://docs.docker.com/reference/cli/docker/compose/config/) references.
