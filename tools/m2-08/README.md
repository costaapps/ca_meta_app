# M2.08 CI and security checks

This package adds the candidate CI and its local, reproducible entry points. It does not publish images, deploy, call Meta, or require production secrets. CI uses `pull_request`, `push`, and manual dispatch with `contents: read`; it does not use `pull_request_target`. No repository secret is referenced. Fork PRs run with GitHub's read-only workflow token and cannot publish or deploy.

## Toolchain and local checks

Use Node `24.22.2`, npm `11.19.1`, Python `3.10+`, PowerShell `7.3+`, and Docker Engine with Compose v2. CI pins Node and npm and caches npm metadata by `package-lock.json`. From the repository root:

```powershell
npm install --global npm@11.19.1
node --version
npm --version
npm ci --ignore-scripts
npm rebuild @pb33f/openapi-changes --workspace=@ca-meta/contracts
npm run lint
npm run typecheck
npm test -- --watch=false
npm run build
python -B tools/m1-10/check_governance.py
python -B -m unittest discover -s tools/m1-10 -p "test_*.py" -v
```

`npm run lint` includes the Angular boundary check, the API backend-only boundary check added here, and the existing OpenAPI lint. The API lint is a narrow architecture check, not a general-purpose ESLint/style rule set.

The contract suite includes `packages/contracts/test/fixtures/openapi-diff-breaking.yaml`; its breaking-change sensitivity test asserts that removing a public route fails. The canonical M1.07 compatibility workflow remains separately triggered when its OpenAPI sources change.

## Isolated MariaDB and image checks

Both database runners create a UUID-named Compose project, volume, generated passwords and temporary fixture files. They remove only their own project and files. MariaDB is the digest-pinned `11.8.8` service from the existing M2.03/M2.05 harnesses. On Windows, the runners use the approved Node runtime directory; on Linux/macOS they use `node` and `npm` from `PATH`, and both paths require the exact versions above.

```powershell
pwsh -NoLogo -NoProfile -File tools/m2-03/run-mariadb-tests.ps1
pwsh -NoLogo -NoProfile -File tools/m2-05/run-mariadb-tests.ps1
pwsh -NoLogo -NoProfile -File tools/m2-06/run-container-smoke.ps1
```

The M2.03 integration suite consumes `fixtures/tenant-isolation-negative.json`: a tenant-B read of tenant A's synthetic asset returns no row, and an asset from tenant B cannot reference tenant A's app configuration. The existing MariaDB test fails if either isolation assertion stops holding. No provider credentials or real tenant data are used.

CI calls the M2.06 smoke with `-KeepImages`. On full smoke success only, it exposes the two locally built tags to Trivy, scans each independently with Trivy `v0.76.1` for OS/library vulnerabilities, then removes those exact tags. The scan fails on any HIGH/CRITICAL finding. The image labels record the same source commit SHA; neither tag is pushed to a registry.

## Secret and dependency scans

```powershell
$env:M2_08_BASE_SHA = (git rev-parse HEAD^).Trim()
node tools/m2-08/scan-secrets.mjs
# Set this to a clean checkout of M2_08_BASE_SHA before the npm audit comparison.
# $env:M2_08_AUDIT_BASE = 'C:\temp\base-checkout'
node tools/m2-08/scan-npm-audit.mjs
node tools/m2-08/scan-licenses.mjs
```

`scan-secrets.mjs` downloads the official Gitleaks `8.30.0` binary for Windows x64 or Linux x64 and verifies its checked-in SHA-256 before running it. It first materializes a synthetic test marker in a unique temporary directory and requires the scanner to detect it. It then scans the commit diff from `M2_08_BASE_SHA` to `HEAD`; by default it uses the preceding commit. The scan is redacted, the emitted report retains only rule/path/line/commit metadata, and the temporary directory is removed. It scans commit diffs rather than arbitrary untracked files and does not read local `backend/connect.php` or `backend/connect_old.php`.

For an npm audit comparison, set `M2_08_AUDIT_BASE` to a checkout of the chosen base SHA before running the script. CI checks out the PR target or push predecessor in `audit-base`; `workflow_dispatch` uses the repository's configured default branch and records its resolved SHA. Both full and `--omit=dev` reports cover the root workspaces and isolated M1.07 contract toolchain, mapped per package, install path, advisory and severity. New package/advisory/path/scope pairs and severity escalations fail the check. Findings already present in the comparison base remain visible in the report; they are not allowlisted or discarded. The local audit script refuses an empty comparison base unless `M2_08_ALLOW_EMPTY_AUDIT_BASE=1` is explicitly set for a new-project bootstrap.

The historical report on 2026-10-28 counted 47 npm advisories (4 critical, 31 high, 11 moderate, 1 low). This dated count is context, not an identity-level baseline or a whitelist. The branch-relative comparison establishes which advisories were added by the candidate; the current inventory still shows every finding and labels it `runtime-or-mixed` or `dev-only`. npm audit does not establish exploitability or reachability.

The license scan records each lockfile package, license metadata, path, and runtime/dev class. The repository's legal license policy is not confirmed, so this inventory is informational and does not claim to approve unknown or unreviewed licenses. It reads npm lockfile metadata only; it does not inspect license texts. A license policy decision is required before turning those entries into a legal allow/deny gate.

The local security reports are written under `artifacts/security/`, ignored by Git. Set `M2_08_REPORT_DIRECTORY` to another writable folder to keep them elsewhere. The automated workflow uploads only sanitized summaries and vulnerability/package inventories for 14 days; it never uploads raw scanner payloads, dependency tarballs, application logs, or credentials.

## Checks and branch protection

The workflow defines stable checks named `desktop-candidate`, `m2-08-mariadb`, `m2-08-security`, and `m2-08-images`. The existing `m1-07-contract` check is conditional on its contract paths. A check appearing in Actions only proves that the workflow ran; it does **not** prove that GitHub branch protection or a ruleset requires it.

Repository administrators should inspect Settings → Rules → Rulesets / Branch protection and explicitly require the intended checks on `develop` and `main` (if `main` is used), with the protected branch names matched to actual repository practice. For milestone branches, apply the same required checks if they are intended to be protected. Verify the exact check names from a completed run before selecting them. This package does not read or change branch protection, and no protection is claimed as enabled by this change.

## Reports and retention

CI uploads `artifacts/security/` even after a failing scan when any report exists. The `m2-08-security-<commit>` and `m2-08-images-<commit>` artifacts have a 14-day retention. The secret report omits matched content and tokens; the npm report includes only advisory metadata, package names/paths and version ranges; the Trivy run scans vulnerabilities only and does not enable image secret/config scanning. Workflow logs suppress scanner payloads. Actions log retention is controlled by the repository/organization setting and cannot be set per workflow here; administrators should verify its current value alongside branch protection.
