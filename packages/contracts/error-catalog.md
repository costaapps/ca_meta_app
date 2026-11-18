# M1.07 — safe API error catalog

**Status:** proposed contract, not an implemented or deployed API. Every message below is synthetic and safe for a portal response. Provider bodies, access tokens, authorization codes, app secrets, cookies, ciphertext and private identifiers stay out of this envelope.

The wire shape is `ErrorEnvelope` in [`openapi.yaml`](openapi.yaml): stable `code`, `safeMessage`, `requestId`, `retryable`, and an allowlisted `action`. HTTP status and retry behavior are operation-specific; a retryable infrastructure error does not authorize repeating an external effect whose outcome is unknown. `Retry-After` is returned for rate limiting when applicable.

| Code | HTTP | Meaning exposed to caller | Action | Retry rule |
|---|---:|---|---|---|
| `AUTH_REQUIRED` | 401 | No usable portal session or one-time proof | `SIGN_IN` | Ticket-exchange response-loss recovery retries only the exact same ticket/JTI, challenge and pre-auth browser binding to return the same still-active session; changed bindings and expired/revoked state are denied. |
| `MEMBERSHIP_REVOKED` | 403 | Current membership is no longer active | `CONTACT_ADMIN` | No retry until current membership is confirmed. |
| `ACCESS_DENIED` | 403 | Current role/capability cannot perform this action | `CONTACT_ADMIN` | Do not retry without a new authorization decision. |
| `RESOURCE_NOT_AVAILABLE` | 404 | Resource is absent or unavailable in the current tenant | `REFRESH` | Same safe response for a foreign-tenant identifier and an absent resource. |
| `STATE_INVALID` | 422 | One-time callback, challenge or onboarding state cannot be used | `RESTART_ONBOARDING` | Do not replay a consumed state. |
| `ONBOARDING_EXPIRED` | 422 | Server-side onboarding window expired | `RESTART_ONBOARDING` | Create a new onboarding session. |
| `FLOW_UNAVAILABLE` | 422 | Flow is not enabled by server configuration | `CONTACT_ADMIN` | No retry until configuration changes. Actual provider availability is **Not confirmed**. |
| `FLOW_NOT_ELIGIBLE` | 422 | Fresh product-specific evidence says the configured flow is not eligible for this account | `CONTACT_ADMIN` | Use only when the server has current evidence; Meta flow eligibility remains **Not confirmed** until an authorized scenario proves it. |
| `ASSET_GRANT_MISSING` | 403 | Verified grant does not cover this asset/operation | `REAUTHORIZE` | Re-check current grant before retrying. |
| `ASSET_CONFLICT` | 409 | Asset identity or route conflicts with existing tenant-safe evidence | `RECONCILE` | Preserve quarantine; require explicit conflict resolution. |
| `META_PERMISSION_REQUIRED` | 422 | Required permission evidence is missing | `REAUTHORIZE` | Provider permission names and grants are **Not confirmed** by this contract. |
| `META_REAUTH_REQUIRED` | 422 | Current authorization needs a new user authorization step | `REAUTHORIZE` | Keep the old grant only while its current evidence remains valid. |
| `META_RATE_LIMITED` | 429 | Provider limit was observed and normalized | `WAIT` | Honor `Retry-After` and adapter bounds; never loop. Provider-specific limits are **Not confirmed**. |
| `SUBSCRIPTION_PENDING` | 409 | Required subscription is not verified yet | `CHECK_STATUS` | Poll/reconcile the server status; do not claim readiness. |
| `OUTCOME_UNKNOWN` | 409 or 503 | External side effect may have happened but confirmation is missing | `CHECK_STATUS` | **Not retryable.** Reconcile provider/local evidence first; never blind-retry a message send. |
| `VERSION_CONFLICT` | 412 | `If-Match` does not match the latest representation | `REFRESH` | Read the latest representation, review the change, then send a new update. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same tenant+operation key was already used with a different payload hash | `USE_NEW_REQUEST_KEY` | No effect is attempted. A new intentional request needs a new key. |
| `COEXISTENCE_SESSION_ACTIVE` | 409 | This tenant already has an active WhatsApp Coexistence onboarding session | `CHECK_STATUS` | Resolve the current session or wait for it to reach a terminal state before starting another number. |
| `CONTEXT_CHANGED` | 409 | Tenant context rotated since the request was prepared | `REFRESH` | Reload current session context and revalidate the UI selection. |
| `ORIGIN_NOT_ALLOWED` | 403 | Browser Origin/Fetch Metadata did not match configuration | `RELOAD_PORTAL` | Do not retry from an untrusted origin. |
| `HOST_NOT_ALLOWED` | 403 | Request Host is missing, malformed, or not in the server allowlist | `CONTACT_ADMIN` | Do not retry until the configured host is corrected. This is distinct from browser Origin validation. |
| `CSRF_INVALID` | 403 | Session-bound CSRF check failed | `RELOAD_PORTAL` | Refresh the first-party portal context; cookie/session is still independently required. |
| `VALIDATION_FAILED` | 400 | Request is invalid or exceeds a field rule | `FIX_REQUEST` | Correct the request; response never echoes sensitive field values. |
| `PAYLOAD_TOO_LARGE` | 413 | Endpoint-specific byte/field limit was exceeded | `REDUCE_REQUEST` | Reduce content; webhook ingress rejects the oversized body before enqueueing. |
| `RATE_LIMITED` | 429 | Local quota was exceeded | `WAIT` | Honor `Retry-After`; bounded by tenant and operation. |
| `DEPENDENCY_UNAVAILABLE` | 503 | A required dependency cannot currently confirm the request | `CHECK_STATUS` | Retry only safe reads or idempotent local operations; reconcile external effects. |
| `META_UNAVAILABLE` | 503 | Provider dependency cannot currently be reached or queried | `CHECK_STATUS` | Honor bounded adapter retries. If an external mutation may have happened, return `OUTCOME_UNKNOWN` and reconcile before retry. |
| `PROVIDER_REJECTED` | 422 | Provider rejected an operation after response normalization | `REAUTHORIZE` | Do not retry unchanged input indefinitely. Raw provider details remain restricted. |
| `INTERNAL_ERROR` | 500 | An unexpected server error occurred and no safe operation-specific retry decision is available | `CONTACT_ADMIN` | Not retryable by default. For an ambiguous external effect, return `OUTCOME_UNKNOWN` and reconcile before retrying. |

