# Engenharia de entrega, SDD, migração e operação

Esta especificação cobre o caminho até operação plena e retirada controlada do PHP. Nenhum comando de produção deve ser executado apenas porque aparece neste plano; cada etapa exige suas evidências e escopo operacional.

## Desenvolvimento guiado por especificação

Cada feature vive em `specs/<domínio>/<feature>/` e referencia issue, ADRs, contrato, dados/invariantes, cenários Given/When/Then, testes, efeitos externos, compatibilidade e rollout. Estado da spec deve distinguir proposed, ready, implemented e verified. Um agente de IA lê o AGENTS aplicável e somente o contexto necessário; dados reais sensíveis não entram nos prompts ou fixtures.

Definition of Ready: objetivo/escopo claros, dependências necessárias resolvidas, dados/contrato coerentes, critérios mensuráveis, fixtures disponíveis e evidência externa exigida disponível. Trabalho de descoberta pode antecipar a resolução; código dependente não se baseia em hipótese disfarçada de fato.

Definition of Done: implementação revisada, critérios atendidos com comandos/ambiente/resultados, docs/contratos/consumidores atualizados, migração e recuperação pertinentes e nenhum segredo introduzido. Testes devem verificar invariantes/fronteiras reais, não espelhar cada linha de implementação. Alteração reversível de baixo impacto não justifica suíte redundante.

Templates de spec e ADR acompanham este plano. A issue fornece checklist executável; a spec guarda regra estável e o PR registra comportamento final e validação. Mudança de escopo reescreve esses artefatos para o resultado final, evitando história de conversa como especificação.

## CI e release

| Estágio | Entrada | Verificações/saída | Permissões |
|---|---|---|---|
| PR | Branch de feature e specs | Lint/typecheck, contratos, testes web/API, integração MariaDB, migrations e secret scan | Read-only; sem secrets de produção |
| Build | Commit testado | Imagens web/api, smoke, SBOM e análise de vulnerabilidade | Publicação desabilitada para contexto não confiável |
| Release | Tag/commit autorizado | SemVer+sha tags imutáveis, digests, proveniência e release manifest | Docker Hub de menor escopo em ambiente adequado |
| Staging | Manifest | Migration preflight, deploy por digest, smoke e evidências externas | Segredos/recursos isolados de produção |
| Produção | Manifest homologado e go/no-go | Gates, backup, canário, observação e ledger | Acesso explícito por serviço/operador; audit trail |
| Rollback | Manifest anterior compatível | Roteamento/flags/schema/effects reconciliados e operação comprovada | Mesmo controle de deploy, sem reviver token revogado |

Actions de terceiros são fixadas por SHA verificado. Workflows evitam executar código não confiável com secrets (`pull_request_target` perigoso não é atalho). Checks estáveis podem ser configurados em rulesets por maintainer, mas a existência do YAML não significa que a proteção está habilitada.

Registro Docker Hub proposto: imagens `ca-meta-web` e `ca-meta-api` no namespace a confirmar. Worker usa a segunda imagem com command de processamento. Não publicar em nome/namespace presumido sem verificar autorização. `latest` nunca é referência de produção; deploy usa digest e release manifest.

Manifest associa commit, contract version, schema min/max, config version, digests web/api, worker command, checks e changelog. Publicação parcial não cria release completa. Promover o mesmo digest para staging e produção evita rebuild não homologado.

## Containers e Compose

Web usa build Angular multi-stage e servidor estático com SPA fallback, `/api` proxy e cache adequado: assets com hash podem ter cache longo; index/runtime config precisam atualização previsível. Config pública tem schema/allowlist e não inclui segredo.

API compila NestJS, executa sem root, tem health/live e ready, limites de request, config validada e shutdown. Worker deixa de capturar jobs em SIGTERM e drena/expira leases de forma segura. Migration é processo separado com lock/preflight; não roda em cada réplica do startup.

Base Compose declara web/api/worker, MariaDB e fila se escolhida. Overrides de desenvolvimento montam código; produção consome digests e secrets de runtime. Apenas ingress/serviço público necessário expõe porta. Banco/fila ficam na rede interna ou serviço gerenciado autorizado. Volumes persistem em recriação de container; runbook de atualização não usa `down -v`.

