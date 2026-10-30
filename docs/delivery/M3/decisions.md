# M3 decisions

## M3.01 identity and tenant boundary

- Follow the accepted M1.05/M1.06 model: principal identity is the exact stable `(issuer, subject)` pair; a person membership is keyed by `(tenant_id, principal_id)`; role and membership status are read from the server on each authorization boundary.
- A service principal is a distinct `kind=SERVICE` identity. Its tenant grants use `ca_meta_service_identity_scopes`; human roles do not authorize service operations. Database checks and composite foreign keys keep USER memberships and SERVICE grants on their matching principal kind.
- Tenant ID, legacy database/company IDs, asset IDs, and context references are identifiers only. A scope is minted only from a server-verified portal session plus a live membership. Every helper for an ID lookup includes the minted tenant ID in its predicate.
- The API has no identity or session routes in M2. OpenAPI already defines `/api/v1/session` and tenant switch. M3.01 supplies the Principal/Membership/context/policy service used by those routes; M3.04 owns persistent portal sessions, HTTP/cookie/CSRF/CORS/rate-limit enforcement and the controller wiring. The context service requires the current server session's context-reference hash and the presented `X-Tenant-Context`; stale references fail with a uniform `CONTEXT_CHANGED` error. A tenant switch resolves a new active membership and returns a new context version but does not reassign existing onboarding sessions or jobs.
- There is no public tenant or membership provisioning endpoint. Suite4's issuer and membership contract remain **Not confirmed**. Only an internal authenticated or audited provisioning path may create production membership; synthetic tests seed disposable data directly.
- Adding migration version 4 updates the executable M2.03 restore assertion and M2.07 current-schema smoke expectation. This keeps those existing consumers aligned with the new migration ledger without changing their acceptance criteria.

## External evidence

Local issuer, principal, tenant and membership fixtures prove only code behavior for those inputs. They do not establish the Suite4 subject mapping, active membership, roles, cookie topology or deployed business ownership. Meta permissions/assets and staging operations are not exercised by M3.01.
