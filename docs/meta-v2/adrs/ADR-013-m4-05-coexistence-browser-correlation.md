# ADR-013 · Coexistence browser correlation and disabled provider boundary

Status: accepted for the local implementation boundary; enabling a provider adapter is deferred. Issue/spec: [#49](https://github.com/costaapps/ca_meta_app/issues/49), [Coexistence browser onboarding](../specs/coexistence-embedded-signup.md). Functional owner: Meta integration. Evidence SHA: pending package review. Provider wire contract: **Not confirmed**.

## Context

M4.03 provides session-bound onboarding creation, one-use provider state/code handling and authoritative status reads. Coexistence uses a distinct server auth variant, `WHATSAPP_BUSINESS_APP_ONBOARDING`. Current official accessible material did not establish the exact current Coexistence SDK/Embedded Signup versions, `featureType`, event payload, `postMessage` origin/source semantics or Sandbox behavior. General Embedded Signup documentation is not enough to implement those values safely.

## Decision

Add a dedicated `/setup/coexistence` route and a route-scoped service. Keep provider integration behind an injected adapter that must include explicit version, feature type, schema and origin/source evidence. The root provider is intentionally unavailable. It does not load the SDK, create an onboarding session or accept messages until a reviewed adapter implementation and server profile both allow the exact flow. When enabled, the user click first prepares a temporary browsing context synchronously; the server session and launch URL are validated before that context is navigated. Failed checks close the temporary context and create no duplicate session.

When enabled by a later reviewed implementation, the service keeps each onboarding reference, state, listener, timers and one-use code within that route instance. It rejects a prepared message source already bound to another unresolved attempt, checks exact message origin and source before invoking the adapter's closed-schema decoder, and re-reads the authenticated portal session before each code submission, status read or recovery action. The tenant-context reference must match the attempt; a mismatch sends no session-scoped request and stops polling until an explicit status check in the original context. It posts a decoded code only to the matching M4.03 authorization-code endpoint. Finish/QR/cancel messages cannot set readiness; the service reads the matching server status and reports readiness only from its terminal authoritative response. A code submission with an ambiguous response is not retried.

`PARTIAL` remains unresolved, not terminal, in the browser lifecycle. Preserve the server's `nextAction` and step statuses, expose a `RESUME` button only for a downstream `RETRY_PENDING` step, and expose a `RECONCILE` button only for a matching `UNKNOWN`/`RUNNING` step. Submit those exact `{action, stage}` values through M4.03's session action endpoint after re-reading current status and portal context. A 202 response leaves the action pending; status polling continues and prevents duplicate recovery requests or a new number while the server still reports an unresolved/in-flight outcome. A local cancel or timeout follows the same rule and cannot release the slot until a terminal server status is confirmed.

M4.03 does not accept `REAUTHORIZE` on that action endpoint. When a fresh authoritative read reports `PARTIAL` + `nextAction=REAUTHORIZE` + authorization step `FAILED`, show a distinct reauthorization button. Its handler retains the old record, creates a new onboarding session through the existing create endpoint and enabled server profile, and launches only the new session through the injected adapter. The create key is fresh relative to the old session but stable for all retries from that old session. The old history item is locally superseded only after the server has returned the replacement session; the new attempt remains start-blocking until its own authoritative terminal status. No phone/WABA matching is introduced.

The create key is stable for the source onboarding (`reauth-${onboardingRef}`), so simultaneous reauthorization calls for the same source session replay one M4.03 create result rather than minting multiple replacements. Different source onboarding IDs produce different keys. M4.03 has no cross-session logical-number claim, so this does not deduplicate separate original sessions that might later represent the same phone; that guarantee requires a server contract and is outside M4.05.

## Consequences

- Existing exclusive WhatsApp setup and its current callback behavior are untouched; Coexistence does not share `MetaAuthService.pendingProduct`.
- The adapter boundary preserves the browser's user activation across session creation by preparing a temporary browsing context before the asynchronous API calls; its provider-specific navigation remains disabled until protocol evidence is reviewed.
- A second tab receives a separate Angular route instance and cannot match a message by phone/WABA or consume another tab's in-memory session pointer.
- Each attempt retains its server-provided recovery action and remains start-blocking through `PARTIAL`, `RESUME` and `RECONCILE`. Separate route instances keep both provider sources and recovery state local; an action or message in one tab cannot update the other tab's session.
- `REAUTHORIZE` is treated as the server's instruction to issue a fresh onboarding session after authorization failure, never as an unsupported `/actions` payload. The prior attempt stays in history and is excluded from the local pending slot only after the replacement session is created.
- The current flow remains unavailable. A Sandbox run, actual SDK message fixture, four-number sequence and real Coexistence completion are not claimed.
- Attempt-scoped code, status and recovery requests stop locally after a tenant-context switch; returning to the original context permits an explicit status check without using browser storage as recovery state.
- Future enabling requires a primary source for every protocol field, a reviewed exact decoder/fixture, validated runtime/server configuration, adversarial browser tests and an authorized Sandbox run. It cannot be enabled by a public runtime flag alone.

## Alternatives rejected

| Option | Reason |
|---|---|
| Reuse the exclusive WhatsApp callback or `pendingProduct` | Mixes two auth variants and allows tabs/flows to overwrite correlation. |
| Guess a known sample's `featureType` or postMessage fields | Current version/source semantics were not confirmed; a sample does not prove this app's contract. |
| Treat QR, FINISH, popup close or HTTP 202 as ready | M4.03 requires trusted server-side grants/assets/saga evidence. |
| Store session/code/state in browser storage for recovery | Browser persistence is unnecessary for the current disabled path and risks cross-session correlation or credential residue. |