Validar dependências com retry/backoff: `depends_on`/health order não prova conectividade eterna. Definir CPU/memória/pool/concorrência depois do benchmark. Host único tem SPOF explícito; necessidade de HA muda o ADR e custo.

## Migração de código, dados e tráfego

| Fase | Escritor/roteamento | Prova para avançar | Recuperação |
|---|---|---|---|
| Baseline | Legado permanece dono | Inventário, DDL, contratos, backups e consumidores | Nenhuma alteração operacional |
| Plataforma isolada | Nova stack em staging | Segurança/worker/cofre/fluxos comprovados | Remover stack de teste sem tocar ativos de produção |
| Importação | Leitura legado; gravação nova por lote | Dry-run, grants/ativos, mapa de IDs e quarentenas | Retomar/checkpoint, sem sobrescrever reauth posterior |
| Shadow-read | Um escritor existente; comparação de leituras | Diferenças de metadata/config/status resolvidas | Desligar leitura sombra; nunca shadow-send |
| Gateway comum, quando exigido | Um ingress verifica e roteia por recurso | Inventário do webhook app-level e adaptador legado autenticado | Ledger de propriedade e encaminhamento reproduzível |
| Piloto | Flags por tenant/canal/função | Paridade e eventos/envios corretos, projeção recuperável | Reverter flags/rotas compatíveis e reconciliar efeitos |
| Expansão | Coortes explícitas | SLO/aceite por coorte e zero P0 | Pausar ampliação e rollback direcionado |
| Corte final | Nova API/worker donos; legado apenas compatibilidade | Consumidores completos e ausência de escritor duplo | Manifest/schema compatíveis e ledger |
| Retirada | Sem dependência operacional remanescente | Janela cobre cron, reauth, callbacks e suporte | Arquivo/backup/contratos conforme retenção; não excluir ativos Meta |

### Migração do webhook compartilhado

O app Meta pode ter callback configurado por objeto de forma compartilhada. Não assumir que é possível migrar por tenant apenas alterando um campo local. Levantar configuração real de app, overrides por ativo quando oficialmente suportados e consumidores existentes.

Se a configuração for compartilhada, introduzir ingresso/gateway seguro antes do corte: validar assinatura Meta no raw body, persistir e separar itens, consultar ledger de propriedade por app/ambiente/ativo e entregar cada item uma única vez ao executor legado ou novo. Normalizar e autenticar a entrega interna com envelope próprio; não alterar o body e reutilizar a assinatura Meta como se ainda validasse os bytes modificados.

O adaptador legado precisa de endpoint interno autenticado e idempotente, com escopo e compatibilidade confirmados. Guardar hash/referência do original para auditoria com retenção limitada, não segredo ou mensagem inteira em log. Desabilitar auto-resposta/forward duplo: um evento deve ter um executor de negócio por ação. Rollback muda ledger/flags e mantém ingress verificando/inbox/replay. Se houver override por ativo comprovado, registrar sua regra e efeitos em vez de presumir essa solução para todos os produtos.

### Importação e concorrência

Importador conserva provenance e IDs, converte expiração sem inventar prazo e criptografa ao ingerir. Duplicatas/órfãos/mapeamento indefinido entram em quarentena. Snapshot legado pode ficar velho durante a transição: registrar watermark/change version e reconciliar alterações antes de trocar escritor. Não sobrescrever credencial nova obtida por reauth com lote antigo.

Por campo/agregado, definir escritor em cada fase. Exemplo: depois de migrar configurações do tenant A, portal/API central são donos e projetam para A; tenant B ainda pode usar legado. O sistema não permite ambos gravarem a mesma versão sem conflito/precedência. Relay de operação pode migrar separadamente de leitura de metadata, mas a combinação precisa estar no ledger.

## Projeção empresarial

Cada outbox é versionada por agregado e destino. Projeção usa mapeamento tenant→IdDatabase+IdCompany, conexão de catálogo permitido e transação no destino. Checkpoint e guarda de versão suportam entrega repetida/fora de ordem; tombstone impede ressuscitar recurso removido. Banco offline de uma empresa não bloqueia todos os tenants.

