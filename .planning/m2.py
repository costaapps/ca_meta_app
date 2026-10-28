task("M2.01", "Reorganizar Angular em monorepositório preservando comportamento e histórico", "platform", "P0", 5, "M1.04 M1.08 M1.10",
"Criar apps/web, apps/api e packages/contracts sem misturar mudança estrutural com redesenho das telas ou perda de funções existentes.",
[
"Criar workspace npm conforme ADR, com scripts de raiz para lint, typecheck, testes, build e execução por aplicação; evitar ferramentas adicionais de monorepo sem ganho demonstrado.",
"Mover src, public, angular.json e tsconfigs para apps/web com git mv quando implementado; ajustar caminhos de assets, styles, index, outputPath e testes mantendo a configuração efetiva.",
"Reconciliar nome do projeto/pacote e paths usados pelo deploy; preservar rotas, SCSS, templates e componentes existentes nesta mudança estrutural.",
"Definir política de importação: frontend pode depender de contratos públicos e UI; proibir imports de API, ambiente servidor e schemas de persistência contendo segredos.",
"Documentar instalação limpa e comandos de cada app, atualizar mapa AGENTS e migração dos caminhos de evidência; manter referências históricas por SHA.",
"Separar pull request de reorganização de PRs de autenticação e funcionalidade, facilitando revisão e rollback de um movimento de diretórios."
],
"Estrutura alvo: apps/web, apps/api, packages/contracts, database/migrations, specs, docs/adr e infra. Scripts mínimos: npm run build --workspace apps/web; scripts de raiz equivalentes documentados após configurar os nomes reais.",
[
"Instalação limpa usa um lockfile coerente e comandos de workspace reproduzíveis.",
"Build e testes Angular mantêm o resultado da baseline; diferenças são explicadas.",
"Rotas /setup, /channels e /templates continuam disponíveis no servidor de desenvolvimento e no build estático.",
"Bundle frontend não inclui código servidor, variáveis secretas ou dependências de criptografia.",
"Movimento de arquivos pode ser revertido sem alteração de schema ou ativos Meta."
],
["Executar instalação/build/testes antes e depois do movimento no mesmo ambiente.", "Verificar navegação direta e refresh das três rotas no servidor estático.", "Inspecionar bundle e mapa de dependências para imports proibidos."],
"Imports relativos, output do Angular e regras do servidor estático são pontos de quebra frequentes. Fazer mudança estrutural isolada.",
["angular.json", "package.json", "tsconfig.json", "src/app/app.routes.ts"])

task("M2.02", "Criar API NestJS modular com configuração validada e boundaries de segurança", "platform", "P0", 5, "M2.01 M1.07",
"Disponibilizar uma API independente, observável e testável antes de incorporar lógica dos provedores.",
[
"Criar bootstrap NestJS e módulos definidos no ADR, separando aplicação, domínio e adaptadores; controllers só validam/encaminham e não executam SQL nem manipulam tokens.",
"Validar configuração no startup com tipos e campos obrigatórios por ambiente. Falhar com nomes dos campos ausentes, sem exibir valores; configurações de teste não podem apontar para produção por padrão.",
"Implementar prefixo /api/v1, validação estrita de DTO, limites de corpo, filtro de erros seguro, requestId e logs estruturados com redação central.",
"Criar health/live sem dependências externas e health/ready com banco/infra essencial. Meta indisponível não derruba liveness; detail de readiness é restrito ao operador.",
"Configurar proxy confiável de forma explícita, timeouts, headers e graceful shutdown com drenagem; interfaces de acesso ficam deny-by-default, com rotas públicas documentadas.",
"Fornecer módulo de testes com adaptadores fake e clock injetável; nenhuma chamada real à Meta em testes de unidade ou startup."
],
"Contratos iniciais: GET /health/live e /health/ready; envelope de erro {code,safeMessage,requestId,retryable}. Nest e Node terão versões compatíveis fixadas no lockfile e nas imagens após verificação oficial.",
[
"API inicia isolada da web e recusa configuração inválida com erro seguro.",
"Nenhuma rota de negócio fica pública por omissão; exceções são revisáveis.",
"Processo encerra sem perder trabalho já confirmado e sem aceitar novas requisições durante shutdown.",
"requestId é retornado em respostas e permite correlacionar logs sem dados pessoais.",
"Healthcheck não expõe credenciais, DSNs, endpoints privados nem falha por indisponibilidade transitória da Meta."
],
["Testar config ausente, DTO com campos extras, erro interno e requestId malformado.", "Integrar teste de inicialização e encerramento com requisição em andamento.", "Verificar endpoint público versus protegido antes de adicionar controllers de negócio."],
"Configuração de proxy permissiva pode falsificar IP e enfraquecer rate limits; fixar ingress esperado por ambiente.",
["src/environments/environment.prod.ts", "backend/meta_auth_helper.php"])

