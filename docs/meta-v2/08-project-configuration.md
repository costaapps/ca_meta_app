# GitHub Projects, issues, milestones e manutenção do plano

## Estrutura publicada e capacidade disponível

Destino: repositório privado `costaapps/ca_meta_app`. A baseline é a `develop` fixa indicada no índice. O conector expõe criação/atualização de issues com labels/milestone, leitura de código e operações Git/PR. Não expõe criação de Project V2, campos/visões, milestones, subissues ou relações blocked-by.

Milestones e labels foram provisionadas por workflow de metadados na branch de planejamento, com token efêmero do próprio repositório (`contents:read`, `issues:write`). [Run de provisionamento](https://github.com/costaapps/ca_meta_app/actions/runs/40627241622): sucesso; milestones nativas 1–6 criadas. O script é idempotente e não muda configuração da aplicação ou segredo.

As 73 issues estão mapeadas por número/URL reais em `.planning/issues-map.json`. `.planning/manifest.json` guarda conteúdo renderizado, títulos, labels, milestone, parent e deps; os fontes estruturados estão em `catalog.py`, `m1.py`…`m6.py` e `render.py`. Fonte e corpo publicado devem ser reconciliados quando o plano mudar.

O workflow de auditoria verifica catálogo/grafo/links e executa build/testes da baseline exata em job isolado. O job de relações cria e relê subissues e blocked-by pela API, sem trocar título, conteúdo, estado, assignee ou progresso. Seu relatório/summary é evidência da estrutura efetiva, não de implementação do aplicativo.

## Pendência: Project V2 nativo

O navegador acessado para a configuração não tinha sessão GitHub e o repositório privado apareceu como não acessível nessa sessão. O conector continuou funcionando para o repositório, mas não oferece a capacidade organizacional de Projects. Nenhuma credencial ou permissão adicional foi criada ou obtida por atalho.

O `GITHUB_TOKEN` do workflow tem escopo do repositório; a [documentação GitHub](https://docs.github.com/en/actions/concepts/security/github_token) explica esse limite. O script de probe registra o resultado de leitura de Projects com a credencial disponível; leitura bem-sucedida também não comprova escrita. O provisionamento não afirma criar Project quando o acesso falha.

`.planning/project.py` está preparado para um ambiente com autenticação já autorizada que possua Projects organizacional write e leitura das issues privadas do repositório. Recebe `GH_TOKEN` do mecanismo seguro de runtime, nunca de corpo de issue/chat/arquivo versionado. Não concede colaboradores, não vincula team nem muda permissões do repositório. Credencial e login devem ser fornecidos pelo fluxo seguro apropriado, fora da documentação de planejamento.

## Configuração do Project

Título: **ca_meta_app · Meta Platform v2**. Organização: **costaapps**. Privacidade obrigatória: **privado**, confirmada antes de importar metadata de issues. Marcador de propriedade: `ca_meta_app/meta-v2/planning-20261028` no README. Link do índice, contexto e Definition of Done no README.

| Campo | Tipo | Valores / origem |
|---|---|---|
| Title | Nativo | Título da issue |
| Status | Single select nativo | Backlog, Ready, In progress, In review, Blocked, Done |
| Milestone | Nativo | Milestone 1–6 da própria issue; não criar cópia divergente |
| Labels | Nativo | program, type, priority, area e evidence |
| Assignees | Nativo | Pessoas definidas na execução; inicialmente não atribuídas |
| Etapa | Single select | Programa, M1…M6 |
| Area | Single select | architecture, platform, security, data, meta, web, integration, delivery, quality, operations |
| Prioridade | Single select | P0, P1, P2; hipótese inicial revisável |
| Esforco | Number | Pontos relativos apenas em pacotes, sem dupla contagem de epic |
| Risco | Single select | Alto, Medio; refinar com evidência |
| Tipo | Single select | Programa, Epic, Pacote |
| Responsabilidade | Text | Função técnica responsável, sem inventar pessoa |
| Inicio / Alvo | Date | Preencher após capacidade e dependências externas; vazios no planejamento |
| Parent/subissues/blocked-by | Nativo | Hierarquia e grafo sincronizados por API |

### Visões preparadas

| Visão | Layout | Filtro / propósito |
|---|---|---|
| 01 · Backlog completo | Table | Issues abertas do programa |
| 02 · Execucao | Board | Pacotes abertos, organização por Status |
| 03 · Prioridade P0 | Table | Prioridade P0 aberta |
| 04 · Bloqueios | Table | Status Blocked com razão/dono no corpo |
| 05 · Revisao | Table | Status In review |
| 06 · Integracoes Meta | Table | Área meta aberta |
| 07 · Roteiro das milestones | Roadmap | Epics; datas só quando estimadas |

O script cria layouts/filtros e campos visíveis pela API documentada. Agrupamentos/ordenação adicionais podem ser refinados pela UI depois de existir sessão autorizada; não foram apresentados como configurados. Roadmap sem datas reais não contém cronograma fictício.

## Provisionamento e recuperação

Comandos de validação, sem autenticação ou mutação:

```bash
python3 .planning/validate.py
python3 .planning/sync_relationships.py
python3 .planning/project.py
```

Em ambiente de execução já autenticado/autorizado, `sync_relationships.py --apply` escreve somente relações no repositório fixo; `project.py --apply` cria/reconcilia o Project privado do marcador. `--probe` faz leitura de capacidade e registra resultado seguro. Nunca colocar token literal no comando, issue ou screenshot.

O sincronizador valida repo, marker, título, label e milestone de todas as issues antes de mutar. Adiciona apenas relações ausentes e relê o estado. Não reparenta issue de outro trabalho, não fecha tarefa e não altera conteúdo. Em timeout de mutação, encerra para rerun com leitura atual, evitando retry cego.

O provisionador só adota Project com título e marker próprios ou uma criação vazia registrada no journal local. Confirma privacidade antes de importar; preserva status, estimativas e campos preenchidos ao reexecutar. Não cria Project duplicado diante de ambiguidade e não sobrescreve board alheio com o mesmo título. Datas ficam vazias. Falha parcial deixa journal/estado que permite retomar com leitura.

API client usa paginação e intervalos de escrita; rate limit com espera longa encerra para rerun posterior em vez de tentar antes do prazo. Tokens são apenas headers em memória e não são logados. Scripts usam bibliotecas padrão do Python para não depender de instalação adicional.

## Convenções de trabalho

Labels `program:meta-v2`, `type:program|epic|work-package`, `priority:P0|P1|P2`, `area:*` e `evidence:external-required`. Evidência externa pendente não obriga marcar tudo Blocked na criação: a equipe inicia descoberta e bloqueia somente execução dependente.

Uma epic contém pacotes; o índice contém as seis epics. Dependências são entre pacotes, sem ciclos. Estado Done exige evidência; mover cartão para Done não deve automaticamente fechar issue sem aceite. Automações de board, se adotadas, precisam respeitar esse contrato e não tratar PR de documentação como implementação de todas as issues.

## Checklist de entrega do planejamento

- 6 milestones nativas e labels: provisionamento confirmado.
- 1 índice + 6 epics + 66 pacotes: números/URLs reais no manifesto.
- 72 relações de hierarquia e 280 blocked-by: exigem sucesso do job de sync e releitura; consultar report/run vinculados no índice.
- Catálogo, critérios e fontes estruturadas: validados em local/CI.
- Código de aplicação, banco e ativos Meta de produção: implantação permanece fora deste PR.
- Project V2: pendente de acesso organizacional autorizado; configuração e importação preparadas, sem declaração de criação antecipada.
