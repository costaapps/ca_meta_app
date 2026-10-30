# SPEC · delivery/immutable-container-releases

Status: implemented locally; candidate validation pending. Issue: [M2.09 / #33](https://github.com/costaapps/ca_meta_app/issues/33). Contract/version: [release manifest v1](../contracts/release-manifest.md) and [schema](../contracts/release-manifest.schema.json); Compose lock v1/schema-v3 compatibility from M2.07. Functional owner: DevOps / delivery engineering (operator not assigned). Evidence SHA: pending package commit; no registry release has been published.

## Problem and intended behavior

Build web and API images from one source SHA, preserve their digest identity through promotion and rollback, and publish an auditable manifest only after the complete pair passes required checks. The worker uses the API digest and the M2.07 command. Publication runs only from a stable SemVer Git tag already reachable from `develop` and only after the protected Docker Hub environment is configured.

## Invariants and external boundaries

- The release tag is `vMAJOR.MINOR.PATCH`. Image aliases are `MAJOR.MINOR.PATCH` and `sha-<full SHA>`; production references always use `repository@sha256:digest`.
- Both image OCI labels, BuildKit provenance and GitHub signed attestations must match the same source revision/tag. Both images have to pass the exact M2.08 checks and pinned Trivy HIGH/CRITICAL policy.
- Neither image is promoted to immutable aliases until both images have been built, scanned and attested. Manifest creation is downstream of both successful promotions.
- A retry accepts an existing alias only if its digest is consistent with the other alias, runtime labels, BuildKit source provenance and an existing GitHub signature for the exact source. A missing alias is created as a copy of the verified OCI index and must retain the same digest. A conflicting tag fails closed.
- No registry namespace, username/token, target CPU, image tag immutability rules, protected tag rules, GitHub environment reviewers, retention configuration or staging host is assumed to exist. The workflow checks explicit environment gates before login.
- Secrets are only Docker Hub username/token supplied to the protected GitHub environment. They are not build arguments, artifacts or logs. The workflow has no pull-request trigger and never receives Meta or tenant configuration.

## Verifiable scenarios

| ID | Given | When | Then | Evidence/harness |
|---|---|---|---|---|
| M2.09-AC01 | A complete synthetic manifest with schema v3, two distinct digest-pinned images and the same source | Run the manifest checker | It is accepted; releaseId matches stable SemVer plus the source SHA prefix; worker/API digest is exact | `tools/m2-09/test-release-contract.mjs` |
| M2.09-AC02 | A manifest missing either web or API digest | Validate the manifest | It is rejected and cannot be published as a complete release | Synthetic partial-image fixture in the M2.09 harness |
| M2.09-AC03 | An alias already points to a different digest or source | Retry release publication | The workflow fails without changing the existing immutable tag or producing a new manifest | `release-pipeline.mjs` tag/digest/source gates; registry run requires external authorization |
| M2.09-AC04 | Web and API are scanned/attested on one exact source commit | Promote and create manifest | Both SemVer and full-SHA aliases resolve to the verified digests; manifest records checks, SBOM, provenance, worker command and changelog | `.github/workflows/release.yml`; Docker Hub/GitHub evidence is external and pending |
| M2.09-AC05 | A previously complete release manifest and a compatible current schema | Select that manifest for install/rollback | A new Compose lock contains the same image digests; incompatible schema is rejected before deployment | `tools/m2-09/select-release.ps1` and M2.07 Compose runbook |

## Rollout and recovery

The release workflow publishes candidate tags first. It scans and verifies both digests before assigning the immutable SemVer/SHA aliases. If only one release alias exists after interruption, a retry verifies and reuses that digest, then creates the missing alias without rebuilding it. If the tag has a conflicting digest, stop; do not delete or replace it automatically. If the GitHub Release upload is partial, the next attempt verifies the signed existing manifest and uploads only missing assets; existing assets are never clobbered.

Promotion and rollback consume the same manifest and Compose lock. They do not rebuild or republish images. A caller provides the schema version read from the target database's migration ledger; the selector refuses a manifest whose declared compatibility range excludes it. The script writes a lock only; the M2.07 runbook remains responsible for pull, migration gate and service promotion. MariaDB DDL, jobs and provider effects are not rolled back by selecting an older image.

## Validation and evidence

The local contract harness is `node tools/m2-09/test-release-contract.mjs` and requires the repository's Node 24 toolchain (`.nvmrc`, npm 11.19.1). It uses the built-in Node runtime only; M2.09 adds no npm dependencies or lockfile changes. The fixture is synthetic and checked in memory, so it needs no service, registry or cleanup. The coordinator runs it once on the stable package SHA. The release workflow itself is not executed as part of this package PR because Docker Hub namespace/credentials and target infrastructure have not been confirmed. The workflow's first real publication must run from an authorized protected environment and produce exact SHA-specific evidence before #33 can be considered fully accepted.
