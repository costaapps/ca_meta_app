# Aceite, riscos, sequência e responsabilidades

## Governança de execução

O backlog tem 66 pacotes, 427 pontos relativos iniciais e 280 relações de pré-requisito declaradas. Esses números descrevem a decomposição proposta; não são orçamento, horas ou prazo. Dependências transitivas podem ser reduzidas na visualização sem mudar o alcance lógico. O validador rejeita ciclos/IDs inexistentes e gera ondas topológicas e catálogo com links.

Estados operacionais do Project: Backlog, Ready, In progress, In review, Blocked e Done. Todas as implementações começam Backlog. `M1.01` é a primeira candidata a Ready porque não tem pré-requisitos anteriores; assumir pessoa/capacidade/ambiente sem confirmação não é necessário para o planejamento.

Definition of Ready e Done constam no documento 06. Gate de milestone é verificado na epic. Apenas aceites satisfeitos contam como execução concluída; documentação entregue não fecha automaticamente os pacotes de implantação. Percentual nativo de milestone conta issues e epics; progresso de engenharia deve considerar pacotes aceitos ponderados e o gate, sem dupla contagem da epic.

## Responsabilidades funcionais

| Função | Responsabilidade | Evidência que deve revisar |
|---|---|---|
| Produto / responsável Costa Apps | Jornadas, limites, paridade, piloto e go/no-go | UX, capacidades, retenção/consentimento e impacto de desligamento |
| Liderança técnica / arquitetura | ADRs, módulos, contratos, SDD e dependências | Specs, mudanças de fronteira, migração e riscos técnicos |
| Backend / integração Meta | Saga, adapters, grants, transport, subscriptions e relay | Contratos, fixtures primárias e testes Sandbox |
| Frontend | Portal, sessão, popup/embed e acessibilidade | Estados/recovery, regressão visual e ausência de segredos |
| Dados / DBA | Schema, migrações, importação, projeções e backup | DDL real, constraints, dry-run, checkpoints e restore |
| Segurança | Identidade, isolamento, cofre, revisão adversarial e CI | BOLA/replay/CSRF, redaction, chaves, privilégios e achados |
| DevOps / SRE | Imagens, CI/CD, TLS, ambientes, observação e rollback | Digests, manifest, SLO, capacidade e recovery |
| QA | Estratégia de teste, paridade e evidência por requisito | Contratos, E2E, falhas, múltiplos tenants/números e rastreabilidade |
| Operação / suporte | Diagnóstico, reauth, incidentes e estabilização | Runbooks, alertas e exercícios sem acesso irrestrito a tokens |
| Dono de Suite4 / consumidores | Emissor/membership, contrato S2S e adaptação dos legados | Integração real, revogação e escritor por fase |

Uma pessoa pode acumular funções, mas assignees não foram inventados. Definir durante início da execução, com capacidade disponível e revisores apropriados ao risco.

## Passagem de etapas

| Gate | Requisitos obrigatórios | Não é evidência suficiente |
|---|---|---|
| M1 | Inventário, DDL/mapeamento, capacidades Meta, identidade, domínio, contratos, UX, NFR e SDD coerentes | Documento antigo, memória do chat ou código de produção não inventariado |
| M2 | Clone limpo, build/teste, DB migration, jobs, imagens/Compose, CI/release e staging reproduzíveis | Só um Dockerfile que compila ou workflow sem execução |
| M3 | UUID não autentica; membership/tenant, cofre/resolver/ciclo e quatro números testados | Frontend guard, token criptografado sem autorização ou TTL presumido |
| M4 | Quatro fluxos e webhooks certificados com permissões/evidência externa necessárias | QR concluído, `auth_success`, mock ou administrador do próprio app funcionando |
| M5 | Portal e paridade, relay sem token global indevido, projeção e piloto recuperáveis | Número salvo em tabela ou shadow-read que duplica envio |
| M6 | Homologação, segurança, carga/falhas, restore, observabilidade, aprovação externa, canário/rollback e estabilização | Containers healthy, imagem no Hub ou restore nunca exercitado |

## Matriz de cobertura do escopo original