task("M2.03", "Estabelecer migrations MariaDB e disciplina expand/contract", "data", "P0", 5, "M2.02 M1.02 M1.05",
"Permitir evolução versionada do banco central com dados preservados e sem migrations concorrentes no startup das réplicas.",
[
"Validar o driver/ORM escolhido com MariaDB real, transações, precisão de IDs, timezone UTC e charset. Não depender apenas de SQLite em testes.",
"Criar migrations incrementais iniciais, ledger e executor separado do processo API/worker; nenhuma sincronização automática de schema em produção.",
"Definir lock de migration único, timeout, preflight, backup, permissões de usuário de migration distintas do runtime e comportamento quando houver versão incompatível.",
"Implementar constraints e índices compostos com tenant_id, foreign keys coerentes e schema_version, seguindo o dicionário; não criar unicidade global acidental de ExternalId.",
"Definir expand→backfill em lotes→validar→switch→contract. Adiar remoção de coluna/índice até encerrar janela de rollback e confirmar consumidores.",
"Fornecer fixtures sintéticas e seed exclusivamente de desenvolvimento, sem tokens reais; documentar restaurar e retomar migration interrompida."
],
"Entregas: database/migrations, comando migrate:deploy, migrate:status e plano de compatibilidade aplicação N/N-1. Reversão de schema destrutiva exige plano específico; rollback de app não executa down automaticamente.",
[
"Banco vazio chega à versão atual e banco já migrado não repete mudanças.",
"Dois executores concorrentes não aplicam migration em duplicidade.",
"Falha no meio de operação DDL MariaDB tem recuperação documentada; não presumir DDL transacional.",
"Release anterior compatível continua operando durante expand/backfill.",
"Índices previstos atendem queries por tenant/asset/session sem varredura global desnecessária."
],
["Testar banco vazio, versão anterior, migration parcialmente aplicada e concorrência de executor.", "Executar planos EXPLAIN de consultas críticas com volume sintético.", "Validar preservação de IDs externos string e datas UTC sem truncamento."],
"MariaDB pode realizar commit implícito em DDL; scripts precisam ser retomáveis e backup/restore testado.",
["backend/connect_whatsapp.php", "backend/connect_facebook.php"])

