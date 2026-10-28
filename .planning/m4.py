task("M4.01", "Governar configurações Meta, versões, permissões e App Review", "meta", "P0", 5, "M1.03 M2.10 M3.12",
"Manter cada modalidade executando a configuração correta e impedir mistura de apps, ambientes, versões e permissões.",
[
"Implementar registro servidor de app/config por ambiente e flowVariant: WHATSAPP_CLOUD, WHATSAPP_COEXISTENCE, FACEBOOK e INSTAGRAM com authVariant explícita.",
"Guardar referências seguras de app secret e configuração de token, redirect allowlist, versão Graph/SDK/Embedded Signup e capabilities comprovadas. IDs públicos de configuração não autorizam acesso ao tenant.",
"Validar no startup/admin preflight a presença de configuração e coerência de domínio/callback, expondo somente dados públicos necessários à UI.",
"Manter matriz operação→permission→access level→review status→teste de sandbox→dono de aprovação, incluindo mensagens/comentários, templates e webhooks conforme produto.",
"Documentar modo development/live, empresas de teste, limitações do portfólio dono do app e processo de mudança de config/version com teste canário; não transferir app/portfolio para contornar bloqueio.",
"Preparar evidências e roteiro de App Review, URLs de privacidade/deauthorization/data deletion e demonstrações existentes, separando aprovação externa de implementação concluída."
],
"Entregas: MetaAppConfig registry, capability manifest versionado e runbook de mudanças/aprovação. A UI usa endpoint de bootstrap público seguro; app secret permanece exclusivo do servidor.",
[
"Cada um dos quatro fluxos usa configuração específica e versão verificada.",
"Ausência de aprovação/configuração deixa ação indisponível com motivo seguro.",
"Config de staging não pode autorizar chamadas de produção por engano.",
"Mudança de versão exige evidência e permite rollback de configuração compatível.",
"App Review possui roteiro e evidências por permissão sem afirmar aprovação antes do retorno da Meta."
],
["Testar configs trocadas, redirect não permitido, feature ausente e app inesperado.", "Executar preflight em staging e verificar dados públicos retornados.", "Revisar roteiro com as funções atuais de templates/notificações."],
"Acesso avançado, elegibilidade e revisão pertencem à Meta. Não prometer que código ou novo config_id remove restrições empresariais.",
["backend/meta_auth_helper.php", "src/app/core/services/meta-auth.service.ts", "src/privacy.html"], True)

task("M4.02", "Implementar cliente Graph com timeout, paginação e erros seguros", "meta", "P0", 5, "M4.01 M3.08 M2.05",
"Criar transporte comum confiável para os adaptadores sem repetir logging inseguro ou tratar toda resposta HTTP como sucesso.",
[
"Implementar MetaHttpClient com base URLs/versões por config, TLS verificado, allowlist de hosts e caminhos, timeouts separados e limites de resposta.",
"Enviar tokens em Authorization quando suportado; parâmetros que precisam de segredo são redigidos por allowlist. Sanitizar client_secret, input_token, fb_exchange_token, code, headers e erros aninhados.",
"Normalizar HTTP status, erro Meta code/subcode/type/trace id e outcome; distinguir permissão/revogação, rate limit, transitório, request inválido e resultado ambíguo.",
"Implementar paginação completa com proteção de host/cursor, limite de páginas e checkpoint; não seguir URLs next para host arbitrário nem vazar token de query em logs.",
"Aplicar retry com budget/jitter somente a operações comprovadamente seguras. Envio de mensagem e troca de código de uso único exigem política específica em timeout.",
"Registrar métricas por operação/produto/ambiente sem alta cardinalidade ou token; limitar concorrência e consumo de quota por tenant/app."
],
"Interface de transporte recebe credential handle, endpoint tipado, operation e correlationId; resultado traz data ou erro normalizado com retryable/ambiguous. Não há URL Graph arbitrária fornecida pelo browser.",
[
"HTTP 200 com objeto error não vira sucesso e erro não vaza segredo.",
"Todos os assets de lista paginada são processados com limites controlados.",
"429 respeita orçamento/backoff sem tempestade de retries.",
"POST ambíguo não é reenviado cegamente.",
"Endpoint ou next URL fora de host permitido é recusado antes de transmitir credencial."
],
["Contract tests de respostas reais sanitizadas, 200+error, 400/401/403/429/500 e rede lenta.", "Testar paginação circular, host malicioso e payload grande.", "Testar marcador secreto em todos os caminhos de log/erro."],
"A mesma operação pode ter semântica diferente em cada produto/versão. Política de retry deve ser declarada pelo adaptador, não presumida pelo verbo HTTP.",
["backend/meta_auth_helper.php", "backend/connect_whatsapp.php"])

