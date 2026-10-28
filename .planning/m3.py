task("M3.01", "Implementar tenants, identidades, memberships e autorização por recurso", "security", "P0", 5, "M1.05 M1.06 M2.02 M2.03",
"Garantir que toda operação de portal e serviço seja autorizada para a empresa e recurso corretos antes de incorporar qualquer token Meta.",
[
"Implementar Tenant e mapeamento legado IdDatabase+IdCompany; identidade usa subject estável do emissor e memberships explícitas, sem tomar CompanyUUID como credencial.",
"Definir guards/policies por operação e recurso com papéis owner/admin/operator/viewer; evitar autorização baseada só na presença de sessão ou em role enviado pelo frontend.",
"Criar contexto de tenant imutável por requisição/job; repositórios exigem tenantId e rejeitam consultas sem escopo. Filtrar relacionamentos e updates além das listagens.",
"Provisionar tenants e memberships via contrato interno autenticado ou processo administrativo auditado; não abrir endpoint público que cria associação por UUID ou domínio de e-mail.",
"Implementar seleção de empresa da sessão consultando memberships ativas; troca de contexto não modifica onboards em andamento, ligados ao tenant original.",
"Criar fixtures de tenants A/B, duas empresas na mesma base legada e ativos com IDs externos iguais; aplicar isolamento também em caches, jobs e métricas de suporte."
],
"APIs: GET /api/v1/session retorna pessoa/empresa/permissões seguras; POST /session/tenant-switch valida membership. Identidade de serviço tem escopos e tenants próprios, fora das roles de pessoa.",
[
"Trocar assetId, tenantId, UUID ou IdDatabase no request não permite acesso cruzado.",
"Membership revogada impede novas ações e invalida contexto em prazo definido.",
"Todas as queries de negócio e jobs exigem tenant explícito e recurso autorizado.",
"Recurso de outro tenant produz erro seguro sem revelar detalhes.",
"Operador não pode conceder privilégios administrativos nem acessar segredos."
],
["Testes de autorização por matriz role×operação×tenant, incluindo update/delete/jobs.", "Testar mesma base legada com duas empresas e cache compartilhado.", "Auditar ausência de query de recurso externo sem filtro de tenant/app/environment."],
"MariaDB não fornece a mesma defesa RLS de alguns bancos; a aplicação e constraints precisam sustentar isolamento verificável.",
["backend/connect_whatsapp.php", "src/app/core/services/meta-integration.service.ts"])

task("M3.02", "Trocar ticket Suite4 por sessão de portal com replay bloqueado", "security", "P0", 8, "M3.01 M1.06 M2.04 M2.10",
"Abrir o portal a partir de Suite4/Msg4 sem nova senha e sem usar identificador empresarial como prova de identidade.",
[
"Implementar contrato de emissor confirmado: ticket assinado no backend Suite4, algoritmo permitido, iss/aud/sub/tenant/roles/jti/iat/exp e identificação da sessão de origem.",
"API valida assinatura/JWKS e versão de chave, audiência, emissor, validade curta, clock skew limitado e membership autoritativa; não aceitar jku arbitrário nem algoritmo escolhido sem allowlist.",
"Consumir jti atomicamente com criação de sessão, recusando replay inclusive em duas réplicas concorrentes. Guardar hash do ticket/jti quando cabível, nunca ticket bruto em log.",
"Transportar ticket por mecanismo de bootstrap seguro definido no contrato, removendo qualquer parâmetro temporário da URL e impedindo vazamento por referrer, analytics e histórico.",
"Rotacionar sessão anterior e emitir cookie seguro; retornar apenas contexto público e permissões. Mapear falhas para acesso expirado/negado com caminho de recuperação.",
"Definir revogação, rotação de chaves e indisponibilidade do emissor; não reutilizar tickets expirados nem aceitar fallback de cUUID para manter conveniência."
],
"POST /api/v1/auth/exchanges {ticket} → sessão + contexto público; idempotência de rede permite recuperar resultado da mesma operação com vínculo de browser, sem reutilização irrestrita de ticket. TTL inicial ≤60s é proposta a validar.",
[
"Ticket válido abre a empresa correta; assinado para outra audience ou tenant é recusado.",
"Duas tentativas concorrentes de consumir jti concedem no máximo uma nova sessão válida.",
"Ticket não fica em localStorage, logs ou resposta de erro.",
"Revogação de membership impede uso de ticket antigo ainda dentro do prazo.",
"Fluxo funciona com chaves rotacionadas e erro seguro quando emissor está indisponível."
],
["Testar assinatura inválida, alg none, exp/iat futuros, iss/aud errados e replay entre réplicas.", "Integrar emissor real de teste Suite4 com cookies e redirect final.", "Inspecionar logs/referrer/URL após bootstrap com dados sintéticos."],
"Emissor Suite4 é dependência externa ainda não comprovada. Não substituir por JWT assinado no Angular ou por segredo incluído em bundle.",
["src/app/features/channels/pages/channel-setup/channel-setup.component.ts", ".github/docs/agent-context/iframe-integration.md"], True)

