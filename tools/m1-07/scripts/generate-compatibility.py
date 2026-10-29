"""Generate the M1.07 compatibility crosswalk from the sanitized baseline matrix."""

from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASELINE = ROOT / "docs" / "baseline" / "endpoint-matrix.csv"
OUTPUT = ROOT / "docs" / "meta-v2" / "contracts" / "compatibility-matrix.csv"


def mapping(row: dict[str, str]) -> tuple[str, str, str, str, str]:
    kind = row["kind"]
    symbol = row["source_symbol"]
    path = row["path_or_symbol"]

    if kind == "angular_route":
        return "client-navigation", "(no server route)", "preserve-navigation", "M1.08 portal journey", "Navigation only; no API equivalence claimed."
    if kind == "frontend_auth_entry":
        return "createOnboardingSession", "POST /api/v1/onboarding-sessions", "replace-with-contract", "M2/M4 provider flow verification", "Source-level entry path; deployed rewrite/callback behavior Not confirmed."
    if kind == "php_route":
        if row["method"] == "OPTIONS":
            return "ingress-origin-policy", "(ingress policy; no application route)", "replace-with-exact-origin-policy", "M3.04 deployment review", "Production CORS/rewrite behavior Not confirmed."
        if path == "/login-url":
            return "createOnboardingSession", "POST /api/v1/onboarding-sessions", "replace-with-contract", "M1.07/M4 flow-specific callback proof", "Provider URL is server-generated; production rewrite Not confirmed."
        if path == "/facebook/callback":
            return "receiveProviderCallback", "GET /api/v1/meta/{variant}/callback", "replace-with-one-time-server-state", "M4 authorized provider scenario", "Actual deployed callback URI/rewrite Not confirmed."
        if path == "/channels":
            return "listConnections", "GET /api/v1/connections", "preserve-with-tenant-scoped-projection", "M2 consumer compatibility", "Current source-level route; no deployed response parity claim."
        if path == "/save_auto_reply":
            return "replaceAutomationConfig", "PUT /api/v1/assets/{assetId}/automation-config", "replace-with-versioned-contract", "M2 portal consumer", "Request semantics are proposed; Angular runtime is unchanged."
        if path == "/notifications":
            return "listNotifications", "GET /api/v1/notifications", "preserve-safe-notification-list", "M2 portal consumer", "Message content is omitted from notification/event projections."
        if path == "/notifications/action":
            return "actOnNotification", "POST /api/v1/notifications/{notificationId}/actions", "replace-with-typed-async-action", "M2/M4 external-effect evidence", "Ambiguous sends become UNKNOWN; no exactly-once claim."
        if path == "/whatsapp/templates" and row["method"] == "GET":
            return "listTemplates", "GET /api/v1/whatsapp/accounts/{assetId}/templates", "preserve-with-scoped-grant", "M3.08 credential/grant verification", "Provider grant selection and actual template state Not confirmed."
        if path == "/whatsapp/templates" and row["method"] == "POST":
            return "createTemplate", "POST /api/v1/whatsapp/accounts/{assetId}/templates", "replace-with-async-provider-job", "M3.08 authorized provider scenario", "Provider review and idempotency semantics Not confirmed."
    if kind == "php_router_result":
        return "unmatched-route", "(404 RESOURCE_NOT_AVAILABLE)", "preserve-safe-404", "M2 routing tests", "Source file default response is not evidence of deployed rewrite behavior."
    if kind == "php_entrypoint":
        if "facebook" in path:
            return "createOnboardingSession", "POST /api/v1/onboarding-sessions", "preserve-facebook-journey-separately", "M4 Facebook flow proof", "Operational entrypoint and provider permissions Not confirmed."
        return "createOnboardingSession", "POST /api/v1/onboarding-sessions", "preserve-page-discovery-separately", "M4 Instagram flow proof", "Current source discovery is not evidence of Instagram Login."
    if kind == "php_include":
        return "internal-service-boundary", "POST /api/v1/internal/v1/assets/{assetId}/operations", "replace-internal-helper", "M2 service boundary review", "Shared helpers are not public API operations."
    if kind == "php_function":
        routes = {
            "getLoginUrl": ("createOnboardingSession", "POST /api/v1/onboarding-sessions", "replace-with-server-state", "M4 provider flow proof"),
            "facebookCallback": ("receiveProviderCallback", "GET /api/v1/meta/{variant}/callback", "replace-with-one-time-server-state", "M4 authorized callback proof"),
            "getChannels": ("listConnections", "GET /api/v1/connections", "preserve-with-tenant-scoped-projection", "M2 consumer compatibility"),
            "saveAutoReply": ("replaceAutomationConfig", "PUT /api/v1/assets/{assetId}/automation-config", "replace-with-versioned-contract", "M2 portal consumer"),
            "getNotifications": ("listNotifications", "GET /api/v1/notifications", "preserve-safe-notification-list", "M2 portal consumer"),
            "actionNotification": ("actOnNotification", "POST /api/v1/notifications/{notificationId}/actions", "replace-with-typed-async-action", "M2/M4 external-effect evidence"),
            "getWhatsappTemplates": ("listTemplates", "GET /api/v1/whatsapp/accounts/{assetId}/templates", "preserve-with-scoped-grant", "M3.08 grant verification"),
            "createWhatsappTemplate": ("createTemplate", "POST /api/v1/whatsapp/accounts/{assetId}/templates", "replace-with-async-provider-job", "M3.08 provider scenario"),
            "sendWhatsAppMessage": ("runInternalAssetOperation", "POST /api/v1/internal/v1/assets/{assetId}/operations (SEND_REPLY)", "internal-typed-operation", "M3/M4 external-effect evidence"),
            "getCompanyContext": ("getSession", "GET /api/v1/session", "replace-company-uuid-lookup", "M3 identity integration"),
            "meta_get_company_context": ("getSession", "GET /api/v1/session", "replace-company-uuid-lookup", "M3 identity integration"),
            "getWabaExternalIdByPhoneNumber": ("resolveAssetInternally", "(tenant-scoped repository operation)", "internal-only", "M2 repository/BOLA review"),
            "callMetaApi": ("providerAdapter", "(internal allowlisted adapter; no Graph URL route)", "internal-only", "M4 provider adapter review"),
            "meta_call_meta_api": ("providerAdapter", "(internal allowlisted adapter; no Graph URL route)", "internal-only", "M4 provider adapter review"),
            "meta_env": ("serverConfiguration", "(no public route)", "internal-only", "M2 configuration review"),
            "meta_backend_bootstrap": ("serverBootstrap", "(no public route)", "internal-only", "M2 service boundary review"),
            "meta_build_login_url": ("createOnboardingSession", "POST /api/v1/onboarding-sessions", "replace-with-server-state", "M4 provider flow proof"),
            "meta_decode_state": ("receiveProviderCallback", "GET /api/v1/meta/{variant}/callback", "replace-with-one-time-server-state", "M4 replay proof"),
            "meta_redirect_frontend": ("receiveProviderCallback", "303 allowlisted local return route", "preserve-navigation-only", "M4 browser callback proof"),
            "meta_collect_granular_scope_ids": ("verifyOnboardingAssets", "GET /api/v1/onboarding-sessions/{onboardingSessionId}", "internal-job-projection", "M4 grant evidence"),
        }
        if symbol in routes:
            operation, target, policy, gate = routes[symbol]
            return operation, target, policy, gate, "Versioned contract only; current PHP function body was not used to claim future provider behavior."
        return "internal-service-boundary", "POST /api/v1/internal/v1/assets/{assetId}/operations", "internal-only", "M2/M3 service review", "Function has no direct browser route; enforce tenant and operation allowlists."
    if kind == "frontend_request":
        if path == "/channels":
            return "listConnections", "GET /api/v1/connections", "preserve-with-tenant-scoped-projection", "M2 web consumer integration", "Angular runtime remains unchanged in M1.07."
        if path == "/save_auto_reply":
            return "replaceAutomationConfig", "PUT /api/v1/assets/{assetId}/automation-config", "replace-with-versioned-contract", "M2 web consumer integration", "Angular runtime remains unchanged in M1.07."
        if path == "/whatsapp/templates" and row["method"] == "GET":
            return "listTemplates", "GET /api/v1/whatsapp/accounts/{assetId}/templates", "preserve-with-scoped-grant", "M2/M3 web integration", "Angular runtime remains unchanged in M1.07."
        if path == "/whatsapp/templates" and row["method"] == "POST":
            return "createTemplate", "POST /api/v1/whatsapp/accounts/{assetId}/templates", "replace-with-async-provider-job", "M2/M3 web integration", "Angular runtime remains unchanged in M1.07."
        if path == "/notifications":
            return "listNotifications", "GET /api/v1/notifications", "preserve-safe-notification-list", "M2 web consumer integration", "Angular runtime remains unchanged in M1.07."
        if path == "/notifications/action":
            return "actOnNotification", "POST /api/v1/notifications/{notificationId}/actions", "replace-with-typed-async-action", "M2 web consumer integration", "Angular runtime remains unchanged in M1.07."
    if kind == "documentation_drift":
        return "(not mapped)", "(no executable route asserted)", "exclude-not-confirmed", "Authorized sanitized deployment evidence before cutover", "Local sensitive connect.php was not inspected; relationship to deployment is Not confirmed."
    raise ValueError(f"No compatibility decision for baseline row {row!r}")


with BASELINE.open(encoding="utf-8-sig", newline="") as handle:
    rows = list(csv.DictReader(handle))

fieldnames = [
    "matrix_row",
    "source_kind",
    "source_method",
    "source_path_or_symbol",
    "source_file",
    "source_symbol",
    "v1_operation",
    "v1_target",
    "compatibility_policy",
    "next_gate",
    "evidence_limit",
]
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with OUTPUT.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for index, row in enumerate(rows, start=1):
        operation, target, policy, gate, limit = mapping(row)
        writer.writerow({
            "matrix_row": index,
            "source_kind": row["kind"],
            "source_method": row["method"],
            "source_path_or_symbol": row["path_or_symbol"],
            "source_file": row["source_file"],
            "source_symbol": row["source_symbol"],
            "v1_operation": operation,
            "v1_target": target,
            "compatibility_policy": policy,
            "next_gate": gate,
            "evidence_limit": limit,
        })

print(f"Wrote {len(rows)} compatibility rows from {BASELINE.relative_to(ROOT)}")
