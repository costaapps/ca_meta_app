# Execução assistida das Milestones Meta v2

Este diretório explica como executar o planejamento de `.planning/` com Codex, revisões independentes e um supervisor persistente. A automação prepara entregas verificáveis por Milestone; a integração final em `develop` permanece com o responsável Costa Apps. Todos os merges feitos pelo controlador são **squash**, sem exceção ou fallback para merge/rebase.

O catálogo continua em `.planning/manifest.json`, e os números reais de issues em `.planning/issues-map.json`. O supervisor lê essas fontes; não mantém outro backlog. `execution/config.json` contém a política operacional. `.orchestrator/` guarda o estado local e não deve ser versionado.

## O que esta entrega permite

- Selecionar trabalho pelo grafo de dependências, com contexto de issue, contratos, critérios e commit base.
- Executar implementador, revisão técnica, validação e revisão de segurança em processos Codex separados.
- Persistir progresso, tentativas, referências de trabalho e bloqueios para retomada.
- Produzir PRs por pacote para `automation/milestone-m1`, com integração squash opcional e gates.
- Preparar um PR consolidado da Milestone para `develop`, sem integrá-lo automaticamente.
- Sincronizar informações de execução com as issues/Project autorizado, sem confundir planejamento com conclusão.

## Pré-requisitos do operador

1. Clone completo do repositório `costaapps/ca_meta_app`, atualizado em `develop`, com árvore limpa e origin oficial HTTPS/SSH do repositório.
2. Linux, macOS ou WSL com Python 3.11 ou superior, Git, GitHub CLI (`gh`), npm e Codex CLI disponíveis no runner. O lock usa `flock`; Windows nativo não é suportado pelo controlador inicial.
3. Login salvo do Codex configurado pelo operador; nenhum segredo deve ser colocado neste repositório ou no prompt. O transporte remove chaves de API do ambiente herdado e usa a autenticação já configurada do CLI.
4. Acesso GitHub já autorizado para ler o repositório, criar branches/PRs de trabalho e, quando escolhido, integrar pacotes por squash. Projects organizacional exige acesso próprio existente.
5. Ambiente de build/teste requerido pelas tarefas (incluindo Node/PHP conforme o pacote) instalado e verificável.
6. Insumos externos sanitizados da etapa disponíveis: PHP/rewrite operacional, DDL, contrato Suite4 e evidências Meta quando exigidos. Ausência é bloqueio real.

O controlador não instala credenciais, amplia permissões, muda proteção de branches ou configura produção. Uma conta capaz de abrir PRs pode não ter acesso a Projects ou a merge; o diagnóstico deve mostrar essa diferença.

## Primeira execução

Após integrar o PR de preparação da automação, execute no clone do projeto:

```bash
python3 -m tools.orchestrator validate
python3 -m tools.orchestrator plan M1
python3 -m tools.orchestrator doctor
python3 -m tools.orchestrator doctor --online
```

`validate` verifica política/catálogo; `plan` mostra o trabalho sem executar agentes nem escrever no GitHub. `doctor` verifica pré-requisitos locais; `doctor --online` lê `develop` e as opções de Status do Project e confere o login salvo do Codex. O acesso de escrita ainda precisa estar autorizado pelo operador. Leia os erros e ajuste o ambiente/política antes de autorizar uma execução real.

Para executar com PRs de pacote e permitir sua integração automática após os gates:

```bash
python3 -m tools.orchestrator run M1 --execute --merge-packages --max-seconds 14400
```

`--execute` autoriza os efeitos de execução do supervisor dentro da política. `--merge-packages` autoriza squash dos PRs de pacote que passarem pelos gates. Sem essa opção, a entrega para na etapa de integração do pacote. O prazo é um limite, não uma promessa de conclusão da Milestone.

A implementação inicial usa **uma faixa de escrita**, seguida de processos independentes e sequenciais para revisão, validação e segurança. Os agentes executados pelo controlador não criam subagentes aninhados. O limite de três subagentes em `.codex/config.toml` atende o uso interativo pelo chat principal; ele não torna o supervisor automaticamente paralelo. Essa separação preserva o contexto de cada revisor e serializa os merges.