task("M3.03", "Criar acesso direto por link de uso único para membros convidados", "security", "P1", 5, "M3.01 M3.04 M2.05",
"Permitir retorno ao portal sem senha adicional, preservando vínculo empresarial confiável e resistência a abuso.",
[
"Implementar solicitação de magic link apenas para identidades convidadas/associadas previamente; resposta pública uniforme para e-mail existente ou desconhecido.",
"Gerar token opaco de alta entropia, armazenar hash, TTL curto, tentativas e contexto; envio por adaptador de e-mail configurado em runtime e fila com proteção contra abuso.",
"Usar página intermediária que exija ação consciente para consumir o link via POST, evitando que scanners de e-mail gastem o token em GET; limpar URL e referrer.",
"Consumir atomicamente, verificar identidade/membership ainda ativa, rotacionar sessão e oferecer seleção de empresas autorizadas quando houver mais de uma.",
"Aplicar rate limit por IP/identidade normalizada/tenant, quotas e redigir conteúdo de logs. Links expirados têm recuperação clara e não confirmam existência da conta.",
"Documentar convite, remoção de membro, troca de e-mail com verificação e recuperação administrativa; ambiente de desenvolvimento usa inbox local e nunca envia a clientes reais."
],
"POST /auth/magic-links com resposta 202 uniforme; GET página de confirmação sem consumo; POST /auth/magic-links/consume com segredo temporário. Não há cadastro empresarial automático nem senha nova.",
[
"GET do scanner não consome o link e não cria sessão.",
"Link não pode ser reutilizado, alterado para outro tenant nem usado após revogação de membership.",
"Resposta e tempo de erro não expõem listagem de membros.",
"Rate limits e quotas impedem disparo irrestrito de e-mail.",
"Tokens de link são armazenados como hash e não aparecem em logs/analytics."
],
["Testar concorrência de consumo, expiração, e-mail desconhecido e scanner HEAD/GET.", "Testar entrega via provedor de e-mail de staging/inbox local.", "Validar sessões e seleção de tenant de pessoa com duas memberships."],
"Provedor de e-mail, domínio e política de convite precisam de configuração real. E-mail sozinho não estabelece pertencimento a uma empresa.",
[".github/docs/agent-context/security.md"], True)

