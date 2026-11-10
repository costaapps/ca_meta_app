# ADR-019 — M4.13 connection lifecycle boundaries

Status: Accepted for local implementation; provider certification remains gated.
Issue: [#55](https://github.com/costaapps/ca_meta_app/issues/55).

## Decision

Separate local resource disconnect, authorization-wide disconnect, reauthorization-session creation, provider deauthorization, external subscription cleanup, and data deletion into distinct operations.

When a persisted authorization owns multiple active verified asset bindings, an authorization-wide DELETE returns a conflict. The caller must identify one asset for an asset-scoped disconnect. That operation disables only the selected tenant/authorization/asset binding, leaving sibling bindings and shared credentials available for their other authorized resources. An authorization-wide local disconnect is allowed only when there is at most one active verified binding.

Reauthorization creates and associates a new flow-specific onboarding session while keeping the prior grant unchanged. Callback processing requires an app-specific verifier to mint a branded hash-only event and a separate server-owned resolver to map the event to one exact authorization. Both adapters fail closed by default. Deauthorization updates only that exact local authorization and its credential/resource rows; data deletion creates a local request and tombstone but never purges data automatically.

No provider cleanup or destructive Coexistence operation is invoked until current per-flow protocol and offboarding evidence is confirmed. Cleanup status remains `BLOCKED` with a safe reason code, rather than claiming external disconnect success.

## Rationale

The domain model allows one authorization/credential to cover multiple assets. Treating each asset disconnect as token revocation could disable sibling Pages or phone numbers. Current official Meta callback and Coexistence offboarding details were not available during discovery (HTTP 429), so a generic signature parser, event mapping, or delete/deregister fallback would invent behavior. Fail-closed extension ports allow local state handling and tests to proceed without enabling uncertain external effects.

## Consequences

- API clients must use the asset-scoped route for shared authorizations.
- The command ledger retains local and cleanup state with idempotency hashes; callbacks retain only digests.
- No Meta callback can mutate state in the default runtime because verifier and target resolver are unconfigured.
- A later provider adapter must supply current official protocol evidence, per-flow mapping, replay policy, cleanup retry semantics, and integration tests before activation.

## Alternatives rejected

- Disconnecting/revoking the whole token for one asset risks disabling sibling resources.
- Reusing the M4.10 generic webhook signature contract for deletion/deauthorization would assume an unconfirmed callback format.
- Automatically issuing a Meta delete, deregister, or subscription removal during local disconnect risks unintended external side effects.