| Tópico | Pacotes principais |
|---|---|
| Diagnóstico do estado atual e contratos PHP | M1.01, M1.02, M1.03 |
| Escolha Angular/NestJS versus alternativas | M1.04, M2.01, M2.02 |
| Arquitetura modular e escala de workers | M1.04, M1.05, M2.05, M6.03 |
| Acesso sem senha adicional e UUID inseguro | M1.06, M3.01–M3.05 |
| Modelo autorização/ativos/cofre/resolver | M1.05, M3.06–M3.09, M3.11 |
| WhatsApp tradicional | M4.01–M4.04, M4.11, M4.14 |
| Coexistence por número e histórico/echo | M4.05–M4.07, M4.10–M4.14, M5.03 |
| Facebook e Instagram independentes | M4.08, M4.09, M4.11–M4.14 |
| Assinaturas/webhooks/deduplicação | M2.05, M4.10–M4.13 |
| Portal de recursos/status/reauth/desconexão | M1.08, M3.12, M5.01–M5.03, M5.10 |
| Templates/respostas/notificações existentes | M1.01, M5.04–M5.06 |
| Msg4/Suite4, API e bancos empresariais | M1.02, M1.07, M3.11, M5.07–M5.09 |
| SDD e IA | M1.10, M2.04, M2.08 e templates deste plano |
| Docker/Compose/CI/Docker Hub | M2.06–M2.10, M6.06 |
| Segurança e isolamento | M1.06, M3.01–M3.10, M6.02 |
| Observabilidade/backup/carga/rollback | M1.09, M6.03–M6.06, M6.08 |
| Produção e desativação Hostinger | M5.09, M6.07–M6.10 |

## Registro de riscos

Probabilidade/impacto são avaliação inicial, a revisar com evidência. A função indicada é responsável por conduzir mitigação, não uma pessoa automaticamente designada.

| ID | Risco / gatilho | Prob. / impacto | Mitigação e pacote | Dono funcional |
|---|---|---|---|---|
| R01 | PHP/rewrite operacional diverge do Git | Alta / alto | Inventário, comparação e paridade antes de corte; M1.01 | Backend/legado |
| R02 | DDL/UNIQUE mescla ExternalId de empresas | Média / crítico | Constraints/tenant completo e dry-run; M1.02/M3.06 | Dados |
| R03 | Ticket Suite4 não comprova membership | Média / crítico | Emissor/JWKS/claims/replay e integração real; M1.06/M3.02 | Suite4/segurança |
| R04 | UUID/assetId permite acesso cruzado | Alta no legado / crítico | Deny-by-default, policy, query/cache/job scoped; M3.01/M6.02 | Segurança |
| R05 | Prazo/refresh de token presumido | Alta / alto | Família e datas observadas, strategy por produto; M3.09 | Integração Meta |
| R06 | Token root serve cliente errado | Alta no legado / crítico | Resolver/grants sem fallback e inventário de consumidores; M3.08/M5.07 | Backend |
| R07 | Segredo aparece em log/trace/bundle/artifact | Média / crítico | Cofre/DTO segregado/redaction marker tests; M3.07/M3.10/M6.02 | Segurança |
| R08 | App/config/versão ou permissão Meta muda | Alta / alto | Registry versionado, documentação e sandbox; M1.03/M4.01 | Meta |
| R09 | Coexistence/portfolio/número inelegível | Média / alto | Preflight e diagnóstico sem exclusão; M1.03/M4.05/M4.06 | Meta/produto |
| R10 | Código de uso único trocado mas resposta perdida | Média / alto | Saga/outcome ambíguo e nova autorização quando exigida; M4.03 | Backend |
| R11 | Quatro onboards/abas trocam contexto | Média / crítico | Sessão por onboarding+tenant, nonce e testes concorrentes; M4.05/M4.14 | Front/backend |
| R12 | Desconectar um número remove webhook compartilhado | Média / alto | Physical target+bindings, lock e dependências totais; M4.11/M4.13 | Meta |
| R13 | Dedupe descarta status ou cria mensagens duplas | Média / alto | Identidade por item/estado e ordenação; M4.07/M4.10 | Backend/QA |
| R14 | Echo dispara auto-resposta em loop | Média / alto | Origem/identidade/correlação e suppress; M4.07/M5.05 | Integração |
| R15 | Callback app-level corta tenants não migrados | Média / crítico | Inventário e gateway/ledger seguro antes da troca; M1.01/M5.09 | Backend/DevOps |
| R16 | Dois escritores ou shadow-send duplicam efeito | Média / crítico | Writer matrix, shadow-read e operação idempotente; M5.07–M5.09 | Migração |
| R17 | Projeção fora de ordem ressuscita credencial/ativo | Média / alto | Aggregate version, tombstone e reconcile; M5.08 | Dados |
| R18 | Banco de uma empresa bloqueia todas | Média / alto | Lanes/quotas/budget, destinos independentes; M2.05/M5.08/M6.03 | Plataforma |
| R19 | Histórico excede janela/volume/retensão | Média / alto | Consentimento/checkpoint/deadline comprovado e orçamento; M4.07/M1.09 | Meta/dados |
| R20 | Iframe/popup/cookies bloqueiam jornada | Alta / médio-alto | Top-level seguro e retomada; M3.05/M5.03 | Frontend |
| R21 | Backup existe mas chave/restore falha | Média / crítico | Recuperação de chaves, teste independente e RTO; M6.05 | SRE/segurança |
| R22 | Workflow/publicação permite código não confiável com secrets | Média / crítico | Least privilege, SHA, gates e contextos; M2.08/M2.09/M6.02 | DevOps |
| R23 | API/field Instagram misturado entre variantes | Média / alto | authVariant e strategies, fixtures separadas; M1.03/M4.09 | Meta |
| R24 | App Review aprova tester mas operação cliente falha | Média / alto | Permissões/aceite externo por fluxo; M4.01/M6.07 | Produto/Meta |
| R25 | Remover root token afeta outros produtos Costa Apps | Média / crítico | Inventário cruzado e revogação seletiva tardia; M6.10 | Operação |
| R26 | Documentação vira estado paralelo desatualizado | Alta / médio | SDD checks, contrato/PR/release rastreáveis; M1.10/M2.04 | Tech lead |
| R27 | Project nativo sem acesso organizacional | Comprovado no ambiente / gestão | Manter issues/milestones/grafo e script idempotente; documento 08 | Maintainer |
| R28 | Baseline npm com 47 vulnerabilidades reportadas, incluindo quatro critical | Comprovado no audit / impacto a triar | Relatório por pacote/caminho, dev/runtime e alcance; correções revisadas, sem audit fix --force cego; M2.08/M6.02 | Backend/segurança |

