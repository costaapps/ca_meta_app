# M2.06 Docker image smoke harness

Runs the web and API image builds and a focused container smoke test. It uses Docker Engine, PowerShell 7, and the repository lockfile. Node/npm on the host are not required. Docker pulls only the digest-pinned Node and unprivileged NGINX bases from Amazon ECR Public; the script never publishes an image or contacts Docker Hub.

From the repository root, run:

```powershell
pwsh -NoProfile -File tools/m2-06/run-container-smoke.ps1
```

The script runs these equivalent image builds with unique temporary tags and `OCI_REVISION` set from `git rev-parse HEAD`:

```powershell
$revision = git rev-parse HEAD
docker build --file infra/docker/web.Dockerfile --build-arg OCI_VERSION=0.0.0-m2-06 --build-arg "OCI_REVISION=$revision" --tag local/ca-meta-web:m2-06 .
docker build --file infra/docker/api.Dockerfile --build-arg OCI_VERSION=0.0.0-m2-06 --build-arg "OCI_REVISION=$revision" --tag local/ca-meta-api:m2-06 .
docker image inspect --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{json .Config.ExposedPorts}}' local/ca-meta-web:m2-06
docker image inspect --format '{{.Config.User}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{json .Config.ExposedPorts}}' local/ca-meta-api:m2-06
docker history --no-trunc local/ca-meta-web:m2-06
docker history --no-trunc local/ca-meta-api:m2-06
```

The script requires a clean Git worktree so the OCI revision labels identify the exact tested commit. It builds uniquely tagged images, creates one UUID-named network, then starts the API and web with read-only roots, a `/tmp` tmpfs, all Linux capabilities dropped, and `no-new-privileges`. Synthetic database settings allow the API to start; its liveness route is intentionally lazy and does not connect to a database. The worker has no registered handlers yet and therefore sleeps without claiming jobs or connecting to the database.

Assertions cover:

- `/setup`, `/channels`, `/templates`, and `/setup/callback` after direct navigation/refresh;
- uncached `index.html` and runtime config, immutable hashed bundles, and no public source maps or PHP tree;
- `/api/health` and `/api/v1/health` proxy to API liveness without routing the paths through the SPA; oversized API bodies receive 413;
- runtime config exposes only the versioned same-origin API path;
- non-root image users, read-only rootfs at runtime, OCI version/revision labels, and no database/Meta secret keys in image environment or web bundle;
- API and worker process exit after Docker sends SIGTERM.

The script removes only its own named containers, UUID network, and temporary image tags. It does not create volumes, inspect or stop other projects, run global prune, contact Meta, or use production/staging data. The smoke does not prove live database readiness, provider permissions, or external callback routing; those remain distinct M2 gates.

The API image's healthcheck targets HTTP liveness. A Compose worker service using the same image must disable that HTTP healthcheck because its command does not listen on a port; its process lifecycle is verified by the SIGTERM smoke instead.
