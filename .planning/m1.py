task("M1.01", "Fixar baseline e inventariar comportamento real, implantação PHP e consumidores", "architecture", "P0", 5, "",
"Transformar a develop em referência verificável e distinguir código versionado, PHP em operação e funcionalidades esperadas antes de mover ou reescrever arquivos.",
[
"Registrar SHA, árvore, lockfile, versões efetivas e comandos; guardar resultados de build/testes com ambiente e duração, sem tratar registros antigos da documentação como execução atual.",
"Mapear entradas Angular /setup, /channels e /templates, callbacks por produto, serviços HTTP e notificações. Inventariar campos, regras de mensagens e comportamento visual que deve permanecer.",
"Obter com o operador uma cópia sanitizada ou inventário do PHP operacional e regras de rewrite da Hostinger. Comparar connect_whatsapp.php com a rota direta usada no frontend e com connect.php citado pelos documentos.",
"Catalogar consumidores Suite4/Msg4, webhooks em produção, cron, GeneralSettings, rotinas de envio, templates e projeções em bancos empresariais. Registrar dono e versão de cada contrato.",
"Registrar divergências comprovadas: state Base64 sem vínculo de sessão, UUID cliente, token global para envios/templates, callbacks que podem declarar sucesso sem ativos, notificações marcadas lidas sem efeito validado.",
"Produzir matriz comportamento→arquivo/linha→contrato→teste de paridade→pacote de migração; classificar itens como comprovado, hipótese ou não confirmado. Não copiar valores sensíveis dos fontes."
],
"Entregas: docs/baseline/inventory.md, endpoint-matrix.csv, parity-matrix.md e relatório de execução. Cada endpoint informa método, auth atual, payload, efeito externo, tabelas, status/erro e consumidor.",
[
"Todos os endpoints e três telas atuais têm destino de preservação, correção ou remoção justificada; nenhuma função some por omissão.",
"A divergência de roteamento WhatsApp é reproduzida ou explicada por configuração real; inferência está identificada.",
"Baseline compilada e testada em ambiente identificado, ou bloqueio documentado com comando e causa exatos.",
"Nenhum segredo ou identificador operacional desnecessário é publicado em issues, logs ou documentação.",
"Código PHP operacional ausente permanece uma dependência explícita de evidência; não se inventa sua implementação."
],
[
"Executar npm ci, npm run build e npm test -- --watch=false em checkout isolado da baseline; capturar saídas redigidas.",
"Traçar requisições com fixtures sanitizadas, sem acionar envio real nem alterar inscrições de produção.",
"Revisar inventário contra todas as funções e rotas dos quatro arquivos PHP versionados."
],
"O repositório não prova a configuração da Hostinger. Bloquear decisões de corte do legado até reconciliar fonte, rewrite e consumidores reais.",
["AGENTS.md", "backend/connect_whatsapp.php", "src/app/core/services/meta-auth.service.ts", ".github/docs/agent-context/backend-contracts.md"], True)

