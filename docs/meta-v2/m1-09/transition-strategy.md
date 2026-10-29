# M1.09 — Estratégia de transição e tabletop

**Escopo:** plano de rollout verificável, não autorização de mudança de tráfego. Datas, volumes e infraestrutura de produção não estão confirmados. Configuração de app Meta, callback compartilhado, contrato gateway/legado e mecanismo de fencing são **Not confirmed** e gates próprios.

## Propriedade de escrita

Ledger de ownership por chave (ambiente, tenant, canal, agregado/finalidade) com versão/fence monotônicos. Para cada chave e instante existe exatamente um escritor de negócio autorizado. write_owner seleciona legacy ou new; troca é transacional e exige fence do escritor anterior antes do novo aceitar comando. shadow_read só compara leitura; shadow_send permanece false. Flags por tenant/canal/finalidade e versão; não usar percentual de requests que misture escritores no agregado. Ingress comum pode persistir inbox e rotear, mas não duplica executor de negócio.

## Fases

| Fase | Escritor único autorizado (tenant/canal/agregado) | Flags/escopo | Observação antes de avançar | Rollback | Saída verificável |
|---|---|---|---|---|---|
| 0. Baseline | Legado existente é dono dos agregados de produção | flags novas OFF; não alterar callback | inventário sanitizado de consumidores, DDL, callbacks, escritor por operação, backup e restore | sem mudança operacional; abortar se ownership não puder ser enumerado | agregados no ledger, caminhos de efeitos externos e dependências conhecidos; desconhecidos em quarentena |
| 1. Plataforma isolada | Stack nova escreve apenas dados sintéticos/ambiente isolado; legado continua dono de produção | new_stack_enabled só no isolamento; produção OFF; sem dados/segredos reais | health, contratos, tenant isolation, worker lease, restore sintético e redaction | remover ambiente isolado; sem recurso externo conectado | segurança e restore sintético passam; sem tráfego real |
| 2. Importação preparada | Legado único escritor de produção; importador escreve somente staging desconectado | import_dry_run; prod write OFF; watermark/checkpoint obrigatório | contagem/hash sanitizado, órfãos/conflitos/quarentenas, alterações concorrentes e reauth posterior | descartar staging/recomeçar no checkpoint; não sobrescrever legado | dry-run repetível sem conflito inexplicado; chaves/fence definidos |
| 3. Shadow-read | Legado único escritor; nova stack só lê cópia/espelho isolado | shadow_read ON, new_write OFF, shadow_send OFF | divergência de estado/versão, latência, redaction e cobertura sem mutação | desligar sombra e descartar dados temporários | diferenças explicadas; nenhum efeito externo ou leitura cross-tenant |
| 4. Piloto tenant/canal | Antes da troca: legado; depois de fence/commit: nova stack. Nunca ambos | write_owner por tenant/canal/agregado; new_ingress por chave se gateway pronto; send por finalidade após aceite | SLO, backlog, fila, outcome Meta, projeção e reconciliação; revisão do suporte | pausar comandos, fence novo writer, reconciliar UNKNOWN/efeitos e voltar ownership ao legado; gateway continua validando/guardando callback | observação ratificada por dono e ciclos relevantes; sem P0, dupla escrita, perda de backlog ou divergência inexplicada |
| 5. Expansão por coorte | Um dono por tenant/canal/agregado em cada coorte | mudar flags somente via ledger/versionado; coorte explícita, sem amostragem de request | SLO, erros, drain e aceite da coorte anterior; quotas/contratos por fluxo | parar expansão; reverter apenas tenants/canais compatíveis; demais owners não mudam | cada coorte passa critérios; escritor/contrato N/N-1 compatíveis |
| 6. Cutover final | Nova stack é única para agregados migrados; legado somente compatibilidade/leitura conforme matriz | fechar importações; flags/owner completos; migrar consumidores individualmente | ausência comprovada de jobs/cron/callbacks gravadores, restore, backlog drenável dentro de objetivo ratificado, suporte e dependências Meta | manifest/schema compatíveis e troca de ownership após fence; reconciliar sem reverter efeito externo | dependências com novo dono e rollback exercitável durante janela aprovada |
| 7. Retirada | Nova stack única; legado sem permissão de escrita nos agregados transferidos | flags legado OFF após janela/go-no-go; callback fica no gateway até provar última dependência | nenhum consumer, cron, reauth/callback ou restore depende do legado; janela auditada | novo go/no-go, credencial válida e compatibilidade comprovada; não reativar token revogado | aceite operacional, arquivo/backup conforme retenção e retirada autorizada |

