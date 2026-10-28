task("M5.01", "Construir shell do portal, entrada segura e catálogo dos quatro fluxos", "web", "P1", 5, "M3.02 M3.03 M3.04 M3.12 M2.04 M1.08",
"Transformar a tela de login Meta em portal de conexões recorrente, preservando a linguagem visual e funções validadas.",
[
"Criar shell com empresa ativa, sessão/perfil, navegação de conexões/templates/notificações e identificação de ambiente; consumir /session sem ler cUUID como autoridade.",
"Implementar entrada a partir Suite4 e link direto, expiração/logout e estados de ausência de membership; guards protegem navegação, mas API continua responsável pela autorização.",
"Renderizar quatro cards de catálogo a partir da configuração/capabilities: WhatsApp API, WhatsApp + aplicativo, Instagram e Facebook, com pré-requisitos claros.",
"Manter componentes/SCSS existentes quando úteis, extraindo padrões comuns sem redesenho gratuito; substituir alert/console-only por mensagens seguras com requestId.",
"Definir lazy routes, loading/empty/error acessíveis e interceptor de sessão/CSRF; não armazenar tickets ou tokens Meta em localStorage.",
"Preservar navegação direta e retorno depois de popup/callback/refresh, sem transportar empresa por query não autenticada."
],
"Rotas públicas de acesso são separadas das áreas autenticadas /connections, /connections/new/:flow, /assets/:id, /templates e /notifications; aliases legados de /setup e /channels recebem transição documentada.",
[
"Usuário retorna ao portal e vê somente empresas e recursos autorizados.",
"Os quatro fluxos ficam identificáveis e usam configuração de servidor.",
"URL antiga com cUUID não concede acesso, mas apresenta caminho seguro de entrada.",
"Layout, responsividade e funções atuais são preservados onde não há mudança de requisito.",
"Bundle/storage/erros não contêm tokens permanentes, app secrets ou tickets reutilizáveis."
],
["E2E Suite4/magic link, refresh/deep link, expiração e ausência de membership.", "Testes de acessibilidade e navegação por teclado dos cards/menu.", "Regressão visual das telas atuais com fixtures sintéticas."],
"Guard frontend não é barreira de segurança. Todas as chamadas continuam sujeitas às políticas de tenant e recurso do backend.",
["src/app/app.routes.ts", "src/app/features/channels/pages/channel-setup/channel-setup.component.ts", "src/styles.scss"])

task("M5.02", "Exibir conexões, recursos e status verificáveis por dimensão", "web", "P1", 5, "M5.01 M3.12 M4.12 M1.08",
"Permitir que o usuário entenda qual número/conta/página está conectado, o que falta e quando a informação foi confirmada.",
[
"Criar listagem com filtro por produto/modalidade/estado e paginação, distinguindo conta e número de WhatsApp, Page e Instagram; mostrar identificação segura e empresa ativa.",
"No detalhe exibir status do ativo Meta, autorização, webhook e sincronização empresarial com última verificação; sintetizar próxima ação sem reduzir tudo a conectado/desconectado.",
"Exibir conexão parcial, credencial expirada/revogada, status desconhecido e informação desatualizada com texto e ação conforme status-copy matrix.",
"Implementar refresh manual limitado e acompanhamento de job; evitar polling permanente por componente e consolidar consultas por tela.",
"Disponibilizar reauth/disconnect por capability e papel, com explicação de escopo/recursos afetados. Operações destrutivas externas têm tratamento separado da remoção local.",
"Manter identificação consistente de quatro números semelhantes, sem depender só de nome de WABA; não exibir segredo como forma de diagnóstico."
],
"Dados vêm de /connections e /assets/:id; UI renderiza lastVerifiedAt/evidenceSource/staleAfter e status de cada etapa. Meta desconhecida nunca é apresentada como decisão da aplicação.",
[
"Quatro números de uma empresa são distintos e suas ações usam IDs corretos.",
"Status stale/UNKNOWN é compreensível e não vira falso alerta de perda de número.",
"Viewer não recebe controles de administração e API também recusa a ação.",
"Refresh e retry são acompanhados sem duplicação de jobs.",
"Detalhes técnicos e requestId ficam acessíveis para suporte sem poluir a jornada principal."
],
["Fixtures de READY/PARTIAL/ACTION_REQUIRED/stale/revoked por canal.", "Testar paginação, filtros e troca de empresa sem vazamento de estado em memória.", "Regressão de acessibilidade sem depender apenas de cor para status."],
"Muitos status Meta não são comparáveis entre canais; apresentar campos por capacidade e fonte, não uma tabela universal de atributos fictícios.",
["src/app/features/channels/pages/channel-list/channel-list.component.ts", "src/app/core/models/channel.model.ts"])

