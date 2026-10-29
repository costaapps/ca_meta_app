# Acompanhamento e memória entre sessões

O chat principal é o ponto de comunicação. O coordenador mantém um relatório leve em `docs/delivery/MN/progress.md`, um registro de decisões em `decisions.md` e uma entrega final em `handoff.md`. São documentos de trabalho versionados; não são um scheduler, nova lista de issues ou exigência de JSON. Não commitar a cada linha nem fazer PR só para um heartbeat: agrupar updates com entregas e manter o chat atualizado enquanto isso.

## Tabela do chat

| Pacote / issue | Etapa atual | Candidato | Última evidência | PR | Próxima ação |
|---|---|---|---|---|---|
| MN.XX / #N | implementar / preparar ambiente / validar / revisar / CI / integrar / aceito-na-milestone / pendência-externa | SHA real ou não criado | comando e resultado observado | URL ou não criado | ação concreta |

Não preencher antes de observar. Uma linha marcada em execução é último registro, não heartbeat do processo. O coordenador consulta suas ferramentas para informar processo/serviço em andamento e deve distinguir encerramento, espera, limitação e progresso. Ao usuário pedir status, resumir e continuar o trabalho.

## Evidência por pacote

- Issue, critérios efetivos completos e decisões específicas que alteram sua interpretação.
- Base inicial e candidato exato; árvore ou fingerprint do snapshot quando validado antes do commit.
- Arquivos/contratos/consumidores afetados.
- Ambiente, versões e setup/cleanup de recursos de teste.
- Para cada critério: evidência/artefato, comando, resultado e limitação. Teste planejado não é executado.
- Reviews de correção, validação e segurança, com SHA e achados; indicar o que foi corrigido e revalidado.
- PR do pacote e commit de squash na integração; estado final da issue e gates restantes.

Não inserir no arquivo rastreado o hash final do próprio commit. Usar fontes testadas com atribuição correta; o SHA final das revisões fica no PR/comentário e pode ser referenciado por URL.

## Handoff antes de interrupção/compactação

Registrar:

1. Meta e branch da milestone; develop de partida e integração atual.
2. Issues concluídas/aceitas, em execução e pendentes; dependências e exceções de descoberta registradas.
3. Branch/worktree/head/diff pendente de cada escritor, dono e o que preservar.
4. Etapa faltante e comandos já executados no candidato; quais reviews continuam válidos e quais invalidar.
5. PRs/checks/ações remotas pendentes, inclusive resposta de merge incerta.
6. Processos/containers/volumes/portas locais criados e cleanup permitido.
7. Decisões, fontes oficiais e configurações não secretas confirmadas; acessos ausentes e cenários afetados.
8. Próxima ação exata, com alternativa se falhar.

Retomar lendo o handoff e verificando GitHub/Git atuais. Não executar instalação ou implementação novamente só porque a janela mudou. Se as permissões do novo chat forem diferentes, testar o acesso sem expor credenciais e adaptar a execução. O histórico do Desktop e os relatórios ajudam a memória, mas os efeitos remotos precisam de releitura.

## Pedido externo agrupado

Quando realmente necessário: `Recurso ausente → cenário dependente → ação mínima do responsável → trabalho já concluído → evidência esperada`. Pedir apenas aquilo que o agente não consegue obter/criar legitimamente. Não pedir acesso à produção para testar um schema sintético. Não pedir Sandbox para ler documentação. Não apresentar faltas externas como aprovação automática.