task("M4.03", "Implementar sessões de onboarding, OAuth state e saga de finalização", "meta", "P0", 8, "M3.04 M3.06 M3.07 M4.01 M4.02 M2.05",
"Correlacionar autorização e ativos à empresa correta e automatizar etapas recuperáveis sem declarar sucesso antes da hora.",
[
"POST cria OnboardingSession ligada a tenant/principal/session/flow/config e prazo; gerar state opaco imprevisível com hash persistido e uso único, sem tenant editável codificado em Base64.",
"Implementar callback OAuth e submissão de código Embedded Signup com validação de state/correlação, sessão/autor vigente, callback allowlist e proteção de replay. Tratar cancel/error antes de reiniciar login.",
"Trocar código no servidor segundo estratégia do fluxo e guardar credencial criptografada; validar app/família/grants via resposta e APIs autorizadas. Não aplicar troca long-lived genérica a todo token.",
"Usar saga com checkpoints de troca, descoberta, persistência, subscription e projeção. Chamadas externas ficam fora de transações DB longas; cada efeito tem idempotência e evidência.",
"Em falha após efeito externo, registrar PARTIAL e retomar somente etapa pendente. Em timeout de troca de código com resultado desconhecido, usar política explícita de recuperação/reautorização sem replay cego.",
"Retornar ID/status seguro para UI e publicar outbox. Conclusão requer invariantes por modalidade; dados de sessão FINISH ou redirect auth_success são sinais, não validação suficiente."
],
"POST /onboarding-sessions → 201 bootstrap; POST /onboarding-sessions/:id/authorization-code → 202 job; GET /onboarding-sessions/:id → estado/ações. Códigos temporários nunca aparecem em URL pública de retorno, logs ou banco em claro persistente.",
[
"Callback de tenant/sessão/flow/config diferente é recusado mesmo com IDs válidos de ativo.",
"Replay e duplo clique não criam duas autorizações nem repetem etapas concluídas.",
"Zero ativos ou subscription falha não resulta em sucesso total.",
"Onboarding parcial pode ser retomado com status e próxima ação claros.",
"Cancelamento retorna ao portal sem loop de login nem exclusão de conexão anterior."
],
["Testar callback duplicado, state expirado/adulterado, erro sem code e múltiplas abas.", "Injetar queda entre cada checkpoint e observar retomada.", "Testar sessão/role revogada durante espera e código trocado por app/config errada."],
"Troca de código é efeito de uso único: perda do retorno pode exigir nova autorização. O sistema deve revelar esse estado, não simular idempotência externa inexistente.",
["backend/meta_auth_helper.php", "backend/connect_facebook.php", "backend/connect_instagram.php", "src/app/features/channels/pages/channel-setup/channel-setup.component.ts"])