The `safeMessage` field is selected from a fixed, allowlisted localization template for its error code; it never interpolates request values, raw provider text, secrets, or diagnostics. `x-error-policy-by-code` in the `ErrorEnvelope` schema pins the non-retryable/action pair for `OUTCOME_UNKNOWN`, `IDEMPOTENCY_KEY_REUSED`, `COEXISTENCE_SESSION_ACTIVE`, `HOST_NOT_ALLOWED`, and `INTERNAL_ERROR`; the harness rejects contradictory envelopes. The message is not a diagnostic. `requestId` is a server-generated correlation handle, not an authorization token; inbound `X-Request-Id` values from direct clients are ignored. Detailed provider diagnostics belong in access-controlled logs with field allowlists and redaction. Error codes are versioned API behavior; changing a code or status mapping is a reviewed contract change.

## Limits and asynchronous effects

The structured `x-proposed-payload-limits` and `x-retry-policy` extensions in `openapi.yaml` carry the initial bounds: 64 KiB for portal JSON requests, 16 KiB for one-time provider authorization-code requests, 4 KiB for reply text, 16 KiB for template bodies, 1 MiB for raw signed webhook ingress, and page size 50 capped at 100. Safe reads/local idempotent jobs allow up to three automatic attempts within 60 seconds. External mutations without proven provider idempotency allow one automatic attempt including the initial request (zero automatic retries); a new explicit user request after proven no effect gets a new idempotency key. Ambiguous outcomes become `UNKNOWN` and must be reconciled before any later request. These are proposed local guardrails, not provider guarantees or production limits.

`202 Accepted` plus a `Location` pointing at the tenant-scoped job means work was recorded. It does not mean the provider accepted the effect. Jobs and operations expose `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, or `UNKNOWN`; `UNKNOWN` requires reconciliation. A message send may have reached the provider even when the response is lost, and this API does not claim provider exactly-once delivery.
