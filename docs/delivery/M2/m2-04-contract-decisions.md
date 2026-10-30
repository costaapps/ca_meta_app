# M2.04 contract decisions

**Issue:** #23, package branch `desktop/m2-04`
**Date:** 2026-10-29
**Contract source:** `docs/meta-v2/contracts/openapi.yaml` and its M1.07 event schemas.

## Server request ID

The API always generates a UUID v4 request ID with Node's `randomUUID()`. It uses that one value
for the response `X-Request-Id` header, `ErrorEnvelope.requestId`, and structured request logs. It
ignores any inbound `X-Request-Id`, including a syntactically valid UUID, because the API accepts
direct clients and cannot treat client input as trusted log correlation. The Angular client uses a
validated envelope `requestId`, or the response header if the envelope is invalid, and never
displays the raw response body.

## Host and Origin errors

An absent, malformed, or non-allowlisted Host that reaches API middleware returns HTTP 403 with
`HOST_NOT_ALLOWED`, `retryable: false`, and `CONTACT_ADMIN`. `ORIGIN_NOT_ALLOWED` remains HTTP 403
for browser Origin/Fetch Metadata rejection with its existing `RELOAD_PORTAL` action. An HTTP/1.1
request with no Host header is rejected by Node's HTTP parser before Express middleware and returns
HTTP 400 without an API envelope; an HTTP/1.0 no-Host test reaches the middleware and verifies the
403 contract. Parser-level malformed HTTP is outside the application middleware contract.

## Unexpected server errors and effects

Generic HTTP 500 errors map to `INTERNAL_ERROR`, `retryable: false`, and `CONTACT_ADMIN`. The
operation must decide separately when a side effect is known not to have happened. If an external
effect may have happened but cannot be confirmed, the operation must return `OUTCOME_UNKNOWN` and
reconcile before a later explicit retry. HTTP 503 readiness/dependency failures keep
`DEPENDENCY_UNAVAILABLE` and `CHECK_STATUS`; retryability never authorizes repeating an external
effect. No automatic retries are installed in the Angular client.

The new error codes are additive against the frozen proposed v1 baseline according to the
`@pb33f/openapi-changes` checker. Existing API version and baseline are unchanged. The breaking
sensitivity fixture proves route removal still fails the gate.

## Public error surface

`INTERNAL_SCOPE_DENIED` describes an internal service identity failing its tenant/asset/operation
scope check. It remains in the canonical contract and error catalog for the internal service route,
but is excluded from the published OpenAPI, error catalog, generated TypeScript, error-code and
policy constants, and runtime validator. The `@ca-meta/contracts` and M1.07 public-client generators
apply the same exclusion and test that the canonical sources retain the code while public artifacts
do not. The canonical contract and frozen baseline are unchanged.

## Limits

These decisions implement local API/client behavior and fixtures only. They do not establish
deployed Host allowlists, reverse-proxy parser behavior, Meta permission grants, provider delivery,
production availability, or staging behavior. No real Meta account, credential, message, production
database, or shared environment is involved.
