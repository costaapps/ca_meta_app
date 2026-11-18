# M6.04 operations runbook

These procedures are proposed for the SRE/operations and Meta integration functions. No individual owner, staging alert receiver, paging channel, or retention policy is assigned/confirmed. Configure authorized receivers outside this repository. Alert silences must include an incident/change reference, reason and owner, and an expiry no later than two hours; renew only after review.

## API errors {#api-errors}

1. Start from `CaMetaApiServerErrorRateHigh`; split by `route_group` and `outcome` in the service dashboard.
2. Search structured logs using `requestId` or the generated `correlationId`. The middleware ignores client-supplied correlation values.
3. For `dependency_failure`, check the relevant dependency health and retry state. For `internal_failure`, inspect the safe `errorType`, status and release SHA.
4. Preserve only redacted logs and timestamps in the incident record. Never attach request payloads, cookies, authorization headers or credentials.

## Meta Graph failure {#meta-graph-failure}

1. Split `ca_meta_graph_calls_total` by `product`, `operation`, `outcome` and `category`.
2. Search logs for the same trusted `correlationId`; one bounded event records the product/operation/environment/outcome/category. Metrics never carry correlation IDs or asset/provider identifiers.
3. `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`, `TRANSIENT_PROVIDER_FAILURE`, `RATE_LIMITED`, `PERMISSION_REQUIRED` and `CREDENTIAL_REJECTED` indicate provider/grant investigation; `CONFIGURATION_UNAVAILABLE`, `CAPABILITY_DISABLED`, `CREDENTIAL_UNAVAILABLE`, `BUSY` and request/response validation categories need internal investigation. Confirm classification against the operation's safe result; category alone is not proof of a Meta incident.
4. Use tenant-authorized diagnostics for asset-specific drilldown. Do not query or share another tenant's data to investigate a global alert.

## Webhook ingress {#webhook-ingress}

1. Check `accepted`, `signature_rejected`, `payload_rejected`, `configuration_unavailable`, `ingress_failure`, duplicate and quarantined counters.
2. Accepted means the durable inbox write completed before ACK. Investigate database availability and ingress latency when the 3-second alert fires.
3. Never log, export or paste the raw webhook body, signature, verification token, app secret, message, phone or provider IDs. Signature rejection does not authorize bypassing verification.
4. Quarantined/duplicate numbers are aggregate counts only. Use the authorized tenant/event workflow for item-level investigation.

## Expected webhook silence {#expected-webhook-silence}

The inactivity rule is disabled by default (`API_OBSERVABILITY_EXPECTED_WEBHOOK_INTERVAL_SECONDS=0`). Set a non-zero interval only after the owning operator documents an authorized staging or production expectation for the relevant environment and channel. The current metric is process-local and resets on restart; it waits three expected intervals after process start before evaluating first activity. A trigger means the agreed activity was not observed; it does not prove Meta delivery failure. Check authorized callback configuration and permitted synthetic health checks, then record external evidence. Staging/Meta evidence is Not confirmed.

## Unavailable signal sources {#unavailable-signal-sources}

`credential_health`, `subscription_drift`, `queue_backlog`, `dead_letter` and `projection_lag` currently report source availability `0` (unknown/unavailable), not an empty/healthy state. Existing operations diagnostics are per-tenant and require authorization; projection lag is explicitly unavailable. Do not scrape or aggregate those records globally. Keep related flow activation/rollout gated, investigate whether a policy-approved aggregate adapter exists, and link the finding to a reviewed implementation before changing the availability signal.

## Alert routing and exercise

Prometheus rules are versioned under `tools/m6-04/alerts`. Route `warning` to the authorized operations receiver and `info` to a non-paging operational coverage view. Receiver, channel, escalation schedule and human assignee are Not confirmed. Exercise a synthetic API failure, Meta Graph category result and webhook rejection in local test; staging delivery, end-to-end trace, recipient receipt and silence TTL behavior require the authorized staging Alertmanager/receiver and remain Not confirmed. Do not use a production Meta call or send a real message as a synthetic incident.

## SLO proposals

See [M6.04 acceptance report](../../../docs/delivery/M6/M6.04.md) for numerator, denominator, rolling window, exclusions, proposed role owner and ratification gates. Proposed initial values are not ratified SLAs.