## Decisões pendentes com próximo experimento

| Decisão | Experimento mínimo | Critério de resolução |
|---|---|---|
| ORM MariaDB | Migration/transaction/index/UTC em banco real | Driver suportado e operação reproduzível, sem synchronize |
| Banco/fila de jobs | Crash/claim/redelivery + benchmark | Persistência durável e metas sem complexidade desnecessária |
| Emissor Suite4 | Ticket/identity reais de staging | Validação servidor, membership, revogação e replay comprovados |
| Estratégia Instagram | Permissões/recursos/aprovações atuais | Uma variante certificada; alternativa com tradeoffs explícitos |
| Versão Embedded Signup e modelo de ativos | Doc primária + builder/SDK sandbox | Sessão, token family e relações verificadas sem valores secretos |
| Callback de migração | Inspeção app-level/overrides e contrato legado | Sem perda/fanout/double-send ao trocar endpoint |
| Runtime infra/Hub | Proposta de capacidade/custo/permissões | Alvo e namespace autorizados, restores/deploy possíveis |
| Retenção/conteúdo histórico | Inventário de dados e aceite do responsável | Finalidade, consentimento, prazo e expurgo definidos |

## Estratégia de estimativa e planejamento de tempo

Primeiro refinar M1 e disponibilidade externa. Depois decompor pacotes grandes em PRs verticais com limites revisáveis, estimar por função e identificar gargalos de revisão/contas Meta. Datas de milestones devem derivar dessa capacidade e das janelas externas, não de uma tabela arbitrária no planejamento.

O grafo contém dependências técnicas; tarefas de evidência podem avançar em paralelo quando não alteram contrato. Uma equipe pode preparar infraestrutura enquanto obtém permissões Meta, mas não deve implementar regras críticas a partir de suposição para “ganhar tempo”.

## Evidência de fechamento

Cada issue deve informar versão/commit, ambiente, comando/cenário, resultado, artifacts redigidos, PR e limitações. Se teste não foi executado, registrar o bloqueio exato. Aceite manual externa inclui recurso de teste e contexto permitido de forma segura. Não anexar token/código OAuth nem dados pessoais desnecessários.

No encerramento do programa: quatro fluxos e múltiplos números/tenants, paridade de produto, credenciais individualizadas por grant, relay/projeções, SDD/CI/release, capacidade, segurança, restore, rollback e operação precisam estar comprovados. Não fechar a epic para “limpar o board” enquanto o gate falta.
