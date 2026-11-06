# ADR-010 — M3.11 legacy import preflight and ledger boundary

Status: implementation candidate. Issue/spec: [#39](https://github.com/costaapps/ca_meta_app/issues/39), [legacy import preflight](../specs/legacy-import.md). Functional owner role: backend / data / DBA. Evidence SHA/date: pending candidate commit and coordinator CI; no production source was accessed.

## Contexto comprovado

The M1.02 inventory and field mapping are based on reviewed versioned source code, not live DDL or an authorized business database. `GeneralSettings` has no established field contract. Legacy tokens have no verified tenant/app/grant provenance. M3.06's assets repository requires trusted evidence before grants and relations can be marked verified. A synthetic fixture can prove local classification but not the external source or Meta grants.

## Options

| Option | Benefit | Cost/risk | Evidence |
|---|---|---|---|
| Build a synthetic, dry-run-only planner with source, ledger and target ports | Exercises mapping and quarantine without contacting customer systems or assuming DDL | Persistent ledger and real source adapter remain a later schema/access gate | Synthetic fixtures and unit tests |
| Connect now to guessed production tables and attempt an import | Could appear end-to-end sooner | DDL, privileges, app configuration, source ownership and provider grants are unconfirmed; risks credential exposure and tenant misassignment | No authorized source evidence exists |

## Decision and consequence

Implement the first option. The M3.11 command reads only the checked-in synthetic snapshot, defaults to dry-run, and rejects apply. The planner emits metadata-only candidates and quarantines uncertainty. It never reads GeneralSettings, raw tokens or unknown fields. Schema v15 adds persistent batch, item and unique source-claim tables. Their adapter commits each fixed metadata-only claim/item outcome with the checkpoint in one transaction; it detects duplicate HMAC identities and quarantines a changed payload or target context. It persists HMAC references, internal target references and fixed classifications only; no source row ID, provider ID, credential or raw payload is stored. The durable claim is explicitly unverified and never creates a trusted `ca_meta_assets`, authorization, grant or relation row. Report identifiers are HMAC references generated from a future operator-supplied key; the local fixture uses an explicitly non-operational test key.

Storage remains behind typed ports. The v15 migration is a separate candidate from M3.03 schema v14; this implementation worktree was based on v13 before the v14 integration completed. Rebase the v15 entry after accepted v14, resolve registry/harness overlap, and validate the complete ordered schema 1–15 chain before acceptance. No live source database adapter or credential writer is part of this package. Any M5 apply requires separately authorized source DDL, read-only snapshot, approved tenant/app map, verified grant evidence, a same-transaction version fence and checkpoint, and a rollback plan.

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