task("M5.03", "Criar onboarding assistido, retomada e adição sequencial de números", "web", "P1", 8, "M5.01 M5.02 M4.14 M3.05",
"Concluir os quatro fluxos pelo portal e tornar explícito que cada número Coexistence requer sua própria autorização.",
[
"Implementar jornada de preparação, abertura Meta, retorno, verificação servidor e resumo; mostrar somente etapas reais relevantes à modalidade.",
"Integrar adaptadores de OAuth/Embedded Signup com estado isolado por onboardingId. Remover dependência de pendingProduct único e auth_success como conclusão.",
"Acompanhar estado assíncrono com polling bounded/backoff ou canal de progresso autenticado; retomada após refresh consulta o backend sem reexpor código/token.",
"Em PARTIAL apresentar etapa pendente e retry permitido; callback expirado exige reiniciar autorização e preserva recursos já conectados.",
"Após conclusão oferecer adicionar outro número ou canal; reutilizar contexto empresarial seguro, mas criar nova sessão de onboarding individual por número Coexistence.",
"Tratar cancelamento, popup bloqueado/fechado, conexão lenta, volta ao Suite4 e múltiplas abas com focus/accessibility e mensagens curtas de ação."
],
"UI consome onboarding sessions e jobs; eventos de browser são sinais locais. Botão de repetir usa idempotência e política de etapa do servidor, nunca reenvia código expirado indiscriminadamente.",
[
"Usuário conecta quatro números Coexistence, um de cada vez, sem sobrescrever ativos ou credenciais.",
"Retomada após reload mostra estado persistido correto e não inicia novo login automaticamente.",
"Falha parcial pode ser recuperada sem banco/manual token copy.",
"Cancelamento não remove conexões anteriores nem deixa spinner indefinido.",
"Cada um dos quatro fluxos tem happy path e recuperação testados no portal."
],
["E2E por modalidade e sequência de quatro Coexistence no mesmo tenant.", "Testar callbacks em ordem diferente, duas abas e troca de empresa no parent.", "Testar offline/reload no meio de provisioning e retry de subscription."],
"Consentimento, QR, verificação empresarial e decisões de elegibilidade continuam etapas externas da Meta. Automação não deve apresentar conclusão enquanto essas ações faltarem.",
["src/app/features/channels/pages/channel-setup/channel-setup.component.ts", "src/app/core/services/meta-auth.service.ts"], True)

