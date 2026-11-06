# Identidade, contratos de API e segurança

O portal oferece uma experiência sem senha adicional, mas sempre cria identidade e sessão verificáveis. A ausência de formulário de login próprio não significa ausência de autenticação.

## Entrada Suite4/Msg4

| Passo | Ator | Contrato e validação |
|---|---|---|
| 1 | Backend Suite4 | Valida sessão atual e membership; emite ticket curto para finalidade abrir portal |
| 2 | Browser/host | Transporta ticket temporário pelo bootstrap definido; não fabrica tenant/roles |
| 3 | API de conexões | Valida assinatura, emissor, audiência, validade, membership e consumo atômico de jti |
| 4 | API | Rotaciona sessão e emite cookie opaco HttpOnly/Secure; retorna contexto público |
| 5 | Angular | Consulta sessão/recursos; não persiste ticket ou token Meta em localStorage |

Claims propostas: `iss`, `aud`, `sub`, `tenant`, `roles` ou referência autoritativa, `jti`, `iat`, `exp`, `purpose=META_PORTAL_ENTRY`, `ver=1` e `session_iss`, com header `typ=JWT`, `alg=RS256` e `kid` localmente confiável. O skew proposto é limitado a 5 segundos e TTL a 60 segundos. `session_iss` é apenas string obrigatória não vazia e limitada; formato/semântica e relação com Suite4 são **Not confirmed**, sem autoridade sobre identidade ou tenant. Confirmar o perfil com o emissor real. O servidor deve consultar ou comprovar membership vigente, inclusive quando claims antigas ainda estiverem assinadas.

Rotação de chave usa `kid` e conjunto confiável de chaves; não seguir `jku` de input arbitrário. Consumo de jti e criação de sessão são atômicos. Retry de resposta perdida com o mesmo ticket/JTI, challenge e binding pre-auth do browser pode retornar somente a mesma sessão ainda ativa, sem criá-la ou renová-la; sessão/membership/tenant revogada ou expirada e qualquer binding diferente são negados. O ticket não funciona como bearer fora dessa recuperação exata.

Se Suite4 já oferecer OIDC confiável, o ADR pode adotar esse padrão em vez de inventar outro emissor; mantêm-se as invariantes de tenant, replay, audience e sessão. O contrato real ainda não foi fornecido.

## Acesso direto

Magic link é enviado somente para identidade previamente convidada/autorizada. Resposta de solicitação é uniforme. Token opaco de alta entropia é armazenado como hash, tem propósito/validade/uso único e limites de tentativa. GET/HEAD do link não consome: uma página de confirmação exige POST consciente, evitando scanners de e-mail. Criar membership por domínio do e-mail ou CompanyUUID é proibido.

Envio por e-mail depende de provedor/domínio configurado, fila e quotas. Ambiente de teste usa inbox local. Recuperação administrativa e troca de e-mail precisam de contrato e verificação; não criar um bypass de autenticação para suporte.

## Sessão e autorização

- Cookie host-only `HttpOnly`, `Secure`, path apropriado e `SameSite` coerente com fluxo. Preferir origin único para web/API.
- Segredo de sessão aleatório no cookie e hash no servidor, com revogação compartilhada, rotação e proteção contra fixation.
- Propostas iniciais: 30 minutos idle e oito horas absolutas; são parâmetros a validar, não garantias sobre configuração atual.
- Mutação exige proteção CSRF e validação de Origin/Fetch Metadata coerentes. CORS usa origem exata; wildcard/credentials não é aceitável.
- Papéis iniciais por tenant: owner/admin, operator, viewer. Cada operação valida o recurso, não só o papel global.
- Serviço interno usa identidade/escopos próprios com rotação e revogação. Não reutilizar sessão de pessoa ou token Meta como chave da API.
- Qualquer tenant de URL/body é identificador a comparar com a sessão, nunca autoridade. Mudança de empresa valida membership e não altera onboards já iniciados.

Para evitar ação na empresa errada após troca em outra aba, a API devolve `contextRef` opaca ligada à sessão, tenant e versão. Operações empresariais exigem `X-Tenant-Context`; trocar empresa rotaciona a referência. A aba antiga recebe `CONTEXT_CHANGED` antes de leitura/efeito e precisa reconciliar a empresa exibida. A referência pode ficar em memória/sessionStorage e não autoriza sozinha sem cookie/membership. Onboards/jobs continuam ligados ao tenant de origem, sem serem reatribuídos pela troca.

## Embed e janelas Meta

Protocolo parent/child versionado: `EMBED_READY` com nonce; bootstrap com ticket curto; troca na API; ACK seguro. Validar `event.origin` exato e `event.source`, schema/version, nonce e frescor. Resize/theme/navigation têm schemas próprios e não carregam execução arbitrária nem segredo permanente.

