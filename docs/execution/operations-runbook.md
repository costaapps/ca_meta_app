# Operação e recuperação do supervisor

## Preparar o runner

Use um ambiente Linux/macOS/WSL dedicado ao repositório, com Git/Python/GitHub CLI/Codex CLI, npm e espaço para worktrees e instalações de dependências por candidato. O processo deve permanecer ativo durante a execução; o navegador ou computador pessoal não é o executor quando o runner é remoto. O supervisor usa a biblioteca padrão do Python e o login salvo do Codex CLI; não depende do SDK TypeScript nem solicita chave de API.

Configure a autenticação fora do código. Não coloque `GH_TOKEN`, chaves de API ou `auth.json` em arquivos versionados, flags visíveis em logs, contexto de agentes ou comentários. Tokens disponíveis ao controlador podem ser lidos por código executado com as mesmas permissões; separação por instruções não é uma fronteira de segurança. Use controles do host/contêiner e privilégios mínimos.

O diagnóstico verifica o que consegue observar. Ele não amplia acesso nem certifica todos os fluxos do provedor. Execute primeiro uma unidade limitada e confira seu PR/evidências antes de deixar uma Milestone rodando por várias horas.

## Estado persistente

Preserve `.orchestrator/` no volume de trabalho. O checkpoint registra execução e referências; os commits e PRs remotos continuam sendo fontes que precisam ser relidas na retomada. Faça backup do estado de forma protegida conforme a operação do runner.

Não apague locks ou edite o SQLite manualmente para forçar progresso enquanto um executor pode estar ativo. O controlador inicial usa lock de arquivo do sistema (`flock`) exclusivo para o repositório, liberado pelo kernel quando o processo termina; não usa um lease renovável nem heartbeat distribuído. Verifique o processo e o último efeito remoto antes de recuperar uma execução. Dois controladores não podem operar ao mesmo tempo sobre o mesmo estado.

## Interrupção e retomada

Ao receber interrupção, preserve checkout e estado. Não realize reset destrutivo para “limpar” a tentativa. Execute `status` e `report`, examine a última ação e use `resume` para reconciliar estado/PR/checks antes de continuar.

Para solicitar uma pausa entre unidades de execução, crie `.orchestrator/PAUSE`. O controlador verifica o sinal no ciclo; isso não interrompe imediatamente um turno em andamento. `resume --execute` remove o sinal e retoma pelas validações e limites existentes. Uma interrupção de subprocesso pode deixar o consumo desconhecido; trate esse estado antes de tentar outro turno.

```bash
python3 -m tools.orchestrator status M1
python3 -m tools.orchestrator report M1
python3 -m tools.orchestrator resume M1 --execute --merge-packages --max-seconds 14400
```

O processo deve terminar de forma controlada quando alcança orçamento, limite de tentativas, gate final, ausência de trabalho elegível ou bloqueio não resolvível. Retomar não deve ignorar esses limites nem criar um loop de “continue” sem progresso.

## Limites de consumo

`max_total_tokens` soma o consumo informado pelo transporte e é conferido entre turnos. Um único turno pode ultrapassar o saldo restante antes de retornar. O parâmetro não representa preço em dinheiro; preços, limites da conta e execução interna do modelo continuam externos ao supervisor.

### Modelo explícito e execução sem teto de tokens

O transporte agora envia `--model gpt-6-luna` e `-c model_reasoning_effort="xhigh"` em cada processo, incluindo revisões. Esses são valores solicitados, não uma certificação de disponibilidade na conta; um modelo/esforço não suportado deve falhar, sem fallback implementado pelo supervisor. A opção `--reasoning-effort` permite usar o valor exato anunciado pelo cliente/modelo (inclusive `ultra`, se disponível). Referência: https://learn.chatgpt.com/docs/config-file/config-reference.

Para dispensar apenas o teto acumulado nesta invocação:

```bash
python3 -m tools.orchestrator resume M1 --execute --once --no-token-limit --model gpt-6-luna --reasoning-effort xhigh
```

Repita `--no-token-limit` em cada retomada; sem a flag, vale o teto da política. O consumo continua acumulado e o evento `runtime_settings` registra os parâmetros solicitados. A flag não modifica a política fixada, não zera tentativas e não remove timeouts, revisões, gates de evidência ou limites do provedor. A contabilização de entrada pode incluir contexto repetido ao longo dos turnos; não equivale a tokens únicos nem a uma medida de custo monetário.

### Aplicar o executor corrigido a uma M1 já iniciada

Não faça pull/merge na `develop` durante a execução fixada. A atualização dessa base exige reconciliação e não é autorizada pela flag de tokens. Para o incidente iniciado no commit `7b3b38b`, revise o PR da branch de manutenção e carregue seu código em uma worktree separada, mantendo o checkout controlador original intacto:

```bash
cd /mnt/c/VsCodeRepos/ca_meta_app
git fetch origin fix/orchestrator-model-token-runtime
mkdir -p "$HOME/.local/share/ca-meta"
git worktree add --detach "$HOME/.local/share/ca-meta/runner-token-fix" origin/fix/orchestrator-model-token-runtime
cd "$HOME/.local/share/ca-meta/runner-token-fix"
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app resume M1 --execute --once --no-token-limit --model gpt-6-luna --reasoning-effort xhigh
```

Execute no terminal com o ambiente Python e ssh-agent carregados. Se a worktree já existir, não repita sua criação: entre nela e confira o commit. O diretório atual deve ser a worktree do executor atualizado para o Python carregar o módulo correto; `--root` aponta para o checkout com o estado original. A retomada preserva o trabalho e repete as verificações da tentativa interrompida, consumindo uma nova tentativa. Os 760142 tokens anteriores permanecem registrados. Aguarde o gate humano da M1 antes de integrar a manutenção em `develop`; mover a base durante a M1 continua bloqueando a execução. Não há migração automática da base nesta correção.

Quando um turno terminar sem evento de consumo utilizável, o estado fica `usage_unknown` e bloqueia a retomada. Confira o consumo nos registros oficiais da conta/execução, escolha um valor adicional conservador e registre a justificativa:

```bash
python3 -m tools.orchestrator account-usage M1 --tokens 50000 --reason "Consumo adicional conservador reconciliado pelo operador para a execução interrompida"
```

O número do exemplo não é recomendação de orçamento nem medida de um turno real. Use o valor apropriado à ocorrência. O comando acrescenta tokens ao acumulado; ele não zera consumo, reinicia tentativas ou remove uma restrição de orçamento. O evento fica no checkpoint.

## Manter uma execução num runner Linux

Após conferir `doctor --online`, insumos e uma primeira unidade supervisionada, um host com systemd de usuário pode manter o processo fora da sessão do terminal. Este é um exemplo de lançamento, sem instalar serviço persistente ou configurar credenciais:

```bash
systemd-run --user --unit=ca-meta-m1 \
  --property="WorkingDirectory=$PWD" \
  --setenv="PATH=$PATH" --collect \
  /usr/bin/python3 -m tools.orchestrator resume M1 \
  --execute --merge-packages --max-seconds 14400
```

O host precisa permitir que o gerenciador de usuário continue ativo conforme sua política de sessão. Não habilite restart infinito: uma saída pode indicar consumo desconhecido, bloqueio de segurança ou gate humano. Confira `systemctl --user status ca-meta-m1` e o checkpoint antes de relançar o comando. Em macOS/WSL sem systemd, use o gerenciador de processos já autorizado do host ou mantenha o processo no terminal do runner.