task("M2.04", "Gerar contratos tipados e testes de compatibilidade web/API", "platform", "P1", 3, "M2.01 M2.02 M1.07",
"Evitar que frontend e backend evoluam payloads informalmente e reproduzam o desalinhamento de rotas existente.",
[
"Publicar OpenAPI/schemas em packages/contracts sem incluir modelos internos de credencial; selecionar geração de cliente ou tipos com artefatos determinísticos.",
"Implementar validação de contrato no servidor e cliente Angular em serviço próprio; separar transporte, autenticação de sessão, normalização de erro e regras de UI.",
"Criar fixtures sanitizadas de fluxo, recurso, estado parcial, erro e paginação; manter versionamento de contrato independente de cada app quando necessário.",
"Adicionar check de breaking changes e detecção de código gerado desatualizado na CI; mudanças intencionais exigem migração dos consumidores no mesmo PR ou versionamento.",
"Fixar representações: IDs string, enum extensível de estados, data ISO UTC, cursor opaco e propriedades opcionais explícitas; erro desconhecido do provedor continua seguro.",
"Documentar uso de contratos por Msg4/Suite4 e impacto de renomear campos legados, sem exigir TypeScript nos consumidores PHP."
],
"Entregas: packages/contracts, cliente Angular e testes HTTP de consumidor. Nenhum campo access_token, ciphertext, client_secret ou appsecret_proof é permitido nos DTOs públicos.",
[
"Cliente e API compilam a partir da mesma especificação e exemplos válidos.",
"Mudança incompatível falha no check apropriado com diffs legíveis.",
"Erro de transporte e erro Meta são apresentados com códigos estáveis e requestId.",
"Payload não contém company_uuid como autorização de negócio.",
"Novo estado de servidor não quebra silenciosamente renderização nem vira sucesso por default."
],
["Executar geração duas vezes e comparar resultado determinístico.", "Validar exemplos e mock server contra schemas reais.", "Adicionar teste que rejeita accidental secret fields na superfície pública."],
"Compartilhar classes de persistência como contratos aumenta acoplamento e risco de vazamento; expor DTOs dedicados.",
["src/app/core/models/meta-auth.model.ts", "src/app/core/models/channel.model.ts", "src/app/core/services/meta-integration.service.ts"])

task("M2.05", "Construir jobs duráveis, inbox/outbox e worker recuperável", "platform", "P0", 8, "M2.02 M2.03 M1.05 M1.09",
"Garantir que onboarding, eventos e projeções sobrevivam a quedas sem manter transações abertas durante chamadas Meta.",
[
"Implementar Job/Outbox/Inbox e adaptador de fila conforme ADR. Persistir intenção na mesma transação dos dados locais; usar polling/relay com lease e deduplicação se houver Redis externo.",
"Definir estados queued/running/retry/succeeded/dead, attempt, next_run_at, lease_owner/expiry, heartbeat e payload/schema version. Claim de trabalho precisa ser atômico.",
"Estabelecer políticas por tipo de operação: timeout, backoff exponencial com jitter, máximo de tentativas, budget e retryability; não reexecutar envio ambíguo como operação segura por padrão.",
"Criar dead-letter e replay auditado com permissões, dry-run e escopo por tenant/ativo. Preservar causa e histórico de tentativas sem conteúdo sensível desnecessário.",
"Separar lanes de webhooks urgentes, onboarding e histórico/projeções; limitar concorrência por tenant/ativo e proteger a Meta de tempestade de retries.",
"Executar worker pela mesma imagem da API e comando próprio; no SIGTERM parar claims, finalizar/renovar lease e permitir retomada segura em outro processo."
],
"Contrato de job: {id,tenantId,type,schemaVersion,correlationId,idempotencyKey,attempt,nextRunAt,status}. Confirmação HTTP só ocorre após persistência durável quando o requisito exigir replay.",
[
"Matar worker após claim permite retomada após expiração de lease, sem perder intenção.",
"Processamento duplicado não duplica registro, subscription ou projeção.",
"Meta lenta não mantém conexão/transação de banco aberta durante espera de rede.",
"Tenant ruidoso não impede jobs críticos de outra empresa.",
"Falhas permanentes chegam à dead-letter com razão e ação segura de suporte."
],
["Injetar queda antes/depois do commit e entre efeito externo e checkpoint.", "Testar corrida de dois workers, redelivery e lease abandonado.", "Medir latência da fila com histórico grande e webhooks concorrentes."],
"Exactly-once externo não pode ser prometido sem suporte do provedor. Garantir idempotência local e tratar resultados externos ambíguos explicitamente.",
["backend/connect_whatsapp.php"])