OAuth/Embedded Signup abre em popup controlado ou top-level. Retorno sinaliza ID/estado seguro; Angular consulta API. Evento FINISH ou `auth_success=true` não é prova de prontidão. Eventos Meta têm origem/source/schema conforme versão comprovada e não servem como mensagens de administração de tenant.

Bloqueio de cookies de terceiros é cenário real de produto: oferecer top-level seguro e retomável. Não contornar desabilitando CSRF, removendo HttpOnly ou aceitando origem `*`.

## Superfície HTTP v1 proposta

Os paths são contrato inicial para ratificação em OpenAPI. Segurança de todas as rotas é deny-by-default; exceções públicas exigem validação própria.

| Operação | Método e rota | Autorização/efeito |
|---|---|---|
| Iniciar pre-auth | POST `/api/v1/auth/preauth` | Origin exata + Fetch Metadata + quota por IP; cria binding de browser top-level e cookie HttpOnly, sem autenticar nem criar membership |
| Trocar ticket | POST `/api/v1/auth/exchanges` | Ticket confiável e consumo único; cria sessão |
| Pedir link | POST `/api/v1/auth/magic-links` | Público limitado, resposta uniforme; não cria membership |
| Consumir link | POST `/api/v1/auth/magic-links/consume` | Segredo temporário único + controles de origem |
| Sessão | GET `/api/v1/session` | Cookie; pessoa/empresa/permissões públicas e `sessionRef` opaco; limite `SESSION_STATUS` por IP/principal/tenant |
| Troca/logout/revogação | POST `/session/tenant-switch`, POST `/session/logout`, DELETE `/sessions/:id` | CSRF/origin e sessão verificada; revogação limitada ao principal e tenant ativos da sessão corrente. `sessionRef` só seleciona o recurso; não autoriza. Sem endpoint de lista, a interface atual expõe apenas a sessão corrente |
| Catálogo | GET `/integrations/flows` | Tenant autenticado, config/flags/capabilities |
| Iniciar onboarding | POST `/onboarding-sessions` | Papel/capability + CSRF + idempotência; retorna bootstrap público |
| Entregar código | POST `/onboarding-sessions/:id/authorization-code` | Sessão/onboarding/state/correlação; código efêmero, resposta 202 |
| Callback | GET `/meta/:variant/callback` | Público somente com state de servidor de uso único e estratégia do provedor |
| Consultar progresso | GET `/onboarding-sessions/:id`, GET `/jobs/:id` | Mesmo tenant/recurso autorizado; sem payload secreto |
| Conexões/ativos | GET `/connections`, GET `/assets/:id` | Filtros/paginação e autorização por recurso |
| Atualizar status | POST `/assets/:id/refresh` | 202 job coalescido; rate limit |
| Reautorizar | POST `/connections/:id/reauthorizations` | Cria onboarding novo, preserva grant anterior quando válido |
| Desconectar | DELETE `/connections/:id` ou comando tipado | Escopo e impacto descritos; cleanup externo separado |
| Templates | GET/POST `/whatsapp/accounts/:id/templates` | Conta/grant MANAGE_TEMPLATES, payload permitido |
| Automação | PATCH `/assets/:id/automation-config` | Campos por canal, version/ETag e outbox |
| Notificações | GET `/notifications`, POST `/notifications/:id/actions` | Tenant completo e operationId; leitura separada de efeito externo |
| Operações | GET `/operations/:id` | Outcome incluindo UNKNOWN, sem token/resposta bruta |
| Webhook | GET/POST `/webhooks/meta/:appConfigRef` | Challenge/assinatura/raw body/limites; referência pública não é segredo |

O proxy encaminha POST sem `Origin` somente no path exato `/api/v1/webhooks/meta/{appConfigRef}` para ingresso de provedor. O handler precisa verificar a assinatura sobre os bytes originais antes de aceitar ou rotear payload; ele ainda não existe neste candidato e esse caminho não está pronto para receber tráfego. Não há rota interna de serviço com autenticação por credencial neste candidato; futuras rotas desse tipo, planejadas em M3.08, precisam de classificação e guard próprios. M3.02 expõe o bootstrap pre-auth `PORTAL_TOP_LEVEL` ligado ao cookie e à quota do M3.04; o bootstrap ainda não autentica uma pessoa nem estabelece membership. `SUITE4_EMBED` permanece reservado para M3.05 e é recusado até que o handshake, a origem/janela do parent e o caminho top-level de recuperação estejam implementados. Sem issuer/audience/chaves confiáveis de ticket configurados no servidor, a rota de exchange retorna erro seguro 503. O emissor real, a origem Suite4 e o comportamento real de cookies continuam **Not confirmed**.
| Revogação/exclusão Meta | Rota por configuração/produto | Mecanismo assinado conforme documentação validada |
| Relay interno | POST `/internal/v1/assets/:id/operations` | Operação tipada no payload; serviço com escopos de tenant/ativo/operação, sem Graph URL arbitrária |
| Liveness/readiness | GET `/health/live`, `/health/ready` | Detail restrito e sem segredos; não chama Meta no liveness |

