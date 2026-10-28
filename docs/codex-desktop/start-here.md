# Metas curtas para iniciar os prompts completos

Com o kit integrado em develop, abra o repositório no Desktop e inicie um chat por milestone, preferencialmente em Worktree. Se o cliente expuser /goal, use-o e cole a meta correspondente abaixo. Estes são textos para o chat, não comandos de terminal.

## M1

```text
Execute integralmente a meta de docs/codex-desktop/prompts/M1.md. Leia o prompt inteiro, o contrato comum e as decisões de escopo; assuma a coordenação e use subagentes nativos. Comece pela preparação do ambiente e entregue todas as issues concluíveis da M1 integradas por squash em desktop/milestone-m1, com validação/revisões e PR consolidado para meu aceite. Recomece a partir da develop; não use o controlador antigo. Continue até a entrega ou um impedimento externo indispensável, sem devolver reparos rotineiros para mim.
```

## M2

```text
Execute integralmente docs/codex-desktop/prompts/M2.md e seu contrato comum. Confira a M1 entregue em develop, prepare o ambiente e coordene os subagentes nativos até a entrega da M2. Integre pacotes aprovados somente por squash em desktop/milestone-m2 e entregue o PR consolidado para meu aceite, com evidência por issue. Retome etapas em vez de refazer trabalho e resolva erros recuperáveis dentro da sessão.
```

## M3

```text
Execute integralmente docs/codex-desktop/prompts/M3.md e seu contrato comum. Confira as dependências entregues em develop e conclua identidade, isolamento e credenciais com ambiente/testes/revisões reais. Coordene subagentes, integre pacotes aprovados somente por squash em desktop/milestone-m3 e entregue o consolidado para meu aceite. Não confunda fixtures com certificação de emissores/provedores reais.
```

## M4

```text
Execute integralmente docs/codex-desktop/prompts/M4.md e seu contrato comum. Coordene a implementação e validação dos quatro fluxos Meta e webhooks, pesquisando documentação oficial e preparando o ambiente. Integre pacotes aprovados somente por squash em desktop/milestone-m4 e entregue o consolidado com evidências para meu aceite. Pesquisa pública não exige Sandbox; informe separadamente o que falta para certificação real sem bloquear desenvolvimento independente.
```

## M5

```text
Execute integralmente docs/codex-desktop/prompts/M5.md e seu contrato comum. Preserve layout e funções validadas; coordene portal, consumidores e ferramentas de migração com testes locais/isolados e revisão independente. Integre pacotes aprovados somente por squash em desktop/milestone-m5 e entregue o consolidado para meu aceite. Não executar migração real ou efeitos em produção sem autorização do ambiente correspondente.
```

## M6

```text
Execute integralmente docs/codex-desktop/prompts/M6.md e seu contrato comum. Conclua homologação e preparação operacional verificáveis em ambiente autorizado; coordene subagentes, testes e PRs por squash em desktop/milestone-m6. Prepare release candidata e plano concreto de rollout/rollback para meu aceite. Não implantar, executar canário, migrar produção ou retirar PHP sem minha autorização explícita, e não marcar esses efeitos como concluídos antes da execução real comprovada.
```

Não iniciar a milestone seguinte antes de a anterior estar entregue/verificada em develop. Os arquivos completos prevalecem sobre estes resumos, inclusive seus critérios, dependências e limites. Um prompt não concede credenciais ou recursos que o Desktop não possui.
