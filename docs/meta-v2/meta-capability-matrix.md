# M1.03 — Matriz de capacidades Meta

**Registro:** pesquisa pública e experimento offline, consultados em 2026-10-28. **Base de trabalho:** `desktop/milestone-m1@54787a9f18c1cb88ed881bb3a5dd207077b2facf`.

Este artefato separa quatro jornadas do produto: Facebook, Instagram por Facebook Login, WhatsApp Cloud API exclusivo e WhatsApp Coexistence. Instagram Login é uma variante opcional de autenticação dentro da jornada Instagram, com permissões e credenciais próprias. Não houve acesso a app, conta Meta, grant, ativo real ou Sandbox. Nada abaixo certifica elegibilidade, permissão concedida ou comportamento de produção.

## Fontes consultadas

| Ref. | Fonte primária | Uso e limite observado |
|---|---|---|
| W1 | [Meta WhatsApp Business Platform — workspace oficial](https://www.postman.com/meta/whatsapp-business-platform/overview) | Consultado em 2026-10-28; a página indicava atualização em 2026-10-21. Exemplos documentam Cloud API e Embedded Signup. Coleção de requests não comprova grant de app nem elegibilidade de cliente. |
| W2 | [Meta WhatsApp Cloud API — documentação oficial no Postman](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-d0e227d1-e520-4b12-a8f6-32657a52d26e) | Consultado em 2026-10-28. Os exemplos usam variável `{{Version}}`; a versão numérica atual não foi confirmada. |
| W3 | [Meta Embedded Signup — documentação oficial no Postman](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup) | Consultado em 2026-10-28. Demonstra um fluxo de exemplo. Não prova que o app, conta ou fluxo de Coexistence deste produto seja elegível. |
| I1 | [Meta Instagram API — documentação oficial no Postman](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-3fe78620-2258-44b6-893f-42d76c7200d7) | Consultado em 2026-10-28. Os exemplos distinguem Instagram via Facebook Login de Instagram Login. Exemplos de scopes são referência documental, não uma aprovação. |
| D1 | [WhatsApp Cloud API overview](https://developers.facebook.com/docs/whatsapp/cloud-api/overview), [Embedded Signup overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview), [onboarding Business App users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business), [Instagram via Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login), [Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login), [Graph Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/) | Pesquisador e coordenador consultaram/reabriram individualmente cada URL em 2026-10-28; todas retornaram HTTP 429. Portanto, conteúdo atual, versões, grants e regras dessas páginas permanecem **Not confirmed** nesta execução. |
| P1 | [Meta publisher no Postman](https://www.postman.com/meta) | Consultado em 2026-10-28; publisher Meta verificado. |
| D2 | [Meta Developers — Facebook Login for Business](https://www.youtube.com/watch?v=Lmr5SLIs3TY) | Consultado em 2026-10-28. A descrição o classifica como autorização de dados empresariais; não fornece scopes, token family, endpoints, versão ou grants deste app. |
| D3 | [Meta Developers — WhatsApp Business App Coexistence (vídeo histórico)](https://www.youtube.com/watch?v=kmom7HZMeEU) | Publicado em 2024-07-12; descreve contexto de uso do mesmo número no WhatsApp Business app e plataforma parceira via Cloud API. Não confirma regras atuais, elegibilidade, histórico, eventos ou desligamento. |
| B1 | [Código PHP versionado: Facebook](../../backend/connect_facebook.php), [Instagram](../../backend/connect_instagram.php), [WhatsApp](../../backend/connect_whatsapp.php), [helper](../../backend/meta_auth_helper.php) | Evidência de baseline do produto, não fonte da Meta nem prova de implementação implantada. |

## Matriz de capacidades

Escopos abaixo são nomes vistos em exemplos documentais quando há referência direta. A associação exata entre operação e escopo mínimo continua **Not confirmed** até validar no app/revisão e no cenário autorizado. Os códigos `SEND_MESSAGE`, `MANAGE_TEMPLATES`, `READ_STATUS`, `SUBSCRIBE_WEBHOOKS` e `ASSET_DISCOVERY` são capacidades do domínio propostas, não nomes de permissões Meta.

### Operações e permissões: candidatos a validar

Os nomes de capacidade são internos. As referências abaixo sustentam exemplos da collection; elas não estabelecem o conjunto mínimo aprovado, nem garantem a mesma permissão para todo app/versão. O mapeamento permanece hipótese até teste autorizado e conferência do app.

| Capacidade do produto | Jornada | Evidência disponível | Estado do mapeamento |
|---|---|---|---|
| `ASSET_DISCOVERY` | Facebook | Pages discovery / scopes do Login for Business: **Not confirmed** (D1 429; D2). | Proposta; testar descoberta paginada e grants da Page. |
| `ASSET_DISCOVERY` | Instagram via Facebook Login | I1 mostra `pages_show_list` e `GET /{{api_version}}/me/accounts?...instagram_business_account...`; retorna Page access token. | Exemplo da collection, não permissão mínima universal nem grant real. |
| `ASSET_DISCOVERY` | WhatsApp exclusivo / Coexistence | W1/W2/W3 mostram portfolio/WABA/phone e chamadas de fetch Shared WABA no Embedded Signup. | Exemplo Cloud API/Signup; discovery e elegibilidade de Coexistence permanecem separadas e precisam prova atual. |
| `SEND_MESSAGE` | WhatsApp exclusivo | W2 lista `whatsapp_business_messaging`. | Candidato para operação de envio; concedido/mínimo por endpoint neste app: **Not confirmed**. |
| `SEND_MESSAGE` | Instagram Login opcional | I1 Send API cita `instagram_business_manage_messages` e destinatário que iniciou a conversa. | Evidência de sample para essa variante; grant e disponibilidade no app: **Not confirmed**. |
| `SEND_MESSAGE` | Facebook / Instagram via Facebook Login / Coexistence | Escopos mínimos específicos não foram sustentados pelas páginas acessíveis. | **Not confirmed**; não transferir a permissão de outra variante. |
| `MANAGE_TEMPLATES` | WhatsApp exclusivo | W2 lista `whatsapp_business_management`; template operation/endpoint-specific grant não está provado pela lista geral. | Candidato, mapeamento exato para operação **Not confirmed**. |
| `READ_STATUS` | Todos | Nenhuma referência acessível confirmou scopes mínimos/status fields desta configuração. | **Not confirmed** por app/flow/version. |
| `SUBSCRIBE_WEBHOOKS` | WhatsApp exclusivo | W2 exemplifica `POST /{{Version}}/{{WABA-ID}}/subscribed_apps`; W2 também lista `whatsapp_business_management`. | Request/target documentados; associação exata do scope, grants e entrega do evento neste app **Not confirmed**. |
| `SUBSCRIBE_WEBHOOKS` | Facebook / Instagram / Coexistence | A configuração de app e subscription do ativo não puderam ser conferidas nas páginas developers (D1 429). | **Not confirmed**; são gates separados. |

### Matriz por jornada

| Jornada | Variante/bootstrap | Operações e endpoints documentados / propostos | Scopes e família de token | Alvos de ativo / subscription | Versão | Elegibilidade, expiração e refresh |
|---|---|---|---|---|---|---|
| **Facebook** | Facebook Login for Business independente. A baseline chama o fluxo de Facebook em `connect_facebook.php` (B1); a configuração atual do app é **Not confirmed**. | Proposta: descobrir Pages e capabilities. D2 confirma apenas a classificação geral de Facebook Login for Business como autorização de dados empresariais; scopes, token family, endpoints, versão e subscription target para Pages são **Not confirmed** (D1 429, D2). | Scopes e token family aprovados no app: **Not confirmed** (D1 429). Não inferir grants de presença de Page ID no browser. | Page como ativo de produto é proposta da baseline (B1); vínculo, grant e campos/target de subscription atuais: **Not confirmed**. | `graph_api_version`: **Not confirmed**. Configurar por app/ambiente, sem assumir default. | Mode, roles, Advanced Access, App Review, Pages elegíveis, expiry/refresh e offboarding: **Not confirmed**. Exige teste com app/ativo autorizado antes de habilitar. |
| **Instagram — Facebook Login** | Variante Instagram com Facebook Login; o PHP versionado procura vínculo profissional via Page (B1). A coleção I1 mostra exemplos dessa variante e indica conta Business/Creator com Page vinculada. | Proposta: descobrir conta profissional e operações autorizadas por Page; os endpoints exatos e subscriptions devem ser reconfirmados na referência versionada. | O sample I1 lista `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` e `instagram_manage_comments` como necessários para requests daquela coleção, não mínimo universal nem escopos aprovados. O request `GET /{{api_version}}/me/accounts?fields=name,access_token,tasks,instagram_business_account...` usa User Access Token e devolve Page Access Token para agir pela Page vinculada. Grants para este app e expiry/refresh são **Not confirmed**. | Page/conta profissional e relação observada pelo servidor; subscriptions/campos e ownership real são **Not confirmed**. | I1 usa placeholder `{{api_version}}`; versão numérica adotada **Not confirmed**. | A exigência de conta profissional Business/Creator e Page vinculada aparece no exemplo I1. App Review, aprovação, grants, funcionalidades disponíveis e expiry/refresh por app são **Not confirmed**. |
| **Instagram — Instagram Login (opcional)** | Variante separada, Business/Creator, sem reutilizar configuração/credenciais da variante Facebook Login (I1). Não é outro fluxo de produto obrigatório nem está confirmada na baseline implantada. | Operações de mensagem, conteúdo e comentários são **propostas a validar** conforme endpoint e capacidades da variante. I1 indica Send API iniciada pelo usuário; disponibilidade para o app é **Not confirmed**. | I1 lista `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`; o bloco de Send API exige `instagram_business_manage_messages` e conversa iniciada pelo destinatário. O bloco de token da variante cita user/system-user tokens. Nunca intercambiar scopes/tokens entre variantes. Grants e expiry/refresh: **Not confirmed**. | Conta Instagram profissional direta; subscriptions e webhooks: **Not confirmed**. | A versão Graph exata e configuração do app **Not confirmed**. | A coleção indica limitações da variante, inclusive ausência de ads/tagging no sample consultado. Elegibilidade atual, review, grants, consentimento e regras de refresh requerem confirmação antes de adoção. |
| **WhatsApp Cloud API — número exclusivo** | Onboarding Cloud API/Embedded Signup do produto; manter distinto de Coexistence. W1/W2 documentam exemplos de Cloud API que usam portfolio empresarial, WABA e phone number. | W2 exemplifica `POST /{{Version}}/{{Phone-Number-ID}}/register`; W2 também documenta `POST /{{Version}}/{{WABA-ID}}/subscribed_apps`. A collection fala de registro em até 14 dias para usuários Embedded Signup; essa nota não se aplica automaticamente a Coexistence. Revalidar operação, versão e estado antes da implementação. | W2 lista `whatsapp_business_management` e `whatsapp_business_messaging`; `business_management` só para queries que têm portfolio como alvo. A coleção aceita user e system-user access tokens e informa user token com 24h e system-user com até 60 dias ou permanente. São valores publicados na collection em 2026-10-28; reconfirmar antes de rollout, não são contrato permanente nem provam grant deste app. | W1/W2 usam WABA e telefone como recursos; `/{WABA_ID}/subscribed_apps` é o target exemplificado. Identificadores/ownership e sucesso de subscription em app real: **Not confirmed**. | A coleção usa `{{Version}}`; número atual do Graph não confirmado. Versão Embedded Signup/SDK é dimensão independente e **Not confirmed**. | W1/W3 descrevem portfolio/WABA/telefone e papéis Solution Partner, Tech Provider e Tech Partner. W3 diz que o app deve passar por App Review e pedir Advanced Access a `business_management` e `whatsapp_business_management` para publicação; isso não confirma o estado deste app. Elegibilidade, billing, grants e condições atuais: **Not confirmed**. PIN/registro só após verificar estado real e documentação aplicável. |
| **WhatsApp Coexistence** | Business App onboarding / variante própria de Embedded Signup é prevista pelo contrato de produto (ver [fluxos](05-meta-flows-and-webhooks.md)); a documentação developers correspondente retornou 429 (D1). | Qualquer QR/consentimento, register, histórico, sync, echo, desligamento, `featureType` ou endpoint específico atual permanece **Not confirmed**. Não habilitar fallback de registro convencional. O guard local abaixo é uma regra proposta do adaptador, não certificação Meta. | Família de token, scopes, consentimento, refresh e lifetime para Coexistence: **Not confirmed**. Não inferir Business Integration token sem fonte atual acessível. | WABA/telefone e possíveis alvos de subscription exigem confirmação por IDs/requests autorizados. `/{WABA_ID}/subscribed_apps` existe como exemplo Cloud API (W2), mas não comprova todos os bindings/efeitos de Coexistence. | Graph e Embedded Signup/SDK version: **Not confirmed** e devem ser guardados separadamente por configuração. | Elegibilidade, App Review, limites/histórico, billing, QR/consent, echoes, offboarding e regras de registro são **Not confirmed**. Evidência documental atual e Sandbox autorizado são gates antes de certificar/ativar. |

### Configuração por app, ambiente e versão

| Dimensão necessária | Estado observado | Regra do produto enquanto faltar evidência |
|---|---|---|
| App ID e dono do app por jornada | **Not confirmed**; nenhum identificador consultado ou publicado | Resolução servidor deve selecionar perfil explicitamente; nunca aceitar ID/app secreto de request cliente. |
| Development/live, papéis, redirects e Advanced Access | **Not confirmed**; sem acesso a App Dashboard | Manter separado por app e ambiente. Não projetar que dev e live compartilhem grants. |
| Scopes solicitados/aprovados e App Review | **Not confirmed** por app/ambiente | Gate por operação; capacidade não aprovada retorna ação necessária. |
| Graph API version | Documentos acessíveis usam variável, não valor numérico fixado (W2/I1) | Armazenar explicitamente por profile; não inferir versão atual de amostra antiga. |
| Embedded Signup/SDK version | Versão efetivamente configurada não acessível | Campo distinto de Graph API version; validar compatibilidade por experimento antes de mudar. |
| Família de token, expiry, refresh/revocation | Exemplos listam famílias; regra efetiva deste app **Not confirmed** | Armazenar tipo/fonte/observação no servidor; nenhuma credencial real no portal/fixture. |
| Webhook app config e subscription em cada ativo | Configuração e grants não acessíveis | Tratar configuração do app e subscription do ativo como verificações separadas. |

## Experimento offline reproduzível

O harness em [`tools/m1-03/`](../../tools/m1-03/README.md) contém perfis e identificadores **sintéticos**, sem versões reais, tokens, secrets, HTTP, sockets ou chamadas externas. Executado em 2026-10-28: `python tools/m1-03/validate_capabilities.py` — **12/12 casos passaram** em Python 3.13.7; apenas biblioteca padrão. Os cenários verificam seleção por app/ambiente, Graph version, seleção separada de Embedded Signup, operações explicitamente configuradas, variants de login segregadas, ausência de capability e rejeição de registro convencional no adapter Coexistence. Isso valida o guard/config contract local; não testa Graph API, grant, onboarding ou comportamento Meta.

## Evidência pendente antes de certificar cada cenário

| Cenário | Evidência obrigatória antes de ativar em conta/ambiente real |
|---|---|
| Facebook | App/configuration e redirect URI autorizados; grants/Advanced Access aprovados; Page/permissions listadas pelo servidor; versão Graph; token e expiry observados com origem; subscription e webhook entregues no alvo; revogação e reauth. |
| Instagram via Facebook Login | Profissional Business/Creator e Page relation observadas via API; scopes concedidos; ownership/tokens do servidor; permissões e subscriptions por operação; versão Graph; expiração/revogação e App Review. |
| Instagram Login | Configuração/login variant e scopes independentes; conta profissional direta; capabilities permitidas e limites de messaging/content; token family e expiry; webhook/subscription; provar que nenhum token/scopes da variante Facebook é reutilizado. |
| WhatsApp exclusivo | App, portfolio e WABA de teste autorizados; phone number e grant correlacionados pelo servidor; versão Graph/Embedded Signup definida; registrar PIN apenas se estado/documento exigir; subscription observada; message/template de teste consentidos; expiry/revoke/offboard. |
| WhatsApp Coexistence | Eligibility e configuração aprovadas; número Business App e consent/QR; code/assets/grants verificados no servidor; versão/featureType; histórico/echo/state; subscription e offboarding; comprovar que não há fallback de register/deregister convencional. |

Nenhum desses ensaios foi realizado nesta issue. O vídeo histórico D3 de 2024 sobre coexistência do Business App é apenas contexto, não prova de regras atuais. A falta de acesso developers.facebook.com (429) e de conta Sandbox não bloqueia esta pesquisa pública/validação local; bloqueia a certificação externa correspondente.

## Atualização de governança M4.01 — 2026-11-06

Esta atualização não substitui a matriz de hipóteses acima nem transforma exemplos em grants. A
[Meta anunciou Graph API v27.0 em 2026-11-04](https://developers.facebook.com/blog/post/2026/11/04/introducing-graph-api-v27-and-marketing-api-v27/),
mas a página de changelog disponível nesta consulta ainda apresentava v26.0 como mais recente
([Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/)). Essa discrepância
deixa **Not confirmed** a compatibilidade por endpoint e a versão Graph que deve ser ativada neste
produto. Nenhum valor de exemplo ou versão de SDK/Embedded Signup é usado como default.

As coleções oficiais Meta no Postman distinguem Cloud API e Embedded Signup, e distinguem Instagram
via Facebook Login de Instagram Login. Os nomes de permissões nelas continuam candidatos documentais;
grant, nível de acesso, App Review e Sandbox pertencem ao app/ambiente e não foram exercitados. A
documentação pública primária de Coexistence continua indisponível nesta consulta, então elegibilidade,
formato de evento, histórico e desligamento permanecem **Not confirmed**. O harness M1.03 e seus perfis
offline são preservados; seus IDs e rótulos `fixture` não são valores Meta.

M4.01 acrescenta um manifest de runtime versionado em
[`apps/api/src/meta-config/capability-manifest.ts`](../../apps/api/src/meta-config/capability-manifest.ts).
Ele mantém mapeamentos desconhecidos como `NOT_CONFIRMED`, exige status de permission/review/Sandbox
por permissão requerida dentro de cada operação; uma linha aprovada não substitui outra pendente. O
dono de aprovação fica `UNASSIGNED` até existir evidência real. O processo de
configuração, migração de versão e rollback está em
[`docs/delivery/M4/m4-01-runbook.md`](../delivery/M4/m4-01-runbook.md).