task("M3.04", "Implementar sessões seguras, CSRF, CORS e limites de abuso", "security", "P0", 8, "M3.01 M2.02 M2.03 M1.06",
"Sustentar autenticação revogável no navegador e impedir requisições de outros sites ou sessões fixadas.",
[
"Criar sessão opaca com segredo de alta entropia, hash no servidor, cookie HttpOnly/Secure/host-only e SameSite apropriado ao modo; preferir mesmo origin web/API.",
"Definir idle e absolute timeout configuráveis, revogação/logout e rotação em login/elevação; valores iniciais propostos 30min idle e 8h absoluto sujeitos a validação de produto.",
"Proteger mutações com mecanismo CSRF e validação Origin/Fetch Metadata compatível com callbacks públicos separados. SameSite não é considerado defesa única.",
"Configurar CORS apenas para origens exatas necessárias; não refletir Origin desconhecido nem combinar wildcard com credentials. Tratar trusted proxy e Secure cookies corretamente.",
"Aplicar rate limits distribuídos para login, magic link, onboarding, status refresh e ações administrativas, com chaves separadas por tenant/ator/IP e erros seguros.",
"Separar callback OAuth e webhook das rotas de sessão: validações específicas não removem a segurança do restante da API. Definir CSP, proteção de framing e política de referrer por rota."
],
"Endpoints de sessão: GET /session, POST /session/logout, DELETE /sessions/:id quando autorizado. Cookie não guarda token Meta nem claims de tenant confiadas sem consulta de sessão.",
[
"Sessão revogada deixa de autorizar em todas as réplicas dentro do prazo definido.",
"Mutações sem proteção CSRF válida ou Origin autorizado são recusadas.",
"Sessão antiga não sobrevive indevidamente ao login e não existe token persistente em localStorage.",
"CORS/origin desconhecido não recebe acesso credenciado.",
"Limites funcionam entre réplicas e não compartilham quotas de tenants sem necessidade."
],
["Testar session fixation, logout, expiração idle/absoluta, CSRF e cookies em HTTPS.", "Testar CORS de origem permitida/desconhecida e request sem Origin de serviço interno autorizado.", "Simular duas réplicas e rotação/revogação com cache."],
"Iframe em contexto de terceiros pode bloquear cookies mesmo com SameSite=None. Tratar o produto com alternativa top-level validada, sem enfraquecer controles.",
["backend/meta_auth_helper.php", "src/app/core/services/meta-auth.service.ts"])

task("M3.05", "Criar contrato seguro de embed Suite4 e retorno OAuth", "integration", "P0", 5, "M3.02 M3.04 M1.08",
"Permitir portal embarcado sem confiar em mensagens ou tenant enviados por qualquer janela.",
[
"Definir protocolo versionado ready→bootstrap→ack entre parent e iframe com nonce, correlationId, origin e source validados; somente origens Suite4 exatas autorizadas.",
"Enviar ticket curto emitido pelo backend do host, nunca tokens Meta. O child troca por sessão na API e mantém contexto operacional derivado do servidor.",
"Abrir OAuth/Embedded Signup em popup controlado ou top-level conforme modalidade; validar event.source/origin e correlacionar callbacks com onboardingId de servidor.",
"Retorno da janela transmite apenas sinal seguro/ID opaco; iframe consulta o estado na API. Não aceitar auth_success=true nem mensagem FINISH como prova suficiente de conclusão.",
"Implementar popup bloqueado, janela fechada, sessão expirada, tenant trocado no parent e storage/cookies de terceiros bloqueados com alternativa acessível.",
"Definir resize/theme/navigation messages sem executar URLs arbitrárias, evitar scroll/focus trap e configurar frame-ancestors somente para hosts permitidos."
],
"Schemas: EMBED_READY, EMBED_BOOTSTRAP, EMBED_ACK, NAVIGATION_REQUEST e RESIZE com version/nonce. Eventos Meta são adaptadores separados, não mensagens de administração de tenant.",
[
"Mensagem de origem ou janela diferente não cria sessão nem altera tenant.",
"Conexão continua sendo do tenant de início mesmo após trocar o contexto do parent.",
"OAuth retorna para uma rota permitida e estado do servidor confirma sucesso.",
"Fluxo oferece recuperação quando popup/cookies são bloqueados.",
"Nenhum segredo permanece no parent/iframe ou aparece em telemetria."
],
["E2E com parent Suite4 de teste, origem maliciosa e source incorreto.", "Testar popup fechado/bloqueado e duas conexões concorrentes em abas.", "Validar teclado/foco/resize em desktop e mobile suportados."],
"postMessage com origem correta ainda não comprova uma pessoa autorizada; o backend precisa validar o ticket e membership.",
[".github/docs/agent-context/iframe-integration.md", "src/app/app.routes.ts"], True)

