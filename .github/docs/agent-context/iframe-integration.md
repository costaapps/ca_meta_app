# Iframe Integration

## Current State
- The application is not yet designed for secure embedding inside `suite4`.
- Tenant context currently arrives through query params and localStorage.
- No parent-child messaging contract exists.

Evidence:
- `apps/web/src/app/features/channels/pages/channel-setup/channel-setup.component.ts`
- `apps/web/src/app/core/services/meta-integration.service.ts`

## Recommended Direction
- Preferred tenant handoff: validated `postMessage` handshake from `suite4` to the iframe.
- Temporary compatibility fallback: signed query param only if the parent cannot message yet.
- Do not rely on raw `cUUID` query propagation as the long-term embedded contract.

## Planned Handshake
1. Parent creates iframe with a minimal bootstrap URL.
2. Child loads a neutral shell and announces readiness.
3. Parent sends tenant context, theme context, and session metadata via `postMessage`.
4. Child validates `origin`, message shape, and freshness before storing runtime state.
5. Child acknowledges ready state and optionally reports height/navigation updates back to parent.

## Origin Validation
- Allowlist exact parent origins for `suite4`.
- Reject wildcard origin acceptance.
- Validate both:
  - `event.origin`
  - message schema/version

## Tenant Propagation
- Target state: keep tenant in memory first, optionally mirror to storage only if required by navigation refresh behavior.
- If storage remains necessary, namespace or sign tenant context to reduce mix-ups between tabs or tenants.

## Theme And Visual Integration
- Expect `suite4` to pass:
  - theme mode or token set
  - typography tokens
  - spacing/container constraints
- Current app styles are independent and will need a compatibility layer before seamless embed.

## Height And Layout
- Parent-child resize messaging will likely be required.
- Internal pages vary in height significantly, especially channels and templates.
- Avoid nested scrolling where possible.

## OAuth In Embedded Context
- Do not open Meta OAuth fully inside the iframe as the default plan.
- Preferred behavior:
  - open in top-level window or controlled popup
  - return to a parent-managed callback path
  - reconcile state back into the iframe session

Why:
- third-party cookie restrictions
- popup and redirect complexity
- parent/iframe navigation mismatch

## Session Expiry And Recovery
- Child should surface an embedded-safe expired-session state.
- Parent should be able to re-issue session or tenant context without forcing opaque iframe reload loops.

## CSP And Frame Controls
- Future deployment must define:
  - `Content-Security-Policy`
  - `frame-ancestors`
  - any sandbox policy if used
- These controls are not visible in the current repo and must be coordinated with the host platform and backend.

## Accessibility And Mobile
- Embedded focus management must remain keyboard-safe.
- Parent and iframe should avoid trapping scroll or focus.
- Mobile OAuth and popup fallback behavior will need explicit testing.

## Pending Decisions
- exact message schema
- whether to persist tenant locally after handshake
- top-window redirect vs popup for OAuth
- callback ownership between child app, backend, and `suite4`

See also:
- [security.md](security.md)
- [open-questions.md](open-questions.md)
