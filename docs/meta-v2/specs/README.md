# Feature specifications

These specs turn accepted M1 contracts into bounded implementation slices. They are proposed implementation specifications, not evidence of live services or provider eligibility. Resolve their package dependencies and required scenario evidence before marking a slice Ready.

| Feature | Issue trace | Canonical contract / baseline | Executable local evidence |
|---|---|---|---|
| [Compose environments](compose-environments.md) | #29 | [Release-lock contract](../contracts/release-lock.md); ADR-003 jobs and ADR-005 secret custody | `tools/m2-07/` |
| [Authentication](authentication.md) | #15, #17 | `identity-contract.md`; OpenAPI auth and session operations | `tools/m1-06/`, `tools/m1-07/` |
| [Tenancy](tenancy.md) | #11, #14, #15 | `m1-05-domain-model.md`; tenant-scoped endpoint security crosswalk | `tools/m1-02/`, `tools/m1-05/`, `tools/m1-06/` |
| [Credentials](credentials.md) | #14, #16 | domain model; ADR-005; error catalog | `tools/m1-05/`, `tools/m1-09/` |
| [Credential vault](credential-vault.md) | #32 | domain credential model; ADR-008; M3.06 metadata migration | `apps/api/test/m3-07-credential-vault.spec.ts`, M2.05 MariaDB profile |
| [Privacy governance](privacy-governance.md) | #35 | M1.05 audit shape; M1.09 retention proposal; ADR-009 | `apps/api/test/m3-10-privacy.spec.ts`, `apps/api/test/m3-10-privacy.integration.spec.ts` |
| [Meta onboarding](meta-onboarding.md) | #12, #15, #17 | capability matrix; OpenAPI onboarding operations; event schemas | `tools/m1-03/`, `tools/m1-07/` |
| [Webhooks](webhooks.md) | #14, #17 | inbox/outbox event schemas; OpenAPI webhook ingress | `tools/m1-05/`, `tools/m1-07/` |
| [Portal](portal.md) | #18 | M1.08 journey, status-copy, screen/API map | `tools/m1-08/walkthrough.mjs` |
| [Legacy bridge](legacy-bridge.md) | #10, #11, #16 | baseline inventory, field mapping, transition strategy | `tools/m1-01/`, `tools/m1-02/`, `tools/m1-09/` |

### Status interpretation

`proposed` means the document is reviewed design input. `ready` is per implementation slice and requires resolved dependencies, stable contract, measurable acceptance, fixtures, and stage-required evidence. `implemented` means the reviewed code exists but final acceptance may be pending. `verified` requires the exact accepted candidate, relevant tests/reviews, and delivery evidence. All future M2–M6 work stays planned until its issue and evidence say otherwise.