task("M2.06", "Criar imagens Docker separadas, mínimas e sem segredos", "delivery", "P0", 5, "M2.01 M2.02 M2.04 M2.05",
"Produzir imagens web e api reprodutíveis que suportem o mesmo release, com worker independente e configuração de runtime segura.",
[
"Criar Dockerfiles multi-stage para Angular estático e NestJS compilado. Escolher bases suportadas verificadas e fixar por digest; dependências instaladas pelo lockfile.",
"Executar processos como usuário não root, filesystem read-only quando viável, tmpfs temporário, capacidades mínimas e portas internas definidas.",
"Configurar servidor web para SPA fallback, cache forte de assets com hash e sem cache de index/runtime-config. Proxy /api preserva headers necessários e limites de webhook.",
"Definir runtime config pública da web com schema permitido; Meta App Secret, tokens, chaves de cofre e DSN nunca são build args, layers, source maps públicos ou arquivos estáticos.",
"Criar .dockerignore para env, fontes PHP locais sensíveis, caches e dados; processo de API/worker compartilha imagem com entrypoint/command distintos.",
"Incluir healthchecks, version/commit em labels OCI, shutdown correto e documentação das variáveis públicas versus secretas."
],
"Entregas: infra/docker/web.Dockerfile, api.Dockerfile, web server config e env.example apenas com placeholders. Imagens propostas costaapps/ca-meta-web e costaapps/ca-meta-api; confirmar namespace antes de publicar.",
[
"Build limpo produz web e api inicializáveis sem montar código fonte da Hostinger.",
"Escaneamento de layers/bundle não encontra segredos nem arquivos locais proibidos.",
"Rotas Angular funcionam após refresh e /api encaminha corretamente sem reescrever callback.",
"API e worker encerram corretamente em SIGTERM e rodam sem root.",
"Mesma imagem web é promovida entre ambientes com configuração pública de runtime permitida."
],
["Build e smoke test das duas imagens e do command de worker.", "Inspecionar usuário, filesystem, labels, ports e histórico de layers.", "Testar cache de index e assets, proxy e limites de request."],
"Não trocar imagem base por tag latest. A arquitetura deve distinguir dados públicos de configuração e segredos fornecidos em runtime.",
["angular.json", "src/environments/environment.prod.ts", ".gitignore"])

task("M2.07", "Definir Compose de desenvolvimento, staging e produção reproduzível", "delivery", "P0", 5, "M2.03 M2.05 M2.06",
"Entregar uma topologia declarada com web/api/worker separados e dependências duráveis, sem expor banco ou fila à internet.",
[
"Criar base Compose e overrides explícitos: desenvolvimento com build/volumes de código; staging/produção consumindo imagens por digest e configuração externa.",
"Declarar web, api, worker e serviços de infraestrutura escolhidos: MariaDB e fila quando adotada. Permitir banco/fila gerenciados via configuração; não presumir que devem estar no mesmo host.",
"Configurar redes edge/internal, somente ingress público, secrets fora do Git, volumes nomeados, limites de recursos, restart e health dependencies sem loops de startup frágeis.",
"Criar comando separado de migration antes da promoção, health gate e smoke pós-subida. depends_on não substitui retry/backoff de conexão no aplicativo.",
"Documentar backup de volumes, atualização de digest e rollback de release; proibir down -v no runbook de atualização e restauração normal.",
"Validar execução com projeto/portas isoladas para que ambientes de teste não usem os mesmos dados, callbacks ou chaves de produção."
],
"Entregas: infra/compose.yaml, compose.dev.yaml, compose.prod.yaml, catálogo de env e comandos de instalação/update/stop/restore. Arquivo release-lock contém digests e schema versions compatíveis.",
[
"Operador sobe ambiente vazio seguindo comandos documentados, sem dependência da máquina do desenvolvedor.",
"Banco/fila não possuem portas públicas no Compose de produção.",
"API e worker têm configurações idênticas de domínio e chaves corretas por ambiente.",
"Migration falha impede promoção da aplicação incompatível.",
"Recriação de containers preserva dados e jobs pendentes; rollback não apaga volumes."
],
["Executar docker compose config e smoke de stack vazia.", "Recriar api/worker e simular perda temporária de banco/fila.", "Conferir portas publicadas e ausência de secrets no config/logs compartilhados."],
"Compose não oferece alta disponibilidade por si só. Capacidade e RTO de host único precisam ser aceitos ou exigir infraestrutura adicional.",
[".github/docs/agent-context/git-workflow.md"])

