# SPEC — Authentication and portal session

Status: proposed. Issues: [#15](https://github.com/costaapps/ca_meta_app/issues/15), [#17](https://github.com/costaapps/ca_meta_app/issues/17). Contract: [identity contract](../identity-contract.md), [OpenAPI auth/session](../contracts/openapi.yaml), [error catalog](../contracts/error-catalog.md). Functional owner: Suite4/consumer integration and security roles; people unassigned. External issuer agreement: **Not confirmed**.

## Problem and scope

Provide a passwordless Suite4 handoff and a separate direct-access path for invited members without treating a tenant UUID as authentication. Scope covers pre-auth, one-use ticket exchange, session context, session revocation, and the proposed magic-link journey. The real Suite4 issuer/JWKS/membership contract and deployed cookie policy are outside this spec until confirmed.

## Invariants

- The server verifies issuer, audience, subject, signature/algorithm, time claims, membership, roles, nonce/jti replay and ticket expiry before issuing an opaque portal session.
- `POST /api/v1/auth/preauth` creates the browser-bound preauth cookie and `challengeRef`; `POST /api/v1/auth/exchanges` consumes the one-use ticket with that challenge in the same browser context. Do not log or expose either secret.
- The session and current server-side membership determine tenant context. Query/storage `cUUID` and `company_uuid` never grant, select, or elevate authority.
- An exchange retry after a lost response is idempotent only for the exact same ticket/JTI, challenge and pre-auth browser binding; it may return the same still-active session without creating or renewing one. A revoked/expired session or membership, or changed cookie/challenge, is denied. Whether the real Suite4 handoff can safely re-deliver that exact request remains **Not confirmed**.
- Direct access can resolve only a pre-invited principal; it cannot enumerate identities or create membership from email domain.

## Contract and data

Use the M1.07 preauth, exchange, `/api/v1/session`, logout/revoke and magic-link operations. Persist only hashes/references for one-use challenges and session secrets; bind session to principal, tenant membership, context version, issue/expiry/revoke timestamps. No browser DTO contains provider credentials or raw ticket. No issuer-specific claim names beyond the proposed identity contract are assumed.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| AUTH-01 | Valid signed ticket and matching preauth challenge/cookie | Same browser exchanges once | One tenant-bound session is issued after membership check | M1.06 security harness + M1.07 contract tests |
| AUTH-02 | Ticket replayed, wrong audience, stale challenge, or changed membership | Exchange is attempted | Safe failure, no session, no cross-tenant effect | Adversarial contract/security tests |
| AUTH-03 | Exchange outcome is unknown after response loss | Client retries exact same ticket/JTI, challenge and pre-auth browser binding | Same active session only, with no session creation or renewal; revoked/expired state or changed binding is denied | Fault-injection and MariaDB replay tests; issuer handoff remains external gate |

## Implementation, migration and recovery

Add auth adapters behind the canonical contract; maintain separate direct-member and Suite4 entry policies. Migrate off localStorage UUID authority only after the server session path is available. Rollback disables the new entry for a scoped tenant/consumer and preserves the legacy path as the sole writer until cutover evidence passes; never restore an expired ticket or create a second session for a replay. Block real integration until issuer, JWKS rotation/revocation, cookie/SameSite/iframe behavior and membership test are agreed by the functional owner role.
