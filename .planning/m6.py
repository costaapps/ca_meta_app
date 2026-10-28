task("M6.01", "Homologar jornadas completas, paridade e acessibilidade", "quality", "P0", 8, "M4.14 M5.01 M5.02 M5.03 M5.04 M5.05 M5.06 M5.07 M5.09",
"Certificar o produto completo na experiência do usuário e nos consumidores reais antes de liberar produção.",
[
"Criar matriz de homologação requisito→issue→spec→cenário→evidência para entrada Suite4/magic link, quatro fluxos, gerenciamento e operação Msg4.",
"Executar E2E em navegadores suportados, mobile relevante, standalone e embed, com popup/cookies restritos, expiração, refresh e múltiplas abas.",
"Validar quatro números Coexistence, diferentes autorizações e contas, além de WhatsApp exclusivo, Facebook e Instagram na variante aprovada.",
"Demonstrar paridade de templates, respostas e notificações, incluindo falhas corrigidas: SEND_MESSAGE incompleto, sucesso sem ativo, erro Meta e leitura indevida após ação falha.",
"Testar teclado/foco/leitor de tela, contraste e estados loading/partial/stale/action_required; anexar evidências redigidas com versões e resultados.",
"Executar smoke de consumidor Suite4/Msg4 de teste e coletar aceite por função de produto/operação. Bloqueios de App Review ou elegibilidade permanecem explícitos, não são marcados aprovados por mocks."
],
"Entregas: acceptance-report.md, resultados automatizados, checklist de paridade e evidência de sandbox por fluxo. Homologação utiliza release candidate por digest, não build local diferente.",
[
"Cenários obrigatórios dos quatro fluxos e funções legadas passam na release candidata.",
"Nenhum P0 ou P1 funcional/de segurança sem resolução ou decisão formal de escopo impeditiva.",
"Acessibilidade de jornadas críticas está verificada e pendências têm tratamento.",
"Mesma release é reproduzida por outro operador seguindo documentação.",
"Toda limitação externa fica registrada com condição para liberar a modalidade afetada."
],
["Executar suíte E2E/integração/consumer contract em staging com fixtures e contas autorizadas.", "Revisão manual de UX e acessibilidade em estados que dependem da UI Meta.", "Conferir rastreabilidade do teste ao digest/commit e remover segredos das capturas."],
"Teste de mocks não certifica plataforma Meta nem o ambiente Suite4 real. Exigir evidências separadas de integração externa e comportamento local.",
[".github/docs/agent-context/testing-and-validation.md"], True)

task("M6.02", "Auditar isolamento, OAuth, cofre e superfícies privilegiadas", "security", "P0", 8, "M3.01 M3.02 M3.03 M3.04 M3.05 M3.07 M3.08 M4.13 M5.07 M5.10",
"Provar que reconstrução não conserva acesso por UUID, token global ou bypass operacional e que novos endpoints não ampliam a exposição.",
[
"Revisar threat model e testar BOLA/IDOR em todos os endpoints de leitura, mutação, jobs, notificações, templates, importação e suporte.",
"Testar state/ticket/code replay, login CSRF, cookie/session fixation, CORS/Origin, iframe/source, redirect allowlist e troca de empresa/aba concorrente.",
"Auditar cofre, versões/chaves/backup, redação, criptografia autenticada, cache/revogação e ausência de token em bundle, logs, traces e artifacts.",
"Verificar assinatura raw-body de webhook, parser/limites, roteamento por item, unknown assets, SSRF em paginação/mídia e replay/duplicatas.",
"Revisar workflows/imagens/runtime: ações fixadas, escopos mínimos, secrets de ambiente, non-root, portas, dependências vulneráveis e acesso S2S.",
"Executar teste independente quando disponível, classificar achados por risco e ligar correção/reteste à release candidata. Nenhuma aprovação verbal substitui evidência de fechamento."
],
"Entregas: security-assessment.md com método, escopo, fixtures, achados, correções/retestes e riscos residuais. Não executar testes ofensivos contra ativos de terceiros ou produção sem autorização de escopo.",
[
"Zero acesso cruzado entre tenants em todos os cenários de autorização.",
"Zero token/segredo sintético marcador em superfícies públicas e artifacts.",
"Replay e origem inválida não criam sessão, vínculo ou exclusão.",
"Achados críticos/altos corrigidos e retestados antes da promoção.",
"Riscos residuais têm dono, compensação e prazo, sem waiver genérico de segurança."
],
["Suíte adversarial autorizada em staging e análise estática/dinâmica pertinente.", "Testes concorrentes multiempresa e grants conflitantes com dois processos.", "Revisão independente de configuração CI/edge/cofre e pacote de evidências redigido."],
"Mudar linguagem não corrige autorização por si só. Gate verifica invariantes reais, inclusive rotas administrativas e jobs, não só login.",
[".github/docs/agent-context/security.md", "backend/meta_auth_helper.php"], True)

