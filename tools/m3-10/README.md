# M3.10 MariaDB retention fixture

`run-retention-tests.ps1` creates a unique Compose project, uses only synthetic credentials and fixtures, and tears down its own container, volume, network, and temporary files. It pins Node 24.22.2/npm 11.19.1 and MariaDB 11.8.8.

The harness compiles the API and test output, then `prepare-current-schema.mjs` deploys the current migration registry through v22 in the disposable `ca_meta_m203` schema. It deliberately starts with the migration account's schema grants only: v22 creates the coexistence-lock table and pauses before its trigger. The helper uses the generated root password to grant `DELETE` only on that exact table, resumes deployment, and verifies that the full migration ledger is applied before the retention fixtures run.

The helper rejects any database other than `ca_meta_m203`, any migration host other than loopback, and any account other than `ca_meta_migrator`. This schema and its credentials are local to the generated Compose project. This harness does not authorize or validate access to a production database.

Run from the repository root:

```powershell
pwsh -NoLogo -NoProfile -File tools/m3-10/run-retention-tests.ps1
```
