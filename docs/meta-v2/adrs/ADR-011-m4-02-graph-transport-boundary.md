# ADR-011 — M4.02 Graph transport boundary

Status: implementation candidate. Issue/spec: [#44](https://github.com/costaapps/ca_meta_app/issues/44), [Internal Meta Graph client](../specs/meta-graph-client.md). Evidence date: 2026-11-06. Candidate SHA, execution gate and independent reviews are pending coordinator evidence.

## Context

M3.08 supplies credentials through an opaque, one-use callback, and M4.01 supplies environment-scoped application configuration and per-operation capability evidence. A transport that accepts a caller URL, uses an app/global token, resolves a credential without the exact operation policy, or silently retries a mutation would bypass those boundaries. Official current Graph error, pagination and quota documentation was not fully accessible during this review; exact error/status/header semantics remain **Not confirmed**.

## Decision

Implement an internal typed client with a closed endpoint/method/path map. It binds the M4.01 configuration reference, verified Graph API version and exact enabled operation before entering M3.08's `withCredentialForContext` callback. The internal asset UUID remains the resolver key; a separate server-resolved provider object ID binds the Graph resource path. The Node HTTPS transport accepts only exact allowlisted hosts and route templates, validates the configured profile again, requires TLS certificate verification, disables redirects, and caps requests, responses and four timeout phases.

GET retries are bounded and use optional numeric `Retry-After` hints with a capped local backoff. Pagination validates host/path/query before each next request, strips any access-token query parameter, reconstructs safe cursor parameters, preserves allowed paging fields, detects loops and returns only a bounded internal checkpoint. POSTs are not retried: a timeout, network failure or 5xx after transmission is reported as ambiguous `UNKNOWN` for reconciliation. A top-level error body is always a failure even if HTTP status is 200. Normalized errors exclude provider messages, headers and nested error objects.

Per-tenant/app concurrency and request ceilings are local operational safeguards; no Meta quota is inferred. Metrics contain only low-cardinality operation/product/environment/outcome/category labels. Meta's actual permission grants, code mappings, HTTP-200 error details, retry header behavior, current Graph API version and usage thresholds must be verified per app/configuration before enablement.

## Consequences and alternatives

This boundary adds explicit internal context and bounded fixture tests, while keeping any future controller or workflow responsible for resolving the provider object ID and resolver handle from authorized server state. It deliberately does not implement arbitrary Graph operations, history sync, automatic mutation retries or provider-specific quota claims. Direct use of `fetch`/arbitrary URLs or a separate credential resolver graph is rejected because it would weaken these bindings or duplicate vault state.

## Validation

The reproducible command is `npm run test:m4-02 --workspace=@ca-meta/api`, documented in `tools/m4-02/README.md`. It uses synthetic in-process responses only. No M4.02 test, build, live Meta request, production configuration or real credential is claimed by this ADR; coordinator evidence is pending.