task("M1.02", "Mapear esquema legado, vínculo empresa/banco e consistência de dados", "data", "P0", 5, "M1.01",
"Definir como os registros atuais serão associados ao novo tenant sem perder números, permissões ou configurações nem mesclar empresas pelo ExternalId.",
[
"Levantar DDL sanitizado de Company, Database, MetaConnectedPages, MetaConnectedNumbers, GeneralSettings e MetaAppReviewNotifications nos bancos central e empresariais, incluindo índices e chaves reais.",
"Documentar o significado de IdDatabase e IdCompany: uma base pode conter várias empresas. Definir tenant como organização autorizada, com mapeamento explícito para o par legado; não reduzir isolamento a IdDatabase.",
"Medir duplicações de ExternalId por Type/empresa, números órfãos, ParentChannelId inconsistente, data de expiração Never, tokens ausentes e credenciais repetidas sem exibir seus valores.",
"Mapear dono de cada campo e direção da sincronização; listar quem grava configuração de mensagens, canais e tokens hoje. Definir matriz de precedência e conflitos.",
"Especificar chaves compostas e estratégia de backfill com IDs legados preservados em tabela de mapeamento, contagens, hashes de dados não secretos e quarentena de ambiguidades.",
"Registrar seleção de bancos por catálogo interno permitido; proibir nomes de banco, DSN e credenciais vindos de parâmetros HTTP ou eventos de clientes."
],
"Entregas: schema-legacy.md, field-mapping.csv, integrity-report.md e plano de consulta somente leitura. Mapeamento inclui tenant_id, legacy_database_id, legacy_company_id, external_asset_id, source_version e projection_version.",
[
"Todas as colunas consumidas por código atual têm destino e regra de conversão documentados.",
"Duas empresas no mesmo IdDatabase não podem compartilhar dados por acidente; há cenário de teste explícito.",
"Ativo ambíguo é colocado em quarentena, sem reatribuição automática por último login.",
"A estratégia de expiração distingue desconhecida, conhecida e sem prazo retornado pelo provedor.",
"Dry-run de migração pode produzir contagens e conflitos sem gravar em produção."
],
["Validar matriz com fixtures de duas empresas no mesmo banco e duas bases diferentes.", "Revisar índices UNIQUE reais contra todos os ON DUPLICATE KEY UPDATE presentes no PHP.", "Provar que relatórios de credenciais usam apenas IDs internos/fingerprints protegidos."],
"Esquema de produção e mecanismo atual de replicação não foram fornecidos. Esta issue exige evidência operacional antes de liberar importação.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"], True)

task("M1.03", "Validar documentação, versões, permissões e elegibilidade dos quatro fluxos Meta", "meta", "P0", 8, "M1.01",
"Criar uma matriz de capacidades comprovada da Meta e impedir que a reconstrução cristalize suposições antigas de Embedded Signup, ativos ou tokens.",
[
"Catalogar app(s), ambientes, modo development/live, configurações de login por fluxo, callback/redirect, papéis, aprovação avançada e verificação empresarial, sem publicar valores secretos.",
"Consultar documentação primária atual de WhatsApp Cloud, Embedded Signup/Coexistence, Facebook Login for Business, Instagram com Facebook Login e com Instagram Login. Registrar data, versão, URL e trecho que sustenta cada decisão.",
"Reproduzir em Sandbox separado do portfólio dono do app o fluxo validado pelo usuário; capturar sessão sanitizada, tipo de código, ativos e metadados da credencial. Um evento de janela não comprova autorização no servidor.",
"Verificar nomenclatura e vínculos reais entre WABA, WhatsApp account, messaging account e número. Manter tipos e relações extensíveis até confirmar o modelo; não declarar WAAC/PMA equivalentes por rótulo de interface.",
"Validar eventos e versão atual de Embedded Signup, featureType, fields de webhook, histórico/estado/echo, registro convencional e offboarding. Não fixar janela de histórico, limite ou enum sem evidência primária.",
"Comparar permissões mínimas por operação e login; registrar App Review, políticas de mensagens, cobranças/elegibilidade e contingências que exigem ação humana. O produto não promete automatizar consentimento ou aprovação da Meta."
],
"Entregas: meta-capability-matrix.md com provider/API version, flow variant, scopes, token family, asset/operation, subscription target, eligibility, expiration/refresh rule e evidência. Registrar 429 ou documentação inacessível como pendência, nunca como validação.",
[
"Os quatro fluxos têm configuração e critérios de elegibilidade próprios, com origem de cada afirmação.",
"Instagram atual via Facebook é identificado corretamente; suporte a Instagram Login tem decisão separada, sem trocar permissões de uma família pela outra.",
"Há prova de token/ativos em Sandbox para cada modalidade antes do desenvolvimento dependente.",
"Register, histórico e desligamento em Coexistence têm regra específica; nenhum fallback para cadastro tradicional é permitido.",
"Mudança de versão da Graph ou do Embedded Signup possui experimento de compatibilidade e dono."
],
["Conferir a coleção oficial Meta no Postman quando acessível e confrontar com documentação principal.", "Executar provas apenas com contas e números de teste autorizados; registrar resultados sem códigos/tokens.", "Revisar permissões por SEND_MESSAGE, MANAGE_TEMPLATES, READ_STATUS e SUBSCRIBE_WEBHOOKS."],
"A documentação developers.facebook.com retornou 429 durante o planejamento. Detalhes atuais de Coexistence permanecem gate de evidência, e o sucesso manual relatado não substitui os testes dos quatro fluxos.",
["backend/meta_auth_helper.php", "backend/connect_instagram.php", ".github/docs/agent-context/open-questions.md"], True)