Há também um template versionado em `execution/meta-orchestrator@.service`. Antes de usá-lo, revise `WorkingDirectory`, a localização dos binários em `PATH` e a política de sessão do host; o exemplo usa `~/ca_meta_app`. Copie-o para `~/.config/systemd/user/`, execute `systemctl --user daemon-reload` e inicie `systemctl --user start meta-orchestrator@M1`. O template permite no máximo três reinícios em dez minutos, encerra no gate/bloqueio e usa `run` para respeitar um sinal `PAUSE` preservado. Nenhum serviço é instalado ou ativado pelo PR.

## Fornecer evidência externa sanitizada

Pacotes marcados `external` exigem um registro local `.orchestrator/inputs/M1.01.json` (troque a chave para o pacote correspondente). O registro contém `task`, `verified_by` e `references` com caminhos relativos à pasta `inputs` e o SHA-256 real de cada arquivo:

```json
{
  "task": "M1.01",
  "verified_by": "identidade do responsável que conferiu o material",
  "references": [
    {"path": "m1-01-inventory.md", "sha256": "SHA-256 real do arquivo sanitizado"}
  ]
}
```

O exemplo mostra o formato; substitua a impressão digital pelo valor real. Calcule com `python3 -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path(".orchestrator/inputs/m1-01-inventory.md").read_bytes()).hexdigest())'`. Os arquivos precisam existir dentro de `inputs`; referências externas, conteúdo acima do limite de tamanho por documento e sinais conhecidos de segredo são rejeitados. Se o documento mudar, atualize seu hash e revalide o pacote.

O conteúdo sanitizado é inserido no contexto do agente com caminho e impressão digital; o agente não recebe acesso irrestrito ao diretório de insumos. `verified_by` é uma atestação registrada pelo operador, sem assinatura criptográfica: o responsável deve realmente conferir a origem e suficiência da evidência. O filtro de padrões de segredo não garante sanitização completa.

## Diagnóstico de bloqueios

Arquivos de catálogo, TOML, evidências e relatórios são UTF-8. O controlador e os scripts de planejamento declaram essa codificação explicitamente, incluindo a comunicação com subprocessos. Isso evita o erro `charmap`/CP1252 no Windows; não é necessário converter ou regravar o manifesto. Para execução completa, use Linux/macOS/WSL: o lock de processo usa `flock`, indisponível no Windows nativo.

| Situação | Ação |
|---|---|
| Codex/gh ausente ou sem autenticação | Configurar o runner pelo mecanismo oficial e repetir `doctor` |
| Acesso negado a Project | Usar o acesso organizacional já autorizado; manter falha de sincronização visível |
| Campo/opção Status não corresponde | Revisar mapeamento em configuração aprovada; não inventar status Done |
| PHP, DDL ou contrato Suite4 ausente | Obter inventário sanitizado/evidência do responsável |
| Documentação Meta indisponível | Registrar fonte/data e pendência; repetir consulta autorizada posteriormente |
| CI falhou | Corrigir causa dentro do pacote e executar novamente os checks afetados |
| Base/head divergiu | Reconciliar alterações, produzir novo commit e invalidar pareceres antigos |
| Merge recusado | Preservar PR e motivo; não trocar squash, usar bypass ou alterar proteção |
| Resposta de merge ambígua | Consultar o PR e o commit remoto antes de qualquer nova tentativa |
| Limite de uso, tempo ou tentativas | Registrar checkpoint e revisar o próximo orçamento pelo operador |
| Possível segredo em saída | Parar publicação, limitar acesso e tratar rotação com o responsável |

O comando de desbloqueio registra a decisão e o motivo; não transforma uma prova ausente em aceite. Após fornecer a evidência/corrigir a causa:

```bash
python3 -m tools.orchestrator unblock M1 --issue M1.01 --reason "Evidência sanitizada disponibilizada; revalidar a tentativa"
```

Tentativas anteriores são preservadas. Se o limite tiver sido esgotado e o responsável aprovar um novo lote, adicione `--reset-attempts` com uma justificativa: o contador volta a zero, mas o histórico de eventos e consumo permanece. Uma nova tentativa não altera os paths permitidos nem resolve uma divergência de base automaticamente.