task("M4.04", "Implementar WhatsApp Cloud API exclusivo e provisionamento validado", "meta", "P0", 8, "M4.03 M4.11 M3.08 M1.03",
"Concluir o fluxo WhatsApp sem Coexistence, incluindo descoberta, registro quando aplicável e prontidão verificável de cada número.",
[
"Criar adaptador WHATSAPP_CLOUD com Embedded Signup/config validada e experiência de número exclusivo. Informar requisitos e consequências comprovadas antes de iniciar.",
"Receber autorização, validar WABA/conta/número no servidor e percorrer phone_numbers com paginação; confirmar que o token tem acesso aos assets informados pelo fluxo.",
"Selecionar os ativos realmente autorizados e desejados, persistindo relações e origem; não importar todas as contas do portfólio do provedor por token global.",
"Executar registro/2FA PIN somente quando a documentação e estado atual do número exigirem; segredos temporários ficam protegidos e expurgados. Não registrar de novo um número já provisionado.",
"Usar subscription reconciler para o alvo correto e aguardar estados mínimos do ativo; billing/display-name/policy pendentes são condições do provedor, não falha escondida.",
"Confirmar capacidade com testes de envio/recebimento apenas em sandbox autorizado e refletir READY/PARTIAL/ACTION_REQUIRED sem exigir entrada manual de token pelo usuário."
],
"Resultado: autorização/grants, WABA/conta e PHONE_NUMBER verificados, credential handle resolvível, subscription observada e status de prontidão. register convencional é proibido no adaptador Coexistence.",
[
"Número exclusivo conecta integralmente pelo portal sem depender do token root.",
"IDs fornecidos pelo navegador sem grant correspondente são rejeitados.",
"Número já registrado e autorização repetida não geram dupla provisão.",
"Falha de webhook/registro/validação aparece com estado e retomada específicos.",
"Conexões anteriores da empresa permanecem preservadas após adicionar outro número."
],
["E2E sandbox de número novo e número Cloud existente autorizado.", "Testar permissão ausente, conta sem números, registro já realizado e ação externa pendente.", "Enviar/receber mensagem de teste com consentimento, conferindo credential selection e webhook."],
"Regras de registro e PIN dependem da modalidade/versão Meta e precisam de evidência M1.03. Não automatizar exclusão de WhatsApp Business para contornar elegibilidade.",
["backend/connect_whatsapp.php", "src/app/core/services/meta-auth.service.ts"], True)

task("M4.05", "Integrar Embedded Signup Coexistence e correlação segura de código/sessão", "meta", "P0", 8, "M4.03 M3.05 M4.01 M1.03",
"Reproduzir no portal o onboarding de Coexistence validado manualmente pelo usuário, sem depender do builder para obter credenciais.",
[
"Implementar adaptador frontend específico para a versão de SDK/Embedded Signup comprovada, config e featureType de Business App; manter separados do fluxo WhatsApp exclusivo.",
"Iniciar uma sessão de servidor por número e abrir a experiência Meta com gesto do usuário; incluir correlação local segura e dados públicos permitidos, sem app secret.",
"Registrar listeners com origem exata documentada, event.source quando disponível, schema/versão/type/event e limites; cancelar listeners após conclusão/timeout/destroy.",
"Capturar sinais de sessão e código de autorização que podem chegar em ordem diferente; associar à única sessão ativa correta, nunca pelo telefone, WABA ou pendingProduct global.",
"Enviar código ao backend da sessão autenticada para troca imediata; FINISH/QR concluído só altera UI para verificação em andamento até confirmação do servidor.",
"Tratar cancelamento, popup fechado/bloqueado, SDK carregado duas vezes, códigos ausentes, eventos desconhecidos e retorno incompleto. Um novo número inicia novo onboarding sem apagar o anterior."
],
"Contrato SDK é derivado de fixtures reais sanitizadas e matriz M1.03. Evento FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING pode ser observado, mas não se fixa todos os campos como obrigatórios sem validação atual.",
[
"Usuário conclui QR/consentimento no fluxo correto e portal acompanha finalização automática.",
"Mensagem forjada, origem errada ou código de outra sessão não vincula ativo.",
"Eventos antes/depois do código e duas abas não trocam credenciais entre números.",
"Cancelamento e timeout são recuperáveis sem declarar conexão pronta.",
"Quatro números podem passar pelo fluxo individual consecutivamente com histórico separado."
],
["Testes de ordem dos eventos, schema inválido, origem/source e listeners órfãos.", "E2E real em Sandbox separado do proprietário do app com número Business elegível.", "Testar popup/cookie restrito e fallback top-level compatível."],
"Elegibilidade e telas internas Meta podem mudar. A prova do builder demonstra um caso funcional, mas a integração SDK/config vigente precisa ser validada na própria aplicação.",
["src/app/core/services/meta-auth.service.ts", "src/app/features/channels/pages/channel-setup/channel-setup.component.ts"], True)

