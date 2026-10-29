# M1.09 — Minimização, consentimento e retenção

**Natureza:** proposta para orientar implementação e aceite; não é política legal aprovada nem autorização para coletar histórico. Finalidades legais, jurisdições, contratos de clientes, localização, legal hold e durações obrigatórias estão **Not confirmed**. Antes da produção, dono dos dados/Produto, Jurídico/privacidade e contratos de clientes devem aprovar finalidade, base/consentimento aplicável, prazo e expurgo por classe.

## Regras comuns

- Coletar somente o necessário para onboarding, roteamento, entrega, suporte e auditoria. Payload bruto, mensagem, mídia e identificadores diretos não entram em logs/labels; raw_ref aponta para armazenamento cifrado restrito e separado.
- Prazos abaixo são limites de desenho para estimativa e precisam de ratificação. Não ativar classe sem política versionada, dono, relógio de expiração e prova de purge. Sem política, não coletar conteúdo opcional e reter só metadados mínimos para concluir operação segura.
- Expiração remove cópias quentes, índices, caches e referências; backups expiram na própria janela. Tombstone mínimo impede replay/reimport indevido pelo horizonte necessário. Legal hold suspende expurgo somente com base documentada, escopo mínimo, aprovador e auditoria; aplicação e duração legal **Not confirmed**.
- Retirada de consentimento bloqueia nova coleta e agenda exclusão de conteúdo opcional e derivados; manter registro mínimo da retirada e obrigações aplicáveis. Não prometer apagar efeito já entregue ao provedor.
- Segredo Meta não é dado histórico de mensagem. Guardar no backend/cofre, com referência cifrada por autorização; nunca registrar valor. Retenção segue autorização ativa/rotação, revogação e reconciliação. Prazo de versões inativas **Not confirmed** até dependências de auditoria/restore serem definidas.

## Classes propostas

| Classe / finalidade | Minimização e consentimento | Limite de desenho (proposta, não aprovada) | Ação no vencimento / lacuna |
|---|---|---|---|
| Dados operacionais (status, tentativas, tempos, safe error, IDs internos) | Guardar códigos e timestamps; sem body, token, telefone ou texto livre | até 90 dias em armazenamento quente | agregar/redigir e apagar; prazo contratual/legal e agregados reidentificáveis **Not confirmed** |
| Webhook bruto / referência de inbox | Validar assinatura, persistir mínimo para roteamento/replay; body cifrado e acessível só ao ingress/worker autorizado | até 24 h para raw; envelope minimizado e estado dedupe separados pelo tempo mínimo ainda a definir | apagar blob/chave/ref; preservar tombstone/idempotency sem PII; replay Meta/contratos **Not confirmed** |
| Eventos de mensagem, mídia e histórico/echo opcional | **Desativado por padrão.** Opt-in explícito separado por tenant/canal/finalidade, texto claro, pessoa autorizada, instante/versão de termos e withdrawal. Consentimento não substitui confirmação de base legal/contrato | somente após aprovação: no máximo 30 dias, 10.000 itens por tenant e 1 GiB por tenant (primeiro limite); política de excedente a ratificar | bloquear nova ingestão ao atingir quota; não truncar silenciosamente; purge de conteúdo, mídia e derivados; consentimento/limites/direito de retenção **Not confirmed** |
| Auditoria de segurança/operação | Append-only redigida: ator-ref pseudônimo, ação, alvo-ref, correlation ID e diff allowlisted; nunca segredo/body Meta/mensagem | até 365 dias como proposta | purge após revisão de obrigação/legal hold; conteúdo e período legal obrigatório **Not confirmed** |
| Sessão e estado transitório de onboarding | Hash/nonce/referência; estado/code efêmero fora de logs, cookie seguro, expiração explícita; sem cookie/token em claro | inativa proposta 30 min; absoluta proposta 8 h; resíduos no máximo 24 h após expiração | revogar/limpar nonce, state e referência; limites Suite4/UX antes de M3 **Not confirmed** |
| Credencial Meta cifrada e chave | Só backend/cofre, acesso scoped, rotação versionada; sem consentimento de histórico como condição da credencial operacional | enquanto autorização vigente, até revogação/expiração observada; versões antigas após rotação/reconciliação e janela de restore a definir | invalidar acesso na revogação; manter referência/audit mínimo; apagamento provider/contratual **Not confirmed** |
| Backup e artefatos de restore | Backup cifrado e acesso separado; chave compatível; sem export para fixture | 30 dias como hipótese de dimensionamento de storage, não prazo legal aprovado | expirar snapshot/WAL/keys coordenados; janela contratual/regulatória e capacidade do cofre **Not confirmed** |

O teto de histórico limita storage lógico; contabilizar índices, réplicas, WAL, retries, snapshots e backups antes de aprovar quota física. Limite transacional/atômico por tenant evita overshoot concorrente. Fallback é rejeitar nova coleta e alertar, nunca apagar itens recentes sem política.

## Bloqueios de produção

1. Confirmar inventário de campos/destinos com M1.05/M2 e retenção separada para conteúdo, referência e tombstone.
2. Responsável dos dados, Produto, Jurídico/privacidade e contratos de clientes revisam finalidade, opt-in/out, prazo, hold, localização e exclusão. Estado atual: **Not confirmed**; isso não bloqueia trabalho local, mas bloqueia ativar histórico real.
3. Provar purge e exclusão de derivados/backups expirados, incluindo reimport e replay; definir exceções e auditoria.
4. Revisar papéis de acesso, cofre, export e logs; provar que painel/API nunca devolve payload ou segredo.