Tempo de observação depende de ciclos (reauth, cron, suporte, callbacks) e capacidade, não de prazo inventado. Rollback considera código, schema, dados locais e efeitos externos; flag não desfaz mensagem enviada, grant, token ou subscription.

## Webhook durante a troca

1. Callback compartilhado só muda depois de inventário app-level e validação do contrato de encaminhamento. Se houver entrada comum, validar assinatura no raw body e persistir envelope durável antes do ACK. Gateway resolve identidade completa por ledger; ambiguidade vai para quarentena, nunca seleção por último login/token.
2. Evento ganha chave app/env + identidade do evento + item e owner/fence observados. Evento durante transição continua na inbox durável mesmo se roteamento estiver pausado. Não confirmar sucesso com descarte silencioso.
3. Antes de trocar writer: pausar claim, aguardar/revogar leases antigos, gravar high-water mark e fence, trocar ownership condicionalmente. Consumidor novo reclama itens incompletos apenas com owner/fence atual; replay é idempotente.
4. Em rollback, manter ingress validando/persistindo, pausar entrega, reconciliar outcomes confirmados/UNKNOWN e trocar ledger só depois do fence. Reprocessar pendentes idempotentemente, preservando ordem/versões/tombstones. Não repetir efeito externo ambíguo sem reconciliação segura.
5. Backlog válido não é descartado nem transferido a dois executores. Se ultrapassa retenção ou drain seguro, manter durável, pausar expansão, alertar responsável e quarentenar com motivo se necessário. Não assumir garantia de replay Meta nem mudar assinatura.

## Tabletop sintético — corte e rollback de API

Fixture: tools/m1-09/fixtures/tabletop.json. Verificador: python tools/m1-09/validate.py. Sem acesso a PHP, Meta, clientes, banco, fila ou produção.

| Passo/caso | Estado sintético | Decisão esperada | Invariante validada |
|---|---|---|---|
| A. Preparar corte | tenant-synthetic-1/WhatsApp/asset-synthetic-1 owner legacy; API nova saudável; evt-syn-101/item-1 persistido e pendente; lease antigo ainda existe | legado continua writer; persistir backlog, congelar claim e aguardar lease ou expirar fence | um escritor; ACK corresponde a item durável |
| B. Fencing/cutover | lease antigo sem conclusão; novo fence v42 preparado | não habilitar novo writer até antigo deixar de produzir; trocar owner/versão atomicamente; entregar pendente uma vez | evento não some nem chega a dois executores |
| C. API nova falha com backlog | erro na API; item pendente; outro item tem outcome externo UNKNOWN | pausar claim/novos writes, manter gateway/inbox, registrar UNKNOWN e pedir reconciliação | não ACK com perda, sem shadow-send, sem reenviar UNKNOWN |
| D. Rollback | novo owner fenced; legado compatível; evento pendente durável | fence novo, reconciliar writes/eventos locais, trocar ledger por versão; reentregar só pendentes idempotentes; preservar confirmados e quarentenar UNKNOWN | um writer após troca; efeito confirmado não é revertido/repetido cegamente |
| E. Saída | fila pendente preservada e drain calculado; nenhum item apagado | pausar coorte até API, backlog e projeção nos limiares ratificados; exigir novo go/no-go | ensaio sem dupla escrita/perda |

O ensaio local verifica consistência da fixture; não certifica fencing, assinatura, entrega, durabilidade ou comportamento real de PHP, Suite4, Meta, DB ou infraestrutura. Esses pontos exigem teste de integração autorizado e contrato verificado antes do piloto.
