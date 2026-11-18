# M6.04 observability package

## Local setup and focused validation

Requirements: repository-pinned Node `24.22.2` and npm `11.19.1`.

No runtime or test dependency was added; `package-lock.json` remains the pinned workspace dependency source and is unchanged.

```powershell
npm ci --ignore-scripts
node tools/m6-04/run-focused-api-test.mjs
npm run build --workspace=@ca-meta/api
```

Install once per worktree. The harness compiles the API test project into an isolated, process-specific folder under `apps/api/.test-runs`, runs only `test/m6-04-observability.spec.js`, then removes that folder after verifying it is within its private output root. API build output goes to the existing ignored `apps/api/dist`. No database, Docker service, Meta account, receiver or new package dependency is required by the focused scenario. To clean ignored local artifacts after verification: `Remove-Item -LiteralPath apps/api/dist -Recurse -Force` and `Remove-Item -LiteralPath apps/api/.test-runs -Recurse -Force` (verify the resolved paths first if adapting this command outside the repo worktree).

## Runtime configuration

| Variable | Default | Meaning |
|---|---:|---|
| `API_OBSERVABILITY_METRICS_TOKEN` | unset | Optional internal scrape bearer token; when absent, `/internal/metrics` responds 404. When present, use a random secret with at least 32 non-whitespace characters and store it in the deployment secret manager. |
| `API_OBSERVABILITY_EXPECTED_WEBHOOK_INTERVAL_SECONDS` | `0` | Explicit expected activity interval. Zero disables webhook-silence alerting; use a non-zero value only after an environment/channel baseline is authorized and documented. Valid range: 0 to 2,592,000 seconds. |

Scrape `GET /internal/metrics` from an authorized private network over TLS with `Authorization: Bearer …`. The application performs token authentication but does not implement an IP allowlist. Configure scrape cadence, network policy and retention in the deployment platform. Do not expose the metrics route to public ingress.

## Versioned operations assets

- `dashboards/service.json`: API/service request, Meta Graph, webhook latency and source availability.
- `dashboards/flows.json`: Facebook, Instagram, WhatsApp exclusive and Coexistence outcomes.
- `dashboards/migration.json`: aggregate source coverage and migration evidence boundary.
- `alerts/prometheus-rules.yml`: rules with thresholds, durations, proposed functional role, and runbook reference.
- `runbooks/operations.md`: response, safe drilldown, authorized routing, silence expiry and gaps.

Metric names are a local exporter contract, not proof that Grafana/Prometheus/Alertmanager are installed or wired. Replace `${DS_PROMETHEUS}` with the authorized datasource on import. A target with no data means unobserved; do not treat it as healthy. `lastVerifiedAt` for staging/Meta remains an external release record and is Not confirmed here.
