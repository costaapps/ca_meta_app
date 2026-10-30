# ADR-007 · Release credential boundary and attested digest retries

Status: proposed. Issue/spec: [M2.09 / #33](https://github.com/costaapps/ca_meta_app/issues/33), [immutable container releases](../specs/immutable-container-releases.md), [release manifest contract](../contracts/release-manifest.md). Functional owner role: DevOps / delivery engineering (operator not assigned). Evidence SHA/date: candidate changes in progress; exact commit and validation pending.

## Context comprovado

The M2.09 release workflow uses a Docker Hub token to build/push candidate images and promote immutable aliases. The prior implementation stored that token in `DOCKER_CONFIG` while checkout-controlled Node helpers inspected, exported and promoted images. It also accepted an existing alias after checking OCI labels and BuildKit evidence, then generated GitHub attestations later in the retry. That did not prove the required GitHub signature already existed for a reused digest.

Docker Hub namespace, repository visibility, token scope, immutable tag rules, GitHub environment reviewers, tag protection, and GitHub artifact-attestation eligibility are **Not confirmed**. No registry publication or shared staging action is authorized by this decision.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| Keep the registry token in the job and run Node helpers after login | Small workflow | Checkout code can read the recoverable Docker credential; helper correctness becomes a secret boundary | M2.09 static security review identified this exposure |
| Use a Docker credential helper for the full job | Reduces plaintext config content | Checkout code can still invoke the helper while the credential is available | Runner does not provide a durable trusted credential store; no external provider confirmed |
| Scope registry operations to direct Docker/Buildx and `gh` commands in short authenticated steps | No checkout helper runs while Docker config exists; digest and signature checks remain visible in workflow | Inline shell is less reusable; syntax and behavior require CI and eventual authorized registry evidence | Selected for M2.09; candidate validation pending |
| Re-attest any digest found at an existing release alias | Ensures an attestation exists afterward | Can create new provenance that misrepresents a digest this attempt did not build | Rejected; retry contract requires pre-existing exact-source signatures |

## Decisão e consequência

The workflow keeps Docker Hub authentication in a step-local `DOCKER_CONFIG` under the runner temporary directory. While it exists, that step runs only inline shell, the installed Docker/Buildx and GitHub CLI, `jq`, and hashing utilities; it does not execute repository Node helpers or upload artifacts. Docker Hub variables are unset after login, and the config is removed by an exit trap before the next step.

Before a reused digest is exposed as a build-job output, the authenticated registry step verifies both GitHub provenance (`https://slsa.dev/provenance/v1`) and SPDX (`https://spdx.dev/Document`) attestations for the exact repository, release workflow, source SHA, tag and digest. Downstream, new digests receive GitHub attestations only after both scans pass; every digest is reverified before immutable tags are promoted. Reused digests are not described as newly built by the retry.

The manifest points to a GitHub attestation summary URL for a newly created attestation. For a reused digest, it points to the current release workflow run that performed exact-source verification. The official CLI verification JSON and repository attestations API do not document a stable summary URL for an existing attestation; a temporary signed bundle URL is not used.

## Segurança, efeitos e reversibilidade

- Tenant and authorization boundary, including a negative cross-tenant case: release-only; no tenant data or identifiers are sent to the build.
- Secret and credential custody/rotation boundary: only the Docker Hub username/token from the protected GitHub environment; no Meta credentials. Token scope/rotation is **Not confirmed** externally.
- Async or external side effects, duplicate/retry and unknown-outcome handling: an existing alias must match both immutable tags and exact-source attestations; conflicting or unattested aliases fail closed. GitHub release assets are verified before retry and never clobbered.
- Reversible switch, migration writer/checkpoint, abort and rollback: changes are confined to the release workflow and manifest evidence URL semantics; production rollout remains gated by M2.07 digest lock and operator controls.
- Bounded decision scope and explicit non-goals: no real Docker Hub publication, no environment or ruleset configuration, and no staging deployment.

## Prova, implantação e recuperação

Focused contract and secret-scanner validation plus GitHub CI will be attached to the exact candidate SHA. Static-only functional and security reviews must be repeated against that SHA. A successful code PR does not confirm registry publication, token scope, immutable tag rules, environment reviewers or staging; those require a later authorized run.

## Revisão futura

Revisit if GitHub documents a stable link for a previously created image attestation, if registry authentication can be supplied by a trusted short-lived mechanism, or if the repository adopts a trusted reusable workflow that removes caller-controlled code from the credential boundary.