task("M6.03", "Validar carga, quotas, falhas e recuperação de processamento", "quality", "P0", 8, "M2.05 M4.10 M4.11 M4.12 M5.08 M1.09",
"Demonstrar capacidade e resiliência com volume e falhas representativos, sem consumir quotas reais de clientes para simular carga.",
[
"Transformar cenários nominal/pico/crescimento em carga sintética de API/webhook/history/projeção com distribuição por tenant/ativo e payloads representativos.",
"Medir p50/p95/p99 de API/ACK, fila, throughput, DB/CPU/memória, pool e lag de projeção. Propostas iniciais de ACK <1s p95 e <3s p99 devem ser validadas contra requisitos Meta.",
"Misturar histórico grande com mensagens urgentes e quatro onboards concorrentes; avaliar fairness e limites por tenant/ativo/app.",
"Injetar Meta 429/5xx/timeout, banco/fila offline, destino empresarial indisponível e morte/restart de worker no meio do efeito.",
"Provar backpressure, dead-letter, circuit/budget de retry, retenção de inbox e retomada com leases/checkpoints; medir backlog drain após recuperação.",
"Publicar envelope de capacidade e recursos mínimos reais, limites, gargalos e gatilhos de escala. Volumes não conhecidos do negócio continuam hipóteses até confirmados."
],
"Entregas: load scenarios, results e capacity envelope por configuração/digest. Carga Meta é em stub fiel/sandbox limitado e autorizado; testes de escala não enviam mensagens a clientes.",
[
"SLOs ratificados são atingidos no perfil de carga definido e reproduzível.",
"Queda e redelivery não perdem evento confirmado nem duplicam efeito local.",
"Um tenant ruidoso ou banco empresarial offline não paralisa os demais.",
"Backlog recupera dentro do objetivo de RTO/processamento e não causa retry storm.",
"Limites e número de workers/pools recomendados são sustentados por medições."
],
["Rodar carga em staging isolado e comparar com metas propostas.", "Fault injection entre persistência/ACK/efeito/checkpoint em workers.", "Reexecutar somente cenários afetados por tuning e guardar run/configuração."],
"Exactly-once externo e escala ilimitada não são objetivos honestos. Precisamos de limites medidos e tratamento de resultado ambíguo.",
[".github/docs/agent-context/roadmap.md"], True)

