---
name: Specification-driven work package
about: Scope a bounded change with verifiable contract, tests and recovery
title: "[M#] <short outcome>"
labels: []
assignees: []
---

## Problem and outcome
State the user or operator problem and the observable result.

## Scope and non-goals
- In scope:
- Out of scope:
- Functional owner role:
- Dependencies and accepted contract versions:

## Requirements and acceptance
Link requirement IDs from `docs/meta-v2/traceability.csv`. Use Given / When / Then cases, including denied cross-tenant access, duplicate/retry, partial failure, and unknown outcome where relevant.

| Requirement ID | Given | When | Then | Evidence/test |
|---|---|---|---|---|

## Security and external gates
- Tenant source and authorization checks:
- Secrets and sensitive data boundary:
- External provider / Suite4 / infrastructure gates, marked `Not confirmed` until evidenced:
- Async effects, idempotency, retries and reconciliation:

## Contracts and decisions
- Spec:
- API/event/data contract and version:
- ADRs or explicit reason none are needed:
- Affected consumers and compatibility plan:

## Migration, rollout and recovery
Describe writer ownership, checkpoints, reversible flags, abort conditions, rollback, and recovery of ambiguous or irreversible external effects. State `Not applicable` with a reason where appropriate.

## Validation
- Environment and setup/cleanup:
- Exact commands and expected outcomes:
- Synthetic fixtures and security-negative cases:
- Evidence status: planned / executed / blocked, with SHA and limitations:

## Blocked record (only if blocked)
- Affected scenario:
- Missing evidence/resource:
- Responsible functional role:
- Next experiment:
- Independent work that continues:
