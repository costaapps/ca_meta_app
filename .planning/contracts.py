"""Generate proposed API/event contracts; these endpoints are not implemented."""
import json
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "docs" / "meta-v2" / "contracts"


def ref(name):
    return {"$ref": "#/components/schemas/" + name}


def obj(properties, required=()):
    return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(required)}


S = {"type": "string"}
ID = {"type": "string", "minLength": 1, "maxLength": 128}
DATE = {"type": "string", "format": "date-time"}
SCHEMAS = {
    "FlowVariant": {"type": "string", "enum": ["WHATSAPP_CLOUD", "WHATSAPP_COEXISTENCE", "FACEBOOK", "INSTAGRAM"]},
    "SafeError": obj({"code": S, "safeMessage": S, "requestId": ID, "retryable": {"type": "boolean"}, "action": S}, ["code", "safeMessage", "requestId", "retryable"]),
    "Session": obj({"principalId": ID, "activeTenantId": ID, "contextRef": ID, "tenantDisplayName": S, "roles": {"type": "array", "items": S}, "expiresAt": DATE}, ["principalId", "activeTenantId", "contextRef", "roles", "expiresAt"]),
    "ExchangeRequest": obj({"ticket": {"type": "string", "writeOnly": True, "maxLength": 16384}}, ["ticket"]),
    "MagicLinkRequest": obj({"email": {"type": "string", "format": "email", "maxLength": 320}}, ["email"]),
    "MagicLinkConsume": obj({"code": {"type": "string", "writeOnly": True, "maxLength": 8192}}, ["code"]),
    "TenantSwitch": obj({"tenantId": ID}, ["tenantId"]),
    "Flow": obj({"flowVariant": ref("FlowVariant"), "authVariant": S, "title": S, "available": {"type": "boolean"}, "prerequisites": {"type": "array", "items": S}, "unavailableReason": S}, ["flowVariant", "title", "available"]),
    "CreateOnboarding": obj({"flowVariant": ref("FlowVariant"), "returnRoute": {"type": "string", "enum": ["connections", "embedded-return"]}, "requestedCapabilities": {"type": "array", "items": S, "uniqueItems": True}}, ["flowVariant", "returnRoute"]),
    "PublicBootstrap": obj({"onboardingId": ID, "flowVariant": ref("FlowVariant"), "publicAppId": ID, "publicConfigId": ID, "redirectUri": {"type": "string", "format": "uri"}, "state": {"type": "string", "maxLength": 512}, "sdkVersion": S, "signupVersion": S, "authorizationUrl": {"type": "string", "format": "uri"}}, ["onboardingId", "flowVariant"]),
    "SubmitCode": obj({"code": {"type": "string", "writeOnly": True, "maxLength": 16384}, "state": {"type": "string", "writeOnly": True, "maxLength": 512}}, ["code", "state"]),
    "Job": obj({"id": ID, "status": {"type": "string", "enum": ["QUEUED", "RUNNING", "RETRY_PENDING", "SUCCEEDED", "FAILED", "DEAD_LETTER"]}, "requestId": ID, "updatedAt": DATE, "nextAction": S}, ["id", "status", "requestId"]),
    "OnboardingStep": obj({"name": S, "status": S, "safeError": ref("SafeError")}, ["name", "status"]),
    "Onboarding": obj({"id": ID, "flowVariant": ref("FlowVariant"), "status": {"type": "string", "enum": ["CREATED", "AWAITING_PROVIDER", "CODE_RECEIVED", "EXCHANGING", "ASSETS_VERIFIED", "PROVISIONING", "READY", "PARTIAL", "CANCELLED", "EXPIRED", "FAILED"]}, "steps": {"type": "array", "items": ref("OnboardingStep")}, "nextAction": S, "lastUpdatedAt": DATE, "requestId": ID}, ["id", "flowVariant", "status", "steps", "requestId"]),
    "StatusDimension": obj({"state": S, "lastVerifiedAt": {"type": ["string", "null"], "format": "date-time"}, "evidenceSource": S, "stale": {"type": "boolean"}, "nextAction": S}, ["state", "stale"]),
    "Asset": obj({"id": ID, "kind": S, "flowVariant": ref("FlowVariant"), "displayName": S, "displayPhoneNumber": S, "providerStatus": ref("StatusDimension"), "credentialHealth": ref("StatusDimension"), "webhookStatus": ref("StatusDimension"), "projectionStatus": ref("StatusDimension"), "capabilities": {"type": "array", "items": S}, "version": {"type": "integer", "minimum": 1}}, ["id", "kind", "displayName", "capabilities", "version"]),
    "AssetPage": obj({"data": {"type": "array", "items": ref("Asset")}, "nextCursor": {"type": ["string", "null"]}}, ["data", "nextCursor"]),
    "Connection": obj({"id": ID, "flowVariant": ref("FlowVariant"), "asset": ref("Asset"), "status": ref("StatusDimension"), "version": {"type": "integer", "minimum": 1}}, ["id", "flowVariant", "asset", "status", "version"]),
    "ConnectionPage": obj({"data": {"type": "array", "items": ref("Connection")}, "nextCursor": {"type": ["string", "null"]}}, ["data", "nextCursor"]),
    "AutomationConfig": obj({"version": {"type": "integer", "minimum": 1}, "privateWelcomeMessage": {"type": "string", "maxLength": 4096}, "commentPublicReply": {"type": "string", "maxLength": 4096}, "commentPrivateReply": {"type": "string", "maxLength": 4096}}, ["version"]),
    "TemplateCreate": obj({"name": S, "category": S, "language": S, "body": S, "exampleValues": {"type": "array", "items": S}}, ["name", "category", "language", "body"]),
    "Template": obj({"id": ID, "name": S, "language": S, "category": S, "body": S, "status": S, "lastVerifiedAt": DATE}, ["name", "language", "status"]),
    "TemplatePage": obj({"data": {"type": "array", "items": ref("Template")}, "nextCursor": {"type": ["string", "null"]}}, ["data", "nextCursor"]),
    "Notification": obj({"id": ID, "assetId": ID, "type": S, "safeSummary": S, "isRead": {"type": "boolean"}, "createdAt": DATE, "allowedActions": {"type": "array", "items": S}}, ["id", "assetId", "type", "isRead", "allowedActions"]),
    "NotificationPage": obj({"data": {"type": "array", "items": ref("Notification")}, "nextCursor": {"type": ["string", "null"]}}, ["data", "nextCursor"]),
    "NotificationAction": obj({"type": {"type": "string", "enum": ["SEND_MESSAGE", "SEND_TEMPLATE", "REPLY_COMMENT", "READ", "DISMISS"]}, "text": S, "templateName": S, "templateLanguage": S, "templateParams": {"type": "array", "items": S}}, ["type"]),
    "Operation": obj({"id": ID, "assetId": ID, "status": {"type": "string", "enum": ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"]}, "providerResultRef": S, "requestId": ID, "safeError": ref("SafeError")}, ["id", "assetId", "status", "requestId"]),
    "ServiceOperation": obj({"type": {"type": "string", "enum": ["SEND_WHATSAPP_TEXT", "SEND_WHATSAPP_TEMPLATE", "REPLY_FACEBOOK_COMMENT", "SEND_FACEBOOK_MESSAGE", "REPLY_INSTAGRAM_COMMENT", "SEND_INSTAGRAM_MESSAGE"]}, "recipientRef": ID, "text": S, "templateName": S, "language": S, "templateParams": {"type": "array", "items": S}}, ["type", "recipientRef"]),
    "Health": obj({"status": {"type": "string", "enum": ["OK", "NOT_READY"]}}, ["status"]),
}


def operation(method, operation_id, result, request=None, status="200", public=False, service=False, description=""):
    security = [] if public else [{"ServiceAuth": []}] if service else [{"SessionCookie": [], **({"CsrfHeader": []} if method != "get" else {})}]
    response = {"description": "Resultado seguro; verificar status e evidência do servidor"}
    if result:
        response["content"] = {"application/json": {"schema": ref(result)}}
    op = {"operationId": operation_id, "summary": description or operation_id, "security": security,
          "responses": {status: response, "default": {"description": "Erro normalizado seguro", "content": {"application/json": {"schema": ref("SafeError")}}}}}
    if request:
        op["requestBody"] = {"required": True, "content": {"application/json": {"schema": ref(request)}}}
    if not public and not service and operation_id not in ["readSession", "logout"]:
        op.setdefault("parameters", []).append({"name": "X-Tenant-Context", "in": "header", "required": True,
            "schema": ID, "description": "Referência servidor vinculada à sessão+tenant+versão; contexto antigo gera CONTEXT_CHANGED antes de efeito"})
    if method in ("post", "delete", "patch") and not public:
        op.setdefault("parameters", []).append({"name": "Idempotency-Key", "in": "header", "required": True, "schema": {"type": "string", "maxLength": 128}, "description": "Escopo por tenant+operação, com hash de payload; não garante exactly-once externo"})
    return op


def build_api():
    paths = {}
    definitions = [
        ("/auth/exchanges", "post", "exchangeIdentity", "Session", "ExchangeRequest", "201", True),
        ("/auth/magic-links", "post", "requestMagicLink", None, "MagicLinkRequest", "202", True),
        ("/auth/magic-links/consume", "post", "consumeMagicLink", "Session", "MagicLinkConsume", "201", True),
        ("/session", "get", "readSession", "Session", None, "200", False),
        ("/session/tenant-switch", "post", "switchTenant", "Session", "TenantSwitch", "200", False),
        ("/session/logout", "post", "logout", None, None, "204", False),
        ("/integrations/flows", "get", "listFlows", None, None, "200", False),
        ("/onboarding-sessions", "post", "createOnboarding", "PublicBootstrap", "CreateOnboarding", "201", False),
        ("/onboarding-sessions/{id}/authorization-code", "post", "submitAuthorizationCode", "Job", "SubmitCode", "202", False),
        ("/onboarding-sessions/{id}", "get", "readOnboarding", "Onboarding", None, "200", False),
        ("/jobs/{id}", "get", "readJob", "Job", None, "200", False),
        ("/connections", "get", "listConnections", "ConnectionPage", None, "200", False),
        ("/assets/{id}", "get", "readAsset", "Asset", None, "200", False),
        ("/assets/{id}/refresh", "post", "refreshAsset", "Job", None, "202", False),
        ("/connections/{id}/reauthorizations", "post", "reauthorizeConnection", "PublicBootstrap", None, "201", False),
        ("/connections/{id}", "delete", "disconnectConnection", "Job", None, "202", False),
        ("/assets/{id}/automation-config", "patch", "updateAutomationConfig", "AutomationConfig", "AutomationConfig", "200", False),
        ("/whatsapp/accounts/{id}/templates", "get", "listTemplates", "TemplatePage", None, "200", False),
        ("/whatsapp/accounts/{id}/templates", "post", "createTemplate", "Operation", "TemplateCreate", "202", False),
        ("/notifications", "get", "listNotifications", "NotificationPage", None, "200", False),
        ("/notifications/{id}/actions", "post", "performNotificationAction", "Operation", "NotificationAction", "202", False),
        ("/operations/{id}", "get", "readOperation", "Operation", None, "200", False),
    ]
    for path, method, opid, result, request, status, public in definitions:
        paths.setdefault(path, {})[method] = operation(method, opid, result, request, status, public)
    paths["/integrations/flows"]["get"]["responses"]["200"]["content"] = {"application/json": {"schema": {"type": "array", "items": ref("Flow")}}}
    for path, value in paths.items():
        if "{id}" in path:
            value["parameters"] = [{"name": "id", "in": "path", "required": True, "schema": ID, "description": "ID interno autorizado; não aceita tenant/ExternalId como credencial"}]
        if path in ["/connections", "/notifications", "/whatsapp/accounts/{id}/templates"]:
            value["get"].setdefault("parameters", []).append({"name": "cursor", "in": "query", "schema": S})
    paths["/internal/v1/assets/{id}/operations"] = {
        "servers": [{"url": "https://connections.example.invalid"}],
        "parameters": [{"name": "id", "in": "path", "required": True, "schema": ID}],
        "post": operation("post", "executeServiceOperation", "Operation", "ServiceOperation", "202", service=True,
                          description="Relay S2S autorizado por tenant/ativo/operação; outcome UNKNOWN não é reenviado cegamente")}
    paths["/meta/{flow}/callback"] = {"parameters": [{"name": "flow", "in": "path", "required": True, "schema": ref("FlowVariant")}],
        "get": {"operationId": "providerCallback", "security": [], "parameters": [
            {"name": x, "in": "query", "required": x == "state", "schema": S} for x in ["state", "code", "error"]],
            "responses": {"303": {"description": "Redirect permitido com ID/resultado seguro; nunca token permanente"}, "400": {"description": "State/callback inválido"}}}}
    paths["/webhooks/meta/{appConfigRef}"] = {
        "parameters": [{"name": "appConfigRef", "in": "path", "required": True, "schema": ID}],
        "get": {"operationId": "verifyWebhookChallenge", "security": [], "parameters": [
            {"name": x, "in": "query", "required": True, "schema": S} for x in ["hub.mode", "hub.challenge", "hub.verify_token"]],
            "responses": {"200": {"description": "Challenge validado; retornar texto solicitado"}, "403": {"description": "Verificação recusada"}}},
        "post": {"operationId": "acceptWebhook", "security": [{"MetaWebhookSignature": []}], "x-raw-body-required": True,
            "description": "Validar HMAC sobre bytes originais e resolver tenant por item/ativo. Não confiar em tenant do envelope externo.",
            "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "description": "Envelope de provedor não confiável; parsers versionados sob matriz M1.03"}}}},
            "responses": {"200": {"description": "Persistência durável confirmada; negócio processado depois"}, "403": {"description": "Assinatura inválida"}, "503": {"description": "Não persistido; não confirmar recebimento"}}}}
    for path, opid in [("/health/live", "readLiveness"), ("/health/ready", "readReadiness")]:
        paths[path] = {"servers": [{"url": "https://connections.example.invalid"}], "get": operation("get", opid, "Health", public=True)}
    paths["/health/ready"]["get"]["responses"]["503"] = {"description": "Dependência essencial indisponível; processo continua vivo", "content": {"application/json": {"schema": ref("Health")}}}
    return {"openapi": "3.1.0", "info": {"title": "Meta Platform v2 · contrato proposto", "version": "0.1.0-planning", "description": "Rascunho revisável para M1.07. Não representa endpoints implementados. Ratificar nomes, constraints e políticas por produto antes da geração de cliente."},
            "servers": [{"url": "https://connections.example.invalid/api/v1", "description": "Placeholder sem ambiente operacional"}],
            "x-status": "proposed", "paths": paths, "components": {"schemas": SCHEMAS, "securitySchemes": {
                "SessionCookie": {"type": "apiKey", "in": "cookie", "name": "__Host-meta_session"},
                "CsrfHeader": {"type": "apiKey", "in": "header", "name": "X-CSRF-Token"},
                "ServiceAuth": {"type": "http", "scheme": "bearer", "description": "Identidade S2S com escopos; não é access token Meta"},
                "MetaWebhookSignature": {"type": "apiKey", "in": "header", "name": "X-Hub-Signature-256", "description": "HMAC do raw body com app secret; não é token de operação"}}}}


EVENT_SCHEMA = {"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": "urn:costaapps:meta-v2:internal-event:proposed-v1",
    "title": "Envelope interno após autenticação e resolução de tenant", **obj({
        "id": ID, "tenantId": ID, "type": {"type": "string", "enum": ["asset.changed", "authorization.changed", "subscription.changed", "projection.requested", "onboarding.changed"]},
        "schemaVersion": {"const": 1}, "aggregateId": ID, "aggregateVersion": {"type": "integer", "minimum": 1},
        "correlationId": ID, "causationId": ID, "occurredAt": DATE,
        "metadataRef": ID, "legacyDatabaseId": ID, "legacyCompanyId": ID
    }, ["id", "tenantId", "type", "schemaVersion", "aggregateId", "aggregateVersion", "correlationId", "occurredAt"]),
    "description": "Tenant é atribuído pelo servidor após validação; não é schema para confiar no webhook bruto. Segredos e conteúdo de mensagem não pertencem a este envelope operacional."}


def validate_references(document):
    def walk(value):
        if isinstance(value, dict):
            if "$ref" in value:
                target = document
                for segment in value["$ref"].removeprefix("#/").split("/"):
                    target = target[segment]
            for item in value.values():
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(document)


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    api = build_api()
    validate_references(api)
    (DEST / "openapi.proposed.json").write_text(json.dumps(api, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (DEST / "internal-event.proposed.schema.json").write_text(json.dumps(EVENT_SCHEMA, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"api_paths": len(api["paths"]), "api_operations": sum(len([m for m in v if m in ["get", "post", "delete", "patch"]]) for v in api["paths"].values()), "schemas": len(SCHEMAS), "status": "proposed; references checked, external semantics pending M1.07"}))


if __name__ == "__main__":
    main()
