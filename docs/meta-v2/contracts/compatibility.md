# M1.07 — baseline endpoint compatibility

[`compatibility-matrix.csv`](compatibility-matrix.csv) maps each of the 53 rows in [`docs/baseline/endpoint-matrix.csv`](../../baseline/endpoint-matrix.csv) exactly once to a proposed v1 operation, internal boundary, client-navigation rule or an explicit no-route/unknown decision. Regenerate it with:

```powershell
python tools/m1-07/scripts/generate-compatibility.py
```

The map is based on sanitized source-level inventory only. It is not a deployed PHP/rewrite trace and does not claim response parity. Angular routes are navigation, not API endpoints. Existing frontend requests map to proposed `/api/v1` operations; no Angular runtime behavior changes in M1.07. PHP entrypoints/functions map to proposed server operations or internal-only adapter work. Local sensitive `backend/connect.php` was not inspected; its deployment relationship remains **Not confirmed** and is explicitly excluded from executable mappings.

[`openapi-v1.baseline.yaml`](openapi-v1.baseline.yaml) freezes the initial proposed v1 surface. The package `check:breaking` CI step compares the editable canonical `openapi.yaml` with that snapshot. A breaking change requires an explicit API version/compatibility decision and reviewed baseline update; it is not waived by updating the snapshot without review. A local negative fixture removes a path and proves the checker fails on a breaking difference.

## Compatibility policy

| Policy | Meaning |
|---|---|
| `preserve-navigation` | Keep the named client route/journey for M1.08 review; it makes no API equivalence claim. |
| `preserve-with-tenant-scoped-projection` | Preserve the user-visible capability behind the proposed session/tenant-scoped DTO. |
| `replace-with-contract` | Migrate to the listed operation after its consumer and provider scenario is verified. |
| `replace-with-versioned-contract` | Replace unversioned mutation with `If-Match`/ETag protected update. |
| `replace-with-typed-async-action` | Return 202+Location and an explicit outcome instead of optimistic completion. |
| `preserve-with-scoped-grant` | Keep template management but resolve an eligible grant per tenant/account/operation. |
| `replace-with-async-provider-job` | Accept a request into an async job; provider review/result remains independent. |
| `internal-only` | No public browser route; call only through typed service identity/scope. |
| `exclude-not-confirmed` | No executable mapping until authorized sanitized deployment evidence exists. |

These mappings distinguish a proposed future contract from current observations. Provider permissions, callback URI/rewrite behavior, template review timing, Meta idempotency support, Suite4 issuer/cookies, and deployed PHP routing remain **Not confirmed**. M1.07 does not certify those external contracts.