task("M5.04", "Migrar templates WhatsApp com credencial correta e validação de parâmetros", "web", "P1", 8, "M5.02 M3.08 M4.04 M4.06 M2.04",
"Preservar listagem/criação de templates e corrigir a dependência de token global e confusão entre número e conta proprietária do template.",
[
"Mapear número selecionado à conta/template namespace suportado pelo modelo Meta confirmado, validando tenant/grant; resolver MANAGE_TEMPLATES pelo ativo correto.",
"Migrar APIs de listagem/criação com paginação, categorias/idiomas e status observados; UI mantém funcionalidades existentes e separa erro local de rejeição do provedor.",
"Validar nomes, tamanho e placeholders em frontend e backend segundo regras atuais; numeração, lacunas, repetição e exemplos devem corresponder ao contrato efetivo.",
"Usar idempotência e pesquisa/reconciliação após resultado ambíguo de criação para evitar duplicar template; não assumir unicidade só por nome sem idioma/conta.",
"Atualizar aprovação/rejeição por evento ou consulta suportada e exibir última verificação; exportar apenas metadados seguros para notificações de teste/uso.",
"Definir escopo do primeiro release como paridade BODY existente mais correções; novos componentes header/buttons/media têm requisitos explícitos se aprovados, sem remoção de funcionalidade atual."
],
"GET/POST /api/v1/whatsapp/accounts/:assetId/templates ou contrato equivalente. Requests podem partir de phone asset autorizado, mas servidor resolve conta e credencial; frontend não passa WABA/token arbitrário.",
[
"Listar/criar template de cada número usa conta e autorização corretas sem token root.",
"Tenant não pode consultar templates mudando ID de número/conta no request.",
"Placeholders inválidos e exemplos faltantes falham antes do efeito externo.",
"HTTP 200 com erro/rejeição não exibe template criado com sucesso.",
"Numeração/idioma/status são preservados em migração e paridade de UI."
],
["Testar placeholders {{1}}, repetidos, lacunas, ordem, idioma e corpo vazio.", "Testar duas WABAs, números na mesma conta e credenciais diferentes.", "E2E sandbox de template e status, com retry/timeout de criação."],
"Regras de template e propriedade de conta dependem da versão Meta; não reutilizar lógica de número como proprietário sem comprovação.",
["src/app/features/channels/pages/channel-templates/channel-templates.component.ts", "src/app/core/services/meta-integration.service.ts", "backend/connect_whatsapp.php"], True)

task("M5.05", "Preservar configurações de mensagens e respostas por canal", "integration", "P1", 5, "M5.02 M3.06 M3.08 M2.04 M1.01",
"Migrar PrivateWelcomeMessage, CommentPublicReply e CommentPrivateReply com escopo correto e políticas de execução sem loops.",
[
"Mapear comportamento e campos atuais por plataforma; WhatsApp usa configuração privada por número quando definido, Facebook/Instagram têm respostas públicas/privadas com regras distintas.",
"Implementar API de configuração com autorização de ativo, schema por canal, version/ETag e validação de conteúdo/tamanho; frontend envia ID interno e campos permitidos, não Type/ExternalId para escolher tenant.",
"Definir herança/default de conta versus número explicitamente e evitar update de WABA que altere todos os números sem intenção do usuário.",
"Aplicar regras Meta de janela/permissão e anti-loop/anti-spam no executor: echo, evento próprio e reply já processada não geram resposta repetida.",
"Persistir alteração e outbox para projeção empresarial com versionamento; preservar configuração durante reconexão/reautorização e resolver conflito de escritores na migração.",
"Expor erro de campo e estado de sincronização, incluindo configuração salva centralmente com banco empresarial pendente; não fingir commit distribuído."
],
"PATCH /assets/:id/automation-config {version,privateWelcomeMessage,commentPublicReply,commentPrivateReply} retorna nova versão e projection status. Capability por canal limita campos e operações executáveis.",
[
"Salvar mensagem de um número não modifica outro número da mesma WABA por acidente.",
"Campos não suportados pelo canal são rejeitados ou explicitamente desabilitados.",
"Conflito de versão impede sobrescrita silenciosa por aba/consumidor antigo.",
"Reauth preserva configurações e histórico de mudança.",
"Respostas respeitam grants e não reagem em loop a echoes ou eventos duplicados."
],
["Testar configuração dos três canais e quatro números na mesma conta.", "Testar update concorrente, origem legada e projeção indisponível.", "Testar echo/duplicata/janela de mensagem fora da política em executor de teste."],
"Paridade funcional não significa preservar brecha de escopo. É necessário confirmar se o valor atual é por WABA ou número e migrar sem alteração implícita de semântica.",
["src/app/features/channels/pages/channel-list/channel-list.component.ts", "backend/connect_whatsapp.php"])

