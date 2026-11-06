# SPEC — Internal Meta Graph client

Status: M4.02 implementation candidate; issue [#44](https://github.com/costaapps/ca_meta_app/issues/44). Depends on the M4.01 app configuration registry, M3.08 credential resolver and M2.05 runtime profile. This is a server-only transport boundary; it is not evidence that a Meta app, permission or real account is approved.

## Trust and configuration binding

The internal input is a closed typed endpoint, `MetaOperation`, correlation ID, one-use credential handle and server-created execution context. The context retains M3.08's internal asset UUID and a distinct `providerObjectId` resolved from that authorized asset. The request resource ID must equal that server-resolved provider ID; the internal asset UUID is used only for resolver binding. No browser URL, host, path, app ID or token is accepted as authority.

Before credential use, the client resolves the exact M4.01 `(environment, flowVariant, authVariant)` configuration, matches its configuration reference, requires a graph API version marked `VERIFIED`, and requires the exact operation capability to be enabled in the bootstrap projection. It then executes all Graph pages inside one `withCredentialForContext` callback. The resolver rechecks tenant, app, environment, internal asset UUID, operation and distinct Instagram auth variant before supplying a one-use secret. Only the Node transport builds a Bearer header; the secret never enters URL, result, logs or metrics. The client and transport independently reject unlisted hosts, methods, path templates, headers and query keys. HTTPS certificate verification is enabled, redirects are not followed, and TLS 1.2 is the minimum.

The host derives only from the registered auth variant: `graph.instagram.com` for Instagram Login, otherwise `graph.facebook.com`. The Graph API version comes only from an M4.01 version record with reviewed evidence and `VERIFIED` state. No default or guessed version is enabled.

## Typed route and result boundary

The internal route allowlist covers object status reads, flow-checked asset edges, templates list/create, comments list/reply, subscribed-app list/subscribe, and message send. Endpoint and operation must agree with the capability manifest. History synchronization is intentionally not implemented in this client. Route payloads are bounded JSON and reject token, secret, authorization, header, cookie and code fields. Response objects are capped and recursively strip secret-bearing keys; error payloads are normalized without returning provider messages, headers or nested error objects.

Every result reports a safe outcome (`SUCCEEDED`, `FAILED`, `PARTIAL` or `UNKNOWN`), HTTP status where received, attempts/retries, and safe error category/code/type/trace data where validated. Code 190/HTTP 401 maps to `CREDENTIAL_REJECTED` and a reauthorization action; it does not assert that a token is revoked. Known permission-shaped responses map to `PERMISSION_REQUIRED`. This classification is conservative adapter behavior, not a confirmed complete Meta error taxonomy.

An HTTP response whose body contains a top-level `error` is never a success, including HTTP 200. HTTP 429 is `RATE_LIMITED`. Provider 5xx/network errors are transient for reads. A POST timeout, transport failure, 5xx response or oversized response is `UNKNOWN`/ambiguous and is never automatically resent; a caller must reconcile provider state before deciding what to do next. Explicit retryable/ambiguous booleans are included without exposing credentials.

## Paging, retries and local budgets

Collections consume provider `paging.next` only after validating exact HTTPS host, versioned path, resource/edge path, query allowlist and cursor. Query access tokens are discarded; the client reconstructs the next request with its Bearer header, safe cursor and preserved allowlisted pagination fields. Duplicate cursors, malformed URLs, cycles, item/page limits and oversized responses stop safely and return a bounded internal checkpoint. The checkpoint contains only a cursor and counts; it is internal state and must not be logged or sent to a browser.

Local defaults are bounded and configurable within hard maxima: connect 2 s, response headers 3 s, read inactivity 5 s, total request 10 s; request body 64 KiB, response body 1 MB, at most 100 pages and 10,000 items. GET retries at most twice per request with bounded exponential jitter; a collection has a total retry budget of 16. Numeric `Retry-After` hints are capped at 30 s. POSTs are never retried automatically. Concurrency is capped at 4 active calls per tenant/app and 32 process-wide. A local ceiling of 120 requests per tenant/app per minute is enforced; an allowlisted usage header may conservatively reduce available budget. These values are local safety settings, not Meta-published quotas or recommendations.

Metrics expose only operation, product flow, environment, outcome and error category. Tenant, app, asset, provider object, credential handle, correlation ID, cursor and provider message are excluded from metric labels.

## Evidence and limits

On 2026-11-06, Meta-maintained Postman collections were available for [Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), [WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) and [Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup). Their examples show Bearer-header authentication, versioned Graph hosts/paths, cursor-style paging and usage headers; they inform only the adapter shape, not permission grants or exact runtime semantics. Meta's [Graph API reference](https://developers.facebook.com/docs/graph-api/overview/) error-handling, pagination and rate-limiting pages returned HTTP 429 during the same source review. Thus exact HTTP-200 `{error}` behavior, provider error-code meanings, `Retry-After` semantics and usage-header quota thresholds are **Not confirmed**. Usage headers are treated as optional hints only. Confirm actual behavior in a reviewed app/test environment before enabling a provider operation.

The M1.03 capability matrix and compatibility fixture remain separate evidence. Their synthetic values do not verify current provider permissions, Graph API versions, review state or auth eligibility. All production calls remain unavailable unless M4.01 configuration and per-operation evidence are supplied and reviewed.

## Focused local evidence

The offline TypeScript harness and cleanup behavior are documented in [`tools/m4-02/README.md`](../../../tools/m4-02/README.md). It covers normalization/redaction, pagination and hostile next links, retry limits, ambiguous POST handling, exact capability/version gates, timeout budgets, provider-ID binding, concurrency and quota metrics. It does not contact Meta or use real credentials.
