# Branches, PRs, squash e Project

## Fluxo da nova execução

```text
develop -> desktop/milestone-mN
            <- desktop/mN-XX (um PR por pacote; squash)
            -> develop (PR consolidado; squash pelo humano)
```

O desenho representa dependência de branches, não comandos para executar às cegas. O principal confirma os SHAs remotos e o estado antes de cada operação. Não há merge automático da develop. Os commits internos de atualização da base podem usar merge local; a estratégia de **todo PR integrado** continua squash, nunca merge commit ou rebase merge.

## Identidade e acesso

Usar a identidade Git do usuário configurada e o GitHub autenticado no ambiente. Conferir `git var GIT_AUTHOR_IDENT`, `git var GIT_COMMITTER_IDENT` e o usuário da conexão/gh. Subagentes são papéis da sessão, não novas contas. Não atribuir commits a um nome/email inventado, não configurar tokens no repositório e não simular aprovação de outra conta.

## Iniciar milestone

Fetch da develop e das branches relevantes. Confirmar que a milestone anterior foi integrada e suas dependências entregues. Na primeira M1, criar uma branch nova a partir da develop contendo o kit. Um nome já existente exige inspeção; não resetar/forçar a branch. Registrar SHA de partida no handoff. Para retomar, comparar branch/remoto/PRs com esse registro em vez de recriar tudo.

Criar task branch com base na integração atual. Um responsável por mutações GitHub de cada vez: principal ou pr_manager expressamente delegado. Project manager pode preparar updates mas não competir pelo mesmo comentário/PR. O principal mantém um inventário de branches, worktrees e processos que criou.

## PR do pacote

Título: `[MN.XX] resultado concreto`. Body mínimo:

- `Refs #NUMERO` e a chave real do pacote; texto que deixa explícito que a entrega final será na develop.
- Problema e comportamento resultante, escopo e limitações.
- Base/head revisados; testes e evidência por critério; pareceres independentes e limitações dos mocks.
- Dependências satisfeitas e decisões aceitas; flags/gates reais ainda pendentes.

Associar o PR à issue por referência e comentário de acompanhamento e, se suportado, relação nativa sem fechar cedo. `Refs #N` não equivale a `Closes #N` nem garante cartão Development. Não afirmar um vínculo nativo que a API não confirmou. Evitar palavras de fechamento automático nos PRs de pacote: merge em branch intermediária não é entrega em develop.

## Integração autorizada do pacote

1. Confirmar mesmo repositório, head e base esperados, candidato limpo e SHAs revistos. PR do pacote aponta para desktop/milestone-mN.
2. Ler estado real de CI, checks exigidos, conflitos, reviews e proteções. Não considerar CI da baseline histórica como validação do candidato atual.
3. Corrigir código/configuração legítima e falhas; pedir nova revisão quando conteúdo/base mudar. Advisory sozinho não é bloqueio.
4. Fazer squash com precondição do HEAD revisto quando a ferramenta permitir; com gh a operação é `gh pr merge NUMERO --squash --match-head-commit SHA`. Nunca `--admin`, force push, alteração de proteções, merge padrão ou rebase merge.
5. Reler o resultado: merged, base correta, head revisto e commit de squash correspondente. Conferir que a árvore integrada contém o candidato aceito e que a integração ainda é a esperada. Se a resposta de rede foi perdida, reler antes de repetir.
6. Marcar o pacote aceito na milestone, atualizar dependentes e continuar sem pedir autorização individual. Não fechar a issue ainda.

Se a proteção exigir aprovação humana que a identidade atual não pode fornecer, não contornar: reunir uma aprovação concreta e continuar frentes independentes. O pedido do usuário autoriza integrar pacotes aprovados por squash; não torna um parecer de IA equivalente a aprovação nativa exigida.

## Base avançada e mudanças concorrentes

Antes de integrar cada pacote, incorporar a integração atual na task branch preservando rascunhos e commits. Com worktree suja, inspecionar o diff, verificar escopo/segredos, commitar WIP dos arquivos do agente e só então reconciliar. Não tocar mudanças humanas não atribuídas à tarefa. Resolver conflitos de acordo com contratos; rodar testes/reviews afetados no novo SHA. Não declarar aprovação herdada do commit antigo.

Se develop mudar fora desta sessão, comparar o que mudou. Atualização compatível pode ser incorporada à branch da milestone preservando trabalho e revalidando; não descartar a milestone ou exigir um banco de checkpoint antigo. Mudança funcional conflitante precisa de decisão registrada. Apenas um integrador atualiza a branch da milestone por vez.

## Project #12 e dependências

Descobrir campos/opções **atuais** pelo conector ou gh; não confiar em project-config.json histórico para inventar um status. Não criar Project ou campos novos sem necessidade. Se não houver permissão, manter a tabela e os comentários verificáveis; corrigir a sincronização depois, sem parar implementação. Atualizar só os campos deste trabalho, sem apagar discussão humana.

Aceito na milestone não é entregue na develop. Usar o status disponível mais fiel e comentário que distinga os dois. Não mapear silenciosamente aceito para Done se isso sugerir entrega final. Após a revisão humana final, fechar as issues realmente entregues e liberar relações bloqueadoras nativas correspondentes. Não apagar edges do grafo para aparentar progresso. Um histórico de nova execução pode ser marcado com `<!-- desktop-meta-v2:MN.XX -->` no comentário próprio e atualizado, evitando spam.

## PR consolidado e encerramento

Quando todos os pacotes realmente concluídos estiverem integrados, executar checks agregados e revisar o diff completo contra develop. Criar PR `MN: entrega consolidada para aceite` para develop, com tabela issue → PR → squash → evidência, resumo de decisões e limitações, instruções de teste e rollback. Draft enquanto incompleto. Somente apresentar como pronto quando os gates forem satisfeitos; se houver evidência externa pendente, declarar explicitamente e não pedir um aceite de milestone completa.

O usuário faz ou autoriza o squash final. Depois, o principal verifica a árvore/revisão final realmente entregue, fecha apenas as issues correspondentes com evidência e comunica o próximo prompt. Se develop avançou entre review e merge, atualizar e revalidar o conjunto antes do aceite; não declarar equivalência por título do PR.

Não chamar o finalize do controlador antigo nem reutilizar seu SQLite. O estado verificável é GitHub + Git + relatórios do Desktop. Não fechar PR #79, apagar branches antigas, reverter PRs históricos ou aplicar seu conteúdo automaticamente como parte deste kit.