## Fechamento da etapa

Revise o relatório e o PR consolidado contra a epic da Milestone. Exija resultados reais e riscos remanescentes explícitos. O controlador não integra o PR final em `develop`, não fecha as issues automaticamente antes desse aceite e não inicia a próxima Milestone por conta própria.

Depois da integração humana por squash, execute `python3 -m tools.orchestrator finalize M1 --execute`. O controlador verifica o PR e a árvore final antes de fechar somente as issues e a epic da etapa; isso libera os pré-requisitos da próxima Milestone. A verificação tolera a exclusão da branch de origem pelo GitHub; preserve o checkpoint e os objetos Git locais. Ele não realiza o merge final. Deploy, permissões, migrações operacionais e alterações Meta de produção exigem os procedimentos próprios das etapas do plano; preparar o código não autoriza essas ações.


## Retomar M1.01 após erro de identidade e correção do ambiente

A branch `fix/orchestrator-model-token-runtime` também fixa `task`, `role` e `revision` por enum no schema de cada chamada, sem normalizar respostas incorretas nem relaxar `check_result`. O modelo padrão corrigido é `gpt-6-luna`, esforço `xhigh`.

No WSL, sem controlador ativo, atualize somente a worktree do runner. Não faça pull na develop fixada:

```bash
cd /mnt/c/VsCodeRepos/ca_meta_app
git fetch origin fix/orchestrator-model-token-runtime
cd "$HOME/.local/share/ca-meta/runner-token-fix"
git switch --detach origin/fix/orchestrator-model-token-runtime
```

`git switch` deve ser usado sem force; se houver modificações, inspecione antes. Crie uma nota sanitizada no checkout controlador. Ela comunica o relato do operador, não certifica resultados nem substitui evidência externa:

```bash
cat > /mnt/c/VsCodeRepos/ca_meta_app/.orchestrator/operator-m1-01.txt <<'NOTE'
Contexto informado pelo operador em 2026-10-28:
- Os quatro PHP versionados estão presentes no checkout e na worktree M1.01: connect_facebook.php, connect_instagram.php, connect_whatsapp.php e meta_auth_helper.php, sob backend/.
- connect.php não aparece nos dois checkouts. connect_old.php é local/não versionado; não copiar, versionar ou ler esse arquivo sem autorização específica.
- Na worktree M1.01, npm ci --ignore-scripts concluiu; npm run build passou; npm test -- --watch=false passou com 5 testes em 2 arquivos. Verificar novamente os resultados necessários e registrar o ambiente/commit.
- npm ping funcionou no terminal do operador. Isso não prova acesso à rede dentro do sandbox do agente. Se o sandbox impedir comandos, informar comando e causa exatos; não repetir descoberta indefinidamente.
- Inspecionar e preservar os documentos da tentativa anterior. Separar fonte versionado de implantação não confirmada. Não inventar regras rewrite, consumidores externos, DDL ou evidência Meta.
- As evidências externas exigidas continuam pendentes; registrar uma lista concreta e mínima para o operador, sem apresentar os PHP versionados como ausentes.
NOTE
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app unblock M1 --issue M1.01 --reset-attempts --context-file /mnt/c/VsCodeRepos/ca_meta_app/.orchestrator/operator-m1-01.txt --reason "Contrato de identidade e modelo corrigidos; ambiente validado pelo operador; renovar tentativas mantendo auditoria"
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app resume M1 --execute --once --no-token-limit --model gpt-6-luna --reasoning-effort xhigh
```

`--context-file` está disponível em `unblock`: lê UTF-8 até 20000 bytes, rejeita contexto vazio e padrões conhecidos de credenciais, salva texto/hash no checkpoint e registra hash no evento. Esse filtro não detecta todo segredo; sanitizar manualmente antes. A nota chega ao implementador e às revisões na tentativa seguinte. Não é um chat ao vivo; editar o arquivo depois não altera o texto já registrado. Para fornecer outra nota, usar um novo desbloqueio explícito de tarefa bloqueada. `--reset-attempts` renova a contagem, mantendo eventos e evidências anteriores.