task("M4.06", "Finalizar Coexistence no servidor e verificar grants, ativos e subscriptions", "meta", "P0", 8, "M4.05 M4.11 M3.06 M3.08",
"Automatizar a parte hoje feita manualmente: trocar código, obter ativos corretos, salvar credenciais e deixar cada número pronto sem cadastro tradicional indevido.",
[
"Implementar estratégia de troca do código Coexistence para a família de Business Integration token comprovada; validar app, grants e metadados reais sem presumir prazo de expiração.",
"Receber IDs como pistas e consultar Graph para comprovar acesso e vínculo entre número e conta. Quando retorno de sessão omitir IDs, descobrir pelo escopo autorizado com paginação e seleção explícita em caso de ambiguidade.",
"Persistir autorização, credencial, assets e relações no tenant do onboarding; vários fluxos podem gerar concessões sobre a mesma conta sem sobrescrever registros anteriores.",
"Acionar assinatura por conta/ativo apropriado via reconciler com token elegível, configurar jobs de sync exigidos e registrar estados parciais por etapa.",
"Proibir chamada de register convencional e operações destrutivas no adaptador; ausência de elegibilidade ou erro de registro/parceiro recebe diagnóstico seguro, nunca exclusão automática de ativos.",
"Concluir READY somente após prova dos pré-requisitos do fluxo; webhook/histórico opcionais têm estados próprios e não exigem que usuário copie token no banco."
],
"Persistência associa PHONE_NUMBER↔conta↔autorização e credential handle; subscribed_apps é acionado no alvo confirmado por versão. Mensagens usam resolver por operação, sem SYSTEM_ROOT_USER_TOKEN.",
[
"Ao concluir, número permanece utilizável no WhatsApp Business conforme requisitos comprovados e tem acesso API validado.",
"Nenhuma execução Coexistence faz POST /phone/register convencional.",
"Código/ID de ativo incompatível com grants não entra no banco como conexão pronta.",
"Retry da etapa de subscription não refaz autorização nem duplica recurso.",
"Quatro números com tokens distintos ou concessões compartilhadas continuam corretamente associados."
],
["Contract test de código trocado, ID ausente, ativo ambíguo e token sem grant.", "E2E Sandbox com envio/recebimento pelo app e API autorizados.", "Spy de transporte garante ausência de register/deregister/delete no caminho Coexistence."],
"WABA, conta de mensagens e WhatsApp account não podem ser tratados como sinônimos sem evidência. Erro Meta isolado não determina causa nem autoriza limpeza de portfólio.",
["backend/connect_whatsapp.php", "backend/meta_auth_helper.php"], True)

task("M4.07", "Processar histórico, estado e echoes de Coexistence sem loops", "meta", "P1", 8, "M4.06 M4.10 M2.05 M3.10",
"Sincronizar os eventos específicos do WhatsApp Business quando suportados e consentidos, com retomada, prazos e deduplicação.",
[
"Implementar parsers versionados para history, smb_app_state_sync, smb_message_echoes e account_update somente após validar schemas/fields na documentação e fixtures atuais.",
"Registrar consentimento e opção de histórico, início/fim/prazo de sync conforme regra comprovada; iniciar jobs prioritários dentro da janela e distinguir histórico recusado, indisponível, parcial e concluído.",
"Processar lotes grandes com checkpoint por tenant/número/stream, ordenação lógica e idempotência; separar horário do evento, importação e estado da mensagem.",
"Normalizar echoes do app e mensagens da API usando IDs de provedor/correlação para evitar duplicar conversa ou disparar automações de resposta em loop.",
"Aplicar minimização e retenção ao histórico, anexos e contatos; não baixar URLs arbitrárias de mídia sem validação de host/tamanho/autorização.",
"Propagar progresso e necessidade de ação ao portal e Msg4, incluindo instruções de manter aplicativo acessível quando exigido pela Meta, sem prometer suporte a clientes/dispositivos não comprovados."
],
"Eventos de sincronização carregam tenant/phone/stream/schemaVersion/cursor/progress/status. Histórico é dimensão separada da conectividade; política de bloqueio de READY depende de requisito Meta comprovado.",
[
"Histórico recusado não gera falha genérica nem sucesso de importação fictício.",
"Reentrega de lote/echo não duplica mensagem nem provoca auto-resposta ao próprio envio.",
"Queda do worker permite retomar com checkpoint sem perder progresso.",
"Prazo de sincronização e estado parcial são visíveis e monitorados.",
"Dados de outra empresa/número não entram no mesmo histórico ou cache."
],
["Testar lotes duplicados, fora de ordem, sem histórico e erro específico Meta sanitizado.", "Simular echo de mensagem enviada pela API e ação manual no app.", "Teste de volume, deadline e interrupção de sync com retenção/expurgo."],
"Janelas, disponibilidade e campos de Coexistence mudam. Não codificar prazo de 24h ou catálogo de eventos como fato sem validação primária atual.",
[".github/docs/agent-context/meta-integrations.md", "backend/connect_whatsapp.php"], True)

