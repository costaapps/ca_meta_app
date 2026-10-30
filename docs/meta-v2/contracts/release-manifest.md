# CA Meta release manifest contract

Status: implemented locally; publication and staging installation remain **Not confirmed**. Issue: [M2.09 / #33](https://github.com/costaapps/ca_meta_app/issues/33). Schema: [`release-manifest.schema.json`](release-manifest.schema.json). Compose compatibility contract: [`release-lock.md`](release-lock.md), schema v3.

## Release identity

- Git release tags are stable SemVer `vMAJOR.MINOR.PATCH`. Pre-release tags are not accepted because the current M2.07 lock checker accepts stable SemVer only.
- Docker Hub gets separate web/API repositories, each with the immutable SemVer tag `MAJOR.MINOR.PATCH` and immutable `sha-<full 40-character source SHA>` tag. No `latest` tag is created or used.
- `releaseId` is the stable SemVer plus `+` and the first 12 lowercase hexadecimal characters of `sourceRevision`, exactly matching the M2.07 lock contract.
- The only deployable references are `docker.io/<namespace>/ca-meta-web@sha256:<digest>` and `docker.io/<namespace>/ca-meta-api@sha256:<digest>`. Web/API labels and provenance must identify the same full source SHA.
- Worker runs the API image with the exact command declared by the M2.07 Compose service. It does not get a third image.

## Required evidence and invariants

The manifest records contract version and checksum, exact DB schema compatibility range, required M2.08 check-run URLs, web/API digests, verified image/SBOM attestations, Trivy scan identities and report checksums, worker command and generated changelog. Each attestation URL points to its GitHub summary page when created in the current release run; for a reused digest, it points to the release run that verified the existing attestation, since GitHub's verification output does not provide a documented stable summary URL for older attestations. The `scan-results.json` asset records the exact web/API names, references, digests, source SHA, archive checksums and report checksums. The scan job verifies references against build outputs, and the privileged post-scan job checks the reports against those same outputs before it generates the manifest. `tools/m2-09/verify-release-manifest.mjs` checks cross-field invariants; `tools/m2-09/verify-release-assets.mjs` checks exported SBOM, BuildKit provenance, scan-results and Trivy report checksums against the signed manifest, confirms each lock field matches that manifest, and can compare an existing signed manifest with a retry. `tools/m2-07/check-release-lock.ps1` validates the Compose lock derived from the same manifest.

The manifest is published only after both image digests exist, both scans pass, BuildKit SBOM and SLSA provenance are present with the expected revision metadata, GitHub Sigstore provenance/SBOM attestations verify for the exact source/tag, and the immutable SemVer/SHA aliases resolve to the same digests. GitHub's signed attestations and the runtime OCI source/revision labels provide the repository/SHA binding because BuildKit documents local-directory VCS metadata as a hint rather than verified source input. A web-only or API-only push never creates a complete manifest. The manifest itself gets a GitHub Actions/Sigstore attestation.

BuildKit creates an SPDX SBOM from the final image stage by default. The release workflow records that runtime image SBOM; it does not claim that the SBOM inventories dependencies present only in earlier build stages. Its SLSA provenance is generated with `mode=max`; only non-secret OCI version and revision build arguments are passed. Build-time secrets and Meta/tenant configuration do not enter the build.

GitHub attestations are stored with GitHub, not Docker Hub. Verification requires GitHub access as well as registry access. The workflow fails closed if the attestation action or GitHub CLI verification is unavailable. Artifact-attestation availability depends on repository visibility/plan; GitHub documents support for public repositories and Enterprise Cloud private/internal repositories. The effective repository plan and verification service are **Not confirmed** until a release run succeeds.

## Tag immutability and retention

Docker Hub tags are mutable by default. An administrator must configure immutable tag rules for `MAJOR.MINOR.PATCH` and `sha-<40 lowercase hex>` tags before setting the protected `DOCKERHUB_IMMUTABLE_TAGS_CONFIRMED=true` environment variable. Docker Hub currently documents immutable-tag support as Beta; this repository's namespace and effective feature availability are **Not confirmed**. The workflow detects a tag that already points to a different digest and refuses to overwrite it; that check does not substitute for the registry-side immutable-tag rule.

Keep every immutable tag referenced by a published manifest, and retain the manifest itself. Do not apply automatic deletion to those digests. Candidate tags include the source SHA and workflow run/attempt; they are never promotion inputs. Remove unreferenced candidate tags only in a separate, reviewed registry cleanup after the release is complete. No current Docker Hub retention policy has been observed or configured.

## Source references

- [Docker Hub immutable tags](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/) (Docker documents the feature as Beta; current defaults are mutable).
- [BuildKit attestations](https://docs.docker.com/build/metadata/attestations/), [SBOM scope](https://docs.docker.com/build/metadata/attestations/sbom/) and [SLSA provenance](https://docs.docker.com/build/metadata/attestations/slsa-provenance).
- [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) and [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify).

Sources were checked on 2026-10-30. They document the product features; they do not prove this repository's Docker Hub, ruleset, secrets, GitHub plan, environment protection or staging configuration.