A M1.01 canônica tem `external: true` e exige reconciliação operacional, especialmente roteamento WhatsApp. Sem `.orchestrator/inputs/M1.01.json` e referências sanitizadas verificáveis, o controlador não aceita o pacote mesmo que o agente retorne pass. A correção permite descoberta e comunicação melhores; não garante liberação das dependências sem os insumos externos. Não criar atestados fictícios para passar pelo gate. O DDL só pode ser tratado como requisito comprovado quando ligado a contrato/cenário realmente dependente; não transformar qualquer informação histórica ausente em exigência nova de aceite.

## Emenda explícita: descoberta para substituição do PHP

Decisão do operador em 2026-10-28: o backend novo substitui PHP e usa os quatro PHP versionados como referência funcional dos fluxos separados. A investigação exaustiva do ambiente antigo não bloqueia a descoberta do repositório. O operador forneceu listagem, fonte e rewrite da Hostinger; este PR registra somente o resumo sanitizado, sem copiar o fonte operacional anexado ou identificadores de hospedagem.

`execution/m1-baseline-amendment.json` é a emenda versionada ao contrato da M1.01. Não altera as outras 65 tarefas nem declara paridade, DDL, consumidores, permissões Meta ou implantação certificados. Lacunas reais bloqueiam o cenário dependente de migração/corte. M1.02 e outros pacotes mantêm suas próprias exigências; esta emenda não promete execução de M1–M6 sem insumos.

Para a execução existente, atualizar somente a worktree runner e então executar uma vez:

```bash
cd /mnt/c/VsCodeRepos/ca_meta_app
git fetch origin fix/orchestrator-model-token-runtime
cd "$HOME/.local/share/ca-meta/runner-token-fix"
git switch --detach origin/fix/orchestrator-model-token-runtime
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app amend-baseline M1 --execute --reason "Autorizo substituir PHP; descoberta usa backend versionado e pendências operacionais ficam no cenário de migração dependente"
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app unblock M1 --issue M1.01 --reason "Retomar sob contrato de descoberta revisado; preservar entregas e evidências anteriores"
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app resume M1 --execute --once --no-token-limit --model gpt-6-luna --reasoning-effort xhigh
```

O comando de emenda não roda agentes nem desbloqueia automaticamente. Exige lock exclusivo, M1 existente com catálogo/política/base originais, consumo conhecido e nenhum pacote M1 em execução/revisão, aceito ou com PR. Verifica o hash exato da tarefa de origem, faz backup SQLite, registra hashes antigo/novo e motivo, e atualiza atomicamente o catálogo efetivo fixado. Preserva tokens, tentativas, trabalho local, feedback e base Git. Sem `--execute` é apenas diagnóstico. Repetir a adoção é rejeitado; depois da confirmação basta retomar/desbloquear quando apropriado.

Cada construção do controlador recarrega a emenda registrada e verifica seus hashes contra o runner revisado. Portanto use esta versão do executor também para status, retomada e finalização; o executor antigo não conhece a emenda. O manifesto original permanece intacto, com o adendo explícito no checkpoint e neste arquivo versionado. Não editar hashes SQLite manualmente. Esta ferramenta não migra develop e não invalida aprovações existentes: recusa o caso antes que haja aceitação/PR. Uma evolução futura do contrato precisa de nova reconciliação revisada.

O relatório de uma tarefa bloqueada agora substitui o motivo antigo de desbloqueio pelo resumo atual do agente. A decisão e os critérios efetivos são enviados no pacote de contexto a todos os revisores.

## Recuperar mudança de CRLF/LF da validação legada

