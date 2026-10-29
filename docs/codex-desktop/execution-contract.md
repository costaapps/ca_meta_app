# Contrato de execução pelo Desktop

## Responsável e autoridade

O agente principal do chat é o coordenador até o fim da milestone explicitamente atribuída. Ele planeja, executa, valida, delega, integra e acompanha; não devolve ao usuário erros de formato, comandos de reparo ou passos rotineiros que suas ferramentas possam resolver. Não encerrar a tarefa em um plano, em uma única issue ou na primeira falha recuperável. O usuário revisa a entrega consolidada da milestone.

Este contrato aplica a decisão explícita de migrar a execução para o Desktop. Para novas execuções Desktop, substitui as instruções legadas que obrigam usar o supervisor Python, seus schemas, allowlists, orçamento de três tentativas e checkpoint SQLite. Não altera permissões do cliente, proteções GitHub ou requisitos reais de funcionamento. `docs/execution/` e `tools/orchestrator/` permanecem históricos/legados, sem serem chamados para executar a meta.

O escopo funcional vem das issues, `.planning/manifest.json`, `.planning/issues-map.json`, contratos, código e decisões aceitas. Ler o corpo atual da issue; números de issue, ordem de criação e status do Project não são ordem técnica. Quando a issue divergir de uma decisão explícita deste kit, registrar a interpretação em `docs/delivery/MN/decisions.md` com issue/critério, motivo, consequência e gate posterior. Não editar o catálogo para fingir que uma aceitação real foi satisfeita. Mudanças funcionais materiais que o pedido não resolve exigem decisão; implementar outras partes enquanto isso.

## Ciclo principal

1. Ler `AGENTS.md`, o prompt da milestone, contratos e docs relevantes. Conferir repositório remoto, branch, diff, identidade Git, acesso GitHub e pré-requisitos no ambiente efetivo.
2. Criar ou retomar `desktop/milestone-mN` a partir de develop verificada. Na primeira execução M1 usar restart limpo conforme README. Registrar o SHA de partida e dependências externas da milestone.
3. Construir a lista de issues a partir do mapa real. Conferir quais já foram efetivamente entregues em develop e quais são apenas históricas. Montar ondas pela relação deps. Explicar o plano no chat e começar imediatamente.
4. Preparar o ambiente da primeira onda e resolver instalações, versões, serviços e caminhos. Não esperar que a implementação inteira esteja pronta para descobrir ausência de Docker/DB.
5. Para cada pacote elegível: issue + base atual + escopo + critérios + contratos + plano concreto de teste; delegar ou implementar em branch/worktree exclusiva. Escrever/corrigir todos os artefatos necessários, inclusive fixtures, manifests, lockfiles e scripts executáveis dos experimentos.
6. Executar todas as verificações do pacote. O conjunto deve vir dos arquivos entregues e dos critérios, não de uma lista fixa de Angular. Tornar os comandos reproduzíveis. Capturar evidência sanitizada por SHA.
7. Obter revisão de correção, validação e segurança independentes do autor. Encaminhar achados bloqueantes ao autor automaticamente, corrigir e revisar novamente. Observação advisory, falta de formatação JSON ou título não são defeitos funcionais bloqueantes. Não declarar pass quando um cenário obrigatório falhar.
8. Abrir PR do pacote para a branch da milestone, acompanhar CI, corrigir falhas e fazer squash autorizado quando os gates forem satisfeitos. Verificar efeito remoto e tree/ancestralidade. Só então liberar seus dependentes.
9. Atualizar tabela do chat e comentários/Project em lotes idempotentes. Falha de sincronização de metadados não invalida código e testes nem deve impedir trabalho independente.
10. Repetir até todas as issues concluíveis estarem integradas. Rodar validação agregada e revisão do conjunto. Abrir PR final para develop e apresentar o aceite completo. Não iniciar outra milestone ou fazer merge final sem autorização do usuário.

## Dependências sem travar descoberta independente

Distinguir dependência de contrato/código, de acesso e de operação real. Requisito de prova de produção não impede desenhar o modelo com hipóteses explícitas nem implementar/testar adaptadores localmente. Pode-se avançar em um dependente contra contrato/fixture estável e revisado; registrar que a integração real permanece pendente. Não tratar esse avanço como aceite de uma certificação ainda não realizada. O principal resolve a sequência de integração: merge de dependente exige contrato compatível e gates efetivamente aplicáveis; ausência de prova externa afeta só o cenário que dela depende.

Não mudar o grafo silenciosamente. Registrar exceções de descoberta permitidas por `scope-decisions.md`, com testes substitutivos locais e os gates externos preservados. O status final distingue `aceito-na-milestone`, `entregue-em-develop`, `implementado-com-evidência-externa-pendente` e `não-concluído`. Somente os dois primeiros satisfazem o respectivo aceite; não somar o terceiro como issue totalmente resolvida.

