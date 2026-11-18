# M6.02 local security validation

This package runs a focused adversarial selection of the existing API security suites plus a narrow static boundary check for GitHub Actions and runtime containers. It uses only synthetic identities, tenant IDs, credentials, and payloads. It does not call Meta, contact production, perform a penetration test, or certify a staging environment.

## Requirements

- Node `24.15` through `<25`; repository pin `.nvmrc` is `24.22.2`.
- npm `11.19.1` through `<12`.
- Workspace dependencies installed from the root lockfile. In a clean checkout, run `npm ci --ignore-scripts` once at repository root.

On Windows PowerShell, if the pinned runtime is not on `PATH`:

```powershell
$env:PATH = 'C:\Users\user\AppData\Local\ca-meta-runtimes\node-v24.22.2-win-x64;' + $env:PATH
node --version
npm --version
```

## Run

From repository root:

```powershell
node tools/m6-02/run-security-validation.mjs
```

The runner compiles the API source and TypeScript test sources once, then selects only the tenant/identity, OAuth exchange, sessions, credential vault/resolver/lifecycle, privacy/redaction, webhook, notification, internal-operation, diagnostics, and HTTP-boundary suites. It then checks workflow action pinning/permissions and final Docker runtime users/ports. Test output is created under a unique `apps/api/.test-runs/m6-02-*` directory and only that exact validated directory is removed.

The existing M2.08 security/dependency workflows remain responsible for diff-based secret scanning, package vulnerability comparison, image scanning, and broader CI controls. This M6 runner does not alter those gates or treat this local selection as a substitute for them.
