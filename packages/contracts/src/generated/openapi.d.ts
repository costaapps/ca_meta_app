/* Generated from docs/meta-v2/contracts/openapi.yaml. Do not edit by hand. */
export interface paths {
    readonly "/api/v1/auth/preauth": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Start browser-bound pre-authentication
         * @description Public before a portal session. Requires an exact allowlisted Origin, matching Fetch Metadata, and an HttpOnly pre-auth cookie bound to the server-created challenge. The challenge is for a trusted portal-entry handoff, not a Meta provider code. PORTAL_TOP_LEVEL uses a SameSite=Lax host-only cookie. SUITE4_EMBED is enabled only when an exact HTTPS Suite4 parent-origin allowlist is configured; its host-only pre-auth cookie is SameSite=None, Secure and Partitioned. The browser still must pass the exact portal/app Origin and same-origin Fetch Metadata checks. Empty embed-origin configuration rejects SUITE4_EMBED with 400.
         */
        readonly post: operations["startPreauth"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/auth/exchanges": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Exchange a portal-entry ticket for a portal session
         * @description Public in the sense that no session exists yet; protected by a pre-auth cookie and one-time signed ticket. This exchange is distinct from Meta OAuth/Embedded Signup callback handling and MUST NOT accept an authorization code. Ticket, browser challenge, pre-auth cookie/browser binding, current server membership, issuer and audience must match atomically. The `tenant` claim is revalidated; `company_uuid` is ignored. Set-Cookie returns the opaque portal session; the JSON DTO contains no session cookie, Meta credential, or ticket. An exact retry after a lost response (same ticket/JTI, challenge, and pre-auth browser binding) may recover only the same still-active session; it creates or renews no session and fails after session, membership, or tenant revocation/expiry. A different cookie or challenge is denied. When the trusted issuer or server-configured public key set is unavailable, the endpoint returns a safe 503 and issues no session.
         */
        readonly post: operations["exchangePortalEntryTicket"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/auth/magic-links": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Request a sign-in link
         * @description Public and rate-limited. The response is uniform for known and unknown identities. The server sends only to an already invited identity and does not create a membership. No address or delivery status is reflected in the response. Email enqueue is deduplicated by the rate-limit bucket and request fingerprint.
         */
        readonly post: operations["requestMagicLink"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/auth/magic-links/confirm": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Show an explicit sign-in confirmation page
         * @description Safe for email scanners. GET only renders a no-referrer, no-store page with a deliberate POST action; it does not look up or consume the link and never creates a session.
         */
        readonly get: operations["showMagicLinkConfirmation"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        /** Probe the confirmation page without consuming a link */
        readonly head: operations["probeMagicLinkConfirmation"];
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/auth/magic-links/consume": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Consume a sign-in link after explicit user confirmation
         * @description Public before session creation. POST only; GET/HEAD do not consume. Requires exact Origin and one-use link token. Tenant and membership are read from the token record and current server state, never from request tenant fields.
         */
        readonly post: operations["consumeMagicLink"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/session": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Read the current session context
         * @description Returns public identity, current tenant context and role names only. Membership is revalidated server-side. No token, cookie value, authorization code, ciphertext or provider credential is returned. CSRF material, if bootstrapped, is delivered as a separate cookie/header protocol and is not a DTO field. `sessionRef` is a public opaque selector for revocation and authorizes nothing without the current server session, principal and tenant.
         */
        readonly get: operations["getSession"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/session/tenant-switch": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Switch to another current membership
         * @description Tenant selection is a request to check current membership, never authority. Rotates tenantContextRef/contextVersion. Existing onboarding sessions/jobs retain their original server-resolved tenant and principal. Requires current context, exact Origin, CSRF and allowed Fetch Metadata.
         */
        readonly post: operations["switchTenantContext"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/session/logout": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Revoke the current portal session
         * @description Requires current context, exact Origin, CSRF and allowed Fetch Metadata. Revokes the server session and expires the host-only cookie.
         */
        readonly post: operations["logoutSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/sessions/{id}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post?: never;
        /**
         * Revoke an authorized portal session
         * @description Requires a current verified portal session, exact Origin, CSRF, and same-origin Fetch Metadata. The target must belong to the same server-resolved principal and tenant as the actor. The request cannot select a tenant; a session UUID alone is not authorization. Missing and unowned sessions receive the same safe denial.
         */
        readonly delete: operations["revokeAuthorizedPortalSession"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/integrations/flows": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List configured flow choices
         * @description Returns only server-enabled flow configurations for the current tenant. Product variant names distinguish Facebook, Instagram variants, WhatsApp Cloud API and WhatsApp Coexistence; their actual availability, grants and eligibility are Not confirmed.
         */
        readonly get: operations["listIntegrationFlows"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/onboarding-sessions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Create an onboarding session and provider launch request
         * @description Tenant/principal/config are resolved from the current server session. Body cannot select a tenant, CompanyUUID, app or secret. The server generates provider state and its correlation to this onboarding; launch URL is server-generated from allowlisted configuration. Persisted state is represented by a digest and is valid for ten minutes for one use. Requests fail closed with a safe 503 when the required server-side signing key or trusted provider-launch configuration is unavailable. The signing key is runtime-configurable; its presence in any deployment is Not confirmed. A 201 or provider redirect means only that a flow was created, never that a connection is READY.
         */
        readonly post: operations["createOnboardingSession"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/onboarding-sessions/{onboardingSessionId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly onboardingSessionId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read authoritative onboarding status
         * @description The server derives READY/PARTIAL from current versioned policy and verified evidence. A code exchange, HTTP 200, popup finish event, or redirect alone never sets READY. The read is scoped to the verified portal session and principal, then checks current membership in the onboarding's original tenant even after a tenant-context switch. Only a trusted server-side completion port can update status; a front-end return signal cannot do so. Provider completion remains unavailable until a verified server adapter is configured. UNKNOWN/STALE evidence stays visible and blocks READY when required.
         */
        readonly get: operations["getOnboardingSession"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/onboarding-sessions/{onboardingSessionId}/authorization-code": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly onboardingSessionId: string;
            };
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Submit an ephemeral provider authorization code
         * @description Authenticated portal submission for a code returned by the provider Embedded Signup/browser flow. It is not the Suite4 portal-entry ticket accepted by POST /api/v1/auth/exchanges. The server binds the onboarding ID and one-time state to the original principal, tenant, flow and app config. The body never accepts company_uuid; secrets/codes are not logged or returned. When the provider instead calls the server callback, use GET /api/v1/meta/{variant}/callback; do not send that callback code through portal authentication exchange.
         */
        readonly post: operations["submitProviderAuthorizationCode"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/meta/{variant}/callback": {
        readonly parameters: {
            readonly query: {
                /** @description One-time provider authorization code. Never log or echo it. A missing code is an explicit denial/return path. */
                readonly code?: string;
                /** @description Opaque, one-use server state correlated to an onboarding session. It does not identify a tenant by itself. */
                readonly state: string;
                /** @description Allowlisted provider error class only; raw provider descriptions are discarded. */
                readonly error?: string;
            };
            readonly header?: never;
            readonly path: {
                readonly variant: "facebook" | "instagram" | "whatsapp";
            };
            readonly cookie?: never;
        };
        /**
         * Receive provider callback correlated by one-time server state
         * @description Explicit unauthenticated callback route. Correlates the callback to the existing onboarding using one-time server state and configured flow/app variant. It never accepts or trusts company_uuid/tenant from the return query. Callback acceptance schedules or records processing; browser redirect is only navigation, not READY. Provider callback details for deployed variants remain Not confirmed.
         */
        readonly get: operations["receiveProviderCallback"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/connections": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List tenant-scoped connection projections
         * @description Cursor pagination; tenant is resolved from the session and current context only. List items identify status, freshness and last confirmed evidence but contain no raw provider payload or credential.
         */
        readonly get: operations["listConnections"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/connections/{connectionId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly connectionId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read one tenant-scoped connection
         * @description Resource lookup and authorization are both scoped by the server-derived tenant. A foreign tenant resource is indistinguishable from an unavailable resource.
         */
        readonly get: operations["getConnection"];
        readonly put?: never;
        readonly post?: never;
        /**
         * Start a connection disconnect
         * @description Requires operator/owner scope and CSRF. Local desired state is recorded first; provider revocation/cleanup is a separate bounded job. A provider success is not assumed.
         */
        readonly delete: operations["disconnectConnection"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/connections/{connectionId}/reauthorizations": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly connectionId: string;
            };
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Start reauthorization without prematurely revoking the current grant
         * @description Creates a new local onboarding session for the selected connection. Provider authorization starts only after the user follows its launch URL; this request changes no provider state. The prior grant remains usable while verified and eligible under current policy; rotation is explicit.
         */
        readonly post: operations["createReauthorization"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/assets": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List verified assets in the current tenant
         * @description Cursor-paginated tenant-scoped projection. External IDs are opaque strings and are never resolved across tenants. Status includes observation freshness.
         */
        readonly get: operations["listAssets"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/assets/{assetId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read one tenant-scoped asset
         * @description Returns normalized metadata only. Provider response bodies, tokens and raw webhook data are excluded.
         */
        readonly get: operations["getAsset"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/assets/{assetId}/refresh": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Queue an asset status refresh
         * @description Coalesced refresh; does not call a provider synchronously from the HTTP request. Caller receives a job reference, not a claim that status is fresh.
         */
        readonly post: operations["refreshAsset"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/assets/{assetId}/automation-config": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read automation/reply configuration
         * @description Tenant and asset authorization are checked for the requested capability. ETag is returned for conditional updates.
         */
        readonly get: operations["getAutomationConfig"];
        /**
         * Replace automation/reply configuration conditionally
         * @description Requires exact Origin, CSRF, current tenant context and If-Match from the latest representation. Unknown fields are rejected. This changes local configuration; delivery of a reply is a separate external effect.
         */
        readonly put: operations["replaceAutomationConfig"];
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/assets/{assetId}/replies": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Queue a reply to an authorized message reference
         * @description Message text is accepted only for this explicit tenant-authorized action and is not copied into inbox/outbox event envelopes or logs. Recipient/message references are resolved server-side. External delivery is not exactly-once; provider idempotency support is Not confirmed.
         */
        readonly post: operations["sendReply"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/jobs/{jobId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly jobId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read asynchronous work status
         * @description Tenant-scoped job status. UNKNOWN means an external effect may have occurred; it is not retryable until reconciliation supplies evidence. Job responses never include raw provider error bodies or credentials.
         */
        readonly get: operations["getJob"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/operations/{operationId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly operationId: string;
            };
            readonly cookie?: never;
        };
        /**
         * Read an external-operation outcome
         * @description Returns SUCCEEDED/FAILED/UNKNOWN and redacted status metadata only. UNKNOWN is not success and does not authorize blind retry.
         */
        readonly get: operations["getOperation"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/whatsapp/accounts/{assetId}/templates": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque account asset ID; the server verifies tenant and MANAGE_TEMPLATES capability. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /**
         * List templates for an authorized WhatsApp account
         * @description Returns a tenant/account-scoped template projection from the selected eligible grant. Provider eligibility and actual grant semantics are Not confirmed; no global credential is selected.
         */
        readonly get: operations["listTemplates"];
        readonly put?: never;
        /**
         * Request creation of a template
         * @description Validates an allowlisted payload and selected account grant before dispatch. Provider template review/approval is asynchronous and is not inferred from request acceptance.
         */
        readonly post: operations["createTemplate"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/notifications": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * List tenant-scoped operational notifications
         * @description Returns safe metadata, references and freshness; no message body or raw provider payload is included. Cursor and limit are bounded.
         */
        readonly get: operations["listNotifications"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/notifications/{notificationId}/actions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly notificationId: string;
            };
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        /**
         * Apply a notification action
         * @description The action is checked against current membership, asset grant and role. MARK_READ/DISMISS are local; REPLY is an external message effect and enters the bounded async job/reconciliation path. This endpoint never reports a provider send as complete on HTTP acceptance.
         */
        readonly post: operations["actOnNotification"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/api/v1/webhooks/meta/{appConfigRef}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque server-side app-configuration reference; public identifier, not an authorization secret. */
                readonly appConfigRef: string;
            };
            readonly cookie?: never;
        };
        /**
         * Respond to a provider webhook verification challenge
         * @description Public only for an allowlisted configured app reference. Validate the provider handshake against server configuration and never expose secrets. Exact provider protocol/variant and production ingress are Not confirmed.
         */
        readonly get: operations["verifyMetaWebhook"];
        readonly put?: never;
        /**
         * Receive a signed provider webhook
         * @description Public ingress must verify signature over exact raw bytes before accepting. Body is bounded; duplicate delivery is idempotent. The raw body is stored only in a protected short-retention inbox reference; routed internal events contain no indiscriminate message content. Exact Meta signature/event schemas are Not confirmed.
         */
        readonly post: operations["receiveMetaWebhook"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/health": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Check process liveness
         * @description Public minimal response. Does not call Meta or reveal dependencies, tenants, environment values or credentials.
         */
        readonly get: operations["liveness"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/ready": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        /**
         * Check readiness without exposing dependency details
         * @description Public minimal response. Provider health is not synchronously probed; output never includes connection strings, environment values, tenant IDs or secret state.
         */
        readonly get: operations["readiness"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @enum {string} */
        readonly ErrorAction: "SIGN_IN" | "FIX_REQUEST" | "CONTACT_ADMIN" | "REFRESH" | "RESTART_ONBOARDING" | "REAUTHORIZE" | "WAIT" | "CHECK_STATUS" | "RECONCILE" | "USE_NEW_REQUEST_KEY" | "REDUCE_REQUEST" | "RELOAD_PORTAL";
        readonly ErrorEnvelope: {
            /** @enum {string} */
            readonly code: "AUTH_REQUIRED" | "MEMBERSHIP_REVOKED" | "ACCESS_DENIED" | "RESOURCE_NOT_AVAILABLE" | "STATE_INVALID" | "ONBOARDING_EXPIRED" | "FLOW_UNAVAILABLE" | "FLOW_NOT_ELIGIBLE" | "ASSET_GRANT_MISSING" | "ASSET_CONFLICT" | "META_PERMISSION_REQUIRED" | "META_REAUTH_REQUIRED" | "META_RATE_LIMITED" | "SUBSCRIPTION_PENDING" | "OUTCOME_UNKNOWN" | "VERSION_CONFLICT" | "IDEMPOTENCY_KEY_REUSED" | "CONTEXT_CHANGED" | "ORIGIN_NOT_ALLOWED" | "HOST_NOT_ALLOWED" | "CSRF_INVALID" | "VALIDATION_FAILED" | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE" | "META_UNAVAILABLE" | "PROVIDER_REJECTED" | "INTERNAL_ERROR";
            /** @description Fixed, allowlisted localization template selected by error code. Never interpolate raw provider detail, request values, secrets, or diagnostic text. */
            readonly safeMessage: string;
            /** @description Server-generated correlation identifier. Direct-client X-Request-Id values are ignored; this identifier is not authorization evidence. */
            readonly requestId: string;
            readonly retryable: boolean;
            readonly action: components["schemas"]["ErrorAction"];
        };
        readonly AcceptedRequest: {
            /** @constant */
            readonly accepted: true;
            readonly requestId: string;
        };
        readonly PreauthStartRequest: {
            /** @enum {string} */
            readonly entryMode: "PORTAL_TOP_LEVEL" | "SUITE4_EMBED";
            /** @enum {string} */
            readonly returnRoute: "connections" | "setup";
        };
        readonly PreauthChallenge: {
            readonly challengeRef: string;
            /** Format: date-time */
            readonly expiresAt: string;
            readonly requestId: string;
        };
        readonly PortalEntryExchangeRequest: {
            /** @description Short-lived Suite4 portal-entry ticket; never a Meta authorization code. */
            readonly ticket: string;
            readonly challengeRef: string;
        };
        readonly MagicLinkRequest: {
            /** Format: email */
            readonly email: string;
        };
        readonly MagicLinkConsumeRequest: {
            readonly linkToken: string;
        };
        readonly SessionContext: {
            /**
             * Format: uuid
             * @description Public opaque selector only; never a credential and insufficient to authorize revocation.
             */
            readonly sessionRef?: string;
            readonly principalRef: string;
            readonly tenantRef: string;
            readonly roles: readonly ("owner" | "admin" | "operator" | "viewer")[];
            /** @description Session-bound context reference; does not authorize independently. */
            readonly tenantContextRef: string;
            readonly contextVersion: number;
            readonly requestId: string;
            /** @description Current ACTIVE memberships offered after magic-link sign-in. Each selection is revalidated server-side. */
            readonly availableTenants?: readonly {
                readonly tenantRef: string;
                readonly roles: readonly ("owner" | "admin" | "operator" | "viewer")[];
            }[];
        };
        readonly TenantSwitchRequest: {
            /** @description Requested membership reference; always revalidated server-side. */
            readonly tenantRef: string;
        };
        /**
         * @description Distinct configured journeys. Availability, permissions and eligibility are Not confirmed.
         * @enum {string}
         */
        readonly FlowVariant: "FACEBOOK_LOGIN" | "INSTAGRAM_VIA_FACEBOOK_LOGIN" | "INSTAGRAM_LOGIN" | "WHATSAPP_CLOUD_API" | "WHATSAPP_COEXISTENCE";
        readonly FlowDefinition: {
            readonly variant: components["schemas"]["FlowVariant"];
            readonly enabled: boolean;
            readonly requestedCapabilities: readonly string[];
        };
        readonly FlowList: {
            readonly items: readonly components["schemas"]["FlowDefinition"][];
            readonly requestId: string;
        };
        readonly OnboardingCreateRequest: {
            readonly flowVariant: components["schemas"]["FlowVariant"];
            readonly requestedCapabilities: readonly string[];
            /** @enum {string} */
            readonly returnRoute: "connections" | "setup";
        };
        readonly OnboardingCreated: {
            readonly id: string;
            /** @constant */
            readonly status: "AWAITING_PROVIDER";
            /** Format: date-time */
            readonly expiresAt: string;
            /**
             * Format: uri
             * @description Server-generated allowlisted provider launch URL; contains no access token or client secret.
             */
            readonly launchUrl: string;
            readonly requestId: string;
        };
        readonly JobAccepted: {
            readonly jobId: string;
            /** @constant */
            readonly status: "PENDING";
            readonly location: string;
            readonly requestId: string;
        };
        readonly StepStatus: {
            readonly name: string;
            /** @enum {string} */
            readonly status: "PENDING" | "RUNNING" | "SUCCEEDED" | "RETRY_PENDING" | "FAILED" | "UNKNOWN" | "SKIPPED";
        };
        readonly OnboardingStatus: {
            readonly id: string;
            readonly flowVariant: components["schemas"]["FlowVariant"];
            /** @enum {string} */
            readonly status: "CREATED" | "AWAITING_PROVIDER" | "CODE_RECEIVED" | "EXCHANGING" | "ASSETS_VERIFIED" | "PROVISIONING" | "READY" | "PARTIAL" | "CANCELLED" | "EXPIRED" | "FAILED";
            /** @enum {string} */
            readonly readiness: "READY" | "PARTIAL" | "UNKNOWN";
            readonly steps: readonly components["schemas"]["StepStatus"][];
            /** @enum {string} */
            readonly nextAction: "WAIT" | "CHECK_STATUS" | "REAUTHORIZE" | "RECONCILE" | "RESOLVE_CONFLICT" | "NONE";
            /** Format: date-time */
            readonly lastUpdatedAt: string;
            readonly requestId: string;
        };
        readonly ProviderAuthorizationCodeRequest: {
            /** @description Ephemeral Meta provider code from this onboarding flow. Never log, persist in cleartext, or return. */
            readonly authorizationCode: string;
            /** @description One-use server-generated state reference bound to this onboarding. */
            readonly stateRef: string;
        };
        readonly Connection: {
            readonly id: string;
            readonly flowVariant: components["schemas"]["FlowVariant"];
            /** @enum {string} */
            readonly status: "ACTIVE" | "PARTIAL" | "REAUTH_REQUIRED" | "UNKNOWN" | "DISCONNECTED";
            /** @enum {string} */
            readonly readiness: "READY" | "PARTIAL" | "UNKNOWN";
            /** Format: date-time */
            readonly observedAt: string;
            readonly stale: boolean;
            readonly assetCount: number;
        };
        readonly ConnectionAsset: {
            readonly id: string;
            /** @enum {string} */
            readonly kind: "PAGE" | "INSTAGRAM_ACCOUNT" | "WHATSAPP_BUSINESS_ACCOUNT" | "PHONE_NUMBER";
            /** @enum {string} */
            readonly status: "ACTIVE" | "INACTIVE" | "UNKNOWN" | "STALE";
            /** @enum {string} */
            readonly authorizationStatus: "VERIFIED" | "REVOKED" | "UNKNOWN";
            /** Format: date-time */
            readonly observedAt: string;
        };
        readonly ConnectionDetail: {
            readonly id: string;
            readonly flowVariant: components["schemas"]["FlowVariant"];
            /** @enum {string} */
            readonly status: "ACTIVE" | "PARTIAL" | "REAUTH_REQUIRED" | "UNKNOWN" | "DISCONNECTED";
            /** @enum {string} */
            readonly readiness: "READY" | "PARTIAL" | "UNKNOWN";
            /** Format: date-time */
            readonly observedAt: string;
            readonly stale: boolean;
            readonly assets: readonly components["schemas"]["ConnectionAsset"][];
            readonly requestId: string;
        };
        readonly ConnectionListPage: {
            readonly items: readonly components["schemas"]["Connection"][];
            readonly nextCursor: string | null;
            readonly requestId: string;
        };
        readonly Asset: {
            readonly id: string;
            /** @enum {string} */
            readonly kind: "PAGE" | "INSTAGRAM_ACCOUNT" | "WHATSAPP_BUSINESS_ACCOUNT" | "PHONE_NUMBER";
            /** @enum {string} */
            readonly status: "ACTIVE" | "INACTIVE" | "UNKNOWN" | "STALE";
            /** @enum {string} */
            readonly authorizationStatus: "VERIFIED" | "REVOKED" | "UNKNOWN";
            /** Format: date-time */
            readonly observedAt: string;
            readonly stale: boolean;
            readonly capabilities: components["schemas"]["AssetCapabilities"];
            readonly requestId: string;
        };
        readonly AssetListItem: {
            readonly id: string;
            /** @enum {string} */
            readonly kind: "PAGE" | "INSTAGRAM_ACCOUNT" | "WHATSAPP_BUSINESS_ACCOUNT" | "PHONE_NUMBER";
            /** @enum {string} */
            readonly status: "ACTIVE" | "INACTIVE" | "UNKNOWN" | "STALE";
            /** @enum {string} */
            readonly authorizationStatus: "VERIFIED" | "REVOKED" | "UNKNOWN";
            /** Format: date-time */
            readonly observedAt: string;
            readonly stale: boolean;
            readonly capabilities: components["schemas"]["AssetCapabilities"];
        };
        /** @description Advisory snapshot derived from verified evidence and current membership. Exact Meta operation-to-grant eligibility is Not confirmed; these flags do not authorize server operations. */
        readonly AssetCapabilities: {
            readonly canSend: boolean;
            readonly canManageTemplates: boolean;
            readonly canSubscribe: boolean;
            readonly canReauthorize: boolean;
            readonly canDisconnect: boolean;
        };
        readonly AssetListPage: {
            readonly items: readonly components["schemas"]["AssetListItem"][];
            readonly nextCursor: string | null;
            readonly requestId: string;
        };
        readonly AutomationConfig: {
            readonly assetId: string;
            readonly enabled: boolean;
            readonly replyText: string;
            readonly version: number;
            /** Format: date-time */
            readonly updatedAt: string;
            readonly requestId: string;
        };
        readonly AutomationConfigUpdate: {
            readonly enabled: boolean;
            readonly replyText: string;
        };
        readonly ReplyRequest: {
            readonly inReplyToRef: string;
            readonly text: string;
        };
        readonly JobStatus: {
            readonly id: string;
            /** @enum {string} */
            readonly status: "PENDING" | "RUNNING" | "RETRY_PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "CANCELLED";
            readonly operation: string;
            /** Format: date-time */
            readonly createdAt: string;
            /** Format: date-time */
            readonly updatedAt: string;
            /** @enum {string} */
            readonly nextAction: "WAIT" | "CHECK_STATUS" | "RECONCILE" | "REAUTHORIZE" | "NONE";
            readonly safeError?: components["schemas"]["ErrorEnvelope"] | null;
            readonly requestId: string;
        };
        readonly OperationStatus: {
            readonly id: string;
            readonly kind: string;
            /** @enum {string} */
            readonly status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
            readonly requestId: string;
            /** Format: date-time */
            readonly updatedAt: string;
            /** @enum {string} */
            readonly nextAction: "WAIT" | "CHECK_STATUS" | "RECONCILE" | "NONE";
        };
        readonly Template: {
            readonly id: string;
            readonly name: string;
            readonly language: string;
            /** @enum {string} */
            readonly status: "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "UNKNOWN";
            /** @enum {string} */
            readonly category: "AUTHENTICATION" | "MARKETING" | "UTILITY" | "UNKNOWN";
            /** Format: date-time */
            readonly updatedAt: string;
        };
        readonly TemplateListPage: {
            readonly items: readonly components["schemas"]["Template"][];
            readonly nextCursor: string | null;
            readonly requestId: string;
        };
        readonly TemplateCreateRequest: {
            readonly name: string;
            readonly language: string;
            /** @enum {string} */
            readonly category: "AUTHENTICATION" | "MARKETING" | "UTILITY";
            readonly bodyText: string;
        };
        readonly Notification: {
            readonly id: string;
            /** @enum {string} */
            readonly kind: "MESSAGE_RECEIVED" | "ASSET_STATUS_CHANGED" | "ACTION_REQUIRED";
            readonly assetRef: string;
            readonly messageRef: string | null;
            /** @enum {string} */
            readonly status: "UNREAD" | "READ" | "DISMISSED";
            readonly safeSummary: string;
            /** Format: date-time */
            readonly createdAt: string;
            readonly actions: readonly ("MARK_READ" | "DISMISS" | "REPLY" | "REFRESH")[];
        };
        readonly NotificationListPage: {
            readonly items: readonly components["schemas"]["Notification"][];
            readonly nextCursor: string | null;
            readonly requestId: string;
        };
        readonly NotificationActionRequest: {
            /** @enum {string} */
            readonly action: "MARK_READ" | "DISMISS";
        } | {
            /** @constant */
            readonly action: "REPLY";
            readonly replyText: string;
        };
        readonly NotificationActionAccepted: {
            readonly notificationId: string;
            readonly jobId: string;
            /** @constant */
            readonly status: "PENDING";
            readonly location: string;
            readonly requestId: string;
        };
        readonly WebhookChallengeResponse: {
            readonly challenge: string;
        };
        /** @description Raw, signature-verified provider JSON body. This schema asserts only an object shape and a maximum property count; it is not closed or a field-level provider schema. Exact Meta webhook fields are Not confirmed. Ingress validates signature and size, then stores protected bytes. Do not use this schema as an internal event or public read DTO. */
        readonly ProviderWebhookEnvelope: {
            readonly [key: string]: unknown;
        };
        readonly HealthStatus: {
            /** @enum {string} */
            readonly status: "ok" | "unavailable";
        };
    };
    responses: {
        /** @description Request validation failed. */
        readonly BadRequest: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description Authentication or one-time proof is required. For ticket exchange this includes a mismatched pre-auth cookie/challenge or an expired/revoked session, membership, or tenant; a response-loss retry is accepted only for the same still-active session and browser binding. */
        readonly Unauthorized: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The current identity or request host is not allowed to perform this action. */
        readonly Forbidden: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The resource is unavailable in this tenant; foreign-resource existence is not disclosed. */
        readonly NotFound: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The operation conflicts with recorded state or idempotency key. */
        readonly Conflict: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The supplied ETag is missing or stale. */
        readonly PreconditionFailed: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description This route does not support the requested method. */
        readonly MethodNotAllowed: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The payload exceeds the endpoint limit. */
        readonly PayloadTooLarge: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The requested transition is not allowed. */
        readonly Unprocessable: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description The configured rate limit was exceeded. */
        readonly TooManyRequests: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description A dependency is unavailable or outcome must be checked. */
        readonly Unavailable: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
        /** @description An unexpected internal error occurred. Retry is not authorized without an operation-specific decision. */
        readonly UnexpectedError: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ErrorEnvelope"];
            };
        };
    };
    parameters: {
        /**
         * @description Exact configured browser Origin; wildcard matching is forbidden.
         * @example https://portal.example.invalid
         */
        readonly Origin: string;
        /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
        readonly FetchSite: "same-origin" | "same-site";
        /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
        readonly CsrfToken: string;
        /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
        readonly TenantContext: string;
        /**
         * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
         * @example idem_example_key_01
         */
        readonly IdempotencyKey: string;
        /**
         * @description ETag from the latest representation. Missing/stale precondition is rejected; no blind overwrite.
         * @example "automation-v7"
         */
        readonly IfMatch: string;
        /** @description Opaque tenant-bound continuation cursor; do not parse or edit. */
        readonly Cursor: string;
        /** @description Bounded page size, default 50, maximum 50. */
        readonly AssetCatalogLimit: number;
        /** @description Bounded page size, default 50, maximum 50. */
        readonly ConnectionCatalogLimit: number;
        readonly AssetCatalogChannel: "FACEBOOK" | "INSTAGRAM" | "WHATSAPP";
        /** @description Exact opaque WhatsApp phone number filter. */
        readonly AssetCatalogNumber: string;
        readonly AssetCatalogStatus: "ACTIVE" | "INACTIVE" | "UNKNOWN" | "STALE";
        readonly ConnectionCatalogStatus: "ACTIVE" | "PARTIAL" | "REAUTH_REQUIRED" | "UNKNOWN" | "DISCONNECTED";
        /** @description Page size, default 50, maximum 100. */
        readonly Limit: number;
        /** @description Provider signature over exact raw request bytes. Supported algorithm/header configuration must be ratified for the actual app. */
        readonly ProviderSignature: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    readonly startPreauth: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["PreauthStartRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 201: {
                headers: {
                    /** @description Host-only Secure HttpOnly `__Host-meta_preauth` cookie with no Domain attribute. PORTAL_TOP_LEVEL uses SameSite=Lax; configured SUITE4_EMBED uses SameSite=None; Partitioned. Cookie value is not in the response body. */
                    readonly "Set-Cookie"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["PreauthChallenge"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly exchangePortalEntryTicket: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["PortalEntryExchangeRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 201: {
                headers: {
                    /** @description Opaque host-only Secure HttpOnly `__Host-meta_portal` portal session cookie. */
                    readonly "Set-Cookie"?: string;
                    readonly "Cache-Control"?: "no-store";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SessionContext"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly requestMagicLink: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["MagicLinkRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AcceptedRequest"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly showMagicLinkConfirmation: {
        readonly parameters: {
            readonly query: {
                /** @description Temporary opaque link token. It is never logged or sent to analytics. */
                readonly token: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Confirmation form only; no session or link state changes. */
            readonly 200: {
                headers: {
                    readonly "Referrer-Policy"?: "no-referrer";
                    readonly "Cache-Control"?: "no-store";
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/html": string;
                };
            };
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly probeMagicLinkConfirmation: {
        readonly parameters: {
            readonly query: {
                readonly token: string;
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Headers only; no session or link state changes. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly consumeMagicLink: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["MagicLinkConsumeRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 201: {
                headers: {
                    /** @description Opaque host-only Secure HttpOnly portal session cookie. */
                    readonly "Set-Cookie"?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SessionContext"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SessionContext"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly switchTenantContext: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["TenantSwitchRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["SessionContext"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly logoutSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Completed without a response body */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly revokeAuthorizedPortalSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
            };
            readonly path: {
                /** @description Session identifier; authorization is resolved from the current server session. */
                readonly id: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Completed without a response body */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 409: components["responses"]["Conflict"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly listIntegrationFlows: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["FlowList"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly createOnboardingSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["OnboardingCreateRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 201: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OnboardingCreated"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getOnboardingSession: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly onboardingSessionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OnboardingStatus"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly submitProviderAuthorizationCode: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly onboardingSessionId: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["ProviderAuthorizationCodeRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly receiveProviderCallback: {
        readonly parameters: {
            readonly query: {
                /** @description One-time provider authorization code. Never log or echo it. A missing code is an explicit denial/return path. */
                readonly code?: string;
                /** @description Opaque, one-use server state correlated to an onboarding session. It does not identify a tenant by itself. */
                readonly state: string;
                /** @description Allowlisted provider error class only; raw provider descriptions are discarded. */
                readonly error?: string;
            };
            readonly header?: never;
            readonly path: {
                readonly variant: "facebook" | "instagram" | "whatsapp";
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Redirect to an allowlisted local return route with an opaque onboarding reference only; no code/state/token in Location. */
            readonly 303: {
                headers: {
                    /** @description Validated same-origin portal route; never arbitrary caller URL. */
                    readonly Location?: string;
                    readonly "Cache-Control"?: "no-store";
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly listConnections: {
        readonly parameters: {
            readonly query?: {
                /** @description Opaque tenant-bound continuation cursor; do not parse or edit. */
                readonly cursor?: components["parameters"]["Cursor"];
                /** @description Bounded page size, default 50, maximum 50. */
                readonly limit?: components["parameters"]["ConnectionCatalogLimit"];
                readonly channel?: components["parameters"]["AssetCatalogChannel"];
                /** @description Exact opaque WhatsApp phone number filter. */
                readonly number?: components["parameters"]["AssetCatalogNumber"];
                readonly status?: components["parameters"]["ConnectionCatalogStatus"];
            };
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ConnectionListPage"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getConnection: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly connectionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    /** @description Opaque representation version for conditional updates. */
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["ConnectionDetail"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly disconnectConnection: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly connectionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly createReauthorization: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly connectionId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly listAssets: {
        readonly parameters: {
            readonly query?: {
                /** @description Opaque tenant-bound continuation cursor; do not parse or edit. */
                readonly cursor?: components["parameters"]["Cursor"];
                /** @description Bounded page size, default 50, maximum 50. */
                readonly limit?: components["parameters"]["AssetCatalogLimit"];
                readonly channel?: components["parameters"]["AssetCatalogChannel"];
                /** @description Exact opaque WhatsApp phone number filter. */
                readonly number?: components["parameters"]["AssetCatalogNumber"];
                readonly status?: components["parameters"]["AssetCatalogStatus"];
            };
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AssetListPage"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getAsset: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["Asset"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly refreshAsset: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getAutomationConfig: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AutomationConfig"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly replaceAutomationConfig: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description ETag from the latest representation. Missing/stale precondition is rejected; no blind overwrite.
                 * @example "automation-v7"
                 */
                readonly "If-Match": components["parameters"]["IfMatch"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["AutomationConfigUpdate"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly ETag?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AutomationConfig"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly sendReply: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["ReplyRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getJob: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly jobId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobStatus"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly getOperation: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly operationId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["OperationStatus"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly listTemplates: {
        readonly parameters: {
            readonly query?: {
                /** @description Opaque tenant-bound continuation cursor; do not parse or edit. */
                readonly cursor?: components["parameters"]["Cursor"];
                /** @description Bounded page size, default 50, maximum 50. */
                readonly limit?: components["parameters"]["ConnectionCatalogLimit"];
                readonly channel?: components["parameters"]["AssetCatalogChannel"];
                /** @description Exact opaque WhatsApp phone number filter. */
                readonly number?: components["parameters"]["AssetCatalogNumber"];
                readonly status?: components["parameters"]["ConnectionCatalogStatus"];
            };
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path: {
                /** @description Opaque account asset ID; the server verifies tenant and MANAGE_TEMPLATES capability. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["TemplateListPage"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly createTemplate: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque account asset ID; the server verifies tenant and MANAGE_TEMPLATES capability. */
                readonly assetId: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["TemplateCreateRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["JobAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly listNotifications: {
        readonly parameters: {
            readonly query?: {
                /** @description Opaque tenant-bound continuation cursor; do not parse or edit. */
                readonly cursor?: components["parameters"]["Cursor"];
                /** @description Bounded page size, default 50, maximum 50. */
                readonly limit?: components["parameters"]["ConnectionCatalogLimit"];
                readonly channel?: components["parameters"]["AssetCatalogChannel"];
                /** @description Exact opaque WhatsApp phone number filter. */
                readonly number?: components["parameters"]["AssetCatalogNumber"];
                readonly status?: components["parameters"]["ConnectionCatalogStatus"];
            };
            readonly header: {
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
            };
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["NotificationListPage"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly actOnNotification: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /**
                 * @description Exact configured browser Origin; wildcard matching is forbidden.
                 * @example https://portal.example.invalid
                 */
                readonly Origin: components["parameters"]["Origin"];
                /** @description Must match the configured exact-origin topology; cross-site, missing or invalid values fail. */
                readonly "Sec-Fetch-Site": components["parameters"]["FetchSite"];
                /** @description Session-bound anti-CSRF value; not a DTO property and not sufficient without the session cookie. */
                readonly "X-CSRF-Token": components["parameters"]["CsrfToken"];
                /** @description Opaque current context reference returned by the session. It is not authorization without the cookie and current server membership. */
                readonly "X-Tenant-Context": components["parameters"]["TenantContext"];
                /**
                 * @description Random caller-generated request key; server scope is current tenant + operation + key. Same payload hash replays prior acceptance; different payload hash returns 409 with no new effect.
                 * @example idem_example_key_01
                 */
                readonly "Idempotency-Key": components["parameters"]["IdempotencyKey"];
            };
            readonly path: {
                /** @description Opaque resource identifier; authorization is always checked against the server-derived tenant. */
                readonly notificationId: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["NotificationActionRequest"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    /** @description Relative URI of the tenant-scoped accepted job; poll it for the outcome. */
                    readonly Location?: string;
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["NotificationActionAccepted"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 401: components["responses"]["Unauthorized"];
            readonly 403: components["responses"]["Forbidden"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 412: components["responses"]["PreconditionFailed"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 422: components["responses"]["Unprocessable"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly verifyMetaWebhook: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                /** @description Opaque server-side app-configuration reference; public identifier, not an authorization secret. */
                readonly appConfigRef: string;
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["WebhookChallengeResponse"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly receiveMetaWebhook: {
        readonly parameters: {
            readonly query?: never;
            readonly header: {
                /** @description Provider signature over exact raw request bytes. Supported algorithm/header configuration must be ratified for the actual app. */
                readonly "X-Hub-Signature-256": components["parameters"]["ProviderSignature"];
            };
            readonly path: {
                /** @description Opaque server-side app-configuration reference; public identifier, not an authorization secret. */
                readonly appConfigRef: string;
            };
            readonly cookie?: never;
        };
        /** @description Request uses a closed, size-bounded schema. */
        readonly requestBody: {
            readonly content: {
                readonly "application/json": components["schemas"]["ProviderWebhookEnvelope"];
            };
        };
        readonly responses: {
            /** @description Sanitized success example */
            readonly 202: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["AcceptedRequest"];
                };
            };
            readonly 400: components["responses"]["BadRequest"];
            readonly 404: components["responses"]["NotFound"];
            readonly 409: components["responses"]["Conflict"];
            readonly 413: components["responses"]["PayloadTooLarge"];
            readonly 429: components["responses"]["TooManyRequests"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly liveness: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["HealthStatus"];
                };
            };
            readonly 405: components["responses"]["MethodNotAllowed"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
    readonly readiness: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Sanitized success example */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "application/json": components["schemas"]["HealthStatus"];
                };
            };
            readonly 405: components["responses"]["MethodNotAllowed"];
            readonly 503: components["responses"]["Unavailable"];
            readonly default: components["responses"]["UnexpectedError"];
        };
    };
}