Contrato de campo identifica o que fica nas tabelas existentes e o que é referência nova. Credenciais permanecem centrais por padrão; Msg4 pede operação autorizada. Exceção transitória de token local tem ADR, segurança e retirada. Nunca selecionar DB/DSN com string vinda de request ou evento externo.

## Deploy e rollback operacional

Pré-deploy: confirmar manifest, checks, config de ambiente, backup, chaves, compatibilidade schema N/N-1, migrations e flag/writer matrix. Aplicar expand sem remoção destrutiva. Subir stack e conferir health/rotas, depois habilitar coorte.

Critérios de abortar: qualquer cross-tenant/segredo/double-send causa parada imediata. Metas de latência/erros/backlog têm limiar/janela/dono ratificados; violação persistente bloqueia ampliação. Não escolher porcentagem aleatória de requests que mistura dois escritores sobre o mesmo ativo; coortes são por tenant/canal/consumidor e finalidade.

Rollback envolve quatro estados: código, schema, dados locais e efeitos externos. Voltar imagem não desenvia mensagem, revoga/recria token nem restaura subscription. Usar manifest compatível, flags/roteamento e reconciliação com registros de outcome. Nunca reativar credencial revogada ou repetir envio UNKNOWN para “recuperar”. Remoção contract de coluna/índice só após encerrar janela de retorno.

## Metas propostas e validação

| Indicador | Proposta inicial para dimensionamento | Como ratificar |
|---|---|---|
| Disponibilidade de API | 99,9% em janela definida | SLI de requisições elegíveis e orçamento operacional |
| ACK webhook | p95 <1s; p99 <3s, condicionado a requisito Meta vigente | Carga sintética + persistência e ingress reais |
| API interna sem espera Meta | p95 <500ms como hipótese | Perfil nominal/pico e rotas claramente delimitadas |
| Processamento de evento | Objetivo nominal de dezenas de segundos, a fixar | Lanes, payloads, volumes e quotas reais |
| Projeção empresarial | Objetivo inicial <60s nominal | Medição por destino e backlog/drain |
| Recuperação | RPO 15min/RTO 60min como hipótese | Restore real incluindo chaves/jobs e infraestrutura escolhida |

Nenhum número acima é medição da instalação atual ou compromisso de SLA. M1.09/M6.03/M6.05 produzem dados para ratificar ou mudar as metas.

## Observabilidade e runbooks

Dashboards: entrada/sessão, onboarding por modalidade, grants/token health, subscription drift, webhook ACK/dedupe/unknown, fila/dead-letter, projeção e coortes de migração. CorrelationId liga callback→saga→Graph→inbox/outbox→destino sem incluir token ou conteúdo desnecessário.

Alertas precisam de causa provável, janela, dono e ação. Silêncio de webhook pode ser ausência de atividade: só alertar ausência quando houver expectativa/baseline ou canário autorizado. IDs/telefones não devem criar labels irrestritas de alta cardinalidade.

Runbooks mínimos: token expirado/revogado, grant perdido, subscription falha, código/state expirado, elegibilidade/parceiro, histórico parcial/recusado, worker morto, fila/backlog, banco empresarial offline, rotação de chave, restore, rollout abortado e incidente de dado/segredo. Suporte não ganha console de SQL/Graph/token para resolver tudo manualmente.

## Backup, estabilidade e retirada

Backup inclui central consistente, dados de infraestrutura pertinentes, chaves/version recovery e dados empresariais não reconstruíveis. Restore em ambiente limpo valida descriptografia, invalida sessões quando necessário e reconcilia inbox/outbox/externos. Existência de arquivo não é evidência de restore.

Hypercare inicial sugerido de pelo menos sete dias, ampliado para cobrir rotinas relevantes; um ciclo de token longo não pode ser considerado observado só porque passou uma semana. SLOs, incidentes, reauth e jobs periódicos orientam o aceite. Somente depois retirar PHP/cron/callback/fallback e, quando comprovadamente dispensáveis, credenciais/infra antiga. Root token compartilhado exige inventário de outros produtos antes de revogação.
