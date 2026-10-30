# M2 deployment inventory

Status: template and blocker inventory only. No staging host, provider access, secrets or Meta resources were supplied. All real values below are Not confirmed.

Keep the operator-filled copy outside the repository. Record opaque identifiers and evidence links only; never record app secrets, access tokens, database passwords, verify tokens, raw customer data or production environment values.

| Resource / control | Staging record | Evidence required | Status |
|---|---|---|---|
| Host / platform / region | Not selected | Provider/account owner, supported runtime, region and budget decision | Not confirmed |
| Public DNS zone / staging hostname | Not selected | DNS owner, delegation/record change and external resolution result | Not confirmed |
| TLS certificate / termination | Not selected | Issuer, SAN/hostname match, expiry/rotation owner and external chain validation | Not confirmed |
| Ingress / firewall / proxy | Not selected | Public entrypoint, allowed paths/methods, source policy, trusted proxy CIDRs, headers and body bounds | Not confirmed |
| Staging database | Not provisioned | Resource reference distinct from production, grants, schema version, backup and restore evidence | Not confirmed |
| Staging tenant catalog | Not provisioned | Synthetic/test-only tenant source, ownership and cleanup procedure | Not confirmed |
| Secret manager | Not selected | Runtime identity, least-privilege access, names of staged secret records, rotation, recovery and audit | Not confirmed |
| Meta app configuration | None recorded | Owner and opaque app-config reference per product/variant; approved redirect URI, webhook config and permission evidence | Not confirmed |
| Authorized test assets | None recorded | Authorized Page, Instagram professional account, WhatsApp exclusive test assets and Coexistence active-app resources; consent and cleanup | Not confirmed |
| Release manifest / release lock | Synthetic fixtures only | M2.09 verified manifest, matching digest-pinned M2.07 lock and required CI/check evidence | Not confirmed |
| Callback runtime | Contract only | Live GET callback route, bounded state handling, redirect allowlist and callback round-trip evidence | Not confirmed |
| Webhook runtime | Contract only | GET verification, POST raw-body signature verification, delivery/retry evidence and per-app config mapping | Not confirmed |
| Deauthorization route | Not defined | Accepted contract path/semantics, app ownership and provider verification evidence | Not confirmed |
| Data-deletion route | Not defined | Accepted contract path/semantics, privacy response, verification and retention evidence | Not confirmed |
| Observability / clock | Not provisioned | Safe log fields, correlation policy, synchronized clock, alert owner and retention | Not confirmed |
| Production boundary | No read/write performed | Separate resource refs; explicit writer/callback ownership; confirmation existing Hostinger remains active and untouched | Not confirmed |

## Product configuration matrix

| Journey | Config record needed | Runtime/test resources | Availability |
|---|---|---|---|
| Facebook | Facebook Login config selected server-side; no browser app secret | Authorized Page/test identity and callback/webhook config | Not confirmed |
| Instagram | Separate configuration reference and availability record for `INSTAGRAM_VIA_FACEBOOK_LOGIN` and `INSTAGRAM_LOGIN`; select and assess each variant independently | Variant-appropriate authorized professional account and grant; the records may refer to the same Meta app only when the configuration owner confirms it supports both | Not confirmed |
| WhatsApp exclusive | WHATSAPP_CLOUD_API config | Dedicated non-production WhatsApp test business/number, with consent before any message | Not confirmed |
| WhatsApp Coexistence | WHATSAPP_COEXISTENCE config kept distinct from exclusive-number setup | Authorized active-app number, QR/consent and suitable Coexistence test resources | Not confirmed |

The spec does not assume that two product flows share an app, resource or credential family. Nor does it require four distinct Meta app IDs; the authorized configuration owner must prove which app/config is appropriate per flow.

## Callback inventory

| Contract route | Methods | Role | Current status |
|---|---|---|---|
| /api/v1/meta/{variant}/callback | GET | OAuth/Embedded Signup return correlated by one-use server state; path segment is currently facebook/instagram/whatsapp | OpenAPI only; no runtime handler |
| /api/v1/webhooks/meta/{appConfigRef} | GET | Configured verification challenge; appConfigRef is public opaque reference, not a secret | OpenAPI only; provider semantics Not confirmed |
| /api/v1/webhooks/meta/{appConfigRef} | POST | Raw-body signature-verified bounded webhook ingress | OpenAPI only; Meta signature/event schemas Not confirmed |
| Not defined | Not defined | Deauthorization callback | Contract and runtime route Not confirmed |
| Not defined | Not defined | Data deletion callback | Contract and runtime route Not confirmed |

Do not publish callback URLs until a verified runtime, DNS/TLS ingress, configured app/variant, signature secret reference, owner and external smoke exist. App-level webhook config and subscription per asset have separate owners and evidence.