## Subagentes nativos e concorrência

Delegar tarefas delimitadas aos papéis em `.codex/agents/`. A configuração sugere no máximo três subagentes concorrentes. O principal continua responsável; agentes não são contas GitHub distintas nem barreiras de permissão.

| Papel | Entrega |
|---|---|
| milestone_orchestrator | coordenação opcional de uma frente; principal mantém autoridade final |
| implementer | código/docs/fixtures e comandos de teste da issue |
| environment_engineer | dependências, serviços descartáveis, setup reproduzível e diagnóstico |
| docs_researcher | fontes oficiais, data/versão, o que foi confirmado e o que é hipótese |
| reviewer | correção, regressões e cobertura dos critérios no SHA exato |
| validator | comandos reais e cenários no SHA exato; ambiente de teste gravável separado |
| security_reviewer | tenants, credenciais, OAuth, webhooks, efeitos e trust boundaries |
| pr_manager | um único responsável designado por mutações GitHub, PR/CI/squash |
| project_manager | proposta de status, dependências e relatório sem inventar progresso |

O principal entrega ao subagente: objetivo, issue/URL, base/head, worktree, arquivos permitidos, decisões já tomadas, critérios completos, comandos e limites de acesso. Formato de retorno legível: arquivos, SHAs, critérios com evidência, comandos/resultados, achados e próxima ação. Não exigir JSON exato para aceitar o relato. Se o relato omitir critério, pedir complemento ao mesmo agente; não refazer implementação.

Um escritor por worktree. Revisores de fonte podem usar leitura; testes que precisam escrever usam outra worktree no SHA revisado, diretórios temporários e banco de teste próprios. Principal serializa commits/integração e alterações de contratos compartilhados. Paralelizar pesquisa, revisão e frentes realmente independentes. Se o cliente não oferecer subagentes, executar responsabilidades sequencialmente e informar a limitação uma vez, sem parar a meta.

## Recuperar, não recomeçar

Antes de retomar, ler handoff, status/diff local, PRs e CI reais. Manter commits e rascunhos. Registrar o ponto de recuperação e continuar da etapa faltante:

- Check interrompido: repetir esse check quando a evidência anterior não é conclusiva; manter os demais resultados válidos no mesmo SHA/ambiente.
- Revisão incompleta: chamar somente o papel faltante, preservando pareceres do mesmo SHA, escopo e contexto.
- Alteração de código, teste, contrato ou base: invalidar os checks/reviews afetados e executá-los sobre o novo candidato; não reaproveitar aprovação de SHA diferente.
- Push/PR/resposta de merge incerta: reler o remoto antes de tentar outra mutação; não duplicar PR, comentário ou squash.
- Base da milestone avançou: validar e commitar rascunhos permitidos como WIP, incorporar base atual preservando os commits e resolver conflitos. Rever sem descartar trabalho. Nunca fazer reset --hard, git clean, force-push ou mudar branch com force.
- Conflito que o agente pode resolver pelo contrato: resolver, testar e continuar; não pedir ao usuário uma escolha puramente mecânica. Conflito funcional de requisito: tomar decisão reversível sustentada por contrato ou agrupar uma decisão concreta ao usuário enquanto outras frentes avançam.
- Falha temporária de rede/rate limit: esperar o intervalo indicado e tentar novamente com backoff; usar fonte oficial alternativa/cache com data sem inventar atualidade. Não repetir indefinidamente uma chamada idêntica sem progresso.
- Dependência/serviço ausente: delegar ambiente, instalar em escopo local autorizado, preparar container descartável ou alternativa equivalente e validar. Não devolver um checklist genérico ao usuário se pode executar os passos.

Não há contador arbitrário de três tentativas no prompt. Ainda existe limite real de tempo/contexto/conta/permissões; não prometer execução infinita nem criar loop sem progresso. Repetição do mesmo erro deve levar a diagnóstico e estratégia diferente. Manter handoff antes de compactação/interrupção; continuar no mesmo chat quando possível.

## Comunicação e ponto de parada

Atualizar o chat ao concluir ou mudar de etapa de uma issue: chave, atividade, SHA, último check, PR e próxima ação. Responder perguntas de status sem abandonar a meta. Não exigir watch, pgrep, SQLite ou execução manual de resume. Acompanhamento principal é o Desktop; relatório versionado é suporte à memória, não novo scheduler.

Parar ao entregar o PR consolidado para aceite humano, ou quando todas as frentes úteis estiverem esgotadas e faltar acesso/decisão realmente indispensável. Nesse caso entregar uma única solicitação concreta: recurso ausente, cenário afetado, ação mínima e o que já foi concluído. Nunca declarar milestone completa só para evitar pedir algo. Para operações de produção, dados reais e aprovação de terceiros, seguir os gates do prompt específico; pesquisa pública não substitui uma prova real.
