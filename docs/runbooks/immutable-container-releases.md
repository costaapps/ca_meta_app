# Runbook · immutable container release, promotion and rollback

This runbook describes the workflow implemented for M2.09. **No Docker Hub release or staging installation has been executed.** Docker Hub namespace/credentials, target architecture, tag rules, GitHub environment protection, staging host and secret manager are **Not confirmed**. Do not enable the protected release gate until an administrator verifies each matching external setting.

## Release contract

- Git tag: stable SemVer `vMAJOR.MINOR.PATCH`. Pre-releases are rejected until the M2.07 release-lock contract is reviewed to support them.
- Docker Hub repositories: `docker.io/<confirmed-namespace>/ca-meta-web` and `docker.io/<confirmed-namespace>/ca-meta-api`.
- For each image the workflow uses an unpromoted, per-run candidate tag, then writes two immutable aliases: `MAJOR.MINOR.PATCH` and `sha-<full 40-character source SHA>`. `latest` is not produced and cannot appear in a release manifest.
- Release ID and filled Compose lock: `MAJOR.MINOR.PATCH+<first 12 lowercase source SHA hex>`, matching the M2.07 schema-v3 lock contract.
- Target platform currently pinned to `linux/amd64`. The release gate requires the protected environment variable `DOCKERHUB_TARGET_PLATFORMS=linux/amd64`; verify that this matches the actual staging/production hosts first. ARM is not built or supported by this workflow.
- Worker uses the API digest with the command from `infra/compose.yaml`. The manifest records the current OpenAPI contract version and SHA256; it does not claim that the proposed contract is deployed.

## Configure the release environment

The release workflow `.github/workflows/release.yml` is triggered by a pushed `v*` tag and has no pull-request trigger. The build job checks the exact source SHA against the successful `desktop-candidate`, `m2-08-mariadb`, `m2-08-security` and `m2-08-images` check runs, and verifies that the release commit is already reachable from `develop`. It pushes candidate digests and exports those images plus SBOM/provenance evidence as short-lived artifacts. The separate `scan-images` job has only `contents:read`, no Docker Hub credentials, no job-wide `GH_TOKEN`, and no OIDC/signing permissions; it verifies archive checksums and scans the exported image archives. A downstream protected job signs the verified digests, then promotes them and writes the release manifest. The `dockerhub-release` environment protects both jobs that authenticate to Docker Hub, so repository administrators should confirm the resulting approval sequence when configuring its reviewers.

Before the first release, an administrator must configure GitHub environment `dockerhub-release` with required reviewers and:

| Setting | Type | Required value/meaning |
|---|---|---|
| `DOCKERHUB_RELEASE_ENABLED` | environment variable | `true` only after the repository and credential scope are verified |
| `DOCKERHUB_NAMESPACE` | environment variable | Exact authorized Docker Hub owner/organization namespace |
| `DOCKERHUB_IMMUTABLE_TAGS_CONFIRMED` | environment variable | `true` only after repository rules below have been verified |
| `DOCKERHUB_TARGET_PLATFORMS` | environment variable | `linux/amd64` only if the selected hosts are confirmed amd64 |
| `DOCKERHUB_USERNAME` | environment secret | Dedicated least-privilege publishing identity |
| `DOCKERHUB_TOKEN` | environment secret | Rotatable token scoped to the two target image repositories |

Keep Docker Hub credentials out of repository variables, files, image build arguments and workflow text. The workflow maps the username/token only into the Docker Hub login steps, pipes the token to `docker login --password-stdin`, uses an ephemeral Docker config directory, removes it before uploading scan inputs and before the isolated scanner runs, and cleans it again at job end. Rotate the token through the approved operator path. No credential value is committed or printed.

Configure immutable tags in Docker Hub for both image repositories before enabling publication. The tag regex should match only the SemVer and full-SHA aliases:

```text
^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$|^sha-[0-9a-f]{40}$
```

Docker documents immutable tags as Beta and says tags are mutable by default. Verify current feature availability and both repository settings directly; this checkout cannot confirm them. Also protect `v*` Git tags with the repository's ruleset and ensure only the authorized release path can create them. The existence of this workflow does not prove that GitHub branch/tag protection or environment reviewers are enabled.

GitHub artifact attestations sign image provenance and the SPDX SBOM using GitHub Actions/Sigstore. BuildKit also embeds SPDX SBOM and SLSA provenance in each OCI index. The workflow verifies the GitHub signature identity, source tag and full source SHA before promotion, and checks OCI source/revision labels plus the BuildKit revision metadata. Docker documents local-directory BuildKit VCS fields as metadata hints rather than verified source input, so the signed GitHub attestation is the source identity proof. GitHub stores these attestations; Docker Hub stores the image digests. A private repository requires GitHub Enterprise Cloud for artifact attestations; a public repository supports them on all current plans. The repository's effective visibility/plan and successful verification remain **Not confirmed** until the first authorized run.

## Release flow

After external settings are confirmed and a candidate has landed in `develop`:

1. Create and push one stable SemVer tag at the exact candidate commit, for example `v1.2.3`. Tag creation remains behind GitHub's protected tag rules.
2. Review the protected `dockerhub-release` environment gate. The workflow verifies source ancestry and the four required M2.08 checks before Docker login.
3. The workflow builds web and API from the exact tagged SHA with OCI revision/version labels, `--provenance=mode=max,version=v1`, and `--sbom=true`. Build arguments contain only the SemVer and source SHA. It builds `linux/amd64` only.
4. It extracts and records the BuildKit provenance and runtime image SBOM, exports the digest-resolved images as archives, and records each archive checksum with its image digest/source SHA. The unprivileged `scan-images` job checks those checksums and scans the archives with pinned Trivy 0.76.1; HIGH and CRITICAL findings fail the job, and unfixed findings are not suppressed.
5. It creates and verifies GitHub/Sigstore provenance and SPDX attestations for both digests. Only after both image gates pass does it assign immutable SemVer and full-SHA tags. `docker buildx imagetools create` copies the verified OCI index; the resulting digest must stay identical.
6. The workflow generates release notes and writes `release-manifest.json` plus `release-lock.env`. It checks the manifest, checks the lock with M2.07's `check-release-lock.ps1`, signs/verifies the manifest and publishes the complete set as GitHub Release assets. No manifest is published after only one image push or a failed scan/attestation.

The release assets include the manifest, schema-v3 lock, generated changelog, `scan-results.json`, two SPDX SBOMs, two BuildKit provenance documents and two Trivy reports. The scan-results asset records each scanned image name/reference/digest and binds its report checksum; the signed manifest repeats the image scan identity and hashes the scan-results asset. Use [the release-manifest contract](../meta-v2/contracts/release-manifest.md) as the source of field meanings.

If a run fails before promotion, candidate tags are not deployment inputs. A retry uses new per-run candidate tags. If a SemVer or SHA alias was already written during a partial final promotion, the retry verifies and reuses that digest and creates only the missing alias. It refuses conflicting digests and does not overwrite tags. Existing GitHub Release assets are never clobbered; a retry uploads only missing assets after verifying any existing signed manifest.

Candidate tags are not deployment references. Keep them until release recovery is complete. Keep every immutable alias referenced by a release manifest and retain the manifest; do not configure time-based deletion for those objects. Prune unreferenced candidate tags only through a separate reviewed cleanup. No registry retention policy is currently observed or configured; image storage cost/limits are **Not confirmed**.

## Verify and select a release

Download the GitHub Release manifest, lock, `scan-results.json`, SBOMs, provenance and reports from the authorized GitHub account. Verify the signed manifest and image attestations before selecting a lock:

```sh
node tools/m2-09/verify-release-assets.mjs /secure/ca-meta/release-assets

gh attestation verify release-manifest.json \
  --repo costaapps/ca_meta_app \
  --signer-workflow costaapps/ca_meta_app/.github/workflows/release.yml \
  --source-digest <full-source-sha> \
  --source-ref refs/tags/v<major>.<minor>.<patch>

gh attestation verify oci://docker.io/<namespace>/ca-meta-web@sha256:<web-digest> \
  --repo costaapps/ca_meta_app \
  --signer-workflow costaapps/ca_meta_app/.github/workflows/release.yml \
  --source-digest <full-source-sha> \
  --source-ref refs/tags/v<major>.<minor>.<patch>
```

Repeat the image command for the API image. Verify the SPDX SBOM attestations with `--predicate-type https://spdx.dev/Document`. Registry login is required to retrieve private images; GitHub access is required to retrieve GitHub attestations. The SHA references above are placeholders, not release evidence.

Before selecting a lock, read the current schema version from the authorized target database migration ledger and pass it explicitly. The script only creates a lock; it does not pull images, access the DB, or deploy:

```powershell
pwsh -NoProfile -File tools/m2-09/select-release.ps1 `
  -ManifestPath C:\secure\ca-meta\release-manifest.json `
  -CurrentSchemaVersion 3 `
  -OutputLockPath C:\secure\ca-meta\release-lock.env

pwsh -NoProfile -File tools/m2-07/check-release-lock.ps1 `
  -Path C:\secure\ca-meta\release-lock.env
```

Keep environment-specific `compose.prod.env`, secret files and database settings outside the repository. The lock has only release identity, image digests and schema bounds. Never place registry or database credentials in the manifest or lock.

## Promote and rollback

Follow the migration gate, backup, pull and health steps in [the M2.07 Compose runbook](compose-environments.md). Use the same manifest-derived lock for staging and production; do not rebuild or retag images between environments. If no staging host and separate DB/secrets are authorized, stop before deployment. DNS/TLS, public callbacks, ingress/firewall, secret management, database isolation and Meta resources remain **Not confirmed** and are tracked by M2.10.

For rollback, select the earlier signed manifest and run the same compatibility check using the **current** schema version. The script rejects a schema outside the prior release's declared bounds. Promote the prior digest through the M2.07 health gate. Never revert migration ledgers or delete volumes as an image rollback. If compatibility is absent or uncertain, leave traffic gated and use a reviewed forward-fix or isolated restore process. Container rollback does not undo Meta actions or revive revoked credentials.

## Current external gates

- Docker Hub namespace, repository ownership, minimum-scope credential, immutable tag settings and retention policy: **Not confirmed**.
- GitHub tag ruleset, protected environment reviewer configuration and artifact-attestation capability for this repository account: **Not confirmed**.
- Deployment platform/CPU, staging hostname/DNS/TLS/ingress, private database and secret manager: **Not confirmed**.
- No image was published, no manifest was created from a real image, and no staging/production installation or rollback was performed in this package.

References checked 2026-10-30: [Docker Hub immutable tags](https://docs.docker.com/docker-hub/repos/manage/hub-images/immutable-tags/), [BuildKit provenance](https://docs.docker.com/build/metadata/attestations/slsa-provenance), [BuildKit SBOMs](https://docs.docker.com/build/metadata/attestations/sbom/), [imagetools create](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), and [`gh attestation verify`](https://cli.github.com/manual/gh_attestation_verify).
