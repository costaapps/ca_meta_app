# M1.06 — Modelo de ameaças de identidade, tenant e embed

**Issue:** [#15](https://github.com/costaapps/ca_meta_app/issues/15). Este documento analisa o contrato proposto para M2/M3 e o código/referências versionados em M1.05/M1.06. Não afirma que Suite4 ou o deployment atual já implementam esses controles.

## Escopo, ativos e fronteiras

### Evidência atual

- O frontend Angular usa `cUUID` em contexto de cliente e a base ainda não estabelece um contrato seguro parent/iframe; ver `src/app/core/services/meta-integration.service.ts`, `src/app/features/channels/pages/channel-setup/channel-setup.component.ts` e [.github/docs/agent-context/iframe-integration.md](../../.github/docs/agent-context/iframe-integration.md).
- M1.05 propõe `Principal`, `Membership`, `PortalSession`, `OnboardingSession`, jobs e audit versionados. Chaves/consultas empresariais incluem `tenant_id`; sessão guarda hashes opacos e versão de contexto. O harness M1.05 executa constraints sintéticas em MariaDB, não migra DDL real: [m1-05-domain-model.md](m1-05-domain-model.md), [m1-05-state-machines.md](m1-05-state-machines.md) e [`tools/m1-05/`](../../tools/m1-05/README.md).
- A implementação futura deve negar por padrão e tirar autoridade de UUID do browser. PHP local, produção, emissor Suite4, identidade/membership reais, topologia/cookies e configuração de frame não são reproduzidos por esta PoC.
- Cada uma das 53 linhas da matriz legada tem identidade, tenant, Origin/CSRF, role/scope, efeito e gate mapeados no [crosswalk](endpoint-security-crosswalk.md); o runner exige correspondência única com a fonte CSV.

### Ativos protegidos

| Ativo | Impacto se comprometido | Proteção proposta |
|---|---|---|
| Membership, principal, tenant e papel | Acesso cruzado a contas e ativos empresariais | Lookup autoritativo por issuer+subject+tenant e estado vigente em cada autorização |
| Ticket temporário e `jti` | Troca/replay e fixação de identidade | Assinatura allowlisted, claims restritas, TTL curto e consumo atômico |
| Cookie e sessão | Sequestro de sessão e ações não autorizadas | Segredo aleatório, somente hash server-side, `HttpOnly/Secure`, expiração, rotação e revogação |
| Contexto e onboarding | Operação no tenant errado ou reatribuição indevida | `contextRef` versionado/rotacionável; onboarding/job mantém tenant/principal de criação |
| Magic link | Tomada de conta ou membership indevida | Convite existente, hash de token, resposta uniforme, GET/HEAD sem consumo, POST explícito |
| Bridge parent/iframe | Ticket/contexto entregue a frame atacante | Origem exata, `source`, schema/version, nonce único e `targetOrigin` exato |
| Assets, autorizações, credenciais Meta | Exposição ou ação externa em nome de empresa errada | Policy por tenant/recurso/capability; credenciais somente backend, handles internos e audit redigido |
| Evento/webhook e audit | Reprocessamento, fanout ou vazamento de payload/PII | Assinatura sobre bytes conforme contrato, dedupe durável, quarantine; audit sem token/payload |

### Atores e limites de confiança

- **Não autenticado:** visitante, scanner de e-mail, bot ou browser com `cUUID` controlado pelo usuário.
- **Usuário autenticado:** principal com owner/admin/operator/viewer, sempre por membership no tenant específico.
- **Host Suite4:** emissor presumido somente na proposta. Seu domínio, sessão, contrato de ticket, chaves e membership são **Not confirmed**.
- **Iframe/portal:** código frontend parcialmente controlável; valores em URL, storage, evento e body não são autoridade.
- **Serviços internos:** identidade de workload distinta de usuário e token Meta, escopo limitado por tenant/asset/operação e credencial rotacionável.
- **Atacante externo/tenant vizinho:** pode adulterar URL/body/header, iniciar requests cross-site, replay de ticket/link/mensagem, explorar timing concorrente ou controlar janela/frame sibling.
- **Operador/suporte:** poder privilegiado precisa de ações tipadas, justificativa e audit; não tem endpoint genérico de SQL, decrypt, Graph URL ou sessão impersonada.

Fronteiras: browser ↔ API; Suite4 ↔ API de troca; browser parent ↔ iframe; API ↔ banco de memberships/sessões; API ↔ serviço de e-mail; API/worker ↔ Meta; receiver de webhook ↔ fila/roteador; API ↔ serviço interno. Tráfego cifrado não corrige claims, tenant ou destinatário incorretos.

## Análise de abuso e controles

| ID | Ameaça / abuso | Controle exigido no contrato e implementação | Prova desta entrega / limite |
|---|---|---|---|
| T01 | cUUID/tenant/assetId arbitrário em URL, body, cache key, job ou suporte; tenant suspenso | Resolver tenant da sessão; membership atual e `tenant.status=ACTIVE`; query/FK e policy por recurso usam tenant derivado. UUID é identificador, nunca prova de acesso. | `AC01` tenta sem sessão e com tenant diferente; `AC02` suspende tenant antes de ler/trocar. M1.05 executa consultas/FKs sintéticas. |
| T02 | JWT `alg=none`, troca RS/HS, assinatura adulterada, kid desconhecido ou seleção SSRF por `jku`/`x5u` | Algoritmo fixo allowlisted e compatível com chave; issuer/aud/type/purpose/perfil estritos; `kid` consultado somente no conjunto confiável e rotação controlada. Ignorar/rejeitar URLs de chave do token. | `AC02` usa chaves RSA efêmeras e casos adversos; não consulta JWKS real nem prova gestão de chaves. |
| T03 | Ticket vindo de Origin/host não confiável, fluxo não allowlisted, troca para outra API ou `jti` repetido | Antes de verificar/consumir ticket, exigir contexto server-derived: request Origin exata, host Origin exata casada com modo top-level/embed permitido e purpose do ticket; só então validar claims e consumir `jti`/criar sessão atomicamente. | `AC01` testa contexto ausente/adulterado/fluxo inválido e consulta que `jti` segue livre; real origin/flow Suite4 é gate M3.02. |
| T04 | Claims antigas ainda assinadas após desligamento de pessoa ou tenant | Membership/role reconsultados na troca e operações; estado revogado nega sessão existente na próxima verificação; revogação de sessão é server-side. | `AC02` revoga membership sintética entre emissão e exchange e após sessão; não define SLA de revogação real. |
| T05 | Magic link revela e-mail cadastrado, é usado por scanner, replayado ou editado para outro tenant | Status/body públicos consistentes; token de alta entropia/hash/purpose/expiração; GET/HEAD sem consumo; POST explícito e consumo único em transação; tenant é do registro; membership/tenant ativos; quota por origem confiável. Igualdade de resposta não prova tempo constante nem não-enumeração por timing. | `AC03` compara status/body, exercita quota sintética process-local, simula GET/HEAD, replay e tenant adulterado. Não envia e-mail real nem prova timing, rate limit distribuído/real ou scanners de fornecedores. |
| T06 | Fixation, roubo ou replay de cookie; sessão continua válida após troca/revogação | Rotacionar na autenticação e elevação; cookie host-only `__Host-`, `HttpOnly`, `Secure`, sem `Domain`; hash server-side, idle/absoluta, logout/revogação; revalidar membership. Não colocar sessão em URL/log/localStorage. | `AC02` confere atributos, hash persistido e revogação. `SameSite`/durabilidade/timeout reais dependem de topologia e operação. |
| T07 | CSRF/login-CSRF em mutation, tenant switch, logout, magic link ou início de onboarding | Origin estrita, token CSRF vinculado à sessão para mutações, Fetch Metadata e CORS exato. Exchange/link exige Origin/fluxo explícito. GET/HEAD não mudam estado. | `AC02` testa Origin/CSRF válido e inválido; não é browser E2E nem configuração CORS/proxy implantada. |
| T08 | Duas abas mudam contexto; request atrasado, callback ou job liga dados ao tenant atual errado | Troca verifica membership e versão/contextRef esperado sob serialização/controle otimista; rotaciona ref. Onboarding/job persiste tenant/principal da criação e callback reconcilia apenas com state/sessão de servidor. | `AC04` concorre trocas, verifica `CONTEXT_CHANGED` e tenant original do onboarding; callback real integra depois em M3. |
| T09 | `postMessage` de janela irmã, domínio parecido, subframe ou mensagem antiga | `origin` exato completo, `event.source` esperado, versão/schema allowlisted, nonce e freshness de uso único, `targetOrigin` explícito; jamais `*`. Mensagem não concede membership por si. | `AC04` rejeita origem, source, schema/version e nonce repetido; sem browser/Suite4 real. |
| T10 | Cookie de terceiro bloqueado causa tentativa de desabilitar CSRF ou baixar segurança | Caminho recuperável top-level/popup com sessão retomável e Origin/CSRF preservados. Não usar token em localStorage, remover HttpOnly, wildcard ou proteções de browser. | `AC04` verifica estado de fallback seguro; navegadores/domínios reais são gate M3.02. |
| T11 | Replay/adulteração de webhook, ID de app errado ou evento em lote roteado a tenant vizinho | Validar assinatura no raw body e configuração de app correta; idempotência durável por evento+item; dedupe e rota unívoca; conflitos vão a quarantine sem fanout. Não confiar em payload como membership. | M1.05 AC05 cobre replay/dedupe/transação fake. Assinatura, chaves, entrega e rotas físicas Meta não são certificadas aqui. |
| T12 | Endpoint interno de credencial/decrypt/Graph vira confused deputy | Identidade service distinta; scopes contêm tenant + asset + operação; operações tipadas e hosts permitidos; sem Graph URL livre, SQL, token humano ou decrypt arbitrário; allowlist e audit. | `AC05` exercita policy sintética; endpoint/credencial/permits operacionais não foram implementados. |
| T13 | Ação de conectar/desconectar/retry por papel indevido ou suporte oculto | Matriz explícita owner/admin/operator/viewer e service; revalidar resource/capability/estado; idempotency key; audit seguro para resultado e negativa, sem segredo ou payload. | `AC05` verifica policy, scoping e audit marker sintético; política final depende do produto e integração. |
| T14 | Token Meta, código OAuth, cookie, ciphertext, e-mail ou payload aparecem em logs, DTO, audit ou inbox não autorizado | DTO público separado; redaction; writer de audit allowlisted; raw payload em storage restrito por mínimo tempo. Chaves/segredos somente backend. | O harness verifica ausência de valores secretos sintéticos em linhas controladas; não varre logs/trace de deploy nem estabelece retenção legal. |

## Critérios de aceite executáveis

| Critério | Verificação | Evidência esperada |
|---|---|---|
| `M1.06.AC01` | Abrir diretamente com cUUID sem sessão; trocar ticket com contexto ausente, Origin/host adulterado ou fluxo inválido | `AUTH_REQUIRED`/deny; nenhum principal, sessão ou asset é criado; `jti` não consumido |
| `M1.06.AC02` | Emissor fake assina ticket correto, depois altera assinatura, issuer, audience, purpose, alg, `kid`, validade, `jti`, membership ou suspende tenant | Só chave/perfil/contexto permitidos trocam; membership ou tenant suspensos falham; `jti` válido gera no máximo uma sessão |
| `M1.06.AC03` | Solicitação conhecida/desconhecida; GET/HEAD de scanner; POST; replay, expiração, tenant manipulado e quota fake excedida | Status/body públicos consistentes; scanner não consome; quota local se aplica; teste não afirma timing não enumerável ou quota real |
| `M1.06.AC04` | Duas abas usam mesma versão e onboarding A é iniciado antes da troca para B | Uma troca vence; outra ref fica stale; onboarding/job retém A; handshake rejeita origin/source/version/nonce fora do contrato |
| `M1.06.AC05` | Tentar conectar, desconectar e reenviar evento em cada papel e via service scope | Matriz menos privilegiada, nega fora do escopo e grava audit safe para a decisão |

## Limitações e gates remanescentes

- Contrato Suite4 real, issuer/JWKS/audience, claims, papel, tenant, validade, revogação e comportamento após troca: **Not confirmed**; gate da integração real M3.02.
- Origens, `frame-ancestors`, CSP, cookies cross-site/particionados, CORS/proxies, popup/callback e browsers suportados: **Not confirmed**; testes em ambiente não produtivo autorizado são obrigatórios.
- Emissor fake gera chave RSA em runtime; harness prova invariantes e casos adversos locais, não segurança operacional, custódia/rotação real, deployment multi-região ou resistência a key compromise.
- Igualdade de status/body e quota em memória não medem timing, CDN/proxy, rate limit distribuído ou desempenho sob abuso. Esses controles precisam de limites operacionais e revisão de enumeração antes de acesso direto público.
- O banco é MariaDB local isolado; tabela é sintética e não é DDL/migration de produção. Não houve Meta call, envio externo, acesso a PHP operacional, import de identidade real ou escrita de produção.
- Política de suporte, ownership de uma empresa e recuperação de resposta perdida ficam abertas para ratificação; nenhum bypass administrativo é proposto.

## Referências

Para fontes oficiais e decisões do contrato, ver as [referências de segurança em identity-contract.md](identity-contract.md#referências-de-segurança), RFC 8725, OWASP Session/CSRF Cheat Sheets e MDN `postMessage`. Essas recomendações são gerais e não confirmam a configuração Suite4.
