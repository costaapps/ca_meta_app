# M1.06 — Contrato de identidade e acesso ao portal

**Issue:** [#15](https://github.com/costaapps/ca_meta_app/issues/15). **Estado:** proposta para implementação M2/M3, validada apenas com emissor e tenants sintéticos. Não é acordo com Suite4 nem prova de comportamento implantado.

O cruzamento da proposta com cada rota, request, função e exceção de [`docs/baseline/endpoint-matrix.csv`](../baseline/endpoint-matrix.csv) está em [endpoint-security-crosswalk.md](endpoint-security-crosswalk.md); o runner valida exatamente uma linha por cada uma das 53 entradas atuais.

## Decisões do contrato proposto

1. Antes de iniciar o emissor, o browser chama a operação pré-autenticação do portal com Origin exata e modo allowlisted. O servidor cria um desafio aleatório one-use, armazena somente seu hash associado ao hash de um cookie pre-auth `__Host-` host-only/`Secure`/`HttpOnly`, e envia o cookie; o desafio segue pelo handoff confiável ao emissor. O ticket assinado vincula o desafio em `preauth_challenge`. Ticket/desafio copiados para outro browser não correspondem ao cookie pre-auth daquele browser. Um valor em URL/query isoladamente nunca inicia ou autoriza sessão.
2. A API aceita um ticket de entrada assinado por um emissor configurado no servidor. Antes de validar/consumir o ticket, exchange requer contexto de entrada criado pelo servidor com `requestOrigin` exata da API, `hostOrigin` exata, `entryMode` allowlisted (`PORTAL_TOP_LEVEL` ou `SUITE4_EMBED`) e o cookie pre-auth recebido do browser. Ticket, challenge e cookie precisam corresponder a uma linha pre-auth não expirada e não consumida. O valor embed só vem do handshake validado; nenhum campo de body/query ou `cUUID` escolhe origem, fluxo, chave ou identidade.
3. O perfil proposto de ticket é `typ=JWT`, `alg=RS256`, `kid` confiável e claims `iss`, `aud`, `purpose=META_PORTAL_ENTRY`, `preauth_challenge`, `sub`, `tenant`, `roles`, `jti`, `iat`, `exp`, `ver=1` e `session_iss`. `roles` é informativo: a autorização usa membership atual do servidor. `tenant` precisa corresponder a membership ativa e tenant com status `ACTIVE` de `sub`.
4. O TTL máximo proposto é 60 segundos, com tolerância de relógio de até 5 segundos. A API valida assinatura, algoritmo, `kid`, issuer, audience, tipo/perfil, challenge e cookie vinculados, claims obrigatórias, janela temporal e membership antes de consumir o ticket. São parâmetros iniciais para negociação; valores Suite4 reais são **Not confirmed**.
5. `jti` e challenge são armazenados como hashes. Na mesma transação, a API trava/verifica a linha pre-auth ligada ao cookie, consome challenge e `jti` com unicidade por issuer e cria a sessão. Falha/replay reverte tudo; uma chave já consumida falha mesmo se a resposta anterior tiver se perdido. Recuperação precisa de novo desafio iniciado no mesmo browser, sem reutilizar ticket como bearer genérico.
6. A sessão é um segredo aleatório opaco. Só seu hash fica no servidor; o cookie é host-only, `HttpOnly`, `Secure`, `Path=/`, sem `Domain`, com política `SameSite` escolhida após confirmar a topologia. A primeira sessão e a troca de credencial rotacionam o segredo para impedir fixation. Propostas iniciais de expiração: 30 minutos sem atividade e oito horas absolutas; ambas são **Not confirmed** como política operacional.
7. Toda mutação autenticada exige Origin exata permitida, token CSRF ligado à sessão e validação compatível de Fetch Metadata. Exceções pré-autenticação têm contrato próprio: início de pre-auth valida Origin/host/flow; exchange valida o mesmo contexto, cookie e challenge vinculados antes de consumir challenge/`jti`; magic link exige POST explícito, Origin e token único. CORS usa origens explícitas, nunca `*` com credenciais. `GET` e `HEAD` não realizam efeitos de autenticação ou consumo.
8. Tenant é resolvido da sessão e membership vigentes. `cUUID` em URL/body é somente identificador legado não confiável; não cria principal, membership, sessão ou permissão. Uma divergência entre contexto da sessão e tenant solicitado termina em deny-by-default.
9. Cada troca de tenant revalida membership e altera `contextRef` e `contextVersion`. Operações empresariais exigem a referência corrente. Uma aba antiga recebe `CONTEXT_CHANGED`; ela não pode reusar o contexto anterior. Se o tenant atual for suspenso, seus recursos são negados; somente uma troca com Origin/CSRF/contextRef válidos para outro tenant `ACTIVE` com membership vigente pode recuperar a sessão. Onboarding, jobs e autorização iniciados mantêm o tenant e principal originais, conforme M1.05.
10. Link direto é emitido apenas para identidade já convidada com membership elegível. A resposta pública é uniforme para endereço existente e inexistente. O banco guarda hash do token, purpose e validade. Scanner `GET`/`HEAD` apenas mostra confirmação; consumo exige `POST` explícito, Origin exata, token íntegro, expiração vigente e membership ativa. O tenant vem do registro do link, nunca do formulário.
11. O handshake embed usa versão fixa, origem exata, referência de `event.source`, schema fechado, nonce aleatório de uso único e prazo curto. Só o ticket temporário pode cruzar o canal. `targetOrigin` é exato; mensagens nunca transferem cookie, token Meta, app secret, tenant escolhido pelo browser ou URL de navegação arbitrária.

## Emissor e rotação de chaves

| Campo | Proposta local | Estado Suite4 real |
|---|---|---|
| `iss` | Identificador exato configurado para o serviço emissor | **Not confirmed** |
| `aud` | Audiência exclusiva para abrir o portal de conexões | **Not confirmed** |
| `preauth_challenge` | Desafio one-use criado pelo portal antes da emissão e vinculado ao hash do cookie pre-auth do browser | **Not confirmed** |
| `sub` | Subject estável do principal no issuer | **Not confirmed** |
| `tenant` | Tenant interno resolvido no serviço de identidade | **Not confirmed** |
| `roles` | Indicação assinada, nunca fonte final de autorização | **Not confirmed** |
| `jti` | Identificador imprevisível, consumido uma vez por issuer | **Not confirmed** |
| `iat` / `exp` | Inteiros Unix; TTL proposto ≤60 s e skew ≤5 s | **Not confirmed** |
| `ver` | Versão explícita do perfil de ticket; inicial `1` | **Not confirmed** |
| `session_iss` | Identificador da sessão/autoridade que originou a troca | **Not confirmed** |
| `kid` / algoritmo | `kid` seleciona chave apenas no conjunto confiável; RS256 allowlist local | **Not confirmed** |

Rotação proposta: publicar chave nova no conjunto confiável antes de emitir com seu `kid`; permitir somente uma sobreposição curta configurada de chaves antigas; parar de emitir com a chave anterior; remover/revogar o `kid` comprometido e rejeitar novos tickets assinados por ele. Chave e issuer não são selecionados por dados do ticket. A API não baixa URL de chave fornecida no header. Atualização/indisponibilidade do JWKS, cache, período de sobreposição e procedimento de revogação do Suite4 dependem de contrato real.

Membership é reconsultada no exchange e em cada autorização de sessão. Revogar membership invalida somente essa associação tenant/principal, impedindo trocas e invalidando sessões daquele tenant na próxima verificação; não desativa implicitamente a identidade global nem outras memberships. Qualquer desativação global é uma operação separada e auditada, fora do harness desta entrega. Se o tenant atual for suspenso, seus recursos são negados e uma sessão ainda válida pode trocar, com CSRF e nova membership, para outro tenant ativo; sem outra membership ativa, a recuperação exige novo processo de identidade autorizado. Logout/revogação marca a sessão server-side. Invalidar tickets já emitidos por incidente de issuer pode exigir `jti` denylist/versão de emissor além do TTL curto; o mecanismo real ainda depende do emissor. A assinatura não substitui a consulta de membership.

## Sessão, CSRF e contexto de tenant

```text
Browser inicia pre-auth no portal; servidor vincula challenge ao cookie HttpOnly
  -> handoff confiável entrega challenge ao emissor
  -> Suite4 valida sessão + membership e emite ticket curto com challenge
  -> portal valida ticket + membership atual + challenge/cookie + jti ainda livres
  -> transação consome challenge e jti e cria PortalSession
  -> browser recebe cookie opaco e CSRF; resposta não contém segredo Meta
  -> API resolve principal/tenant/role do servidor em cada operação
```

Exemplo de cookie proposto: `__Host-meta_portal=<segredo aleatório>; Path=/; Secure; HttpOnly; SameSite=Lax`. O harness local verifica que não há `Domain`; `SameSite=Lax` é uma escolha de teste, não decisão de compatibilidade cross-site. Cookies de terceiros podem estar bloqueados: o produto oferece retorno retomável em janela top-level, sem remover `HttpOnly`, afrouxar CSRF ou ampliar CORS.

Origem e token CSRF são exigidos em `POST`, `PATCH`, `PUT` e `DELETE`, incluindo troca de tenant, logout, iniciar/cancelar onboarding, desconectar e repetir uma operação. A verificação de Origin é exata (scheme, host e porta), além do token imprevisível associado à sessão; Fetch Metadata reforça a decisão. Endpoint sem sessão não aceita `cUUID` como autenticação. IDs de recursos são sempre consultados no tenant derivado da sessão; ausência e tenant divergente não revelam existência de outro cliente.

`contextRef` é uma referência opaca rotacionada em toda troca de tenant e armazenada como hash junto a `contextVersion` na `PortalSession`. A sessão autenticada e membership continuam necessárias; `contextRef` não é bearer. Cada mutação compara a referência/versão esperada sob lock ou controle otimista. Uma entre duas trocas concorrentes com a mesma versão pode vencer; a outra recebe `CONTEXT_CHANGED`. Onboarding e job carregam seu `tenant_id`/`principal_id` inicial e nunca são reatribuídos pela sessão corrente. Para voltar a consultar a jornada, o usuário seleciona explicitamente o tenant de origem e obtém um novo contexto válido.

## Acesso direto por magic link

1. `POST /api/v1/auth/magic-links` normaliza a entrada, aplica quota/rate limit por origem confiável e alvo protegido e devolve status/body iguais para qualquer endereço. Resposta igual **não prova tempo constante nem ausência de enumeração por timing**. Só uma identidade previamente convidada e membership elegível gera envio; o endpoint não cria usuário, membership ou tenant por domínio de e-mail/UUID.
2. O serviço gera token aleatório de alta entropia, armazena apenas seu hash com `purpose`, principal, tenant, `expires_at` e `consumed_at`; resposta de API, métricas e logs não recebem o token. O token vai ao destinatário por canal configurado; o harness usa inbox fake somente dentro do container. O harness limita o token a 10 minutos como fixture; prazo real é **Not confirmed**.
3. `GET` e `HEAD` do link mostram a confirmação e não alteram o registro de uso. Uma confirmação explícita de usuário faz `POST /api/v1/auth/magic-links/consume`; Origin, validade, purpose, uso único e membership são verificados na transação que consome o token e cria sessão.
4. Tenant enviado pelo browser é ignorado ou comparado ao tenant do registro e rejeitado se divergente. Replay, expiração, tenant alterado e membership/tenant suspensos falham com erro público indistinguível que não confirma cadastro. O harness prova apenas resposta/status consistentes e um bucket de quota em processo; não prova timing não enumerável, rate limit distribuído, limites operacionais, entrega real de e-mail ou retenção. Esses controles são **Not confirmed** e precisam de M3.

## Papéis e matriz ator → operação → escopo

Proposta inicial por tenant; o serviço deriva papel de membership atual. Permissão não substitui validação de recurso, capability, estado, idempotency key e policy do fluxo. Todo comando cria audit event com ator/tenant/operação/alvo/resultado/correlation ID e diffs permitidos; nunca grava cookie, token, código, segredo, ciphertext ou payload bruto. Recusas de autorização também geram evento seguro de segurança sem expor existência entre tenants.

| Ator | Operação | Escopo mínimo | Decisão proposta / auditoria |
|---|---|---|---|
| `owner` | Ler conexão, ativos e histórico permitido | Membership ativa + tenant da sessão + recurso daquele tenant | Permitido; leitura sensível segue política de acesso/auditoria |
| `owner` | Conectar / reautorizar | Tenant da sessão + capability/configuração server-side + idempotency key | Permitido; `CONNECT_REQUESTED`/`REAUTH_REQUESTED` |
| `owner` | Desconectar | Conexão daquele tenant e confirmação do impacto | Permitido; `DISCONNECT_REQUESTED`, revogação seletiva M1.05 |
| `owner` | Reenviar evento falho | Evento explicitamente selecionado daquele tenant, estado retryable e idempotency key | Permitido; `EVENT_RETRY_REQUESTED`; sem replay de payload livre |
| `admin` | Ler, conectar/reautorizar e desconectar | Mesmo tenant, membership ativa e policy do recurso | Permitido; audit event para cada comando |
| `admin` | Reenviar evento falho | Evento retryable do tenant e operação tipada | Permitido; `EVENT_RETRY_REQUESTED` |
| `operator` | Ler, conectar/reautorizar | Mesmo tenant e capability/configuração elegível | Permitido; comandos auditados |
| `operator` | Desconectar | Qualquer ativo/conexão | Negado na proposta; `AUTHZ_DENIED`, owner/admin decide |
| `operator` | Reenviar evento falho | Evento retryable explicitamente selecionado no tenant | Permitido; idempotência obrigatória e `EVENT_RETRY_REQUESTED` |
| `viewer` | Ler recursos públicos do portal | Mesmo tenant, recursos permitidos e membership ativa | Permitido; sem segredos ou payload bruto |
| `viewer` | Conectar, desconectar ou reenviar evento | Qualquer recurso/efeito | Negado; tentativa sensível gera `AUTHZ_DENIED` redigido |
| Serviço `suite4-ticket-issuer` | Emitir ticket | Sessão/membership Suite4 atual; principal/tenant/audience próprios | Sem sessão humana do portal; issuer/key auditados fora do payload secreto |
| Serviço `event-relay` | Executar operação tipada | Tripla allowlisted `(tenant, asset, operation)` e credencial própria curta/rotacionável | Sem token humano, token Meta, Graph URL livre ou decrypt genérico; audit event com correlation ID |
| Serviço `mail-delivery` | Enviar magic link | Link existente, purpose, destinatário e quota previamente aprovados | Não enumera pela API; token não aparece em log; envio auditado com resultado seguro |

Papéis e permissões acima são uma política proposta para M2, não roles recebidas/confirmadas do Suite4. Grants reais, delegação de admin/owner, fronteira dos serviços e política de suporte são **Not confirmed**.

## Handshake de embed proposto

| Direção | Mensagem | Campos | Verificações |
|---|---|---|---|
| child → parent | `EMBED_READY` | `version=1`, `nonce`, `requestId` | Child envia apenas a `targetOrigin` exata configurada |
| parent → child | `EMBED_BOOTSTRAP` | `version=1`, nonce correspondente, ticket curto | `event.origin` e `event.source` exatos; schema allowlist; nonce recente, pendente e de uso único; ticket trocado server-side |
| child → parent | `EMBED_ACK` | `version=1`, requestId, status público | Enviado à mesma origem exata; sem tenant secreto, cookie ou token Meta |
| ambos | resize/theme/navigation | payload tipado pequeno e versão conhecida | Esquema específico; sem URL livre, comando de administração ou segredo |

Sem suporte a terceiro cookie, o estado é `TOP_LEVEL_REQUIRED` e a retomada ocorre em navegação top-level consentida. `frame-ancestors`, CSP, sandbox, domínio exato, callback e comportamento de popup precisam ser acordados com Suite4 antes de ativar iframe.

## Cenários e rastreabilidade

| Requisito | Given / When / Then | Evidência local |
|---|---|---|
| `M1.06.AC01` | Given ticket/challenge próprios ou transplantados, cookie pre-auth ausente, tenant ativo ou suspenso / When ocorre exchange ou URL cUUID é arbitrário / Then somente desafio iniciado no mesmo browser, contexto exato e tenant ACTIVE criam sessão; falhas deixam jti livre | `AC01` + `AC02` no harness MariaDB |
| `M1.06.AC02` | Given chave RSA fake confiável e principal com memberships A/B / When alg, assinatura, kid, issuer, audience, purpose, challenge, prazo, jti, tenant ou membership são adulterados/revogados / Then exchange falha; revogação de A nega A e preserva B; jti válido concorre atomicamente | `AC02` no harness; emissor fake não prova Suite4 |
| `M1.06.AC03` | Given convite sintético conhecido/desconhecido e bucket de quota / When resposta é solicitada, scanner usa GET/HEAD, token expira/replay/tenant muda / Then status/body permanecem consistentes, quota local é exercida e somente POST explícito consome link; timing e rate limit real não são certificados | `AC03` no harness |
| `M1.06.AC04` | Given onboarding no tenant A e duas abas com mesma versão / When uma troca tenant e outra usa referência antiga / Then onboarding permanece A e a aba atrasada recebe `CONTEXT_CHANGED` | `AC04` no harness |
| `M1.06.AC05` | Given owner/admin/operator/viewer/service / When comandos de conexão, desconexão e retry são autorizados/negados / Then policy por escopo e audit outcome ficam explícitos | `AC05` no harness e matriz ator→operação→escopo |

## Gates para integração real M3.02

Antes de integrar com Suite4, ratificar: issuer/subject estáveis; audience exclusiva e purpose/type do ticket; suporte a `preauth_challenge`, emissão após desafio iniciado pelo browser e handoff protegido; claims/versão/TTL/skew; algoritmo/kid/JWKS e cache/rotação/indisponibilidade/revogação; membership lookup e latência/semântica de revogação; relacionamento real entre principal e tenant; comportamento após exchange com resposta perdida; origens e `event.source` do iframe; CSP/frame ancestors/sandbox; domínio/API/cookie SameSite/partição e preservação do cookie pre-auth durante o handoff/embed; fluxo quando third-party cookies estão bloqueados; CSRF/CORS/proxy; e papéis/donos/admins/suporte. Executar teste em ambiente não produtivo autorizado por Suite4, browser matrix, integração de cookies/iframe e revisão de segurança. Até lá, nenhum teste local certifica identidade Suite4, issuer/JWKS, challenge/handoff, roles, tenant real, política de cookies, origem ou comportamento de navegador implantado.

## Referências de segurança

Consultadas em 2026-10-28. As fontes fundamentam as propriedades gerais abaixo; não descrevem o emissor Suite4.

- [RFC 7519 — JSON Web Token (JWT)](https://www.rfc-editor.org/rfc/rfc7519): formato e claims padrão `iss`, `sub`, `aud`, `exp`, `iat`, `jti`.
- [RFC 8725 — JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725/): allowlist de algoritmos, validação mutuamente exclusiva de perfil/issuer/audience e cuidados com key selection.
- [RFC 7517 — JSON Web Key (JWK)](https://www.rfc-editor.org/rfc/rfc7517): conjunto/chave pública e identificador `kid`.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) e [CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): sessão opaca, cookies e token/Origin para mutações.
- [MDN `Window.postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage): checar `origin`, `source`, schema e `targetOrigin` exato.
- [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110/): semântica de métodos safe; scanner de link não deve disparar mutação por GET/HEAD.