task("M4.08", "Implementar Facebook independente com Pages, tokens e subscriptions", "meta", "P1", 8, "M4.03 M4.11 M3.08 M4.01",
"Preservar conexão de Facebook Pages sem exigir WhatsApp/Instagram e sem sucesso falso quando nenhuma página operacional foi autorizada.",
[
"Implementar estratégia Facebook Login for Business confirmada com scopes mínimos para operações aprovadas; configurar callback independente e tratar cancel/error antes de criar novo login.",
"Trocar/inspecionar token conforme família e descobrir Pages autorizadas com paginação e permissões/tarefas reais; não depender apenas da existência de target_ids em debug_token.",
"Derivar Page tokens por fluxo suportado, persistir no cofre e associar a Page/autorização; registrar validade observada sem usar literal Never como garantia.",
"Permitir selecionar/persistir recursos desejados e verificar grants de cada Page; login repetido atualiza concessões sem apagar configurações de mensagens.",
"Reconciliar subscriptions de mensagens/comentários/campos suportados usando credencial adequada; nomes de campos vêm da matriz validada, não são copiados sem revisão do PHP.",
"Expor capabilities de leitura/resposta/mensagem por Page e definir resultados de zero ativos, permissão parcial, papel insuficiente, token revogado e action_required."
],
"Flow FACEBOOK produz PAGE assets, Page credential grants e subscription state; não adiciona Instagram ou WhatsApp implicitamente. Operações de mensagens/comentários respeitam políticas e permissões comprovadas.",
[
"Facebook conecta sem scopes de WhatsApp/Instagram desnecessários.",
"Zero Pages elegíveis gera estado informativo recuperável, sem auth_success fictício.",
"Page token correto é resolvido para cada recurso e tenant.",
"Subscription falha deixa conexão parcial até reconciliação.",
"Templates e números de WhatsApp de outras conexões não são alterados."
],
["E2E Sandbox com uma/múltiplas Pages, seleção parcial e página sem tarefa necessária.", "Testar grants ausentes no debug e descoberta paginada autorizada.", "Validar webhook e resposta de comentário/mensagem com conta de teste consentida."],
"A documentação/conta Meta pode restringir operações por política ou App Review; capabilities devem refletir prova de acesso, não somente scope solicitado.",
["backend/connect_facebook.php", "src/app/core/services/meta-auth.service.ts"], True)

task("M4.09", "Implementar Instagram independente com variante de login explícita", "meta", "P1", 8, "M4.03 M4.11 M3.08 M4.01 M1.03",
"Conectar Instagram com a estratégia realmente suportada pelo aplicativo e preservar as diferenças de permissões, tokens e vínculos de cada variante.",
[
"Registrar ADR de authVariant: baseline usa Instagram via Facebook Login e descoberta de instagram_business_account. Preservar esse caminho no primeiro release salvo decisão comprovada de adotar Instagram Login.",
"Se Instagram Login for adotado, implementar endpoints/scopes/troca/refresh próprios em adaptador isolado; não misturar instagram_basic com permissões instagram_business_* nem exigir Page onde a variante não pede.",
"Descobrir contas profissionais autorizadas com paginação e confirmação servidor; persistir INSTAGRAM_ACCOUNT, relacionamento Page quando aplicável e concessões de credencial específicas.",
"Reconciliar assinatura no alvo/campos corretos para a variante e comprovar recebimento de mensagens/comentários com fixtures e Sandbox; ausência dessa etapa no PHP atual não deve ser preservada como arquitetura.",
"Normalizar capabilities e limitações de resposta por operação/política, estado da conta e review; retornar zero contas, conta não elegível e permissão parcial como estados acionáveis.",
"Reautorização de Instagram não deve trocar credencial de Facebook de outra autorização nem criar Page duplicada de produto quando vínculo é apenas técnico."
],
"Flow INSTAGRAM inclui authVariant em autorização/configuração; token resolver e subscriptions consultam essa variante. Instagram Login adicional é opção técnica sujeita a ADR, não quinto fluxo obrigatório disfarçado.",
[
"Uma variante de produção é validada ponta a ponta, com critérios documentados para a outra.",
"Tokens/scopes/endpoints de variantes diferentes nunca são intercambiados.",
"Instagram via Facebook mantém vínculo correto com Page; variante direta não recebe dependência fictícia.",
"Zero contas ou webhook ausente não vira conexão pronta.",
"Mensagens/comentários de teste usam conta e credencial corretas sem afetar Facebook/WhatsApp existentes."
],
["Contract tests por variante habilitada e rejeição de configuração incompatível.", "E2E de conta profissional, permissões parciais e token expirado/revogado.", "Validar webhook e ação de resposta com permissões aprovadas no ambiente de teste."],
"A escolha do login Instagram altera APIs e permissões; precisa de evidência M1.03. Não migrar silenciosamente para a variante nova por conveniência de framework.",
["backend/connect_instagram.php", "src/app/core/services/meta-auth.service.ts"], True)