task("M6.04", "Implantar observabilidade, alertas e diagnóstico com SLOs", "operations", "P0", 5, "M2.02 M2.05 M3.10 M4.12 M5.08 M1.09",
"Detectar falhas de autenticação, onboarding, credenciais, webhooks e projeções antes que o usuário precise editar o banco ou abrir chamado sem contexto.",
[
"Instrumentar logs estruturados e traces com requestId/correlationId/onboardingId/jobId/asset internal ID, com redaction e acesso/retensão conforme política.",
"Criar métricas por produto/ambiente/resultado: sucesso e duração de onboarding, exchange failure, credential health, subscription drift, webhook ACK/dedupe/unknown, fila/dead-letter e projection lag.",
"Controlar cardinalidade e dados pessoais: IDs externos/telefones não viram labels de métricas irrestritas; links de drilldown ficam em diagnóstico autorizado.",
"Criar dashboards de serviço, quatro fluxos e migração com lastVerifiedAt e ingestão; health de processo não é indicador suficiente de operação Meta.",
"Definir alertas acionáveis com limiar/janela/dono/runbook: assinaturas falhas, fila parada, token revogado, ausência inesperada de eventos e projeção atrasada.",
"Testar alertas e correlação ponta a ponta com incidente sintético; definir roteamento de incidentes e silenciamento com prazo. Configuração de envio depende dos canais operacionais autorizados."
],
"Entregas: dashboards/alert rules versionados, catálogo de sinais e runbooks por classe de falha. Metas iniciais propostas incluem disponibilidade 99,9% e processamento/projeção em janelas ratificadas após benchmark.",
[
"Uma falha de cada etapa pode ser localizada por correlationId sem token/payload sensível.",
"Alertas geram ação concreta e são ensaiados em staging.",
"SLO define numerador, denominador, janela e exclusões justificadas.",
"Monitoramento distingue falha Meta, falha interna e ausência de atividade esperada.",
"Regras e dashboards acompanham a release e possuem responsável funcional."
],
["Injetar falhas de token/subscription/worker/projeção e verificar alerta/runbook.", "Conferir cardinalidade, volume e ausência de segredos nas exportações.", "Validar tracing de callback→job→Meta→outbox→banco empresarial."],
"Ausência de webhook pode ser silêncio legítimo do canal. Alertas de ausência precisam de baseline/contexto ou canário autorizado, não limiar cego.",
["backend/meta_auth_helper.php", ".github/docs/agent-context/roadmap.md"], True)

task("M6.05", "Provar backup, restauração e recuperação de chaves e filas", "operations", "P0", 8, "M2.03 M2.07 M3.07 M3.10 M5.08 M1.09",
"Garantir que banco, cofre, jobs e projeções possam voltar a operar dentro de RPO/RTO definidos.",
[
"Definir backups criptografados do central e inventário de projeções, PITR/binlog quando adotado, destino, retenção, integridade e separação de acesso.",
"Guardar plano de recuperação de chaves/versões fora do banco com controle operacional; backup sem chave acessível de forma autorizada não é considerado restaurável.",
"Restaurar em ambiente isolado por digest/schema compatível e testar descriptografia de credenciais sintéticas, sessão invalidada e jobs/inbox/outbox/checkpoints.",
"Reconstruir projeções empresariais a partir do central ou aplicar plano específico de backup quando houver dados exclusivos; medir backlog e reconciliação pós-restore.",
"Tratar efeitos Meta externos após restore: tokens revogados continuam revogados, subscriptions e mensagens já enviadas não são revertidas. Bloquear replay perigoso de envio ambíguo.",
"Documentar cenários de perda de host, DB corrompido, chave indisponível/comprometida e falha de operador; ensaiar runbook com outra pessoa de operação."
],
"Entregas: backup/restore runbooks, inventário de chaves sem valores, evidência de restore e RPO/RTO medidos. Propostas iniciais RPO 15min/RTO 60min dependem da infraestrutura e benchmark reais.",
[
"Restore completo funciona em ambiente limpo com aplicação e chaves autorizadas.",
"RPO/RTO ratificados são medidos, não apenas declarados.",
"Reprocessamento pós-restore não duplica mensagens nem reativa autorização revogada.",
"Volumes e backups têm retenção/expurgo coerentes com política de dados.",
"Operador independente executa runbook e registra resultado e limitações."
],
["Restore de backup amostrado com validação de integridade e cofre.", "Testar chave antiga após rotação e chave temporariamente indisponível.", "Simular outbox/inbox parcialmente processadas e reconciliar sem reenvio externo cego."],
"Backup de Docker volume sem consistência do banco pode falhar silenciosamente. Usar método adequado e comprovar restauração, não somente existência de arquivo.",
[".github/docs/agent-context/git-workflow.md"], True)