task("M1.04", "Registrar ADRs de stack, limites de serviço, banco e topologia de execução", "architecture", "P0", 5, "M1.01 M1.02",
"Fixar uma arquitetura executável que reaproveite Angular e separe API, processamento assíncrono e segredos, com alternativas e consequências documentadas.",
[
"Adotar como direção Angular existente em apps/web, NestJS em apps/api, TypeScript estrito e contratos HTTP versionados; comparar PHP modernizado e Next.js usando requisitos reais, sem reescrever a interface por preferência tecnológica.",
"Definir monólito modular de API com módulos Identity, Tenancy, Meta, Credentials, Assets, Webhooks, Jobs, LegacyBridge e Audit. Impedir importação direta dos adaptadores Meta por controllers e da criptografia pelo frontend.",
"Manter MariaDB como opção inicial para reduzir migração simultânea. Selecionar ORM e versão após prova de migrations, JSON/indexes, transações e driver MariaDB; registrar alternativas e lockfile.",
"Executar web e api em containers distintos; worker usa a mesma imagem da API com comando próprio. Banco e fila são dependências de infraestrutura, não se presume que dois containers sozinhos cubram processamento durável.",
"Preferir um mesmo origin público com /api roteado pelo proxy. Documentar TLS, ingress, DNS, proxy confiável e separação dev/staging/prod de app/config/segredos e callbacks.",
"Definir fronteiras de dados: central como fonte de integrações; bancos empresariais como projeção; outbox sem transação distribuída. Definir quando escala para novos workers e quais custos não são necessários no primeiro release."
],
"Entregas: ADR-001 stack; ADR-002 monorepo; ADR-003 persistence/jobs; ADR-004 edge/session; ADR-005 secrets/legacy. Cada ADR inclui contexto, decisão proposta, alternativas, tradeoffs, verificação e condição de revisão.",
[
"Há diagrama de containers e tabela de responsabilidades e dependências por ambiente.",
"Nenhum requisito funcional depende de SSR/SEO ou acoplamento de API ao ciclo de build Angular.",
"Versões suportadas são verificadas no início da implementação, sem copiar a baseline 21.0.8 como compromisso permanente.",
"API e worker podem escalar separadamente com persistência durável e shutdown definido.",
"Escolhas de ORM/fila não comprovadas têm prova de conceito curta e critério de decisão, não ficam implícitas."
],
["Revisar limites de módulos com mapa de dependências proposto.", "Validar compatibilidade Angular/Node/TypeScript e NestJS/Node em fontes oficiais na data de execução.", "Ensaiar falha de worker durante gravação/entrega em uma PoC isolada."],
"Decisão de arquitetura não equivale a instalar ou migrar produção. Alternativas só são encerradas com evidência e registro de custo operacional.",
["package.json", "angular.json", ".github/docs/agent-context/architecture.md"])