task("M5.06", "Migrar notificações e ações com resultado comprovado e idempotência", "integration", "P1", 8, "M5.04 M5.05 M3.08 M2.05 M1.01",
"Preservar a área de notificações e corrigir ações que hoje podem ser marcadas como lidas mesmo quando não houve envio ou ocorreu erro Meta.",
[
"Confirmar escopo de MetaAppReviewNotifications e separar demonstração/App Review de uso operacional quando aplicável, preservando o que estiver em uso real.",
"Implementar listagem autorizada por empresa completa, não apenas IdDatabase; paginação e leitura não devem revelar notificações de outra empresa na mesma base.",
"Modelar ação solicitada/running/succeeded/failed/unknown com operationId e idempotency key; desabilitar duplo clique não substitui proteção do backend.",
"Migrar SEND_TEMPLATE e REPLY_COMMENT com credencial resolvida por ativo; implementar SEND_MESSAGE atualmente incompleto somente com configuração válida e política suportada, ou apresentar indisponibilidade explícita até ficar pronta.",
"Marcar ação concluída/lida conforme semântica definida após confirmação de sucesso; erro, resultado null e timeout ambíguo não geram success=true nem retry automático de envio incerto.",
"Criar trilha de tentativa, mensagem segura/requestId e status de entrega quando disponível; separar lido pelo usuário de ação externa realizada."
],
"POST /notifications/:id/actions → 202 operation; GET /operations/:id. READ/DISMISS é ação separada de SEND/REPLY. Payload usa template/asset autorizados e parâmetros validados.",
[
"Ação sem efeito implementado nunca retorna sucesso falso.",
"Mesmo clique/retry não envia mensagem duplicada quando resultado já é conhecido.",
"Timeout ambíguo fica UNKNOWN para reconciliação, sem reenvio cego.",
"Notificação de outra empresa não pode ser lida ou acionada mudando ID.",
"Falha Meta mantém evidência e ação recuperável, sem esconder a notificação indevidamente."
],
["Testar result null, objeto error em 200, duplicate action e update de read state.", "Testar mesmo IdDatabase com IdCompany distinto e ações não autorizadas.", "E2E consentido de template/texto/comentário usando credenciais específicas."],
"O propósito de App Review ainda precisa de confirmação externa. Não remover a funcionalidade nem tratá-la automaticamente como produto de mensageria irrestrita.",
["src/app/features/channels/components/notification-bell/notification-bell.component.ts", "backend/connect_whatsapp.php"], True)

task("M5.07", "Integrar Msg4/Suite4 por API de serviço e eliminar token global nos consumidores", "integration", "P0", 8, "M3.08 M3.09 M4.14 M1.01 M1.07",
"Permitir operação real dos canais pelo Msg4 com credencial correta por contexto, mantendo segredos centralizados no novo backend.",
[
"Inventariar e migrar cada consumidor identificado em M1.01: envio WhatsApp, templates, comentários, mensagens Facebook/Instagram, status e subscriptions. Criar matriz consumidor→operação→asset→auth→teste.",
"Implementar autenticação máquina-a-máquina de menor escopo, rotação e revogação conforme contrato, preferindo emissão padrão de client credentials/serviço ou assinatura validada definida em ADR.",
"Expor comandos tipados de operação por asset ID autorizado e tenant derivado de escopo do serviço; API funciona como relay autorizado, não endpoint genérico de Graph/decrypt.",
"Resolver credencial internamente, validar política de mensagem, payload, destino autorizado e idempotência. Registrar provider message ID/outcome com redaction e status assíncrono.",
"Remover leituras indevidas de GeneralSettings/SYSTEM_ROOT_USER_TOKEN progressivamente por consumidor, com feature flag e comparação de paridade sem duplicar envios.",
"Se sistema legado exigir segredo local temporariamente, criar ADR de exceção com prazo, escopo, distribuição criptografada e dono; caminho padrão permanece sem exportar token bruto."
],
"API interna /internal/v1/assets/:id/operations/<tipo> com escopos restritos e audit trail. Nunca permitir URL Graph arbitrária nem caller escolher token de outra autorização. Timeout de envio retorna outcome UNKNOWN com operationId.",
[
"Cada operação dos quatro números usa concessão correta mesmo com credenciais distintas.",
"Serviço de tenant A não opera ativo do B nem muda tenant no payload para ampliar acesso.",
"Não existe fallback global quando permissão específica está ausente.",
"Nenhum token permanente chega à web ou cliente externo não autorizado.",
"Todos os consumidores legados têm plano de migração e teste de equivalência sem double-send."
],
["Contract tests com consumidores PHP reais/sanitizados e tokens sintéticos por recurso.", "Testar rotação/revogação do serviço e escopo/tenant inválido.", "E2E sandbox de envio/recebimento/template/comentário com operationId e retorno de status."],
"Consumidores e rotina GeneralSettings estão fora da árvore examinada. A execução depende do inventário operacional; não declarar eliminação do token global só por mudar uma função.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"], True)