task("M4.10", "Receber webhooks com assinatura, inbox durável e roteamento empresarial", "meta", "P0", 8, "M2.05 M3.06 M3.10 M4.01 M4.02",
"Receber eventos dos quatro fluxos com integridade e isolamento, tolerando duplicatas, eventos fora de ordem e interrupções do processamento.",
[
"Implementar verificação GET de challenge com verify token protegido e comparação segura, sem confundir esse segredo com o access token de operação.",
"Capturar bytes brutos do POST e validar X-Hub-Signature-256 com app secret da configuração correta antes de parsear/confiar no evento. Tratar limites de tamanho e conteúdo inválido.",
"Validar envelope, entry/change/item individual e router por app/environment/asset confirmado; um payload pode conter múltiplas empresas e cada item precisa de resolução própria.",
"Persistir inbox durável e ACK rápido após commit, deixando processamento de negócio em worker. Falha de persistência não confirma sucesso para perder evento.",
"Deduplicar pela identidade real do evento/objeto/estado, com fallback de hash canônico de item quando necessário; nunca deduplicar toda mudança apenas por timestamp ou message id ignorando atualizações de status.",
"Quarentenar ativo desconhecido/conflitante, permitir reconciliação pós-onboarding e replay auditado; não confiar em tenant_id do payload nem encaminhar evento por telefone textual."
],
"Rota pública por app/config ou router equivalente com configuração inequívoca. Inbox inclui assinatura verificada, schemaVersion, eventKey, providerTimestamp, receivedAt, asset mapping e processamento por item.",
[
"Payload adulterado, assinatura ausente/inválida e configuração errada não são processados.",
"ACK depende de persistência durável e respeita orçamento validado com o provedor.",
"Duplicatas/out-of-order não repetem efeitos nem fazem status regredir.",
"Ativo ambíguo não vaza evento para tenant escolhido por tentativa.",
"Evento recebido antes de concluir onboarding pode ser reprocessado após mapear ativo."
],
["Testar assinatura sobre raw body, JSON com whitespace, payload grande e secret version rotation.", "Testar múltiplos entries/changes/statuses e ativos desconhecidos.", "Injetar indisponibilidade de DB/fila/worker e confirmar reentrega/replay corretos."],
"Assinatura prova origem no app, não o tenant. O mapa local verificado do recurso define a empresa e deve impedir fanout acidental.",
[".github/docs/agent-context/security.md", "backend/connect_whatsapp.php"], True)