task("M1.05", "Especificar domínio, estados e modelo autorização–credencial–ativo", "architecture", "P0", 8, "M1.02 M1.03 M1.04",
"Projetar o modelo central para múltiplas autorizações e números sem confundir token, conta, número, canal e tenant.",
[
"Definir Tenant, Principal, Membership, PortalSession, MetaAppConfig, OnboardingSession, MetaAuthorization, MetaCredential, MetaAsset, AssetRelation e AssetAuthorization com IDs internos e tenant explícito.",
"Modelar uma autorização concedendo acesso a vários ativos e um ativo podendo ter autorizações sucessivas; credencial tem família, emissor/app, ambiente, permissões, versões, expiração e vínculo à autorização.",
"Separar estado de onboarding, saúde de credencial, estado Meta do ativo, subscription e projeção. Um único connected boolean não representa credencial válida com webhook pendente.",
"Especificar transições: CREATED→AWAITING_PROVIDER→CODE_RECEIVED→EXCHANGING→ASSETS_VERIFIED→PROVISIONING→READY/PARTIAL; CANCELLED/EXPIRED/FAILED com erro tipado, retry e tentativas auditadas.",
"Definir unicidade por tenant/provider/app/environment/kind/external_id, IDs externos string e UTC. Criar política de exclusividade de roteamento de eventos para ativo compartilhado por empresas, com conflito em quarentena.",
"Projetar WebhookSubscription, InboxEvent, OutboxEvent, SyncJob, ProjectionCheckpoint e AuditEvent; limites de retenção, chaves idempotentes e versionamento otimista fazem parte do modelo."
],
"Entregas: ERD, dicionário de dados, máquinas de estado, invariantes e exemplos de quatro números em uma/duas WABAs e autorizações distintas. Campos de ciphertext não integram DTOs de UI.",
[
"Quatro onboards de Coexistence não sobrescrevem conexões anteriores nem exigem um token único global.",
"Foreign keys e queries protegem o tenant nos vínculos entre entidades.",
"READY exige os pré-requisitos definidos para a modalidade; PARTIAL permanece consultável e recuperável.",
"Ativos e autorizações podem ser revogados seletivamente sem apagar outras permissões válidas.",
"Status desconhecido e dado desatualizado são representáveis sem inventar resposta da Meta."
],
["Simular login repetido, token substituído, WABA compartilhada e IDs externos grandes como strings.", "Revisar invariantes com cenário de mesmo ativo tentando ser conectado por tenant diferente.", "Derivar testes de transição e constraints a partir do dicionário."],
"O modelo de ativos da Meta muda; relações devem ser verificadas por versão e não inferidas apenas dos campos retornados pelo navegador.",
["src/app/core/models/channel.model.ts", "backend/connect_whatsapp.php"])

task("M1.06", "Definir identidade Suite4, acesso direto e modelo de ameaças", "security", "P0", 8, "M1.01 M1.04 M1.05",
"Substituir UUID como autorização por um contrato verificável de identidade e associação empresarial, sem exigir nova senha no portal.",
[
"Definir Suite4 como emissor confiável somente após mapear sessão, identidade estável e membership. Backend emissor cria ticket curto assinado, com iss/aud/sub/tenant/roles/jti/iat/exp; browser não escolhe suas próprias claims.",
"API troca ticket de uso único por sessão opaca; valida algoritmo permitido, assinatura/JWKS, audience, emissor, relógio, membership e jti consumido atomicamente. Prazo inicial proposto ≤60s, ajustável com teste.",
"Para acesso direto, definir magic link para identidades previamente convidadas, uso único e curta validade. Não criar associação por domínio do e-mail nem revelar se conta existe.",
"Modelar CSRF/login CSRF, session fixation, roubo de URL, state adulterado, troca de empresa em outra aba, callback atrasado, postMessage forjado, replay de webhook e abuso do endpoint interno de credenciais.",
"Especificar cookie HttpOnly/Secure host-only, sessão revogável com idle/absolute timeout e rotação, Origin/CSRF e allowlists exatas. UUID permanece identificador, nunca prova de direito.",
"Projetar modo embed com handshake versionado, event.source/origin/nonce e fallback top-level para bloqueio de cookies. Nenhuma solução depende de desabilitar proteção do navegador."
],
"Entregas: threat-model.md, identity-contract.md e tabela ator→operação→escopo. Papéis iniciais owner/admin/operator/viewer por tenant; identidade de serviço distinta de pessoa.",
[
"Abrir URL com cUUID arbitrário não concede sessão nem acesso a ativos.",
"Suite4 e API concordam sobre emissor, audience, rotação e revogação; evidência ausente é bloqueio rastreado.",
"Magic link não permite enumeração, replay, alteração de tenant ou consumo automático por scanner de e-mail.",
"Mudanças de empresa e concorrência de abas não alteram contexto de onboarding já iniciado.",
"Ações de conectar/desconectar/reenviar eventos têm permissões e auditoria definidas."
],
["Definir testes de replay, nonce adulterado, emissor errado e associação revogada.", "Validar cookies/sessão em standalone, iframe same-site e contexto de terceiros bloqueado.", "Revisar threat model contra todos os endpoints da matriz legada."],
"Identidade real e mecanismo emissor do Suite4 não estão no repositório. A implementação dependente exige contrato confirmado, sem aceitar apenas UUID assinado por lógica no frontend.",
["src/app/features/channels/pages/channel-setup/channel-setup.component.ts", "backend/meta_auth_helper.php", ".github/docs/agent-context/iframe-integration.md"], True)

