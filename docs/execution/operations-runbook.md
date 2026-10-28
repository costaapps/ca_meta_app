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

