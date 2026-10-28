# Contrato inicial para o chat principal

Depois do merge da preparação da automação, abra um clone atualizado da `develop` no Codex. A instrução abaixo autoriza a execução da M1 quando enviada pelo responsável; este arquivo não inicia agentes, workflows nem chamadas Meta sozinho.

```text
Assuma o papel milestone_orchestrator do ca_meta_app e coordene somente a M1.

Leia AGENTS.md e docs/execution/README.md, protocol.md, review-policy.md e context-contract.md.
Use .planning/manifest.json, issues-map.json e a epic #4 como contrato. A issue inicial é M1.01/#10;
depois siga dependências satisfeitas, sem ordenar simplesmente pelo número da issue.

Confira o checkout limpo em develop e execute validate, plan M1, doctor e doctor --online.
Se faltar autenticação, ferramenta, opção do Project ou material externo exigido, registre a causa
e o menor próximo passo. Não invente evidência nem altere permissões ou controles para prosseguir.

Use python3 -m tools.orchestrator run M1 --execute --merge-packages --max-seconds 14400.
O controlador delega a implementação e os três pareceres independentes em processos Codex.
Se usar subagentes interativos para investigar um bloqueio, delegue explicitamente trabalhos
independentes, sem compartilhar escrita e sem iniciar um segundo controlador.

Estão autorizados os worktrees, branches e PRs de pacote da M1 e sua integração por squash
somente em automation/milestone-m1, quando todos os gates passarem. Preserve funções e layout.
Não integre develop, não inicie outra Milestone, não implante, não envie mensagens reais,
não troque tokens nem altere ativos/configurações Meta ou bancos de produção.

Mantenha os checkpoints e a fila de sincronização. Corrija problemas de código dentro do escopo
e do limite de tentativas. Ao faltar evidência externa ou atingir um limite, preserve o trabalho,
publique o estado verificável e aguarde a resolução do bloqueio.

Conclua preparando o PR consolidado para develop, o relatório completo na epic e os pareceres
vinculados ao SHA exato. Entregue o link e as decisões para meu aceite final. Não declare a M1
100% concluída antes do gate humano e da verificação de finalize.
```

A instrução não substitui a configuração de um runner e suas credenciais. Para acompanhar uma execução existente, use `status M1` e `report M1`; para retomá-la, use `resume M1 --execute --merge-packages`. O consumo é limitado entre turnos e pode exigir reconciliação após uma interrupção.
