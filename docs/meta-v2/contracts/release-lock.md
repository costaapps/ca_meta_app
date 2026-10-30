# Compose release-lock contract

Status: implemented as a template/checker; no published M2.07 release exists. Issue: [M2.07 / #29](https://github.com/costaapps/ca_meta_app/issues/29). Feature spec: [Compose environments](../specs/compose-environments.md). Compose files: `infra/compose*.yaml`.

## Required fields

The protected, filled `release-lock.env` is key/value text consumed by Compose's `--env-file`. The tracked `infra/release-lock.env.example` is not a usable release. Each key occurs once; values are nonempty and placeholders are rejected by `tools/m2-07/check-release-lock.ps1`.

| Key | Type / invariant |
|---|---|
| `RELEASE_ID` | SemVer plus `+` and the first 12 lowercase hex characters of `SOURCE_REVISION`. |
| `SOURCE_REVISION` | Full lowercase 40-hex Git SHA whose source was built and checked. |
| `CA_META_WEB_IMAGE` | Distinct web registry image reference ending `@sha256:<64 lowercase hex>`. |
| `CA_META_API_IMAGE` | API registry image reference ending `@sha256:<64 lowercase hex>`; the worker uses this same image with its worker command. |
| `WEB_SOURCE_REVISION` | Must equal `SOURCE_REVISION`; must also match image build provenance/OCI label through the M2.09 release gate. |
| `API_SOURCE_REVISION` | Must equal `SOURCE_REVISION`; must also match image build provenance/OCI label through the M2.09 release gate. |
| `SCHEMA_VERSION` | `3` for the M2.07 candidate image/schema. |
| `SCHEMA_MIN_COMPATIBLE` | `3` until a wider compatibility range is verified. |
| `SCHEMA_MAX_COMPATIBLE` | `3` until a wider compatibility range is verified. |

The release validator checks required fields, no unresolved placeholders, image digest syntax, source SHA consistency and the current exact schema-v3 range. It does **not** authenticate signatures, registry permissions, SBOM, OCI labels, build provenance or the DB's actual schema. Release automation must record and verify those facts before materializing a filled lock. Registry namespace, actual web/API digests and a released source SHA remain **Not confirmed** until M2.09 publishes the images.

## Promotion semantics

The `prod` override requires both image references from one filled lock and does not build from checkout source. The operator checks the lock and uses the same lock for image pull, one-off migration and service promotion. A failed migration exits before the promotion command; API/worker also wait for migration completion in Compose. The compatibility bounds determine whether a prior API image is eligible for rollback after schema changes; they do not authorize destructive/contract migrations. MariaDB DDL can implicitly commit.

The lock contains no secret or environment-specific DB host. Secret file paths, host allowlist, proxy ranges, DB accounts and public ingress are supplied in protected environment configuration, separately per environment. Do not store token/config values or secret bytes in this file.