O validador `.planning/validate.py` gera arquivos como efeito colateral. `csv.writer` usa CRLF por padrão; o CSV rastreado pode estar em LF. O supervisor agora executa essa etapa através de `planning_check.py`, que compara os quatro artefatos gerados com o conteúdo existente, normalizando CRLF/LF sem escrever nenhum deles. Conteúdo divergente ou tentativa de escrever outro destino falha. O registro da validação inclui o comando original e o efetivamente executado. O gate de worktree limpa continua ativo, sem mudança de política ou checkpoint.

Após atualizar a worktree runner, restaure somente a variação de fim de linha confirmada, com o controlador parado:

```bash
python3 - <<'PY'
from pathlib import Path
import subprocess
root = Path('/mnt/c/VsCodeRepos/ca_meta_app/.orchestrator/worktrees/M1.01')
name = 'docs/meta-v2/acceptance-matrix.csv'
original = subprocess.run(['git', 'show', 'HEAD:' + name], cwd=root, check=True, capture_output=True).stdout
path = root / name
if path.read_bytes().replace(b'\r\n', b'\n') != original.replace(b'\r\n', b'\n'):
    raise SystemExit('Conteúdo diferente do commit: nenhum arquivo foi alterado; revisar manualmente.')
path.write_bytes(original)
print('CSV restaurado aos bytes do commit; nenhuma alteração de conteúdo descartada.')
PY
```

Só depois do sucesso, `unblock M1 --issue M1.01 --reason "Validação do planejamento agora é somente leitura; CSV reconciliado por igualdade de conteúdo"`, seguido do `resume` habitual com modelo, esforço e opção de orçamento explícitos. Não renovar tentativas sem necessidade; a ocorrência relatada estava na tentativa 2 de 3. Não repetir `amend-baseline`, pois a emenda já está registrada.

## Revisões somente leitura e evidência executada pelo supervisor

Antes de chamar os revisores, o supervisor executa o perfil de validação no candidato, exige worktree limpa e fornece `context.validation` com comando, resultado e SHA. Os revisores continuam somente leitura: inspecionam diff, critérios, fontes, fixtures e suficiência dos checks. Não devem tentar `npm ci`, builds, geradores ou suítes que exigem arquivos temporários nessa sessão. Devem atribuir os resultados ao supervisor e exigir SHA correspondente, status passed e cobertura suficiente; ausência ou insuficiência continua bloqueando. Uma tentativa redundante impedida por EROFS não invalida checks reais e correspondentes do supervisor. Esta correção não concede escrita ao validador nem aceita relato do implementador como teste executado.

Relatórios rastreados identificam o commit da baseline testada e rotulam snapshots anteriores como históricos. O SHA final do documento só existe depois de commitá-lo: a proveniência final é registrada pelo checkpoint e pelo PR, sem tentar embutir no arquivo o hash do próprio commit.

Quando reviews retornarem correções, o relatório passa a mostrar o resumo dos resultados não aprovados, sem reutilizar o motivo antigo de desbloqueio. `unblock --reset-attempts` agora aceita também estado retry; sem essa autorização explícita não renova o orçamento. Nunca se aplica a tarefas running, reviewing, pr_pending ou accepted.

Para recuperar a rodada de M1.01 em retry/attempt=3, atualize a worktree runner. Acrescente ao arquivo de contexto do operador: corrigir oito fixtures com handler (não sete), rotular SHA 2bc3bee como snapshot histórico sem chamá-lo de HEAD final e referenciar a proveniência final do supervisor; acrescentar cenários explícitos de replay após consumo do state e cancelamento. Execute unblock com --reset-attempts, --context-file e motivo; depois resume --execute --once --no-token-limit --model gpt-6-luna --reasoning-effort xhigh. Não repetir amend-baseline, descartar alterações ou editar resultados dos revisores. O próximo implementador recebe os três pareceres via previous_attempt e todas as validações/revisões são executadas novamente sobre o novo SHA.