task("M1.07", "Especificar OpenAPI, eventos e catálogo de erros verificável", "architecture", "P0", 8, "M1.05 M1.06",
"Tornar frontend, API, worker e consumidores implementáveis a partir de contratos comuns, com compatibilidade explícita com o legado.",
[
"Definir /api/v1/auth/exchanges, /session, /integrations/flows, /onboarding-sessions, /connections, /assets, /jobs, /templates e configurações/notifications. Tenant vem da sessão; IDs de recursos são internos e validados.",
"Descrever callback e submissão de código Embedded Signup separados da sessão de portal: correlação pelo onboarding e state de uso único, nunca por company_uuid fornecido ao retornar.",
"Especificar respostas 202+job/location, paginação por cursor, concurrency/version/ETag quando cabível, Idempotency-Key e limites de payload. Idempotência possui escopo tenant+operação+chave e valida hash do payload.",
"Criar catálogo de erros estável com code, safeMessage, requestId, retryable e action; mapear permissões ausentes, reauth, elegibilidade, conflito de ativo, timeout ambíguo e Meta indisponível.",
"Definir schemas de eventos inbox/outbox, correlation/causation IDs, versão de schema, timestamps e ator. Dados sensíveis de mensagens não entram indiscriminadamente no evento operacional de status.",
"Especificar API interna restrita para operações Msg4 por ativo; nunca expor decrypt ou token bruto ao frontend. Definir caminho de compatibilidade para os payloads PHP legados e testes de consumidor."
],
"Entregas: contracts/openapi.yaml, events/*.schema.json, error-catalog.md e exemplos sanitizados de request/response/erro por operação. Segurança global deny-by-default, exceções públicas listadas.",
[
"Todos os endpoints da baseline têm mapeamento v1 e política de compatibilidade.",
"Cliente gerado compila e não contém campos de segredo; métodos tipam sucesso e erro.",
"Um 200 ou redirect não é interpretado como conexão pronta sem consultar estado de servidor.",
"Idempotency-Key repetida com payload diferente gera conflito e não repete efeito.",
"Contratos identificam efeitos externos e limites de retry, especialmente envio de mensagens."
],
["Validar OpenAPI e exemplos contra schemas; comparar breaking changes em CI.", "Criar testes de contrato dos consumidores para listagem, templates, respostas e notificações.", "Testar 401/403/404 seguros sem revelar existência de ativo de outro tenant."],
"IDs externos e company_uuid legados não podem se tornar chaves de autorização nas rotas novas. Respostas brutas da Meta precisam de normalização/redação.",
["src/app/core/services/meta-integration.service.ts", "src/app/features/channels/components/notification-bell/notification-bell.component.ts"])