task("M4.11", "Reconciliar subscribed_apps e inscrições por ativo de forma idempotente", "meta", "P0", 8, "M3.06 M3.08 M4.02 M2.05",
"Automatizar inscrições e reparos sem usar token global, duplicar efeitos ou remover subscriptions ainda necessárias a outros recursos.",
[
"Separar configuração app-level de webhook/campos das inscrições asset-level. Definir alvo por produto/variante/versão, por exemplo conta WhatsApp confirmada e Page/IG conforme estratégia.",
"Criar desired state e observed state para cada app+ambiente+alvo/campos com credential resolver, lastAttempt/lastVerified/error/retry e ownership/refcount das conexões dependentes.",
"Consultar estado atual quando suportado, calcular delta e aplicar assinatura idempotente; validar resposta e fazer read-after-write/recebimento de evento conforme prova disponível.",
"Em falha de permissão ou timeout, manter PARTIAL e agendar reconciliação com backoff; uma exceção capturada não pode ser descartada seguida de sucesso global.",
"Proteger com lock/version por alvo para quatro números na mesma conta não competirem; atualizar fields suportados sem apagar inscrições necessárias a outra modalidade/autorização.",
"Na desconexão remover somente vínculo local e inscrição externa que não tem outro consumidor autorizado; se não houver permissão de offboard, sinalizar ação manual com evidência."
],
"SubscriptionTarget representa estado físico por app/ambiente/alvo; SubscriptionBinding guarda necessidade por tenant/conexão, desiredFields e grant. Coordenador e lock consideram todas as dependências antes de remover efeito externo; portal acessa somente seus bindings. O plano não presume que todo produto usa o mesmo subscribed_apps.",
[
"Toda inscrição usa credencial elegível do contexto correto.",
"Retry e onboards concorrentes não duplicam registros/efeitos.",
"Falha em subscription impede estado de prontidão falso e fica recuperável.",
"Desconectar um número não remove webhook de outros números da mesma conta.",
"Drift de configuração pode ser detectado e reparado com histórico auditado."
],
["Testar já inscrito, campo divergente, grant ausente, 429 e timeout ambíguo.", "Concorrência de quatro números na mesma WABA/conta e disconnect de apenas um.", "E2E valida evento real de sandbox após assinatura com token correto."],
"subscription é um efeito externo e não participa da transação do banco. Compensação precisa considerar consumidores compartilhados e acesso real.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php", "backend/connect_instagram.php"], True)

task("M4.12", "Sincronizar ativos, permissões e status observados com controle de drift", "meta", "P1", 5, "M4.04 M4.06 M4.08 M4.09 M4.10 M3.12",
"Manter o portal fiel ao que a Meta permite e informa, sem depender somente do estado capturado no login.",
[
"Criar jobs de reconciliação por ativo/autorização com seleção de campos suportados e budget; consultas de status variam entre número, conta, Page e Instagram.",
"Guardar snapshot permitido, normalized state, source API/webhook, fetchedAt e schema/version, distinguindo dado indisponível de estado negativo.",
"Aplicar eventos incrementais e reconciliação periódica com precedência/versionamento para não regredir por evento atrasado; unknown enum é preservado e sinalizado.",
"Detectar perda de permissão, número removido, mudança de nome/quality, subscription drift e projeção atrasada com notificações deduplicadas e próxima ação.",
"Implementar refresh manual assíncrono coalescido com rate limits; não realizar polling de Graph por cada render do dashboard.",
"Registrar discrepância entre esperado/observado e expor diagnóstico seguro ao suporte; não restaurar conexão revogada por causa de snapshot antigo."
],
"Read model informa status por dimensão, lastVerifiedAt, evidenceSource, staleAfter, actionableReason e safe providerCode. Campos billing/quality só aparecem quando disponíveis e autorizados para o ativo.",
[
"Falha de rede produz estado desatualizado/UNKNOWN sem transformar conexão válida em removida.",
"Mudanças reais Meta são refletidas em prazo mensurado do SLO.",
"Atualização atrasada não reativa credencial ou ativo revogado.",
"Refresh repetido respeita budget e não gera N jobs equivalentes.",
"Quatro tipos de recursos exibem informações adequadas, sem campos fictícios compartilhados."
],
["Testar snapshots/eventos fora de ordem e enum novo.", "Testar rate limit, missing fields e autorização parcial.", "Validar SLO de atualização em sandbox com mudança controlada de status/permissão."],
"Nem todo status da interface Meta está disponível por API. Marcar não disponível e orientar ação, sem inventar equivalência.",
["src/app/core/models/channel.model.ts", "backend/connect_whatsapp.php"], True)