task("M5.08", "Replicar metadados para bancos empresariais via outbox idempotente", "data", "P0", 8, "M1.02 M3.06 M2.05 M5.05 M5.07",
"Manter tabelas empresariais compatíveis sem copiar segredos por padrão ou fingir uma transação atômica entre bancos diferentes.",
[
"Implementar projetor por tenant usando catálogo permitido de conexão/DSN e mapeamento IdDatabase+IdCompany; credenciais de banco permanecem no servidor e escopo mínimo.",
"Mapear dados operacionais para MetaConnectedPages/MetaConnectedNumbers e configurações necessárias conforme DDL real; manter IDs legados, relações pai/filho e campo de referência central quando necessário.",
"Publicar outbox na transação central; worker aplica transação apenas no banco de destino e grava checkpoint/version. Falha de um destino não bloqueia todos os tenants.",
"Definir ordenação por agregado, deduplicação, upsert tenant-safe, tombstones e guarda de versão para não reativar registro removido com evento atrasado.",
"Projetar somente metadata/referências e capabilities por padrão. Consumidores usam relay; exceção de segredo local exige ADR aprovado e plano de retirada, nunca UserAccessToken com valor global para tudo.",
"Oferecer backfill/rebuild, reconciliação de contagens/hashes de campos não secretos, dead-letter/replay auditado e status de atraso no portal/suporte."
],
"Evento de projeção versionado: {tenantId,legacyDatabaseId,legacyCompanyId,aggregateId,aggregateVersion,eventType,schemaVersion,metadata}. Contrato define source-of-truth por campo e nenhum DB é escolhido por entrada de usuário.",
[
"Mesmo evento repetido ou fora de ordem não duplica nem regride dados.",
"Tenant A não escreve no banco/tabelas de B, inclusive empresas na mesma base.",
"Banco empresarial offline gera backlog recuperável e não perde commit central.",
"Remoção/reauth de ativo não é revertida por projeção antiga.",
"Rebuild completo produz paridade sem tokens em relatórios ou eventos."
],
["Teste com dois bancos reais e duas empresas em uma base; injetar desconexão no commit de destino.", "Redeliver/out-of-order/tombstone/backfill e versão de schema desconhecida.", "Reconciliar campos e relações com fixtures derivadas do DDL sanitizado."],
"Há janela de consistência eventual entre central e empresa. UI e consumidores precisam observar projection status e evitar ler credencial local antiga como fallback.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"], True)

