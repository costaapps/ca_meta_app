# M1.08 portal journey walkthrough

This read-only Node harness exercises the M1.08 synthetic product/status decisions against fixtures and the proposed M1.07 OpenAPI/event contracts. It does not call Angular, PHP, Meta, Suite4, the network, or a provider; it performs no database/production writes and includes no credential material.

## Environment and commands

Requires Node.js 22 or newer; the authoring environment used Node `v22.17.0`, npm `10.9.2`, and Python `3.13.7`. The harness uses only Node built-ins, so it has no third-party dependencies and intentionally has no package lockfile.

From the repository root:

```powershell
node --version
node tools/m1-08/walkthrough.mjs
git diff --check
```

Expected final summary:

```text
M1.08 synthetic walkthrough: 31/31 checks passed; fixtures only; provider calls=0; production writes=0.
```

The exact count can increase when a new trace check is added. A non-zero process exit code means at least one assertion failed. The script reads `docs/meta-v2/experience/journey-spec.md`, both CSVs, text wireframes, the M1.07 OpenAPI YAML, the inbox/outbox schemas, and `fixtures/walkthrough.json`.

## Walkthrough cases

- Four top-level choices map to the five M1.07 `FlowVariant` values; both Instagram variants stay distinct.
- Four synthetic WhatsApp Coexistence connection references are separate and never replace one another.
- The current session tenant is the only tenant used by fixture resources; without a safe company label, the switcher is hidden and all writes are blocked.
- ACTIVE/READY, PARTIAL, REAUTH_REQUIRED, UNKNOWN/stale, DISCONNECTED, authorization states, and the absent webhook/subscription field remain separate.
- Suite4 preauth precedes ticket exchange in the same browser; cookie/ticket values are absent, and lost responses follow the contract retry boundary. Popup close, server-confirmed cancellation, timeout/UNKNOWN, and cross-tab `CONTEXT_CHANGED` have separate recovery checks.
- Reauthorization stays disabled while no launch reference is returned; notification loading, empty, and read-error copy are separate checks. Template creation stays disabled when examples required by the existing UI are not represented by the proposed API request; automation `412` does not overwrite; notification REPLY stays pending and is not repeated automatically.
- Traceability and W3C accessibility references are present.

The fixture's four Coexistence references, masked-number labels, onboarding cases, and job outcomes are synthetic examples only. They do not prove real Meta eligibility, a provider limit, actual grants/subscriptions, account labels, Suite4 session identity, popup support, accessibility conformance, or production behavior.

## Manual design review still required before portal implementation

Use a keyboard-only walkthrough of setup, provider popup return, status refresh, company switch, accessible confirmation dialog, templates, and notifications. Check visible/unobscured focus, Escape/Cancel behavior, focus restoration, error/status announcements, labels/instructions, target size, reflow at narrow/embedded widths, and color contrast against WCAG 2.2. The current work records the checklist and text wireframes; it has not executed a real browser or screen-reader audit.

## Cleanup

No service, container, file, browser session, credential, or external resource is created by this harness. There is nothing to clean up.