## Trace offline como evidência por SHA e execução contínua

Quando `experiments/baseline/trace_routes.py` está presente no candidato, o supervisor executa `python3 experiments/baseline/trace_routes.py` além do perfil de validação, antes das revisões individuais e da revisão agregada. Registra comando, status e SHA no mesmo conjunto de checks. Falha é ValidationFailure, sem PR nem aceite; revisores continuam verificando a suficiência dos cenários. A ausência do arquivo não é evidência de execução: continua sujeita ao contrato/critério do pacote. A presença do trace nas próximas milestones também mantém esse check ativo. Não altera política fixada nem hashes da emenda.

Uma sessão com --once encerra após um ciclo, incluindo eventual resultado retry. Para deixar o controlador repetir correções/revisões e integrar pacotes aprovados por squash sem pedir um novo comando a cada ciclo, remova --once e autorize --merge-packages explicitamente. Exemplo, executado no runner atualizado:

```bash
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app resume M1 --execute --merge-packages --no-token-limit --model gpt-6-luna --reasoning-effort xhigh --max-seconds 14400
```

Isso autoriza squash somente na branch da milestone, nunca develop. Mantém limite de tentativas, timeout por agente, limite de 4 horas por invocação, evidências, revisões e gate humano final. No estado retry/attempt=1 não precisa executar unblock nem resetar tentativas. O supervisor pode parar antes por gate externo de outra issue, orçamento de tempo/tentativas, falha de GitHub ou validação; não garante uma milestone sem intervenção. As correções desta seção não descartam trabalho nem alteram histórico.

## Recuperação por etapa e descoberta independente (revisão consolidada)

A atualização preserva PAUSE: instalar código/adotar escopo não inicia o controlador. Não atualizar arquivos do runner enquanto existir controlador ativo. O novo executor usa a identidade Git configurada para commits futuros (verificada por git var); não altera autoria de commits existentes. Removida a identidade fixa Meta automation/automation@users.noreply.github.com.

Cada candidato registra stage=validate/review/publish, SHA e hash do contexto. Na retomada limpa e com mesma base, SHA e contexto, não chama novamente o implementador. Checks e reviews concluídos são reaproveitados somente quando a assinatura do gate corresponde a tarefa, contexto, política, modelo/esforço e código do runner/transport. Um SHA novo invalida as aprovações; achados que exigem edição voltam ao implementador. Interrupção na validação ainda repete o perfil de checks; não existe checkpoint por comando nesta versão. Publicação pode ser repetida idempotentemente após falha com até quatro falhas de transporte; não repete implementação e reviews válidos. Verificações de branch, árvore, escopo e squash permanecem obrigatórias.

O schema vincula identidade e quantidade/índices dos critérios. Resultados inválidos têm até duas chamadas de reparação de JSON, em sandbox somente leitura, com uso contabilizado; nunca se preenchem critérios como pass por programação. Se a reparação continuar inválida, a tarefa permanece bloqueada. Consumo desconhecido continua exigindo reconciliação. Avisos advisory não devem reprovar critérios satisfeitos; achados realmente bloqueantes são encaminhados na tentativa seguinte dentro do orçamento existente.

Pesquisa de documentação é solicitada com web_search="live" em cada processo, independente de conectores. Referência oficial: https://learn.chatgpt.com/docs/web-search. Disponibilidade continua sujeita ao cliente, modelo e requisitos gerenciados. Não é garantia de acesso a qualquer página, nem autorização para enviar dados privados às buscas. Pesquisa deve usar documentação primária pública e não exige Sandbox Meta. Um Sandbox Meta só fornece prova de integração real; fixtures não substituem essa prova.

