# ADR-009 · Privacy audit and retention execution boundary

Status: proposed. Issue/spec: #35 / [privacy governance](../specs/privacy-governance.md). Functional owner role: data owner and platform security owner; named owners **Not confirmed**. Evidence SHA/date: implementation candidate evidence pending.

## Contexto comprovado

The API already emits metadata-only HTTP logs, stores append-only identity, replay, and credential audit rows, and keeps credential ciphertext in the backend vault. M1.09 is explicitly a proposal and does not authorize collection or retention durations. The checkout has no runtime policy approval authority for legal retention, backup expiry, key retirement, or provider deletion.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Activate proposed category durations at deploy time | Immediate scheduled cleanup | Treats unapproved design values as production law and risks cross-category deletion | Rejected; M1.09 marks all periods as proposals |
| Add a closed, tenant/environment/category policy registry; keep it empty and fail closed | Supports synthetic execution without enabling production retention implicitly | Only explicitly implemented local categories can run until owners and adapters are approved | Chosen; synthetic MariaDB fixture checks tenant isolation and resume |

## Decisão e consequência

Add a generic metadata-only audit ledger, deletion workflow/tombstone and resumable retention run. Only `MAGIC_LINK_TRANSIENT` has a purge adapter in this package. Policy writes/activation, purge execution, deletion reads/updates and support reads require explicit ports; shipped application wiring denies by default. The M3.06 and M3.07 persistence consumers add their safe lifecycle events to the shared audit ledger. The migration targets schema v12 after the M3.05 v10 and M3.07 v11 milestone sequence; this package branch's starting registry predates that integration and must be reconciled before milestone validation.

## Segurança, efeitos e reversibilidade

- Tenant and authorization boundary: every policy, run, deletion request, tombstone and purge predicate binds an explicit tenant; runtime environment/category are closed values. Cross-tenant fixture is synthetic only.
- Secret and credential boundary: actor and requester references are hashed; deletion targets are hashed; no credential value, ciphertext, request body, provider message or free-text reason enters generic audit.
- Side effects: purge deletes only local expired magic-link mail/link records; a currently processing mail row pauses purge. No external provider request, message, subscription change, backup deletion or key retirement occurs.
- Reversibility: no migration backfill changes existing rows; added tables and append-only triggers are additive. Purged expired transient rows are not restored by application rollback; use the disposable fixture only until a production policy and recovery plan are approved.
- Bounded scope: audit retention/physical purge, inbox/blob deletion, message history, logs, backups and key lifetime remain unsupported until separately evidenced.

## Prova, implantação e recuperação

Planned commands: `npm --workspace=@ca-meta/api run test:m3-10`; disposable database harness: `pwsh -NoLogo -NoProfile -File tools/m3-10/run-retention-tests.ps1`. These tests were not run by the package author. Production DDL equivalence, data-owner/legal approval, real support roles, backup/key restore compatibility and Meta deletion permissions are **Not confirmed**.

## Revisão futura

Revise before enabling any non-test policy, when an approved retention owner supplies versioned periods and legal-hold rules, or when inbox, backup, key-management or provider deletion adapters are added. Update policy schema, category registry, tests and this ADR in the same reviewed scope.
