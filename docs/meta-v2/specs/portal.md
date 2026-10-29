# SPEC — Portal resource and status experience

Status: proposed. Issue: [#18](https://github.com/costaapps/ca_meta_app/issues/18). Contracts: [journey](../experience/journey-spec.md), [status copy](../experience/status-copy-matrix.csv), [screen/API/permission/test map](../experience/screen-api-permission-test.csv), [OpenAPI](../contracts/openapi.yaml). The accepted M1.08 vertical example is its [portal spec](../experience/journey-spec.md) and [synthetic walkthrough fixture](../../../tools/m1-08/fixtures/walkthrough.json). Functional owner: frontend/product; people unassigned. Browser/Suite4 runtime and WCAG conformance are **Not confirmed**.

## Problem and scope

Let a member return safely, identify active business/resources, choose one of four flows, understand current versus stale status and recover from pending/partial/auth failures while preserving channel messages, templates and notifications. Preserve the Angular layout as reference; M1.08 contains the full text wireframes and copy matrix.

## Invariants

- Company label and resource list derive from authenticated session plus server membership. If there is no safe tenant label, hide switcher and block mutations; UUIDs in URL/storage are never authority.
- Keep `ACTIVE`, `PARTIAL`, `REAUTH_REQUIRED`, `UNKNOWN`, stale observation, disconnected, asset grant and webhook/subscription status distinct. Show timestamp/source quality where available.
- A `202` starts an async job; do not show success until the job/connection is re-read. Popup close/timeout means pending or unknown, not connected or canceled without server evidence.
- Reauth stays unavailable without the contract's safe onboarding/launch reference. Templates/messages/replies stay disabled when the current contract cannot safely represent their required fields/context.
- Keyboard/focus, target size, reflow, labels, status announcements and destructive-action confirmation are implementation requirements; the spec does not claim WCAG certification.

## Contract and data

Use M1.07 session, connection, asset, job, automation, template and notification operations. Required tenant display context and several current UI fields/actions are identified as contract gaps in the M1.08 matrix; do not invent a `/me` endpoint or send reduced/incompatible write payloads.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| PORTAL-01 | Session has no safe display label | Dashboard loads or mutation is requested | Explain unavailable business context; hide switcher and block writes | M1.08 CTX fixture |
| PORTAL-02 | Resource is stale or partial | Member opens status detail | Distinguish last confirmation/read failure and offer only supported recovery | M1.08 state matrix + walkthrough |
| PORTAL-03 | Disconnect/reauth returns `202` | Member returns from popup | Show pending action and query server state before final result | M1.08 recovery fixtures; future API E2E |

## Implementation, migration and recovery

Deliver status/tenant contract gaps before enabling the corresponding controls. Keep legacy templates/messages/notifications recoverable during migration; do not drop an action until an explicit product change and compatibility plan are accepted. For error/timeout, retain the original connection and expose safe status check rather than duplicate an external effect.