task("M6.06", "Preparar produção, release candidata e gates de promoção", "delivery", "P0", 5, "M2.09 M2.10 M6.01 M6.02 M6.03 M6.04 M6.05",
"Dispor de release publicável e operação reproduzível antes de tocar o roteamento do legado em produção.",
[
"Confirmar infraestrutura alvo, DNS/TLS, rede, volumes/DB/fila, capacidade, secrets, backups e contas de serviço com acessos mínimos e donos funcionais.",
"Publicar imagens web/api da release candidata no Docker Hub autorizado, obter digests, SBOM/proveniência e manifest; worker usa o digest de API homologado.",
"Verificar compatibilidade de schema N/N-1 e dry-run/preflight de migrations; preparar backup e plano de abortar antes de expand/backfill.",
"Configurar ambientes GitHub de staging/produção e gates necessários por política confirmada, sem supor que workflow versionado já protege deploy.",
"Disponibilizar callbacks/webhook/privacidade/revogação/exclusão em produção e validar configurações Meta por variante, preservando rotas do legado durante transição.",
"Reunir evidence pack e go/no-go com produto, segurança e operação: testes, permissões/eligibilidade, capacidade, restore, rollback, suporte e riscos abertos."
],
"Release manifest imutável liga commit/contrato/schema/digests/config version e evidências. Preparar produção não ativa automaticamente novos tenants nem desliga Hostinger.",
[
"Mesmos digests homologados são instaláveis em produção com configuração externa correta.",
"Todos os gates P0 estão comprovados e pendências externas por fluxo são resolvidas ou bloqueiam sua ativação.",
"Migration/health preflight impedem versão incompatível.",
"Manifest anterior e backup estão disponíveis para rollback.",
"Promoção e configuração real possuem trilha de auditoria e responsável de operação."
],
["Smoke de instalação, TLS/headers/callback/webhook e secrets sem exposição.", "Verificar manifest/digests e checks de CI/release associados.", "Ensaio final de migration expand e rollback de app em staging equivalente."],
"Publicação de imagem e ativação de produção são ações distintas. A autorização de planejamento atual não significa go-live antecipado.",
[".github/docs/agent-context/git-workflow.md", "src/environments/environment.prod.ts"], True)

task("M6.07", "Concluir aceite externo, App Review e preparação de operação", "operations", "P0", 5, "M4.01 M6.01 M6.02 M6.06",
"Fechar dependências que não podem ser provadas só com código: plataforma Meta, contrato Suite4 e uso por pessoas autorizadas.",
[
"Confirmar aprovação de permissões/access levels necessários para cada modalidade e registrar evidência/versionamento, sem anexar dados sensíveis do painel.",
"Executar roteiro de App Review/demonstração quando exigido e manter funcionalidade de teste segura; permissões não utilizadas não são pedidas por conveniência.",
"Obter aceite do contrato Suite4 de identidade, membership, embed, rotação/revogação e operação de consumidores Msg4 com cenário real de teste.",
"Validar termos de produto, política de dados/retensão, consentimento de histórico e descrição de limitações Meta com responsável apropriado antes do go-live.",
"Treinar operação/suporte com runbooks de reauth, número inelegível, erro de parceiro/registro, assinatura, histórico e projeção; indicar quais ações exigem cliente ou Meta.",
"Definir comunicação de rollout, canais de suporte, horário de corte e responsáveis de plantão sem enviar avisos ou convites nesta etapa de planejamento."
],
"Entregas: readiness checklist externo por fluxo, evidências de permissão/aceite e matriz de operação. Não registrar aprovado apenas porque app está em live ou funcionou com administrador/tester.",
[
"Cada fluxo ativável tem as permissões e elegibilidade necessárias comprovadas para clientes reais.",
"Contrato Suite4/Msg4 foi executado com identidade e empresa reais de teste.",
"Suporte sabe diferenciar ação interna, reauth do cliente e bloqueio Meta.",
"Políticas de histórico/dados e limites do produto estão definidos antes do uso real.",
"Há responsáveis funcionais e evidências suficientes para decisão de go/no-go."
],
["Walkthrough de usuário não administrador/tester no cenário permitido pela Meta.", "Simular chamado com diagnostic bundle redigido e seguir runbook.", "Revisar checklist externo contra permissões realmente usadas por operações."],
"App Review pode demandar prazo externo imprevisível. Planejar gate e evidência, sem atribuir data fictícia ou burlar teste com ativos do provedor.",
["src/privacy.html", ".github/docs/agent-context/open-questions.md"], True)