task("M2.08", "Implantar CI de qualidade, contratos, segurança e builds", "delivery", "P0", 5, "M2.03 M2.04 M2.06 M1.10",
"Tornar as condições técnicas de merge verificáveis no GitHub, antes de qualquer publicação de imagem.",
[
"Criar workflow pull_request/push confiável com permissões mínimas, actions fixadas por SHA, lockfile/caches, concorrência e limites de tempo.",
"Executar formatação/lint/typecheck, testes Angular e API, contratos e integração com MariaDB real; guardar relatórios JUnit/cobertura sem payload de clientes.",
"Construir ambas as imagens e executar smoke/Compose quando aplicável. PRs de forks ou não confiáveis não recebem segredos nem publicam artefatos privilegiados.",
"Adicionar secret scanning, dependências/licenças e imagens com severidade/política de exceção; findings têm dono e validade, não são silenciados indefinidamente. A execução da baseline em 28/10/2026 reportou 47 vulnerabilidades npm (4 critical, 31 high, 11 moderate, 1 low): gerar relatório por pacote/caminho, distinguir dependência dev/runtime, avaliar alcance e corrigir patches/majors de forma revisada antes do gate, sem npm audit fix --force indiscriminado.",
"Checar migrations, schema drift, generated-client e links/specs; usar testes de fronteiras e invariantes, sem meta de cobertura que premie testes espelho de implementação.",
"Documentar checks que deverão proteger develop/main e processo de habilitação por maintainer. Planejamento do requisito não altera permissões ou regras do repositório automaticamente."
],
"Entregas: .github/workflows/ci.yml, scripts de checks e guia de execução local. Nomes dos checks estáveis para rulesets; CI de PR não faz deploy nem escreve na produção.",
[
"PR com violação de contrato, token no fixture ou tenant isolation quebrado falha em check pertinente.",
"Pipeline limpo passa sem secrets de produção e com serviços de teste isolados.",
"Logs e artifacts têm retenção definida e não expõem credenciais.",
"Builds de web/api são independentes e relacionados ao mesmo commit.",
"Instrução de proteção de branches distingue check implementado de proteção efetivamente habilitada."
],
["Executar workflow em branch de prova com falhas controladas em lint, contrato e migration.", "Revisar permissões/eventos de workflow e ausência de pull_request_target com código não confiável.", "Reexecutar somente checks pertinentes após correções, registrando run URL."],
"Versionar um workflow não protege uma branch automaticamente. Habilitação de regras e ambiente precisa de evidência posterior.",
["package.json", "src/app/app.spec.ts", "src/app/features/channels/pages/channel-list/channel-list.component.spec.ts"])

