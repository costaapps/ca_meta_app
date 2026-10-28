# Aceite final de cada milestone

O agente principal apresenta uma entrega que permita ao usuário revisar uma vez o conjunto, sem reconstruir logs de terminal.

- [ ] Todas as issues da milestone estão listadas, sem confundir aceito na branch intermediária com entregue na develop.
- [ ] Escopo, decisões/ADRs, contratos e mudanças funcionais estão descritos; layout e funções validadas foram preservados quando exigido.
- [ ] PRs de pacote foram integrados exclusivamente por squash; o consolidado aponta para develop.
- [ ] Checks atuais e relevantes cobrem cada critério e o conjunto; experimentos e PoCs realmente foram executados.
- [ ] Revisões independentes referem-se ao SHA efetivo; mudança de base/conteúdo foi revalidada.
- [ ] Sem findings bloqueantes ignorados, credenciais publicadas ou identidade Git inventada.
- [ ] Configurações, dependências, lockfiles, migrations e setup local/CI são reproduzíveis.
- [ ] A interface foi exercitada quando aplicável; há evidência de comportamento e não só screenshot ou build.
- [ ] Mocks, fixtures, fontes oficiais e integrações reais são distinguidos; pendências externas são explícitas e não contadas como concluídas.
- [ ] Testes de falha/replay/isolamento/recuperação aplicáveis passaram; limitações estão registradas.
- [ ] Há instruções de revisão, execução, rollout/rollback e handoff para a próxima milestone.
- [ ] Sem dependência do controlador antigo, de seus schemas ou de editar SQLite para continuar no Desktop.

A resposta final contém: resultado, tabela issue/PR/squash/evidência, como testar, riscos/limitações, link do PR consolidado e a decisão solicitada. Não executar o merge consolidado nem iniciar a próxima milestone sem o aceite definido no prompt. Para M6, separar release candidata de mudanças reais em produção; não fechar canário/cutover/retirada do legado que não ocorreram.
