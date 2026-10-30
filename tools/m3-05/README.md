# M3.05 focused validation harness

This harness compiles the API sources with only the M3.02 pre-auth and M3.05 embed/status tests, typechecks the Angular application, and runs the focused web config/embed tests. It uses the repository lockfile and adds no dependencies. No database, Docker service, Meta credential, Suite4 issuer, or provider call is used.

Requirements: Node `24.x` and npm `11.x` as pinned in the root `package.json`.

From a clean checkout:

```powershell
npm ci
npm run m3-05:validate
```

On Windows hosts that keep the supported Node runtime outside `PATH`, select it before running the commands:

```powershell
$env:PATH = "C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2;$env:PATH"
npm ci
npm run m3-05:validate
```

The API compiler output is placed under a uniquely named temporary directory within `apps/api` and removed by the harness in its `finally` cleanup. The harness fails before running checks when the Node major version or local dependencies do not match the requirements.
