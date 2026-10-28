# Kit de execução no Codex Desktop

Este kit substitui, para novas execuções autorizadas, o controlador Python por um chat principal no Desktop com subagentes nativos. É um conjunto de instruções e evidências de trabalho, não outro daemon, serviço ou scheduler. Não executar `tools.orchestrator run/resume/finalize`, ler seu SQLite como fonte de aceite, iniciar serviços antigos ou mesclar o PR #79 para usar este kit.

## Preparar uma vez

1. Encerrar o controlador antigo no terminal que o executa e manter `.orchestrator/PAUSE`. Se um serviço antigo foi instalado, desativar somente esse serviço identificado. Conferir processos ativos antes de iniciar outro escritor. Não apagar worktrees, SQLite ou commits antigos.
2. Revisar e integrar por **squash** o PR deste kit em `develop`. Este PR parte da develop, não da branch de correções do controlador.
3. Abrir no Codex Desktop o repositório `costaapps/ca_meta_app` e selecionar `develop` atualizada. Preferir **Worktree** para o chat da milestone. O ambiente escolhido pelo Desktop deve realmente enxergar Git, GitHub, dependências e Docker; disponibilidade no terminal WSL não garante disponibilidade num chat Windows ou Cloud.
4. Selecionar `gpt-6-luna` com esforço `xhigh`, se disponíveis no cliente/conta. `.codex/config.toml` e os agentes fornecem esses defaults. Não substituir o modelo silenciosamente nem tratar prompt como concessão de acesso. As permissões continuam as configuradas no Desktop/organização.
5. Iniciar **um chat principal por milestone**. Usar Goal mode (`/goal`) se disponível na versão instalada; caso contrário colar o mesmo prompt no chat normal e manter a sessão. Escolher apenas um prompt completo abaixo. Não iniciar M2 enquanto M1 não estiver verificada em develop.
6. Deixar o computador e a sessão disponíveis, com acesso à rede e prevenção de suspensão quando apropriado. Um prompt não mantém a máquina ligada nem elimina limites da conta. Não iniciar vários chats escrevendo na mesma checkout.

[Metas curtas para copiar no Desktop](start-here.md). Cada uma manda carregar o prompt completo correspondente.

## Prompts prontos

| Milestone | Issues de trabalho | Epic | Prompt completo |
|---|---:|---|---|
| M1 — descoberta e arquitetura executável | 10 | #4 | [M1](prompts/M1.md) |
| M2 — plataforma, containers e entrega | 10 | #5 | [M2](prompts/M2.md) |
| M3 — identidade, tenants e credenciais | 12 | #6 | [M3](prompts/M3.md) |
| M4 — fluxos Meta e webhooks | 14 | #7 | [M4](prompts/M4.md) |
| M5 — portal, consumidores e migração | 10 | #8 | [M5](prompts/M5.md) |
| M6 — homologação e operação | 10 | #9 | [M6](prompts/M6.md) |

Cada prompt contém a meta, o mapa real de issues/dependências, validações específicas e a condição de entrega. Carrega também [contrato comum](execution-contract.md), [decisões de escopo](scope-decisions.md), [ambiente e validação](environment-and-validation.md) e [GitHub](github-workflow.md). Nenhum arquivo local gera automaticamente um chat, meta ou subagente: o usuário inicia a sessão, e o agente principal coordena com as ferramentas nativas disponíveis.

## Recomeçar a partir de develop

O reinício é de execução, não apagamento do planejamento. Criar branches novas `desktop/milestone-m1` e `desktop/m1-01`, etc. Não reutilizar `automation/milestone-m1`, `codex/m1-*` ou checkpoints da experiência anterior. Os PRs #80–#82 são históricos e foram integrados na branch antiga; não provam entrega na develop. Não reabrir/fechar issues ou sobrescrever comentários humanos em massa. O coordenador verifica a situação real antes de trabalhar.

Artefatos antigos podem ser consultados como referência e reavaliados; não fazer cherry-pick em lote nem herdar aprovações. A evidência da nova execução refere-se a novos commits. Não reverter os PRs #76/#77/#78 ou remover o backend automaticamente: este pedido não autoriza apagar o repositório ou a documentação preparada.

## Acompanhar e orientar no próprio Desktop

O chat principal mostra progresso e subagentes nativos. Solicitações úteis, sem abrir outro executor:

- `Mostre o estado de todas as issues da milestone, a etapa atual, os PRs e os próximos passos; depois continue.`
- `Explique a decisão da issue M1.04 e continue com a opção recomendada, registrando o ADR.`
- `Retome a partir do último handoff, confira commits/PRs reais e conclua a milestone sem refazer trabalho validado.`
- `Pause a meta e todos os subagentes; preserve arquivos, commits e serviços de teste identificados.`

[Modelo de acompanhamento e handoff](progress-and-handoff.md). Use o mesmo chat para decisões relacionadas. Uma mensagem neste chat do ChatGPT não é entregue automaticamente ao chat do Desktop.

## O que será entregue

Todas as issues implementáveis devem chegar a PR integrado na branch da milestone, com testes, revisões e documentação; o agente principal apresenta um PR consolidado para develop e uma tabela final por issue. A meta termina aguardando a sua revisão final. Após seu squash, a mesma sessão verifica a integração e fecha apenas as issues efetivamente entregues. [Checklist final](review-checklist.md).

Lacunas de acesso não justificam parar trabalho independente ou pedir comandos repetidamente. Ainda assim, um pacote que exija Sandbox real, App Review, ticket de identidade, DDL/produção ou deploy não pode ser declarado completamente validado apenas por pesquisa/mocks. O coordenador entrega tudo que for possível, agrupa o pedido externo mínimo e declara o que não foi executado. Não há garantia de milestone inteira sem intervenção, pois prompts não fornecem credenciais, privilégios administrativos ou aprovação de terceiros.

## Documentação oficial do cliente

- [Metas e trabalho longo](https://learn.chatgpt.com/docs/long-running-work)
- [Subagentes e arquivos TOML](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Ambientes Local/Worktree/Cloud](https://learn.chatgpt.com/docs/environments/modes)
- [Pesquisa pública](https://learn.chatgpt.com/docs/web-search)

Consultadas em 2026-10-28. Confirmar recursos efetivamente expostos pelo cliente; se um papel customizado ou paralelismo não estiver disponível, o principal executa a mesma responsabilidade sequencialmente, sem inventar agentes ou aprovações.
