# SPEC — Signed webhook ingress, inbox and routing

Status: proposed. Issues: [#14](https://github.com/costaapps/ca_meta_app/issues/14), [#17](https://github.com/costaapps/ca_meta_app/issues/17). Contracts: [inbox schema](../contracts/events/inbox-event.schema.json), [outbox schema](../contracts/events/outbox-event.schema.json), [OpenAPI](../contracts/openapi.yaml). Functional owner: Meta integration/platform; people unassigned. Real app subscription, delivery and retry guarantees are **Not confirmed**.

## Problem and scope

Accept provider callbacks safely, retain enough evidence to recover processing, route each event item to at most one server-resolved tenant, and dispatch durable internal work. This does not claim exactly-once provider effects or production webhook setup.

## Invariants

- Validate the signature against the exact raw body before trusting/parsing provider fields. Keep raw body in restricted retention storage; normalized metadata cannot replace signature input.
- Persist each envelope/item to a durable inbox before acknowledging success. Dedupe by provider/app/event and per-item identity as specified by the contract.
- Unknown, malformed or ambiguous events stay tenantless and quarantined; no fanout, last-login routing, client-selected tenant or provider text in UI/error messages.
- Worker redelivery is at least once, fenced by lease/version and idempotency key. Unknown effects are reconciled; no blind repeat of message send/subscription changes.
- Outbox is committed with local intent and has explicit schema version, tenant scope, correlation, causation and safe payload boundaries.

## Contract and data

Use the M1.07 inbox/outbox schemas and webhook ingest/notification operations. Route resolution uses the M1.05 `AssetRouteClaim`/tenant-scoped asset relation and quarantine state. `provider.unclassified` is an open-envelope representation, not a closed list of future provider event types.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| WH-01 | Valid signature and two items in one envelope | Ingress accepts the batch | Persist separate inbox item identities before ACK; route each independently | M1.07 contract tests; future ingress integration |
| WH-02 | Unknown or conflicting asset ownership | Resolver processes item | Tenant stays null, item is quarantined and not fanned out | M1.05 conflict fixture; M1.07 event schema tests |
| WH-03 | Worker crashes after local commit or provider timeout | Lease expires/redelivery occurs | Recover locally by version/idempotency; ambiguous provider effect remains `UNKNOWN` | M1.04 worker PoC + M1.07 behavior fixtures |

## Implementation, migration and recovery

Add durable raw-reference retention and replay tooling behind operator authorization. Verify database and queue recovery, lease fencing and signature key rotation. Migration of shared callback/app subscriptions requires an authorized ingress gateway and one executor per action; roll back routing flags/ledger without double delivery. Real Meta signature keys, subscriptions and redelivery contract are external gates.
