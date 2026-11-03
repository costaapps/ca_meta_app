# ADR-010 — M3.11 legacy import preflight boundary

Status: proposed. Issue/spec: [#39](https://github.com/costaapps/ca_meta_app/issues/39), [legacy import preflight](../specs/legacy-import.md). Functional owner role: backend / data / DBA. Evidence SHA/date: implementation candidate pending; no production source was accessed.

## Contexto comprovado

The M1.02 inventory and field mapping are based on reviewed versioned source code, not live DDL or an authorized business database. `GeneralSettings` has no established field contract. Legacy tokens have no verified tenant/app/grant provenance. M3.06's assets repository requires trusted evidence before grants and relations can be marked verified. A synthetic fixture can prove local classification but not the external source or Meta grants.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Build a synthetic, dry-run-only planner with source, ledger and target ports | Exercises mapping and quarantine without contacting customer systems or assuming DDL | Persistent ledger and real source adapter remain a later schema/access gate | Synthetic fixtures and unit tests |
| Connect now to guessed production tables and attempt an import | Could appear end-to-end sooner | DDL, privileges, app configuration, source ownership and provider grants are unconfirmed; risks credential exposure and tenant misassignment | No authorized source evidence exists |

## Decision and consequence

Implement the first option. The M3.11 command reads only the checked-in synthetic snapshot, defaults to dry-run, and rejects apply. The planner emits metadata-only `CLAIMED` candidates and quarantines uncertainty. It never reads GeneralSettings, raw tokens or unknown fields. Each item separates stable source identity from an allowlisted payload fingerprint so a future ledger can quarantine changed rows. Report identifiers are HMAC references generated from a future operator-supplied key; the local fixture uses an explicitly non-operational test key.

Storage remains behind typed ports. Do not add tables, migration versions or registry entries until the M3.03 schema-v14 change is integrated; then add the persistent batch/item ledger as schema v15 and review the exact candidate again. No live database adapter or credential writer is part of this package. Any M5 apply requires separately authorized source DDL, read-only snapshot, approved tenant/app map, verified grant evidence, a same-transaction version fence and checkpoint, and a rollback plan.

## Segurança, efeitos e reversibilidade

- Tenant ownership uses exact database/company/environment mapping; duplicate or missing mappings fail closed.
- The snapshot DTO rejects extra fields, including raw credential columns. No public HTTP route exposes import.
- M3.11 ports expose no token-bearing or grant-creation operation. Credential presence only requires reauthorization.
- Batch and item state will be committed atomically with target metadata after schema v15. This implementation has no writer or external effects.
- Rollback of metadata must be batch-scoped and cannot undo provider effects, restore revoked credentials or overwrite a later reauthorization.
- Bound scope is synthetic planning and sanitization; actual migration is owned by a future authorized M5 operation.

## Prova, implantação e recuperação

Test plan and exact commands are documented in `tools/m3-11/README.md`. No tests or production access have run as part of this implementer task. Exact SHA, candidate checks, review and persistent-ledger evidence remain pending coordinator validation.

## Revisão futura

Revisit after the authorized legacy DDL and catalog owner are identified, and after schema v15 ledger design is reviewed. Promote this ADR only when storage/transaction semantics and operational rollback have executable evidence.
