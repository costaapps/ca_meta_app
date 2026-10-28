# M1.01 — inventário verificável da baseline

Status: descoberta da baseline versionada concluída; evidência operacional de migração/corte pendente. Issue: M1.01 (#10). Data: 2026-10-28. Responsável funcional: arquitetura/liderança técnica; pessoa designada: **Not confirmed**. Contrato descritivo: `baseline-source-v1`, fixado no SHA abaixo; não é um novo contrato de API aprovado.

## Escopo, invariantes e recuperação

Baseline funcional autorizada e examinada: commit `7b3b38b0581928a18d14dd5fdb75ee020498241a`; árvore rastreada `a1d7b5168bfa99badab1e1f7ee71f9e6dfbd718c`. SHA-256 de `package-lock.json`: `aaa2c07882c01ed5f500be876efa55e7defb7a03fcf0449d9d4c4fe2a4c857d5`. No snapshot inicial da tentativa do pacote, `git status --short` já continha `?? docs/baseline/` e `?? experiments/`; essa observação é histórica e não afirma que o worktree desta correção estivesse limpo. A árvore rastreada examinada corresponde à base e nenhum arquivo de aplicação rastreado foi alterado pelo inventário. A referência histórica `7062247…` dos documentos não substitui esta base. Ver [relatório de execução](execution-report.md) para proveniência de pacote, ambiente e validações.

Escopo: inventário de fonte, contratos observados, destinos funcionais propostos e experimentos locais. Layout, componentes, SCSS, PHP, dependências e controles de automação permanecem sem alterações. Nenhuma remoção de comportamento foi autorizada. Rollback desta entrega: retirar os artefatos documentais/experimento; não há migração de dados ou implantação. O inventário versionado conclui esta descoberta; qualquer migração, troca de rota ou corte do legado depende das lacunas operacionais abaixo.

Classificação: **Comprovado** = observável neste SHA ou execução local identificada; **Hipótese** = interpretação explicitamente limitada; **Not confirmed** = evidência ausente. Comprovado no fonte não significa comprovado em produção. Testes de paridade propostos na matriz são obrigações futuras, não resultados executados.

Artefatos: [endpoints](endpoint-matrix.csv), [paridade e cobertura das funções](parity-matrix.md), [execução](execution-report.md), [traçado offline](../../experiments/baseline/trace_routes.py). A matriz cobre as oito rotas de negócio do roteador WhatsApp, as duas respostas de fallback/método, as três entradas PHP diretas do frontend, callbacks, OPTIONS e dependências Meta de saída. As quatro fontes PHP versionadas são `backend/connect_whatsapp.php`, `backend/connect_facebook.php`, `backend/connect_instagram.php` e `backend/meta_auth_helper.php`; os dois scripts de produto não declaram funções nomeadas e seus branches top-level estão mapeados. A matriz não certifica endpoints desconhecidos do PHP operacional.

## Fronteiras observadas

- `src/main.ts:1`, `src/app/app.config.ts:1` e `src/app/app.routes.ts:6`: bootstrap standalone, HttpClient e router. `/` e wildcard levam ao setup; não há guard de identidade nas três telas.
- `src/app/core/services/meta-auth.service.ts:67-69,83-91,93-106`: URL de autorização abre arquivo PHP por produto com `company_uuid` obtido de localStorage. Produto pendente fica em sessionStorage. Configuração de callback no catálogo não obriga o PHP a usá-la.
- `src/app/core/services/meta-integration.service.ts:14`: captura UUID no construtor; setter atualiza memória e storage. Setup grava somente storage (`channel-setup.component.ts:76`), portanto uma instância já criada do serviço pode manter contexto anterior (Hipótese de sequência, não reproduzida em navegador).
- `src/app/features/channels/components/notification-bell/notification-bell.component.ts:96-120,146-172,368-370`: lê storage a cada refresh/ação e usa HttpClient diretamente. Não há polling automático no componente; atualização é manual e limitada a 3 segundos.
- `src/environments/environment.ts:1` e `environment.prod.ts:1`: base de API; seu valor configurado não prova onde cada URL é roteada na implantação.

## Divergências comprovadas no fonte

| ID | Evidência | Consequência / destino |
|---|---|---|
| B01 | `channel-setup.component.ts:73-76`; `meta-auth.service.ts:67-69,83-91`; `meta-integration.service.ts:13,20-27` | UUID controlado pelo cliente é enviado como tenant. Membership/autenticação no bootstrap ausente: Not confirmed. M3.01–M3.05 |
| B02 | `backend/meta_auth_helper.php:58` e `:77`; `connect_whatsapp.php:94` e `:156` | State é JSON/Base64; não há vínculo com sessão/nonce de consumo demonstrado nessas funções. M4.03 |
| B03 | `meta-auth.service.ts:16-17`; `connect_whatsapp.php:45-67` | GET direto do arquivo não casa com os predicados versionados do roteador; fixture offline retorna fallback 404. O operador relata rewrite para `connect.php`, mas regra e comportamento implantado: Not confirmed. Resolver em M4.03 antes de trocar/desativar a rota; esta lacuna não bloqueia o inventário versionado. |
| B04 | `connect_whatsapp.php:763`, `:808`, `:894` | Templates e envio usam token root global; callback tenta usá-lo em `:236` sem declará-lo global em `:144`. Permissões efetivas: Not confirmed. M3.08/M5.07 |
| B05 | `connect_facebook.php:125` até final; `connect_instagram.php:123` até final; `connect_whatsapp.php:462` | Callback pode declarar auth_success após zero ativos; subscription não é critério de sucesso. M4.03/M4.08/M4.09 |
| B06 | `connect_whatsapp.php:714`, `:748`, `:751` | SEND_MESSAGE está comentado; notificação pode ser marcada lida com resultado nulo ou erro da Meta e success=true. M5.06 |
| B07 | `connect_whatsapp.php:623`, `:667`, `:732`; comparar `:481`, `:885` | Notificações filtram IdDatabase; canais e resolução de WABA usam IdCompany também. Isolamento efetivo depende de DDL/dados ausentes. M1.02/M3.01 |
| B08 | `connect_facebook.php:14`, `connect_instagram.php:13` | empty(code) antecede tratamento de erro OAuth; retorno de recusa sem company_uuid pode resultar 400 em vez do redirect de erro. M4.03 |
| B09 | finais dos três callbacks PHP versus `channel-setup.component.ts:82` e `app.routes.ts:8` | PHP redireciona /channels; setup interpreta parâmetros e exibe sucesso/erro. Lista não trata esses parâmetros. M5.01/M4.03 |
| B10 | `connect_whatsapp.php:563` versus `:481` | Save usa Databases.CompanyUUID, leitura usa Company.CompanyUUID; equivalência e número de linhas alteradas não comprovados. WhatsApp salva mensagem na WABA pai, não no número. M1.02/M5.05 |
| B11 | `meta_auth_helper.php:106`; `connect_whatsapp.php:925` | Máscara contempla access_token/fb_exchange_token, não todos os campos sensíveis. Não executar callbacks para gerar logs. M3.10 |
| B12 | `connect_instagram.php:128` | Instagram é descoberto via Facebook/instagram_business_account; não prova Instagram Login independente nem Coexistence. M1.03/M4.09 |

## Implantação e consumidores: fatos, relatos e gates

### Proveniência e limites

- O issue packet relata, como informação do operador, implantação compartilhada Hostinger em `public_html/meta/auth`, presença operacional de `connect.php` e `connect_old.php`, rewrite de caminhos inexistentes para `connect.php` e um fluxo PHP unificado implantado. Esse relato é registrado como contexto informado, não como arquivo, hash, configuração ou comportamento reproduzido.
- O pacote supervisor informa separadamente que `connect.php` não está nesta worktree e que `connect_old.php` é referência local que não deve ser copiada/versionada. A árvore commitada contém quatro PHP versionados listados acima; não contém `connect.php`, `connect_old.php` ou `.htaccess`. Nenhum conteúdo operacional foi fornecido ou comparado. A diferença de proveniência/ambiente permanece **Not confirmed**.
- No código versionado, `connect_facebook.php` e `connect_instagram.php` são entradas separadas, enquanto `connect_whatsapp.php` também contém `getLoginUrl` e `facebookCallback`, com descoberta de ativos de mais de um produto. Isso é comportamento encontrado neste SHA, não prova de que corresponda ao `connect.php` relatado.
- A arquitetura nova deve manter entradas e estados de autorização separados para Facebook, Instagram e WhatsApp. O callback legado combinado, token global e `state` sem vínculo demonstrado não são requisitos de compatibilidade. Preserve as capacidades de negócio que a matriz identifica, corrija defeitos conhecidos e decida o método/protocolo de cada produto com a evidência própria de M1.03; não se afirma suporte Meta atual.

### Consumidores e lacunas operacionais

Em todas as linhas abaixo, dono pessoal e versão implantada são **Not confirmed**. A evidência indicada é gate antes do cenário dependente de migração/corte, não pré-requisito para concluir este inventário versionado.

| Consumidor/contrato | Evidência versionada | Status e lacuna | Cenário afetado e gate antes de migração/corte |
|---|---|---|---|
| Portal Angular → endpoints PHP | `endpoint-matrix.csv`; serviços e notification bell mapeados em `parity-matrix.md` | Comportamento do checkout comprovado; build/hash implantados e rotas resolvidas em produção **Not confirmed** | Troca de base URL, callback ou remoção de rota PHP: comparar build/hash e roteamento; M4.03 |
| Suite4 → identidade/iframe | UI aceita `cUUID`; emissor e membership não aparecem comprovados neste código | Consumidor, contrato, dono, versão, claims e origem **Not confirmed** | Login incorporado/troca de tenant: contrato e origem de staging aceitos antes do corte; M1.06 |
| Msg4 e outros chamadores de envio | `sendWhatsAppMessage` é chamado pelo caminho E06; demais chamadores não observados | Catálogo externo, autenticação, dono e versão **Not confirmed** | Remover endpoint/token global ou alterar relay: inventariar chamadores, jobs e método de autenticação; M1.07/M5.07 |
| Webhooks de produção (Facebook/Instagram/WhatsApp) | Scripts solicitam `subscribed_apps`; receptor/versionamento operacional não fornecido | URLs, eventos, owners e contratos externos **Not confirmed** | Reinscrição, callback change ou revogação: inventariar callbacks por app/ativo e dependentes; M1.03/M4.10–M4.13 |
| Cron, workers, retries e automações | Nenhum catálogo operacional foi fornecido | Entradas, saídas, agendas, garantias e dono **Not confirmed** | Desativar PHP ou mudar entrega assíncrona: inventariar schedules/consumidores e estratégia de replay; M1.07/M5.08 |
| GeneralSettings | Não demonstrado nos quatro PHP versionados | DDL, semântica, consumidores e dono **Not confirmed** | Migrar configuração ou alterar fonte de verdade: schema e consumers aprovados; M1.02/M1.07 |
| Projeções e bancos empresariais | SQL cita `Company`, `Databases`, `MetaConnectedPages`, `MetaConnectedNumbers` e `MetaAppReviewNotifications`; não prova replicação | DDL, índices, writers, replicação, recovery e dono **Not confirmed** | Backfill, cutover de leitura/escrita ou recovery: DDL e reconciliação de dados aprovados; M1.02/M5.08 |
| Consumidores de templates fora do portal | Portal lista/cria templates via WABA; outros chamadores não observados | Rotinas, contrato, versão e dono **Not confirmed** | Remover/alterar API de template: inventário de jobs e consumidores; M1.07/M5.04 |
| Hostinger / PHP operacional | Só o relato do issue packet descreve `public_html/meta/auth` e rewrite; fonte e regras ausentes | Arquivos implantados, hashes, includes, versão PHP/extensões, rewrite e resposta real **Not confirmed** | Redirecionar conexão, callbacks ou desligar PHP: obter inventário sanitizado, regra efetiva e comparação de comportamento; M4.03 |
| `connect.php` / `connect_old.php` | Não estão na árvore commitada; conteúdo não foi acessado | Presença relatada em produção no issue packet; estado do checkout e presença externa têm proveniências distintas. Comparação **Not confirmed** | Qualquer alegação de paridade, substituição ou remoção: obter cópia/identidade sanitizada autorizada e comparar antes do corte; M4.03 |
| DDL e identidade de tenant | Consultas versionadas citam tabelas/colunas, sem schema completo ou membership comprovado | Owners, versão, constraints, índices e vínculo por consumidor **Not confirmed** | Autorização por tenant, migração de dados ou isolamento: DDL e contrato de identidade aprovados; M1.02/M1.06 |
| Requisitos atuais do provedor Meta | Código contém chamadas e scopes observáveis; consulta às páginas oficiais não concluiu | Versões, permissões, elegibilidade e setup atual **Not confirmed** | Escolher/ativar fluxo ou permission set: validar fontes oficiais e evidência do app no pacote de decisão; M1.03 antes de M4.* |

Não liberar corte, remoção, troca de callback ou revogação de token root antes de reconciliar consumidores e dados reais. Nenhum dono pessoal, versão implantada, schema ou comportamento externo foi inferido de nomes de tabelas ou do relato operacional.

## Cenários e aceite

Dado o SHA fixado, cada rota/função e tela observada tem arquivo/linha, payload ou estado, auth observada, efeito, dados, erros, destino funcional proposto e cenário de paridade nas matrizes. Dada a URL direta WhatsApp, aplicar apenas os predicados do roteador versionado reproduz o fallback; isso não executa PHP, HTTP, rewrite, SQL ou Meta. O relato Hostinger está distinguido da execução e do fluxo PHP observado. Dadas lacunas operacionais, cada linha identifica cenário dependente e gate. Os destinos descrevem preservação/correção/remoção funcional; não aprovam novas URLs, schemas ou contratos de API.

Aceite 1: cobertura e destino funcional explícito para os quatro PHP versionados e as três telas Angular; consumidores externos ausentes permanecem marcados. Aceite 2: frontend e PHP traçados por arquivo/linha; rewrite e fluxo unificado implantado registrados como relato, separados do roteamento reproduzido e do código versionado. Aceite 3: build/testes e proveniência da instalação documentados em `execution-report.md`. Aceite 4: referências de fonte, nomes de campos/tabelas e fixtures sintéticas; sem segredos ou identificadores operacionais. Aceite 5: cada lacuna operacional tem status **Not confirmed**, cenário e gate; essa ausência não bloqueia a descoberta versionada nem autoriza migração/corte. Resultado do inventário: concluído para o checkout fixado; paridade operacional não certificada.

## Fontes primárias atuais

Consulta em 2026-10-28 às fontes primárias oficiais [Meta manual login flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/), [WhatsApp Cloud API messages](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/) e [WhatsApp Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup/) retornou HTTP 429; a busca oficial não retornou resultados e a abertura direta também falhou com 429. Conteúdo atual, permissões e validade de configuração: **Not confirmed**. Essas páginas são pendência da decisão de fluxo/permissões em M1.03, não fundamento de afirmações neste inventário. As constatações acima se limitam ao fonte versionado. Documentos históricos `.github/docs/agent-context/` e `docs/meta-v2/01-baseline-evidence.md` são contexto, não execução nem prova operacional desta revisão.