task("M2.09", "Planejar pipeline Docker Hub com versões imutáveis e proveniência", "delivery", "P0", 5, "M2.06 M2.07 M2.08",
"Publicar duas imagens confiáveis e promover exatamente os mesmos digests entre ambientes, com rollback rastreável.",
[
"Definir convenção SemVer e tags sha-<commit>; tags de versão protegidas contra sobrescrita. latest é apenas conveniência opcional e nunca fonte do deploy.",
"Criar workflow de release que usa commit testado, gera web/api, SBOM e proveniência, escaneia e publica no namespace Docker Hub confirmado.",
"Usar credencial Docker Hub de menor escopo em secret de ambiente, sem incluí-la em args/logs. Definir rotação, cache e permissões de publicação separadas das de deploy.",
"Produzir release manifest com git SHA, digests web/api, command worker, schema min/max, contrato, changelog e links de teste; assinar/verificar se suportado pela infraestrutura escolhida.",
"Definir promoção staging→produção por manifest, com verificação de digest e gate de rollout. Evitar rebuild por ambiente que torne homologação irrelevante.",
"Documentar falha parcial de push, retry idempotente, política de retenção de imagens e rollback para manifest anterior com schema compatível."
],
"Entregas: release.yml, release-manifest schema e runbook. Repositórios Docker Hub, arquitetura CPU e credenciais são pré-requisitos externos; publicação real só na etapa de implantação autorizada.",
[
"Release identifica exatamente as imagens web/api e origem de código.",
"Manifest não é concluído se somente uma imagem foi publicada ou falhou verificação.",
"Produção usa digests homologados, com versões anteriores disponíveis na janela de rollback.",
"Nenhum token da Meta ou tenant participa do build/publicação.",
"Release de teste pode ser instalada e revertida seguindo o runbook em staging."
],
["Executar release candidata em namespace de teste autorizado e conferir digests.", "Simular push parcial e validar retomada sem mover versão imutável.", "Verificar SBOM/proveniência e rollback de manifest."],
"Namespace Docker Hub e infraestrutura de assinatura não foram verificados. Manter gate externo e não inventar secrets existentes.",
["package.json", ".github/docs/agent-context/git-workflow.md"], True)

task("M2.10", "Preparar staging isolado, DNS/TLS, callbacks e gestão de configuração", "delivery", "P0", 5, "M2.07 M2.08 M2.09 M1.03 M1.06",
"Dispor de ambiente integrável com a Meta sem alterar a Hostinger de produção durante a reconstrução.",
[
"Definir host/VPS ou plataforma alvo, ingress/TLS, domínio e orçamento; separar banco, chaves, apps/configs Meta e catálogos de tenant de dev/staging/prod.",
"Publicar rotas HTTPS estáveis de callback, webhook, deauthorization e data deletion conforme cada produto; registrar allowlists exatas e proprietário da configuração Meta.",
"Configurar secrets via mecanismo de runtime escolhido com controle de acesso e inventário de nomes, rotação e recuperação; nenhuma configuração sensível passa pela web.",
"Implantar stack e migration com release candidata, validar health/readiness, observação de logs e conectividade Meta autorizada; não usar número de produção como fixture de teste.",
"Criar catálogo de recursos de teste e limpar dados sintéticos de forma reprodutível, preservando consentimentos e ativos de terceiros.",
"Registrar URLs de ambiente e procedimentos de atualização/recovery. Confirmar HTTPS, headers de segurança, relógio e roteamento de callbacks após cada alteração de ingress."
],
"Entregas: environment-matrix.md, deployment inventory e relatório de smoke. Configurações de login e webhook por produto são tratadas separadamente de inscrição de cada ativo.",
[
"Staging não lê nem grava bancos/segredos de produção e possui identificação visual clara.",
"Callbacks e webhook públicos chegam à API correta com TLS válido e assinatura verificável.",
"Stack pode ser reconstruída por outro operador a partir do manifest/config autorizada.",
"Os quatro fluxos têm recursos de teste autorizados ou bloqueios explícitos de disponibilidade.",
"Hostinger e conexões atuais continuam operando durante a homologação."
],
["Smoke de DNS/TLS/proxy/callback e endpoint de health de fora da rede interna.", "Testar configuração de ambiente trocada para garantir falha segura.", "Executar verificação Meta de webhook no ambiente de teste com segredo protegido."],
"Provisionar servidores, DNS, acessos ou ativos Meta é execução futura com responsáveis e permissões; esta issue define o contrato e as evidências, não declara infraestrutura existente.",
["src/environments/environment.prod.ts", ".github/docs/agent-context/open-questions.md"], True)
