# Baseline, evidências e limites da análise

Referência fixa: [develop@7062247a15d15b1b1a5213353517bdc1596a1d38](https://github.com/costaapps/ca_meta_app/commit/7062247a15d15b1b1a5213353517bdc1596a1d38). Árvore `cf8108b55581f1844ea88f93a8dd05736e924adb`, consultada por API do GitHub. Nenhum achado estático abaixo prova sozinho a configuração real da Hostinger ou a ocorrência de exploração.

## O que o repositório comprova

| Área | Evidência versionada | Implicação para a reconstrução |
|---|---|---|
| Frontend | `package.json`, `angular.json`, `src/app` | Angular 21, TypeScript estrito, RxJS e SCSS existentes; manter como base útil |
| Conexões | `meta-auth.service.ts`, `meta-auth.model.ts`, `channel-setup.component.ts` | Três jornadas de produto; falta representar as duas modalidades WhatsApp separadamente |
| Tenant | setup grava `cUUID`; serviços usam localStorage e enviam `company_uuid` | Falta prova de identidade/membership; contexto empresarial não deve autenticar |
| Backend | `backend/connect_whatsapp.php`, `connect_facebook.php`, `connect_instagram.php`, `meta_auth_helper.php` | Parte do PHP já está versionada; a afirmação de que todo backend está fora do Git é desatualizada |
| Referências locais | AGENTS e `.gitignore` tratam `connect.php`/`connect_old.php` como sensíveis locais | Não copiar/commitar esses arquivos sem escopo explícito e sanitização |
| Produto atual | canais, templates e notification-bell | Migração precisa de paridade dessas funções, não só login |
| Entrega | árvore fixa sem Dockerfiles/Compose e sem workflows de app | Infraestrutura de produto ainda deve ser implementada; os workflows deste PR são apenas do planejamento |

Os arquivos `meta-auth.service.ts` e `meta-auth.model.ts` existem nessa revisão. O diagnóstico anterior de import ausente não se aplica a essa baseline. Há resultados históricos de build/testes em documentação; somente runs novos identificados por ambiente/SHA serão tratados como execução atual.

## Achados estáticos específicos

| ID | Arquivo e trecho funcional | Constatação e tratamento |
|---|---|---|
| B01 | `meta-auth.service.ts::buildConnectionUrl`; `channel-setup::syncTenant` | UUID vem de URL/storage e é passado como contexto. M3.01–M3.05 estabelecem sessão/membership |
| B02 | `meta_auth_helper.php::meta_build_login_url/meta_decode_state` | state é JSON/Base64, sem vínculo de sessão e consumo de nonce demonstrado. M4.03 substitui por state opaco servidor |
| B03 | `connect_whatsapp.php` roteamento versus URL de `meta-auth.service.ts` | Front abre arquivo direto, mas roteador procura `/login-url`/`facebook/callback`. M1.01 confirma rewrite/produção antes de concluir defeito operacional |
| B04 | `connect_whatsapp.php::sendWhatsAppMessage`, templates e subscription | Operações usam token root global em vez do grant do cliente. M3.08/M5.07 fazem resolução por contexto |
| B05 | `connect_whatsapp.php::facebookCallback` | `$SYSTEM_ROOT_USER_TOKEN` é lido na função sem constar na lista `global` mostrada. É achado do arquivo versionado; produção precisa de comparação |
| B06 | callbacks Facebook/Instagram | Branch inicial `empty(code)` ocorre antes do tratamento de erro de retorno; zero ativos pode terminar com `auth_success`. M4.03/M4.08/M4.09 corrigem estados |
| B07 | callbacks e helper | Chamadas externas ocorrem em transação longa e subscription nem sempre tem resultado comprovado. Saga/checkpoints e reconciler separam efeitos externos |
| B08 | `connect_instagram.php` | Descoberta via Facebook e `instagram_business_account`, sem subscription Instagram equivalente demonstrada nesse arquivo. Não chamar isso de Instagram Login direto |
| B09 | expiração nos callbacks | Fallback de 60 dias e literal `Never` em caminhos atuais. Novo modelo guarda evidência/tipo, com expiração desconhecida distinta de validade garantida |
| B10 | `connect_whatsapp.php::actionNotification` | SEND_MESSAGE comentado/incompleto; ação pode marcar notificação lida e retornar sucesso com resultado nulo/erro. M5.06 separa read/action/outcome |
| B11 | notifications e consultas legadas | Algumas operações usam apenas IdDatabase. M1.02 verifica duas empresas na mesma base e define tenant completo |
| B12 | `meta_auth_helper.php::meta_call_meta_api` | Redação cobre alguns nomes de token, mas não todos os segredos possíveis, como code/client_secret/input_token. M3.10/M4.02 usam allowlist e testes |
| B13 | headers PHP | Fallback de CORS pode combinar wildcard/credentials ou devolver origem sem autorização coerente. M3.04 endurece por origem exata e sessão |
| B14 | docs `known-issues`, `roadmap`, `git-workflow` | Há afirmações históricas de backend untracked/testes falhando/nomes antigos. Atualização é tarefa SDD, sem tratar documentos como estado vivo |
| B15 | Instalação da baseline no run 40687060925 | npm reportou 47 vulnerabilidades: 4 critical, 31 high, 11 moderate, 1 low. M2.08/M6.02 exigem triagem por pacote, uso dev/runtime, alcance e correção revisada; relatório não foi tratado como incidente confirmado |

Não foram publicados valores operacionais de configuração encontrados nos fontes. Links de evidência devem apontar ao arquivo/SHA, sem copiar tokens, app secrets ou dados de cliente para a issue.

## Matriz de paridade mínima

| Comportamento atual | Destino | Correção necessária |
|---|---|---|
| Setup por produto | Catálogo de quatro fluxos + sessões de onboarding | WhatsApp exclusivo/Coexistence distintos; sucesso derivado do servidor |
| Lista de canais | Lista de conexões/ativos + detalhe | Tenant autenticado, status por dimensão, freshness e capabilities |
| Templates listar/criar | Portal e API de templates | Conta/grant correto, paginação e validação de parâmetros |
| Mensagens configuradas | Automation config por ativo/canal | Escopo por número/conta confirmado, controle de versão e projeção |
| Notification bell | Área de notificações e operações | Ação real/erro/unknown separados de leitura; idempotência |
| Envio por token geral | Relay interno por operação/ativo | Remover fallback root; auditar consumidores fora do repo |
| Tabelas empresariais | Projeções outbox | IDs/relações preservados e backlog recuperável, sem segredo duplicado por padrão |

## Evidências externas necessárias

1. Inventário do PHP que efetivamente atende `msg4.app/meta/auth`, bootstrap, includes, cron e regras de rewrite.
2. DDL/índices e amostra sanitizada das tabelas central/empresa; lógica real de replicação e consumidores de GeneralSettings.
3. Contrato Suite4 de identidade, memberships, emissor, cookies/iframe e revogação.
4. Configurações/versões/permissões Meta, elegibilidade das empresas/números e recursos de teste dos quatro fluxos.
5. Infraestrutura de destino, políticas de chaves/backup e namespace/autenticação Docker Hub.

Cada lacuna possui pacote e gate. É permitido preparar código independente, mas não declarar integração externa pronta sem prova.

## Registro de validação

O [run 40687060925](https://github.com/costaapps/ca_meta_app/actions/runs/40687060925) confirmou build da baseline, duas suítes e cinco testes Angular passando, além de lint sintático dos quatro arquivos PHP. A validação do plano e os 15 testes dos scripts também passaram. O npm reportou as vulnerabilidades registradas em B15, ainda pendentes de triagem/correção na implantação. Lint sintático não comprova integração PHP/Hostinger. Nenhum teste desse workflow envia mensagem, consome credencial Meta ou altera ativo de produção.