task("M3.06", "Persistir autorizações, ativos, concessões e relações com constraints de tenant", "data", "P0", 8, "M3.01 M2.03 M1.05",
"Materializar o domínio central e impedir que reconexões sobrescrevam a autoria ou o escopo de acesso de recursos.",
[
"Criar migrations das entidades e relações especificadas, incluindo tenant/app/environment em índices e validação referencial entre autorização, credencial e ativo.",
"Implementar repositórios de upsert por chave composta correta; manter IDs internos estáveis e referências legadas, com versionamento otimista e histórico de origem.",
"Persistir granted_scopes/asset_grants e prova de verificação do ativo, separando claims do navegador de dados confirmados na Meta.",
"Definir política para um ativo reivindicado por tenant diferente: recusar/quarentenar até comprovação, sem transferir com ON DUPLICATE KEY UPDATE global.",
"Registrar asset relations tipadas e verificadas, como phone→account e Instagram→Page quando exigido pela variante. Não tornar vínculo com Facebook obrigatório a toda conta Instagram.",
"Criar read models sem credenciais e estados independentes de auth/asset/subscription/projection; mudanças locais geram outbox na mesma transação."
],
"Entregas: migrations, repos e contratos de agregados. External IDs são strings; dados Meta desconhecidos podem ser preservados em extensão versionada com allowlist e retenção.",
[
"Reautorização preserva histórico e configurações sem duplicar o mesmo ativo do tenant.",
"Mesmo número em empresa diferente não é silenciosamente reatribuído.",
"Authorization e AssetAuthorization de tenants diferentes não podem ser relacionados.",
"Read models e serialização pública não incluem qualquer campo secreto.",
"Falha no commit não publica outbox de alteração inexistente."
],
["Testar upserts concorrentes e rollback em banco real.", "Testar ativo compartilhado legítimo no mesmo tenant com múltiplas autorizações.", "Validar constraints com foreign key cruzada e IDs externos acima de limite numérico JS."],
"Reutilização de ativo na Meta e exclusividade de roteamento no produto são decisões distintas; documentar exceções antes de permitir fanout entre tenants.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"])

task("M3.07", "Implementar cofre criptografado, versões de chave e rotação", "security", "P0", 8, "M3.06 M2.02 M1.04",
"Guardar tokens e segredos recuperáveis de forma protegida, acessível somente aos serviços autorizados e sem chaves dentro do banco.",
[
"Criar interface Vault/CredentialStore e adaptador de criptografia autenticada com biblioteca/runtime confiável; definir AES-256-GCM ou envelope KMS conforme ADR e infraestrutura disponível.",
"Guardar ciphertext, nonce/IV único, auth tag, key version e AAD vinculando tenant/credential/app/environment; não registrar token em logs, exceções, traces ou objetos genéricos.",
"Fornecer chaves somente em runtime por secret manager/arquivo protegido, com catálogo de versões e fail-closed se chave faltar. Nunca gerar nova chave descartável no startup para esconder erro.",
"Implementar acesso mínimo à descriptografia e auditoria por credentialId/operation, sem conteúdo; garantir que controllers/DTOs públicos não exponham decrypt genérico.",
"Criar rotação em lotes com leitura de versões antigas, reencrypt/rewrap, checkpoints e verificação; manter chave antiga apenas pelo período necessário de rollback/backup.",
"Planejar incidente de chave/token comprometido: revogação no provedor, invalidação de cache, bloqueio de jobs e rotação não são a mesma operação."
],
"MetaCredential guarda segredo criptografado e metadados; chaves permanecem fora de Git, banco e imagens. Hash/fingerprint para deduplicação deve ser não reversível e protegido quando necessário.",
[
"Dump de banco e artefatos da aplicação não revelam token em claro.",
"AAD ou ciphertext adulterado impede descriptografia segura.",
"Rotação retoma após queda sem perder credenciais nem misturar tenants.",
"Ausência de chave mantém operações de credencial bloqueadas com erro operacional seguro.",
"Backup restaurado com chaves autorizadas recupera credenciais de versões válidas."
],
["Testar criptografia/descriptografia, nonce, adulteração, AAD e versão inexistente.", "Executar rotação com interrupção e múltiplas réplicas.", "Injetar token sintético marcador e verificar ausência em todos os logs/respostas/layers."],
"Criptografia em repouso não substitui autorização de serviço. Recuperação de chave é parte do RTO e precisa de acesso operacional controlado.",
["backend/meta_auth_helper.php", ".github/docs/agent-context/security.md"])