Os comandos de validação da política são executados em cada worktree. A configuração inicial inclui `npm ci --ignore-scripts`, validação/testes do plano e controlador, build e testes Angular. Instalar dependências somente no clone principal não prepara os worktrees; o controlador faz a instalação configurada em cada candidato. O operador deve preparar acesso ao registry e espaço para essas instalações.

Para acompanhar e retomar:

```bash
python3 -m tools.orchestrator status M1
python3 -m tools.orchestrator report M1
python3 -m tools.orchestrator resume M1 --execute --merge-packages --max-seconds 14400
```

Consulte `python3 -m tools.orchestrator --help` e a ajuda de cada subcomando para a versão instalada. Uma retomada relê o estado e os commits; não transforma resultados antigos em provas atuais.

O orçamento de tokens é cumulativo por Milestone e conferido **entre turnos**; ele não é um teto financeiro nem um corte rígido durante um turno. Se uma interrupção impedir obter o consumo, a execução fica em `usage_unknown` e exige reconciliação antes de outro turno. Veja [o runbook](operations-runbook.md).

## Usar com um chat principal no Codex

O [contrato inicial de M1](start-m1.md) fornece a instrução de entrada para o chat principal, com escopo e condições de parada. Ele referencia os arquivos e comandos reais desta entrega.

Abra este clone no Codex e peça ao chat principal para coordenar **somente M1**, seguindo `AGENTS.md` e [o protocolo](protocol.md). A delegação é explícita: usar os agentes de `.codex/agents/`, respeitar os worktrees e coletar todas as revisões antes de solicitar integração. O supervisor executável é o responsável pelos efeitos e pelo registro persistente.

O chat pode interpretar bloqueios e preparar correções. Não deve abrir outro loop de execução, trocar a política, realizar merges por conta própria ou concorrer com o controlador pelo mesmo checkout. Agentes de papéis diferentes não equivalem a pessoas diferentes no GitHub.

## Entrega para o aceite da Milestone

O responsável recebe PR consolidado, commits de integração dos pacotes, critérios/evidências, resultados de validação e bloqueios restantes. As issues e a epic não são fechadas antecipadamente. O aceite final considera o gate da Milestone em `docs/meta-v2/07-acceptance-risk-and-governance.md`, e não apenas a contagem de issues.

O grafo cobre M1 a M6. O perfil de validação inicial corresponde à aplicação atual Angular/PHP e ao planejamento. Ao final de cada etapa, revise com a entrega o perfil e os paths da etapa seguinte: a reorganização em monorepositório mudará os comandos reais. Mudanças em `AGENTS.md`, `.codex/`, `execution/`, `.planning/`, supervisor e workflows estão protegidas contra autoalteração por um executor. Pacotes que precisem mudar esses controles devem preparar uma alteração dedicada para revisão humana; não ganham permissão para alterar seus próprios gates.

Após revisar e integrar o PR final por **squash**, mantendo a branch da Milestone disponível para verificação, execute:

```bash
python3 -m tools.orchestrator finalize M1 --execute
```

Esse comando não realiza o merge. Ele verifica o PR final já integrado, os commits e a árvore revisada; somente depois fecha as issues e a epic dessa Milestone e atualiza seu estado. A finalização libera os pré-requisitos para a próxima etapa. Não apague a branch da Milestone antes dessa conferência.

## Documentação

- [Protocolo de execução e branches](protocol.md)
- [Política de revisão e squash](review-policy.md)
- [Contrato de contexto e evidências](context-contract.md)
- [Operação, retomada e incidentes](operations-runbook.md)

## Fontes do Codex

Configuração validada contra a documentação oficial em 28/10/2026: [subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents), [execução não interativa](https://learn.chatgpt.com/docs/non-interactive-mode) e [trabalho prolongado](https://learn.chatgpt.com/docs/long-running-work). O executor usa `codex exec` e resultado estruturado; autenticação, sandbox e disponibilidade de modelos dependem do ambiente do operador.

O controlador usa Python e biblioteca padrão, sem dependência adicional de SDK, em conjunto com o Codex CLI. Os testes deste PR exercitam o controlador com agentes/GitHub simulados e repositórios Git temporários. Eles não comprovam um login real, permissões da Meta, integração com Hostinger nem uma execução paga do Codex. O diagnóstico e uma primeira execução supervisionada confirmam esses requisitos no runner escolhido.