task("M1.08", "Especificar jornadas, status e paridade visual do portal", "web", "P1", 5, "M1.01 M1.03 M1.05 M1.07",
"Definir uma experiência simples para voltar ao portal, adicionar qualquer modalidade e entender pendências reais sem jargão técnico ou perda do layout validado.",
[
"Desenhar entrada Suite4 e acesso direto, empresa ativa, dashboard, catálogo dos quatro fluxos, resumo do recurso, detalhe de status, reautorização e desconexão.",
"Manter linguagem e estrutura visual existentes como referência; especificar mudanças necessárias para quatro escolhas: WhatsApp API, WhatsApp + aplicativo, Instagram e Facebook. Não reestilizar indiscriminadamente.",
"Mapear cada estado de servidor para texto, severidade, ação, possibilidade de retry e horário de última verificação. Separar recurso conectado, credencial inválida, webhook pendente e status Meta desconhecido.",
"Definir onboarding individual por número, retorno ao portal, continuidade após popup fechado, cancelamento, timeout, múltiplas abas e adicionar outro número sem substituir o anterior.",
"Incluir telas atuais de templates, configuração de mensagens e notificações; ações indisponíveis devem explicar a condição, sem exibir sucesso fictício ou botões sem backend.",
"Especificar acessibilidade, foco, teclado, contraste, leitores de tela, responsividade e embed; avisos de ação destrutiva descrevem escopo por recurso e consequências comprovadas."
],
"Entregas: journey-spec.md, status-copy-matrix.csv, wireframes de estados e mapa tela→API→permissão→teste. Texto técnico como subscribed_apps fica no diagnóstico de suporte, não na jornada comum.",
[
"Usuário identifica quais recursos pertencem à empresa atual e quando o status foi confirmado.",
"Quatro conexões Coexistence podem ser adicionadas consecutivamente e distinguidas visualmente.",
"Estados loading/empty/error/partial/stale/reauth têm ações coerentes e navegação recuperável.",
"Especificação preserva templates, mensagens e notificações ou registra mudança de produto explícita.",
"Não existem telas que peçam ao usuário colar tokens permanentes para completar o fluxo padrão."
],
["Walkthrough com fixtures de cada fluxo e falhas parciais.", "Revisão de acessibilidade das jornadas de popup/modal e troca de empresa.", "Comparar protótipos com HTML/SCSS da baseline para identificar mudanças intencionais."],
"Sandbox deve ser apresentado como ambiente de teste e não confundido com ativo fictício; elegibilidade da Meta não pode ser prometida pela interface.",
["src/app/features/channels/pages/channel-setup/channel-setup.component.ts", "src/app/features/channels/pages/channel-list/channel-list.component.ts", "src/styles.scss"])

task("M1.09", "Definir SLOs, capacidade, retenção e estratégia de transição", "operations", "P0", 5, "M1.02 M1.03 M1.04 M1.05",
"Definir metas mensuráveis e limites de operação que orientem jobs, infraestrutura, rollout e recuperação sem inventar volume de produção.",
[
"Levantar quantidade de empresas/ativos, taxa média/pico de webhook, tamanho/volume de histórico, envios e operações de templates; manter cenários nominal, pico e crescimento com hipóteses explícitas.",
"Propor orçamento de latência da API, ACK de webhook, atraso da fila/projeção, disponibilidade e tempo de reautorização; validar em carga antes de firmar SLO de produção.",
"Fixar RPO/RTO iniciais propostos para banco, cofre, jobs e projeções; incluir acesso às chaves no restore e reconciliação da Meta, que não é revertida por restaurar banco.",
"Definir retenção por categoria: metadata operacional, payload bruto de webhook, conteúdo de mensagens/histórico, auditoria, sessão e backup. Minimizar coleta e controlar expurgo de dados empresariais.",
"Planejar migração expand/backfill/dual-read ou shadow-read/piloto/cutover/contract com flags por tenant+canal; escolher único escritor por configuração e credencial durante cada fase.",
"Definir orçamento de custo e gatilhos de escala, limites por tenant para evitar vizinho ruidoso, quotas Meta, janelas de manutenção e critérios objetivos de abortar rollout."
],
"Entregas: nfr.md, capacity-model.csv, retention-policy.md, transition-strategy.md e risk-register.md. Números iniciais são metas propostas, não medições da instalação atual.",
[
"Cada SLO define indicador, janela, fonte de medição e ação quando excedido.",
"RPO/RTO cobrem segredos e restaurabilidade; uma cópia de banco sem chave não conta como backup funcional.",
"Histórico opcional tem política de consentimento, retenção e limite de armazenamento.",
"Todas as fases de migração têm escritor autorizado, flags, observação, rollback e condição de saída.",
"Datas de entrega só serão atribuídas após estimativa e disponibilidade; nenhum prazo fictício é usado como compromisso."
],
["Validar contas de capacidade em pelo menos três cenários e falha de um worker.", "Tabletop de corte de API com rollback e pendência de webhook externo.", "Revisar retenção com responsável pelos dados e contratos de clientes antes da produção."],
"Volumes, infraestrutura alvo e política legal de retenção não foram comprovados. Tratar números como hipóteses e solicitar decisão no gate apropriado, não bloquear o planejamento atual.",
[".github/docs/agent-context/roadmap.md", ".github/docs/agent-context/security.md"], True)