task("M3.08", "Resolver credenciais por tenant, ativo, app e operação sem fallback global", "security", "P0", 8, "M3.06 M3.07 M1.03 M1.07",
"Escolher a concessão correta para cada chamada e eliminar a dependência indevida de SYSTEM_ROOT_USER_TOKEN/GeneralSettings nas operações de clientes.",
[
"Implementar resolver interno com {tenantId,provider,appConfigId,environment,assetId,operation}; caller autenticado não escolhe credentialId arbitrário para burlar escopo.",
"Validar ativo e ancestral exigido pela operação, autorizações ativas, scopes/capabilities, família do token e validade/estado conhecido. Aplicar matriz de operações da modalidade.",
"Definir seleção determinística entre múltiplas concessões elegíveis, mantendo histórico e preferência explícita. Falta de permissão gera reauth/action_required; nunca usar token root como tentativa alternativa.",
"Cachear apenas quando necessário com chaves completas e TTL limitado, invalidando por autorização/token version/revogação. Não colocar token em cache público nem persistir mais cópias sem necessidade.",
"Separar execução de operação da exposição de segredo: adaptadores Meta recebem credential handle/resolved secret só no processo servidor; API pública retorna capabilities/status.",
"Adicionar auditoria da escolha com IDs internos e razão, sem token; distinguir credencial de app para inspeção permitida de credencial de cliente para mensagens/subscriptions."
],
"Serviço resolveCredential(context) → handle interno ou erro tipado. SEND_MESSAGE é por phone/Page/IG conforme variante; MANAGE_TEMPLATES resolve conta autorizada; SUBSCRIBE_WEBHOOKS resolve alvo correto.",
[
"Quatro números com autorizações diferentes usam os grants certos, inclusive WABA compartilhada e reauth parcial.",
"Token válido de outro tenant/app/environment nunca é candidato.",
"Revogação impede novas operações e remove credencial dos caches.",
"Ausência de grant específico falha com motivo recuperável, sem fallback global.",
"Nenhuma rota pública retorna token permanente ou conteúdo de cofre."
],
["Testar matriz de números/WABAs/Pages/Instagram com tokens sintéticos distinguíveis.", "Testar expiração desconhecida, permissão removida e empate entre concessões.", "Teste arquitetural impede novos acessos diretos a GeneralSettings/token root no caminho de cliente."],
"Token pertence à autorização, não necessariamente a um número. Desnormalizar um segredo por número pode quebrar revogação e reconexão.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"])