Rotas de portal/Meta são relativas a `/api/v1`; relay `/internal/v1` e health possuem prefixos próprios no ingress. IDs públicos são internos opacos; uso de external ID legado exige compatibilidade explicitamente autorizada.

[OpenAPI 3.1 canônico da M1.07](contracts/openapi.yaml) materializa o contrato proposto, com schemas públicos, CSRF/sessão, IDs, callbacks, webhook, relay e operações assíncronas. O contrato e seus exemplos são validados em `tools/m1-07/`; o JSON `contracts/openapi.proposed.json` e o envelope genérico `contracts/internal-event.proposed.schema.json` permanecem artefatos históricos do planejador, não fontes de verdade para consumidores. A semântica externa, limites por canal e callbacks de exclusão/revogação precisam de ratificação autorizada; não é uma API já implementada nem certificado de conformidade com a Meta.

### Exemplos de contrato público

```json
{
  "flowVariant": "WHATSAPP_COEXISTENCE",
  "returnRoute": "connections",
  "requestedCapabilities": ["SEND_MESSAGE", "READ_STATUS"]
}
```

O request de início não contém `tenantId`, `CompanyUUID`, token ou app secret. Tenant/ator/config elegível vêm da sessão e registro servidor. `returnRoute` é enum/rota permitida, nunca URL de redirect arbitrária.

```json
{
  "id": "onboarding_opaque_id",
  "status": "PROVISIONING",
  "steps": [
    {"name": "authorization", "status": "SUCCEEDED"},
    {"name": "webhook", "status": "RETRY_PENDING"}
  ],
  "nextAction": "WAIT_OR_RETRY",
  "lastUpdatedAt": "2026-10-28T03:00:00Z",
  "requestId": "request_opaque_id"
}
```

Exemplos são sintéticos. O backend não declara READY só porque troca de token funcionou.

### Erros e idempotência

Envelope: `{code,safeMessage,requestId,retryable,action}`. Códigos estáveis propostos: `AUTH_REQUIRED`, `MEMBERSHIP_REVOKED`, `RESOURCE_NOT_AVAILABLE`, `STATE_INVALID`, `ONBOARDING_EXPIRED`, `FLOW_UNAVAILABLE`, `ASSET_GRANT_MISSING`, `ASSET_CONFLICT`, `META_PERMISSION_REQUIRED`, `META_RATE_LIMITED`, `SUBSCRIPTION_PENDING`, `OUTCOME_UNKNOWN`, `VERSION_CONFLICT`, `DEPENDENCY_UNAVAILABLE`. Erro detalhado Meta fica redigido em diagnóstico autorizado; nome do campo/valor secreto não deve aparecer em mensagem comum.

`Idempotency-Key` tem escopo tenant+operação+chave, payload hash, prazo e resultado. Mesma chave/payload diferente retorna conflito. Para efeitos externos, a chave local evita duplicação conhecida; não cria exactly-once Meta. Se envio venceu no provedor e a resposta se perdeu, outcome UNKNOWN exige reconciliação ou decisão explícita antes de repetir. `SUCCEEDED` significa evidência positiva, não ausência de exceção.

Async retorna 202 e ID/Location seguro; nenhum token em query. Paginação usa cursor opaco e tamanho máximo. Updates de configuração/grants têm versionamento para evitar sobrescrita por abas/importações atrasadas.

## Ameaças e provas exigidas

| Ameaça | Defesa | Evidência mínima |
|---|---|---|
| UUID/assetId trocado | Sessão+membership+policy+query tenant | BOLA em leitura, update, jobs, templates, notificações e suporte |
| Callback forjado/repetido | State opaco hashed, vínculo de sessão, TTL/consumo atômico | Replay entre duas réplicas, outra aba/tenant/config |
| Ticket replay/alg confuso | Emissor/audience/assinatura/alg/jti/membership | Chave rotacionada, assinatura errada, expiração e revogação |
| postMessage malicioso | Origem/source/schema/nonce | Janela/origem erradas e evento desconhecido |
| Token vazado | Cofre+DTO segregado+allowlist de logs | Marker secreto ausente de bundle/log/trace/artifact |
| SSRF Graph/mídia | Hosts/endpoints permitidos e limites | URL next/mídia maliciosa e redirects não permitidos |
| Webhook adulterado | HMAC raw body e app correto | JSON equivalente com bytes alterados é rejeitado |
| Vizinho ruidoso | Quotas/lanes/fairness por tenant | Histórico grande não paralisa webhook de outra empresa |
| Backdoor de suporte | Operações tipadas, roles e auditoria | Nenhuma execução Graph/decrypt/SQL arbitrária |

Dados pessoais ou segredos não devem ser anexados como “evidência” em issues. Guardar IDs internos, versões, requestIds, hashes seguros e resultados suficientes para reproduzir o problema.