task("M1.10", "Instituir SDD, governança de decisões e critérios de prontidão", "architecture", "P0", 5, "M1.01 M1.05 M1.06 M1.07 M1.08 M1.09",
"Permitir desenvolvimento guiado por IA com especificações verificáveis, contexto consistente e revisão humana orientada por evidências.",
[
"Organizar specs por authentication, tenancy, credentials, meta-onboarding, webhooks, portal e legacy-bridge. Cada feature recebe problema, escopo, invariantes, contrato, cenários Given/When/Then, testes e migração.",
"Atualizar AGENTS como índice de regras e contexto; reconciliar documentos antigos que dizem backend todo untracked ou testes falhando. Regras locais de arquivos sensíveis continuam vigentes.",
"Definir Ready: dependências resolvidas, contrato estável, critérios mensuráveis, fixtures e evidência externa disponível. Done: código revisado, testes pertinentes, docs/migration/runbook e evidência vinculados.",
"Criar templates de issue/PR/ADR e checklist SDD com foco em isolamento, credenciais, reversibilidade e efeitos externos. IA não deve preencher pendências com suposições ou ampliar escopo do PR.",
"Definir fluxo Backlog→Ready→In progress→In review→Done e Blocked com razão/dono; um pacote bloqueado pode ter trabalho independente, mas não passa gate sem evidência.",
"Manter rastreabilidade requisito→issue→spec→contrato→teste→PR→release, com revisão de escopo e calendário por capacidade. Contagem de issues fechadas não substitui aceite técnico."
],
"Entregas: SDD playbook, templates, traceability.csv, convenções de branches/versões e matriz de responsáveis por função. Não atribuir pessoas ou prazos sem confirmar disponibilidade.",
[
"Todas as milestones e pacotes possuem dependências e critérios de conclusão verificáveis.",
"Nenhuma issue de implementação é fechada por ter somente planejamento escrito.",
"Há caminho único para mudar um contrato/ADR e propagar a mudança para consumidores e testes.",
"Dados de produção, tokens e fontes PHP locais sensíveis não entram no contexto versionado de IA.",
"A revisão identifica lacunas externas e bloqueios com dono funcional e experimento, sem depender de memória do chat."
],
["Aplicar o template a uma feature vertical e demonstrar rastreio completo com fixtures.", "Checar links, IDs e ciclos de dependências por script.", "Auditar regras duplicadas/contraditórias entre AGENTS e documentos legados."],
"A estrutura SDD precisa guiar entregas e testes, não virar documentação paralela desatualizada. Revisão de contrato deve acompanhar cada PR funcional.",
["AGENTS.md", ".github/prompt_templates/plan.md", ".github/docs/agent-context/known-issues.md"])