task("M3.09", "Gerenciar validade, inspeção, renovação e reautorização por família de token", "security", "P0", 5, "M3.08 M2.05 M1.03",
"Manter conexão utilizável ao longo do tempo sem presumir prazo de 60 dias ou renovação disponível para todas as credenciais Meta.",
[
"Registrar issued_at, expires_at/data_access_expires_at quando retornados, last_checked_at, type/family, scopes e health. Null significa ausência de evidência de prazo, não garantia de eternidade.",
"Implementar strategies por login/produto: inspeção, troca/refresh somente onde suportados e reauth onde exigido. Não aplicar fb_exchange_token ao Business Integration token por hábito legado.",
"Agendar checks com jitter, orçamento e locks por credencial; agrupar efeitos de credencial compartilhada para evitar dezenas de inspeções iguais por número.",
"Normalizar invalidação por revogação/erro Meta/membership/remoção de ativo e refletir impacto nas conexões, jobs e alertas; preservar causa e evidência redigida.",
"Controlar renovação concorrente com versionamento, troca atômica de referência e invalidação de caches; descartar resultados atrasados de uma versão já substituída.",
"Expor ao portal somente estado, prazo conhecido e próxima ação; oferecer reauth específica sem apagar recursos ainda cobertos por outra concessão válida."
],
"Estados credential health: VALID, EXPIRING, EXPIRED, REVOKED, UNKNOWN e ACTION_REQUIRED com lastVerifiedAt/evidenceSource. API não apresenta Never como data nem prazo calculado sem resposta real.",
[
"Tokens de famílias distintas seguem políticas distintas de validação e renovação.",
"Falha temporária de inspeção produz UNKNOWN/stale e não revogação falsa.",
"Revogação comprovada bloqueia uso e atualiza todas as conexões afetadas.",
"Renovações concorrentes não restauram token antigo nem perdem versão atual.",
"Notificações de reauth são úteis e deduplicadas por autorização/impacto."
],
["Usar relógio injetável para expiração, data access e janelas de check.", "Testar erro de permissão, rede indisponível e revogação real em sandbox.", "Testar substituição de token com jobs antigos em fila e cache ativo."],
"Meta pode invalidar token sem data fixa de expiração; saúde e prazo precisam ser observados separadamente.",
["backend/connect_facebook.php", "backend/connect_instagram.php", "backend/connect_whatsapp.php"], True)

task("M3.10", "Criar auditoria, minimização, retenção e exclusão de dados", "security", "P0", 5, "M3.01 M3.06 M3.07 M1.09",
"Permitir investigação e atendimento de direitos sobre dados sem transformar logs e histórico em cópias irrestritas de segredos ou mensagens.",
[
"Implementar AuditEvent com tenant, ator, ação, alvo interno, antes/depois permitido, requestId/correlationId, origem e data; eventos de cofre registram metadados e nunca valor do token.",
"Definir redaction central por allowlist para authorization headers, códigos OAuth, cookies, app secrets, tokens, mensagens e dados de contato; testar erros de rede e payloads aninhados.",
"Aplicar políticas de retenção por categoria e ambiente, incluindo inbox bruto criptografado, conteúdo de histórico, jobs mortos, backups e logs; expurgo é retomável e auditado.",
"Criar fluxo de exclusão/desconexão com tombstones e seleção de escopo, observando obrigações do produto e callbacks Meta; não apagar ativo externo só porque registro local foi removido.",
"Controlar acesso de suporte a diagnóstico e replay, com roles e auditoria; mascarar dados pessoais em telas e exportações de evidência.",
"Registrar dependências com política de privacidade/contratos e decisão de retenção a validar antes do go-live, sem declarar conformidade legal sem revisão."
],
"Entregas: audit service, retention jobs, data inventory e runbooks de exclusão/incidente. API de diagnóstico usa correlationId e metadados seguros; conteúdo de mensagem só com necessidade autorizada.",
[
"Tokens sintéticos marcadores não aparecem em logs, traces, erros ou auditoria.",
"Expurgo respeita tenant e categoria, não afeta dados de outra empresa e pode retomar.",
"Solicitação de exclusão possui status e evidência sem revelar dados do solicitante.",
"Acesso de suporte e replay são rastreáveis por ator e motivo.",
"Retenção de backup e chaves é compatível com recuperação e política definida."
],
["Testar redação com payload aninhado, headers e stack traces.", "Rodar expurgo em duas empresas com dados fora/dentro da janela.", "Exercitar trilha de conexão, reauth, operação e desconexão ponta a ponta."],
"Minimização e auditoria precisam ser desenhadas juntas: registrar payload completo para facilitar suporte aumenta risco e custo de retenção.",
["backend/meta_auth_helper.php", "src/privacy.html"])

