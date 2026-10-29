# M1.09 — NFR, SLO e recuperação

**Issue:** [#16](https://github.com/costaapps/ca_meta_app/issues/16). Metas propostas para dimensionamento, não medidas nem SLA aprovado. O documento 06 lista hipóteses iniciais; esta tabela as torna observáveis. Volume, infraestrutura, orçamento, quotas e comportamento operacional real permanecem **Not confirmed**. Sem datas de entrega.

## Indicadores e ações

Um SLO só se torna compromisso após dono funcional, janela, instrumentação e orçamento de erro ratificados. Medir por rota/finalidade/coorte, sem tenant, telefone, token ou mensagem como label.

| Serviço / SLI | Alvo de trabalho | Janela e população | Fonte / cálculo | Ação ao exceder |
|---|---|---|---|---|
| API: disponibilidade | ≥99,9% de sucesso elegível (hipótese do documento 06) | janela móvel de 30 dias; excluir 4xx de entrada inválida | ingress/API: requests elegíveis sem 5xx nem timeout ÷ requests elegíveis | abrir incidente quando orçamento de erro for consumido; parar expansão e reverter coorte se regressão ligada ao release |
| API síncrona: latência | p95 ≤500 ms (hipótese) | janela móvel de 5 min, por rota elegível; excluir espera deliberada por Meta | histogramas server-side do recebimento à resposta; trace amostrado e redigido | procurar dependência/pool saturado; limitar concorrência ou pausar coorte; não aumentar timeout para esconder saturação |
| Webhook: ACK durável | p95 <1 s e p99 <3 s (hipóteses condicionadas ao contrato Meta vigente) | janela móvel de 5 min, entrega válida; separar inválidos/rejeições | ingress mede primeiro byte até ACK após validar e persistir inbox durável | priorizar persistência antes do ACK, acionar fila/DB runbook e interromper troca de rota se durabilidade falhar; nunca ACK sucesso após descarte |
| Evento: atraso até resultado interno | p95 ≤30 s (valor proposto para “dezenas de segundos” no documento 06) | janela móvel de 15 min por lane | timestamps de InboxEvent/SyncJob, idade do item mais antigo e backlog; reportar quarentena separadamente | pausar aumento de entrada/coorte, verificar DB e limites Meta, preservar backlog e escalar lane conforme drain calculado |
| Projeção Suite4: atraso | p95 ≤60 s (hipótese) | janela móvel de 15 min por destino/lane | outbox/checkpoint: now menos created_at de evento ainda não aplicado; sucesso exige avanço de versão | isolar destino lento, manter outbox/checkpoint, pausar expansão do destino e reconciliar sem reordenar tombstones |
| Fila: idade de backlog | item mais antigo ≤60 s em regime nominal (hipótese) | amostra por minuto; alertar 5 amostras consecutivas acima do alvo | idade na fila e estado durável de lease/retry/dead-letter; acompanhar chegada, serviço e drain estimado | verificar worker/DB/pool; aplicar backpressure, preservar inbox/outbox; escalar/pausar coorte se capacidade ≤ chegada |
| Backup funcional: RPO | ≤15 min (hipótese do documento 06, condicionada a DB e recuperação de chave) | distância da última gravação confirmada recuperável ao ponto de falha; cada exercício | ledger de backup e manifesto de chaves; restore de segredo-canário sintético prova decriptação | bloquear cutover se ponto/versão da chave divergir; recuperar e reconciliar inbox/outbox antes de liberar gravações |
| Serviço restaurado: RTO | ≤60 min (hipótese do documento 06, condicionada a DB, chaves, fila e dependências) | início declarado do incidente até API/worker prontos e invariantes reconciliadas; cada exercício | cronômetro e checklist de restore isolado, incluindo atraso de projeção | manter manutenção/backpressure e priorizar restore seguro; não declarar recuperação só porque API responde |

Alvos não estão ratificados. População elegível, exclusões, destino de projeção e objetivos de produto precisam do aceite de Produto/Operação/SRE. Quota/latência Meta não é controlada pelo serviço; erro externo tem indicador separado, retry/backoff limitado e UNKNOWN não conta como sucesso.

## Recuperação por dependência

RPO/RTO são hipóteses iniciais somente se o runbook provar a cadeia completa. Snapshot isolado do banco sem chaves não é backup funcional. Nenhum número certifica serviço existente.

| Dependência | RPO proposto | RTO proposto | Prova / recuperação |
|---|---|---|---|
| Banco central (autorização, inbox/outbox, auditoria, writer ledger) | ≤15 min | ≤60 min | snapshot/PITR consistente e posição conhecida; restaurar isolamento, versões, unicidade e tombstones; reconciliar itens desde o ponto recuperado |
| Chaves e cofre (DEK/KEK, versões, grants) | sem perda da versão que cifra o dado recuperado; casar chave e snapshot | disponível em 60 min, acesso testado | cópia cifrada/versionada fora do domínio do backup de dados, least privilege a definir; restaurar chave antes de declarar DB utilizável; sem chave o ciphertext é irrecuperável |
| Fila durável / leases / dead-letter | ≤15 min se item aceito estiver no inbox/outbox transacional | ≤60 min para consumidores prontos; backlog drena conforme equação | fila volátil reconstrói de inbox/outbox/checkpoint; se durável restaura cursor/lease; redelivery idempotente e reconciliação de leases expirados |
| Projeções/checkpoints empresariais | replay do último checkpoint enquanto outbox central existir | destino isolado retorna após serviço; projeção recupera após drenagem | checkpoint monotônico por agregado/destino, tombstone vence snapshot antigo; acesso/credenciais destino **Not confirmed** |
| Efeito externo Meta (envio, subscription, revogação, troca de code/token) | sem RPO/RTO genérico: API externa não é transação local nem snapshot | **Not confirmed**, depende de disponibilidade, autorização, quota e suporte Meta | persistir intenção/idempotency/correlation antes da chamada e outcome seguro depois; timeout após possível envio = UNKNOWN; reconciliar quando permitido; nunca repetir efeito não idempotente cegamente |

Testar restore em ambiente isolado com chaves sintéticas/versionadas e chave-canário. KMS/cofre, frequência/local de snapshot, cópia fora do domínio, operadores, restore e destino empresarial ficam para M2/M6 (**Not confirmed**). Backup verde sem restore/decriptação/reconciliação não atende ao objetivo.

## Hipóteses a medir

O CSV e validador usam taxas e tamanhos sintéticos; não descrevem clientes, produção ou custos. Capacidade de worker é limitada por CPU/IO, banco, serialização/locks e limites externos; fórmula do worker isolado é teto superior. Medir custo por tipo de evento, carga, conexões/pool, bytes indexados, retenção, cache, chamadas externas e projeção por destino antes de ratificar. Quotas Meta, tráfego real, preço, tenancy/region e topologia: **Not confirmed**.
