# SPEC — Legacy bridge and staged transition

Status: proposed. Issues: [#10](https://github.com/costaapps/ca_meta_app/issues/10), [#11](https://github.com/costaapps/ca_meta_app/issues/11), [#16](https://github.com/costaapps/ca_meta_app/issues/16). Contracts: [baseline evidence](../01-baseline-evidence.md), [compatibility matrix](../contracts/compatibility.md), [legacy schema](../schema-legacy.md), [transition strategy](../m1-09/transition-strategy.md). Functional owner: legacy/backend/data operations; people unassigned. Hostinger, production DDL, consumers and writer ownership are **Not confirmed**.

## Problem and scope

Preserve or explicitly change versioned Angular/PHP behavior while moving consumers by tenant and operation. This spec covers endpoint mapping, read-only comparison, one-writer-per-field ledger, projection/reconciliation and rollback. It does not reproduce or replace local operational PHP, Hostinger rewrite rules or real databases.

## Invariants

- Current versioned code, accepted baseline inventory and verified runtime evidence are separate columns. A historical doc is not runtime proof.
- `backend/connect.php` and `backend/connect_old.php` are local-only sensitive references per AGENTS; do not read, copy, commit or rewrite them without explicit scope. Trace only versioned files and sanitized contracts.
- One authorized writer owns each tenant/resource/field per rollout stage. Shadow-read may compare; shadow-send or two active writers is forbidden.
- Dry-run, checkpoint, quarantine and projection-version checks precede any real import. No production mutation, credential import, external message or deploy is implied by this spec.
- Rollback may restore routing/flags and reconcile records; it cannot undo an external send/revoke or revive a revoked credential.

## Contract and data

Use `docs/baseline/endpoint-matrix.csv`, `parity-matrix.md`, M1.02 `field-mapping.csv` and `schema-legacy.md`, M1.07 compatibility/error contracts, and M1.09 transition controls. Real DDL/table semantics and app-level shared webhook ownership require the evidence gates in those docs.

## Scenarios

| ID | Given | When | Then | Evidence |
|---|---|---|---|---|
| LEGACY-01 | One versioned endpoint or screen is inventoried | New portal route is designed | Link source behavior → accepted contract → test or documented removal | M1.01 53-row inventory and M1.08 map |
| LEGACY-02 | Dry-run finds duplicate/ambiguous asset or unknown tenant | Import is planned | Report/quarantine only, with zero writes and no last-login inference | M1.02 fixtures/dry-run |
| LEGACY-03 | One tenant is migrated while another uses legacy | Route/writer is switched | Ledger has one writer; rollback restores compatible route and reconciles pending effects | M1.09 transition tabletop; future M5 rehearsal |

## Implementation, migration and recovery

Start isolated with synthetic records, compare only sanitized fields, and establish real source/consumer owner before choosing a rollout. Stage gates are baseline → isolated platform → authorized import → shadow-read → scoped pilot → expansion → cutover → retirement, each with exit evidence. Stop on cross-tenant data, secret, duplicate effect or unknown writer; preserve ingress and prevent ACK-after-drop. Production cutover and retirement require separate authorization.
