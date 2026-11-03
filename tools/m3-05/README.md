# M3.05 focused validation harness

This harness compiles the API sources with the M3.02 pre-auth and M3.05 embed/status tests, plus focused M3.04 session-cookie and migration-unit coverage. The normal mode also checks safe Nginx access/error logging, invokes the web entrypoint with synthetic valid and invalid origins, typechecks Angular, and runs focused web config/embed tests. The `--onboarding-only` mode runs just API compilation and the embed-config, status, persisted onboarding-state and migration tests. The Nginx regression test allows only `$uri` and `$status` in access logs and verifies that the provider callback location discards error-log lines that may contain callback queries. The entrypoint test writes its generated files under a unique temporary directory and removes only that directory. It uses the repository lockfile and adds no dependencies. No database, Docker service, Meta credential, Suite4 issuer, or provider call is used by local focused validation.

Requirements: Node `24.x` and npm `11.x` as pinned in the root `package.json`. On Windows, WSL `bash.exe` is also required for the shell-level entrypoint regression test; Linux CI uses `/bin/sh` directly.

From a clean checkout:

```powershell
npm ci
npm run m3-05:validate
```

For the onboarding state boundary only, run `npm run m3-05:onboarding:validate`.

On Windows hosts that keep the supported Node runtime outside `PATH`, select it before running the commands:

```powershell
. 'C:\Users\user\AppData\Local\Codex\runtimes\m3-node24\use-node24.ps1'
npm ci
npm run m3-05:onboarding:validate
```

The API compiler output is placed under a uniquely named temporary directory within `apps/api` and removed by the harness in its `finally` cleanup. The harness fails before running checks when the Node major version or local dependencies do not match the requirements.
