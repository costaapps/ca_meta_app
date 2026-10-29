## Outcome and bounded scope
Summarize the observable change, issue(s), acceptance IDs and non-goals.

## Trace and contracts
- Issue(s):
- Requirement IDs: `docs/meta-v2/traceability.csv`
- Spec / ADR:
- Contract and version:
- Affected consumers:
- Functional owner role:

## Tenant, credential and side-effect review
- [ ] Tenant derives from authenticated server membership; client UUID is not authority.
- [ ] No secret, raw token, production payload or sensitive backend environment value is included.
- [ ] Retry, idempotency, async completion and ambiguous external outcomes are explicit.
- [ ] Migration, rollback and recovery preserve the prior safe state.
- [ ] Scope and external gates are explicit; no mock is presented as external proof.

## Validation evidence
| Command / scenario | Environment and version | Result | SHA / evidence |
|---|---|---|---|

State synthetic fixture coverage, remaining `Not confirmed` gates, reviewer roles, and whether any result invalidates on a base/head change.

## Delivery
- Target branch:
- Required checks/reviews:
- Package PR merge method: squash
- Release evidence: exact tag/artifact/environment, or `NOT_RELEASED`