task("M6.08", "Executar canário por empresa/canal e comprovar rollback", "delivery", "P0", 8, "M5.09 M6.06 M6.07",
"Promover o produto progressivamente, preservando conexões atuais e abortando rapidamente em falhas de credencial, isolamento ou entrega.",
[
"Congelar manifest/config de corte, backup, escritor por campo e flags por tenant+canal+consumidor. Selecionar coortes progressivas e condições de observação definidas no rollout plan.",
"Ativar coorte inicial e acompanhar onboarding, envio/retorno, tokens, subscriptions, fila/projeção, erros e métricas de paridade; não usar porcentagem de tráfego aleatória que mistura estados do mesmo ativo.",
"Adotar bloqueio imediato em incidente de isolamento/segredo/double-send; para latência/backlog/erro usar limiares ratificados, por exemplo violação persistente de SLO, com janela e dono definidos.",
"Ampliar somente após evidência da coorte, registrando tenants/ativos/version; manter legado para não migrados e um escritor por função em cada contexto.",
"Executar rollback de roteamento/flag para release compatível, preservar alterações válidas e reconciliar grants/subscriptions externos. Nunca reusar token comprometido como caminho de retorno.",
"Verificar sucesso do rollback por operação e recurso, não só containers healthy; reconciliar inbox/outbox e projeções antes de nova tentativa de avanço."
],
"Entregas: rollout ledger, flags/writer matrix, canary metrics, registro de abort/rollback e decisão de ampliação por coorte. Percentuais/datas só após capacidade e recursos elegíveis confirmados.",
[
"Canário observa todos os quatro fluxos habilitados e quatro números Coexistence sem troca de credencial.",
"Rollback demonstrado restaura operação dentro do objetivo definido e não perde mudanças ou eventos confirmados.",
"Nenhum double-send ou cross-tenant ocorre; esses incidentes impedem avanço.",
"Empresas não migradas continuam operando pelo legado.",
"Promoção total possui ledger e evidências por coorte, sem estado desconhecido de escritor."
],
["Ensaio de canário e rollback em staging antes da janela real.", "Smoke consentido por canal/ativo na coorte e reconciliação de eventos.", "Injetar flag de falha e verificar alarme, parada e recuperação sem reenvio ambíguo."],
"Banco restaurado não desfaz mensagens já enviadas nem revoke/subscribe da Meta. Rollback precisa ser por comportamento e reconciliação, não comando único de Docker.",
[".github/docs/agent-context/git-workflow.md"], True)