A emenda execution/m1-discovery-amendment.json redefine somente M1.02/M1.03 para projeto de banco/mapeamento e matriz Meta/compatibilidade com fontes, hipóteses e fixtures verificáveis. Não bloqueia desenho independente por falta de DDL/configuração Meta/Sandbox, mas mantém evidência real antes do cenário operacional dependente. Não altera as outras tarefas nem finge que a milestone inteira está concluída. Outros contratos que exijam dados reais podem exigir decisões adicionais; não há promessa de execução que nunca pare.

Para aplicar enquanto pausado:

```bash
cd /mnt/c/VsCodeRepos/ca_meta_app
git fetch origin fix/orchestrator-model-token-runtime
cd "$HOME/.local/share/ca-meta/runner-token-fix"
git switch --detach origin/fix/orchestrator-model-token-runtime
python3 -m tools.orchestrator --root /mnt/c/VsCodeRepos/ca_meta_app amend-discovery M1 --execute --reason "Desenvolvimento independente autorizado; documentação oficial e fixtures agora, prova operacional antes do cenário dependente"
```

O comando exige checkpoint/política/base compatíveis, nenhuma tarefa M1 running/reviewing e nenhuma tarefa alvo já aceita/com PR. Faz backup, registra hashes/motivo e muda os alvos bloqueados para retry preservando consumo e contagem. Mantém M1.01 accepted integralmente. Não remove PAUSE, executa agentes, pesquisa nem toca produção. Executar uma única vez. Não repetir amend-baseline. Os dois adendos são verificados em sequência por todos os controladores novos.

Quando autorizado a executar, usar o mesmo resume contínuo com --execute --merge-packages --no-token-limit --model gpt-6-luna --reasoning-effort xhigh --max-seconds 14400. Esse comando remove PAUSE e reinicia agentes. Limites de tempo/tentativas/conta e gates de integridade continuam existindo; o modo contínuo não é execução infinita. Aceite final da milestone e deploy permanecem humanos. Não misturar atualização da develop com checkpoint ativo.

## Checks dos experimentos por pacote e recuperação sem reimplementar

O supervisor agora descobre entrypoints Python com `if __name__ == '__main__'` em experiments/ e suítes test_*.py em experiments/ e tests/. Executa cada entrypoint e unittest discover por diretório, antes das revisões, registrando comando/status/SHA. Não executa automaticamente helpers sem entrypoint. Usa argv literal, não shell, mantém ambiente sanitizado, timeout e gate de worktree limpa. Os experimentos devem ser offline conforme o contrato dos agentes; esta descoberta não prova ausência de efeitos externos em código arbitrário. Os comandos usam as mesmas permissões de validação já autorizadas para o candidato, como os scripts npm. Revisores verificam suficiência de cobertura; comandos equivalentes de discovery são aceitos quando incluem os testes exigidos.

O implementador não pode esperar o registro do SHA pós-edição antes da entrega: isso cria ciclo impossível. Ele entrega o candidato pronto e evidencia verificações locais com atribuição correta; o supervisor cria o commit e valida o SHA final. Não pode declarar checks inexistentes como executados. Essa divisão é explícita no prompt.

Para candidatos existentes que só aguardam checks/revisões, `recheck M1 --issue M1.02 --execute --reason ...` fila validação sem chamar implementador nem consumir nova tentativa de implementação. Requer blocked/retry, base de integração atual, branch/HEAD conhecidos, escopo permitido, consumo conhecido e ausência de PR. Preserva arquivos permitidos e os commita se necessário com a identidade Git configurada, invalidando gates anteriores. Evidência externa obrigatória não é dispensada. Registra evento, mantém PAUSE e não inicia agentes.

Após atualizar o runner parado, recupere M1.02 e M1.03 com recheck (uma por vez; conferir sucesso), em seguida retome continuamente. Não resetar SQLite, não repetir emendas e não renovar tentativas para essa recuperação. Se outra issue já tiver sido integrada e mudado a base, recheck recusa em vez de rebasear/descartar trabalho automaticamente; reconciliar a integração nesse caso. Não executar recheck durante controlador ativo.