task("M5.09", "Executar migração em lotes, shadow-read e piloto sem duplicar efeitos", "data", "P0", 8, "M3.11 M5.04 M5.05 M5.06 M5.07 M5.08 M4.14",
"Migrar conexões reais com rastreabilidade, mantendo um único escritor por função e opção de voltar ao caminho compatível.",
[
"Selecionar coorte piloto autorizada com recursos representativos e registrar baseline, backup, mapa de IDs, versões e flags por tenant/canal/consumidor.",
"Executar dry-run do importador, resolver/quarentenar ambiguidades e validar credenciais por grants; aplicar somente lotes aprovados pelo gate, com checkpoints e criptografia no ingresso.",
"Rodar shadow-read e comparar metadata/status/config/contagens entre legado e novo; nunca fazer shadow-send nem assinar/desassinar ativos duas vezes para comparar. Levantar se o callback Meta é compartilhado por app/objeto; antes de trocar, introduzir ingress que valida raw body e roteia cada item ao executor dono, por ledger e transporte interno autenticado, sem transplantar assinatura Meta para payload modificado.",
"Trocar escritores por fase: configuração/credencial central, projeção legada e relay operacional. Reconciliar mudanças que ocorreram no legado entre snapshot e corte.",
"Monitorar grants, subscriptions, mensagens/erros, projeção, fila e experiência do piloto; ampliar por coorte somente após janela e critérios definidos.",
"Ensaiar rollback de roteamento e compatibilidade de dados sem reviver token revogado; alterações externas Meta exigem reconciliação específica, não simples restore do banco."
],
"Entregas: migration manifest por lote, relatório before/after redigido, flags/writer matrix e evidências do piloto. Lotes são idempotentes e mantém provenance para reprocessamento e auditoria.",
[
"Todos os registros do lote estão migrados ou explicitamente em quarentena com motivo.",
"Não há envios/respostas duplicados durante shadow/piloto/cutover.",
"Configurações de mensagens, templates e vínculos são preservados e comparados.",
"Rollback de uma coorte é demonstrado sem afetar tenants que ainda operam no legado.",
"Nenhum consumidor do lote mantém leitura indevida de token global sem exceção registrada."
],
["Repetir lote e interromper entre checkpoints para demonstrar retomada.", "Testar alteração concorrente no legado e reconciliação antes do switch.", "Piloto com quatro Coexistence e ao menos um recurso dos outros fluxos quando elegíveis."],
"Importação não transfere automaticamente concessões Meta. Credenciais sem grant comprovado exigem reauth do cliente ou permanecem fora do lote.",
[".github/docs/agent-context/git-workflow.md", "backend/connect_whatsapp.php"], True)

task("M5.10", "Criar diagnóstico e recuperação operacionais sem expor tokens", "operations", "P1", 5, "M5.02 M5.03 M3.10 M4.12 M5.08",
"Dar ao usuário e suporte meios claros de resolver problemas de conexão, fila e projeção sem editar banco manualmente ou copiar credenciais.",
[
"Implementar visão de suporte por tenant autorizado com status de onboarding, credential health, grants, subscription, último webhook, jobs e projection lag, filtrando dados sensíveis.",
"Permitir ações seguras e tipadas: revalidar, retomar etapa, reconciliar subscription, solicitar reauth e replay de job elegível, com roles, motivo e auditoria.",
"Bloquear retry direto de envio com outcome ambíguo sem reconciliação adequada; suporte não deve poder escolher token bruto ou Graph URL arbitrária.",
"Criar diagnósticos exportáveis com requestId/correlationId, versões e códigos seguros; excluir tokens, payload de mensagem e dados pessoais desnecessários.",
"Apresentar ao usuário apenas próxima ação compreensível, separando impedimento Meta, permissão insuficiente, sessão expirada e falha interna.",
"Fornecer runbooks vinculados às classes de erro e escalonamento com dados mínimos para chamado externo, sem enviar mensagens ou tickets automaticamente."
],
"APIs administrativas protegidas e auditadas por tenant; interface usuário usa capabilities públicas e apoio por requestId. Não é console SQL, shell ou explorador de credenciais.",
[
"Operador identifica a etapa que falhou sem consultar segredo no banco.",
"Replay mantém idempotência e exige permissão de suporte apropriada.",
"Exportação de diagnóstico passa em teste de ausência de segredos/dados excessivos.",
"Operações de outro tenant não são acessíveis por alterar filtro/ID.",
"Usuário consegue solicitar reauth/refresh e entender problema sem jargão de endpoint."
],
["Testar cada role e ação de suporte, incluindo replay proibido/ambíguo.", "Testar coleta redigida com marcador secreto e payload de mensagem.", "Walkthrough de incidente de subscription e banco empresarial offline."],
"Ferramenta de suporte é superfície privilegiada; não introduzir backdoor de token ou bypass de tenant para facilitar diagnóstico.",
[".github/docs/agent-context/security.md", "src/app/features/channels/components/notification-bell/notification-bell.component.ts"])