task("M6.09", "Estabilizar produção, documentar suporte e medir operação contínua", "operations", "P1", 5, "M6.08 M6.04 M5.10",
"Consolidar operação confiável depois do corte e evitar desativar o legado antes de observar renovação, reauth e rotinas periódicas.",
[
"Definir hypercare com janela mínima proposta de sete dias e cobertura de rotinas relevantes; ampliar quando validade/cron/volume exigir observação maior.",
"Acompanhar SLOs, alertas, dead-letter, grants/token health, subscription drift, projecões e erros de usuário por fluxo/coorte, registrando causas e correções.",
"Validar on-call, acesso de suporte, restore, rotação e reauth; incidentes seguem runbooks e não são resolvidos por editar token em banco sem trilha.",
"Publicar manual curto de usuário com quatro fluxos, adicionar número, interpretar status, reautorizar e desconectar; manual técnico inclui deploy/rollback/backup/replay e diagnóstico seguro.",
"Criar registro de melhorias e dívidas com prioridade/risco, mantendo P0/P1 de operação como bloqueios de encerramento; evitar expandir escopo antes de estabilidade.",
"Medir suporte e adoção, coletar aceite operacional e registrar quando cada dependência do legado pode ser retirada com evidência."
],
"Entregas: hypercare report, runbooks versionados e acceptance de operação. Janela é proposta de observação, não due date artificial de milestone nem promessa de trabalhar sem supervisão futura.",
[
"SLOs ratificados são observados por janela suficiente e incidentes críticos resolvidos.",
"Nenhum job/projeção permanece parado sem dono/ação conhecida.",
"Runbooks permitem suporte e deploy por outra pessoa.",
"Usuário consegue gerenciar conexões sem copiar credencial ou pedir SQL manual.",
"Dependências remanescentes da Hostinger/token global estão inventariadas antes de desativar."
],
["Exercícios operacionais de reauth, retry seguro e diagnóstico por correlationId.", "Auditar logs/redaction, quotas e backlog durante operação real.", "Revisão de manual com usuário e suporte autorizados."],
"Sete dias podem não cobrir todo ciclo de token ou tarefa periódica. Encerramento depende da evidência do comportamento relevante, não somente do calendário.",
[".github/docs/agent-context/roadmap.md"], True)

task("M6.10", "Retirar PHP/Hostinger e dependências globais com encerramento auditável", "operations", "P0", 5, "M6.09 M5.07 M5.08 M5.09",
"Concluir a transição somente quando nenhum cliente ou consumidor depender do caminho legado, preservando evidência e recuperação pelo período combinado.",
[
"Reinventariar tráfego, callbacks, webhooks, cron, GeneralSettings e consumidores; confirmar zero dependência não planejada por janela que cubra jobs e reauth periódicos.",
"Desativar por etapa os escritores/rotas antigas, depois leitores compatíveis e jobs, mantendo redirects/erros seguros quando apropriado. Não apagar números, WABAs ou contas Meta para limpar hospedagem.",
"Remover fallback root dos consumidores e revogar somente credenciais de serviço comprovadamente dispensáveis, após verificar se ainda atendem outros apps/recursos.",
"Executar contract migrations finais apenas após janela de rollback e validação de backups; remover cópias de token legadas conforme política e exceções documentadas.",
"Arquivar versão sanitizada de arquitetura/contratos e ledger de migração, não fontes sensíveis operacionais. Definir retenção/descarte de hospedagem/dados conforme responsáveis.",
"Fechar programa com evidência de quatro fluxos, operação de múltiplas empresas/números, CI/CD Docker Hub, SDD, segurança, restauração e suporte; pendência real permanece aberta com dono."
],
"Entregas: decommission checklist, traffic/consumer evidence, release final e encerramento por milestone. Desligar hospedagem/excluir dados é ação futura distinta e exige escopo operacional confirmado.",
[
"Zero consumidor depende de token global indevido ou PHP legado para as funções migradas.",
"Quatro fluxos e múltiplos números operam pela nova arquitetura com evidências.",
"Rotas/cron/credenciais retirados têm prova de não uso e nenhum ativo Meta é excluído por efeito colateral.",
"Backups, contratos e plano de recuperação permanecem pelo período aprovado.",
"Todas as milestones atingem critérios de aceite; issue fechada significa implementação/evidência, não documento escrito."
],
["Auditar tráfego e dependências de código/config/cron antes e após cada retirada.", "Smoke consentido completo após desativar rota/jober antigo.", "Revisar ledger e ausência de segredos/tokens obsoletos em superfícies expostas."],
"Revogar um root token compartilhado pode afetar outros produtos Costa Apps. Inventariar escopo e dependências antes de qualquer revogação.",
["backend/connect_whatsapp.php", ".github/docs/agent-context/git-workflow.md"], True)
