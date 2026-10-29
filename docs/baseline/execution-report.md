# M1.01 baseline execution report

## Source and environment

- Source baseline: `develop@733e4a6dcccc93ee58a24958ed9830bfcc878e62`.
- Baseline command window: 2026-10-28 21:34–21:36 America/Sao_Paulo (UTC−03:00).
- Corrected harness/artifact validation: 2026-10-28 21:48 America/Sao_Paulo (UTC−03:00; minute precision).
- Isolation: Codex worktree `C:\Users\user\.codex\worktrees\m1-01\ca_meta_app`, branch `desktop/m1-01`.
- Host: Windows 10 x64; Node `v22.17.0`; npm `10.9.2`; Python `3.13.7`; PHP CLI `8.3.30`.
- Project lockfile selected Angular `21.0.8`, Angular CLI `21.0.5`, TypeScript `5.9.3`, RxJS `7.8.2`, Vitest `4.0.16`.

The Angular baseline ran before the M1.01 documents and harness were added, so those results refer to the untouched source tree at the base SHA. The PHP syntax check was run by the coordinator on the same baseline SHA. The source-trace harness ran after its own files and matrix had been added in the isolated worktree; the coordinator must repeat the aggregate checks on the committed candidate SHA.

## Commands and observed results

| Command | Result |
|---|---|
| `npx ng version` | Passed; duration not captured. Detected Angular 21.0.8 and CLI 21.0.5 on Windows x64; Node 22.17.0; npm 10.9.2; TypeScript 5.9.3; RxJS 7.8.2; Vitest 4.0.16. |
| `npm ci` | Passed in npm-reported 1 minute. Added 505 packages and audited 506. Reported 46 vulnerabilities: 1 low, 11 moderate, 30 high, 4 critical. No automatic audit fix was run. |
| `npm run build` | Passed in 11.79 s. Angular production bundle generation completed successfully. |
| `npm test -- --watch=false` | Passed in 9.77 s. 2 test files; 5 tests. |
| `php -l backend/connect_whatsapp.php` | Passed (PHP 8.3.30; same base SHA); duration not captured. Syntax only. |
| `php -l backend/connect_facebook.php` | Passed (PHP 8.3.30; same base SHA); duration not captured. Syntax only. |
| `php -l backend/connect_instagram.php` | Passed (PHP 8.3.30; same base SHA); duration not captured. Syntax only. |
| `php -l backend/meta_auth_helper.php` | Passed (PHP 8.3.30; same base SHA); duration not captured. Syntax only. |
| `python -m py_compile tools/baseline/trace_versioned_routes.py` | Corrected harness passed in a measured rerun (0.28 s). |
| `python tools/baseline/trace_versioned_routes.py` | Passed on the corrected fixture in a measured rerun (0.25 s). 20 PHP functions; 8 GET/POST WhatsApp selectors plus 1 OPTIONS preflight (9 router branches total); 9 Angular route declarations; 12 synthetic route cases. The OPTIONS case asserts source status 200. The WhatsApp direct-file input matched no selector and reached the source default 404 branch. |

The npm vulnerability count is the result of this exact installation; historical documentation recorded 47 for an older run. Neither count alone proves exploitability. Package/security triage is outside M1.01.

The artifact hygiene check directly read the seven M1.01 deliverable files listed below. It verified non-empty files, no trailing whitespace, 53 CSV data rows with 10 fields each, valid JSON with 12 fixture cases, and absence of two narrow credential patterns (Meta token-like `EAAG...` prefixes and hard-coded `client_secret` assignments). This check covers only those named files; it is not a repository-wide secret scan and does not use `git diff --check` as evidence about untracked files.

## Trace boundary

The harness and JSON fixture use only local versioned source and synthetic identifiers. No production HTTP request, PHP endpoint, database, Graph API call, OAuth exchange, subscription, or message send occurred. “No matching selector/default 404” is the source router's branch for the synthetic unchanged path. `scope-decisions.md` records the operator report of a shared Hostinger rewrite of missing paths to `connect.php`; the report is not verified here. The deployed rewrite and actual incoming URI are **Not confirmed**.

## Artifact set and current status

- `docs/baseline/inventory.md`
- `docs/baseline/endpoint-matrix.csv`
- `docs/baseline/parity-matrix.md`
- `docs/baseline/fixtures/routes.json`
- `docs/baseline/README.md`
- `docs/baseline/execution-report.md`
- `tools/baseline/trace_versioned_routes.py`

The artifacts were uncommitted when this report was first drafted and are now committed in the M1.01 package candidate. This report records the tested base revision and trace results but intentionally omits its own final commit SHA. The coordinator records the current candidate SHA, exact-candidate checks, and reviews in `docs/delivery/M1/progress.md` and the package PR.
