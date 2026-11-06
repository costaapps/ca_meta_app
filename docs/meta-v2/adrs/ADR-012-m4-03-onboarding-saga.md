# ADR-012 · Durable Meta onboarding correlation and recovery

Status: accepted. Issue/spec: [#45](https://github.com/costaapps/ca_meta_app/issues/45), [onboarding saga](../specs/onboarding-saga.md). Functional owner role: Meta integration. Evidence SHA: pending package commit; external provider evidence is **Not confirmed**.

## Contexto comprovado

M3.05 supplies a persisted tenant/principal/portal-session-bound onboarding aggregate; M3.06 supplies the asset catalog; M3.07 supplies the credential vault; M2.05 supplies durable jobs. M4.01 pins configuration and supported flow/auth/manifest/Graph versions. A one-time provider code crosses a trust boundary and an uncertain exchange cannot be blindly retried. The accepted M4.03 criterion also requires an operator-visible next action for partial onboarding.

Meta's official Instagram API collection exposes separate documentation sections for Instagram API with Facebook Login and Instagram Login: [Meta Instagram API documentation](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api). This supports keeping the variants separate; it does not prove current grants, review state, callback mechanics or customer eligibility. WhatsApp Embedded Signup runtime behavior, grants and eligibility remain **Not confirmed**.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Keep only opaque status and leave `UNKNOWN` without an action | Small contract | A partial saga can remain stuck or tempt blind replay | Existing onboarding status contract and durable job semantics |
| Resume every failed stage automatically | Simple UX | Can repeat an ambiguous Meta mutation or replay authorization | Rejected by M2.05 `AMBIGUOUS` effect policy |
| Persist only allowlisted checkpoints; reconcile UNKNOWN read-only; require explicit RESUME after proven NO_EFFECT | Recoverable while retaining effect safety | Requires a recovery operation and a new safe next action | M4.03 focused fake-adapter and MariaDB harness |

## Decisão e consequência

Use a durable saga checkpoint whose fields are internal authorization/asset/subscription/projection references only. Store OAuth state as a digest and code as a brief AES-GCM envelope with onboarding-bound AAD; atomically consume and erase the envelope before exchange. Bind every durable step to the original tenant, principal, portal session, exact flow/auth/config and expiry. Callback route slugs map to one exact profile.

Every ambiguous stage remains `UNKNOWN` until a read-only adapter reconciliation identifies `APPLIED`, `NO_EFFECT` or still `UNKNOWN`. Applied evidence advances the checkpoint. Confirmed no effect marks later stages `RETRY_PENDING` and exposes `RESUME`; authorization no-effect requires a new authorization. `RESUME` is accepted only for asset verification, subscription or projection after its prerequisites are present. A bounded automatic retry is allowed only for explicit typed no-effect evidence.

The provider adapter remains an injected boundary. Runtime currently registers no adapter and returns unavailable for launch/code processing; this is an explicit gate for dependent M4 flows, not evidence of live Meta behavior.

## Segurança, efeitos e reversibilidade

- **Tenant and authorization boundary:** server-resolved current tenant plus original session/principal; SQL revalidates current session, membership and owner/admin/operator role both when queuing recovery and immediately before worker calls.
- **Secret custody:** state is digested; code exists encrypted briefly and in memory for a single exchange; no raw code/token/provider body enters a job or checkpoint. Adapter token persistence must use M3.07 vault.
- **Async effects:** job and state transition are one transaction; idempotency is tenant/action scoped. Ambiguous mutation is never replayed. Reconciliation is read-only; retry is enabled only after proven no effect.
- **Migration and rollback:** additive schema 16 adds pinned config context, saga evidence, a tenant candidate key, an explicit `RESUME` enum member and the code-envelope table. Rollback must retain unresolved/consumed records and must not restore code material or delete prior connection assets.
- **Scope:** actual Meta provider adapters, app review, customer eligibility, active grants and deployed callback/web-server rewrite are outside this issue's confirmed evidence.

## Prova, implantação e recuperação

Focused unit and gated MariaDB integration tests are authored under `apps/api/test/m4-03-*`; run with `npm run test:m4-03 --workspace=@ca-meta/api`. The authoring worktree has not run tests/build/CI; the coordinator owns the one final candidate gate and exact-SHA review. The harness uses synthetic values and no Meta credentials. Migration is not deployed. Production provider grants, eligibility and callback delivery are **Not confirmed**.

## Revisão futura

Replace adapter limitations when M4.04–M4.13 provide independently reviewed flow implementations. Revisit retry semantics only when a flow adapter documents an idempotency guarantee or has a verified reconciliation query; never generalize one flow's grant/callback semantics to another.