task("M4.13", "Implementar reautorização, desconexão e callbacks de revogação/exclusão", "meta", "P0", 8, "M4.10 M4.11 M4.12 M3.09 M3.10",
"Completar o ciclo de vida sem apagar números ou permissões de outras conexões quando um usuário remove somente um vínculo.",
[
"Definir disconnect local, revogar autorização, cancelar subscription e excluir ativo externo como operações diferentes com escopo, permissão e consequências específicas.",
"Implementar desconexão/reautorização por recurso ou grant, preservando outras concessões elegíveis e subscription compartilhada; verificar refcount/ownership antes de remover efeito externo.",
"Revogar acesso local imediatamente, invalidar cache e bloquear novos jobs; tratar trabalhos em curso com política explícita e registrar cleanup externo pendente.",
"Receber deauthorization/data deletion conforme mecanismo assinado documentado da Meta, validar autenticidade/replay e mapear usuário/autorização/ativos afetados com escopo correto.",
"Implementar tombstones, confirmação/progresso de exclusão e retenção mínima exigida, sem restaurar credenciais revogadas durante rollback/importação.",
"Para Coexistence, usar procedimento de offboarding comprovado, preservando uso do app conforme regras; não invocar deregister/delete tradicional como compensação automática."
],
"DELETE /connections/:id ou comando assíncrono explicitamente tipado; POST /connections/:id/reauthorizations cria nova sessão e associa histórico. Endpoints Meta de exclusão/revogação são públicos apenas com validação específica.",
[
"Remover uma conexão não derruba outras Pages/números da mesma autorização sem necessidade comprovada.",
"Tokens revogados deixam de ser escolhidos pelo resolver e caches.",
"Callback forjado não apaga dados e evento duplicado não repete cleanup.",
"Cleanup externo falho permanece visível/reprocessável, sem declarar desconexão externa confirmada.",
"Operação destrutiva externa não acontece implicitamente na exclusão local."
],
["Testar grant compartilhado, número único em conta compartilhada e quatro números.", "Validar callbacks assinados, duplicados, inválidos e sem mapeamento.", "E2E sandbox de offboarding Coexistence e reauth mantendo configurações anteriores."],
"Revogação Meta pode afetar vários ativos da mesma autorização. A interface deve explicar impacto real antes da ação e suporte precisa de trilha de auditoria.",
["src/privacy.html", "backend/connect_whatsapp.php", "backend/connect_facebook.php"], True)

task("M4.14", "Certificar a matriz dos quatro fluxos e cenários adversos", "quality", "P0", 8, "M4.04 M4.06 M4.07 M4.08 M4.09 M4.10 M4.11 M4.12 M4.13",
"Demonstrar equivalência e robustez de cada adaptador antes de expor o portal completo a clientes.",
[
"Criar suíte de contract/integration com fixtures primárias sanitizadas por versão e casos aprovados, rejeitados, parciais, cancelados, expirados e sem ativos.",
"Executar quatro números Coexistence na mesma empresa, com uma/duas contas e tokens/concessões diferentes; testar dois tenants incluindo duas empresas na mesma base legada.",
"Cobrir callback duplicado, código trocado, state de outra aba, eventos antes do token, permission denied, app/config errada e token revogado durante provisioning.",
"Injetar indisponibilidade de Meta/DB/fila, HTTP 429, timeout ambíguo, falha de subscription e crash de worker, verificando PARTIAL, retries e compensações seguras.",
"Provar associação de envio/template/status/subscription ao grant correto com spy de transporte e, depois, testes reais consentidos em Sandbox para cada produto.",
"Produzir evidence pack com versões, recursos de teste identificados de modo seguro, comandos, resultados, URLs de run, limitações e pendências externas; mocks não contam como aprovação da Meta."
],
"Matriz mínima: 4 fluxos × sucesso/cancel/permissão parcial/replay/timeout/reauth/disconnect; cenários adicionais de Coexistence história/echo/4 números e de Facebook/IG paginação/variante. Testes reais não rodam automaticamente em produção.",
[
"Todos os critérios obrigatórios têm evidência de teste e nenhum P0 aberto de isolamento/credencial.",
"Coexistence não chama register/deregister/delete tradicional em nenhum teste.",
"Falhas não geram sucesso falso nem perdem autorização persistida.",
"Suíte identifica token selecionado por handle sintético sem expor segredo.",
"Fluxo dependente de App Review/eligibilidade não comprovada permanece bloqueado para release."
],
["Executar contrato/unidade/integração em CI e E2E sandbox com operador autorizado.", "Revisar coverage por risco e requisito, não só porcentagem de linhas.", "Repetir somente cenários afetados por correções e manter versão de evidência."],
"A comprovação manual prévia cobre um número Coexistence e não certifica quatro fluxos, multiempresa ou operação contínua. Gate exige evidência ampliada.",
[".github/docs/agent-context/testing-and-validation.md", "backend/connect_whatsapp.php"], True)