task("M3.11", "Preparar importador de credenciais legadas com dry-run e quarentena", "data", "P0", 8, "M1.02 M3.06 M3.07 M3.08 M3.09",
"Permitir migração controlada das tabelas atuais para o cofre sem assumir que o token global concede acesso a todos os recursos.",
[
"Implementar adaptador somente leitura para o inventário legado sanitizado/ambiente autorizado, com catálogo de bancos permitido e credenciais operacionais fora do código.",
"Converter UserAccessToken/PageAccessToken e valores GeneralSettings apenas com proveniência, tenant/app/environment e evidência de acesso; token root não vira autorização de cliente por cópia.",
"Deduplicar credenciais por referência/fingerprint protegido quando comprovadamente a mesma autorização, sem fundir tokens iguais de contextos indevidos.",
"Validar grants e ativos em lotes com limites, capturando estado UNKNOWN quando não houver prova; colocar colisões, tenant não mapeado e credenciais inválidas em quarentena.",
"Criar dry-run que produz contagens/diffs sem gravar; apply requer lote/version e checkpoint, criptografa no ingresso e mantém mapa de IDs legados para auditoria e rollback.",
"Definir retomada, idempotência e proteção contra importação posterior sobrescrever reauth já concluída no novo sistema. Execução em produção pertence ao M5."
],
"Entregas: import command com --dry-run por padrão, mapping report e checkpoint ledger. Relatórios exibem IDs internos e contagens; nenhum token em CSV, logs ou anexos de issue.",
[
"Dry-run não altera bancos ou autorizações Meta.",
"Reexecutar lote não duplica ativos, autorizações ou credenciais.",
"Registros ambíguos são bloqueados e listados sem reatribuição automática.",
"Credencial nova obtida por reauth não é substituída por dado legado atrasado.",
"Rollback local conhece origem e impactos externos, sem reviver token revogado."
],
["Testar duplicações, Never/NULL, números órfãos e duas empresas no mesmo banco.", "Interromper importação no meio do lote e retomar.", "Comparar paridade por IDs/contagens e validar nenhum segredo nos artifacts."],
"Fonte operacional e DDL real são gates externos. Importar com sucesso não prova capacidade de envio; grants precisam de validação específica.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"], True)

task("M3.12", "Expor catálogo de fluxos, conexões e capabilities sem segredos", "platform", "P1", 5, "M3.06 M3.08 M3.09 M2.04 M1.08",
"Fornecer ao portal dados consistentes e autorizados sobre o que pode conectar e operar, separando saúde observada de promessas de produto.",
[
"Implementar catálogo dos quatro flow variants por app/environment/tenant feature flags, com pré-requisitos e disponibilidade; não mostrar botão operacional para configuração ausente.",
"Criar listagem paginada de conexões/ativos com filtros de canal, número e estado, usando IDs internos; retornar lastVerifiedAt/source/staleness e resumo de permissões.",
"Calcular capabilities por concessão e estado: canSend, canManageTemplates, canSubscribe, canReauthorize e canDisconnect; não derivar tudo de um único connected.",
"Agregar onboarding, token health, estado Meta, subscription e projection em diagnóstico seguro, preservando dimensões e prioridade de próxima ação.",
"Limitar refresh manual com job assíncrono e coalescing de requisições; leitura da lista não dispara dezenas de chamadas Meta a cada render.",
"Aplicar cache/read models com chave completa de tenant/role/asset e invalidação por versão; filtrar campos para viewer e suporte autorizado."
],
"GET /integrations/flows; GET /connections?cursor=; GET /assets/:id; POST /assets/:id/refresh → 202+job. Respostas incluem estado e evidência observada, nunca access_token ou segredo de configuração.",
[
"Viewer vê somente recursos permitidos e não recebe ações administrativas.",
"Estado antigo é identificado como desatualizado sem declarar a conta desconectada falsamente.",
"Catálogo diferencia WhatsApp exclusivo e Coexistence de forma inequívoca.",
"Duas sessões de tenants diferentes nunca compartilham cache de recursos.",
"Lista com muitos ativos usa paginação e não consulta Graph em N+1 por render."
],
["Testar paginação, filtros, cache entre tenants e credencial compartilhada.", "Testar catálogo sem config Meta e estado UNKNOWN/stale.", "Validar schemas públicos e ausencia de campos secretos."],
"Capabilities locais são orientação, não substituem autorização na execução nem estado atualizado do provedor.",
["src/app/core/models/channel.model.ts", "src/app/core/services/meta-integration.service.ts"])
