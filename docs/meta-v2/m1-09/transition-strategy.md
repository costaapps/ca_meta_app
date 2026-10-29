# M1.09 — Estratégia de transição e tabletop

**Escopo:** plano de rollout verificável, não autorização de mudança de tráfego. Datas, volumes e infraestrutura de produção não estão confirmados. Configuração de app Meta, callback compartilhado, contrato gateway/legado e mecanismo de fencing são **Not confirmed** e gates próprios.

## Propriedade de escrita

Ledger de ownership com chave composta exata (ambiente, tenant, canal, agregado/finalidade, app_config_ref, app_config_version, credential_ref, credential_version). Referências e versões são opacas, nunca valores de segredo. Para cada tupla e instante existe exatamente um escritor de negócio autorizado. write_owner seleciona legacy ou new; troca é transacional e exige fence do escritor anterior antes do novo aceitar comando. Rotação de credencial ou mudança de app config cria/transfere para uma nova chave com reconciliação explícita; não permite executores sobrepostos. shadow_read só compara leitura; shadow_send permanece false. Flags por tenant/canal/finalidade/config/credencial e versão; não usar percentual de requests que misture escritores no agregado. Ingress comum pode persistir inbox e rotear, mas não duplica executor de negócio.

## Fases

Cada linha abaixo aplica separadamente à chave composta definida acima; nenhuma fase autoriza dois escritores para a mesma tupla.

| Fase | Escritor único por chave config/version + credential/version | Flags/escopo | Observação antes de avançar | Rollback | Saída verificável |
|---|---|---|---|---|---|
| 0. Baseline | Legado é único writer de cada tupla de produção inventariada; config/credential são referências opacas | flags novas OFF; callback inalterado | matriz sanitizada por config+credential, DDL, callbacks, writer, backup e restore | sem mudança operacional; abortar se chave/owner não puder ser enumerado | todas as tuplas no ledger; desconhecidas em quarentena |
| 1. Plataforma isolada | Nova stack escreve só tuplas sintéticas isoladas; legado continua dono de cada tupla de produção | new_stack_enabled só no isolamento; produção OFF; sem dados/segredos reais | health, contratos, tenant isolation, worker lease, restore sintético e redaction | remover isolamento; sem recurso externo conectado | segurança/restore sintético passam; nenhuma chave de produção usada |
| 2. Importação preparada | Legado é único writer de cada tupla config+credential em produção; importador escreve staging com chave separada | import_dry_run; prod write OFF; watermark/checkpoint por tupla | contagem/hash sanitizado, conflitos/quarentenas, concorrência e reauth posterior | descartar staging/recomeçar checkpoint; nunca sobrescrever legado | dry-run sem conflito inexplicado; fences/linhagem da chave definidos |
| 3. Shadow-read | Legado é writer por tupla de produção; nova stack sem permissão de escrita sobre essas tuplas | shadow_read ON, new_write OFF, shadow_send OFF | divergência por config/credential/version, latência, redaction, sem mutação | desligar sombra e descartar dados temporários | diferenças explicadas; nenhum efeito externo ou leitura cross-tenant |
| 4. Piloto tenant/canal | Em cada tupla config+credential: legado antes do fence/commit, new depois; nunca ambos no mesmo instante | ledger por chave; ingress/send flags por tupla, ativados separadamente após aceite | SLO, backlog, quota/outcome Meta, projeção e reconciliação; revisão do suporte | pausar comandos, fence do owner atual, reconciliar UNKNOWN e voltar ownership compatível; gateway continua validando/persistindo | observação ratificada; sem P0, dupla escrita, perda ou divergência sem explicação |
| 5. Expansão por coorte | Um owner por tupla config+credential em cada coorte | flags somente via ledger/versionado; coorte explícita, sem amostragem de request | SLO, erros, drain e aceite da coorte anterior; quota/contrato por fluxo | parar expansão; reverter apenas tuplas/tenants compatíveis | cada coorte passa critérios; writer e schema compatíveis |
| 6. Cutover final | Nova stack única por tupla transferida; legado somente compatibilidade/leitura e sem escrita nos pares config+credential transferidos | fechar importação; owner/flags por chave completos; migrar consumidores individualmente | ausência de jobs/callbacks gravadores por configuração e credencial, restore, backlog drenável, suporte e dependências Meta | manifest/schema compatíveis, fence e owner anterior; reconciliar sem reverter efeitos externos | dependências com novo dono e rollback exercitável |
| 7. Retirada | Nova stack única por tupla; legado sem escrita nos pares config+credential transferidos | flags do legado OFF por chave após go/no-go; callback fica no gateway até última dependência | nenhum consumer/cron/reauth/callback/restore depende do legado; janela auditada | novo go/no-go, credential válida, owner/schema compatíveis; não reativar token revogado | aceite operacional, arquivo/backup conforme retenção e retirada autorizada |

Tempo de observação depende de ciclos (reauth, cron, suporte, callbacks) e capacidade, não de prazo inventado. Rollback considera código, schema, dados locais e efeitos externos; flag não desfaz mensagem enviada, grant, token ou subscription.

## Webhook durante a troca

1. Callback compartilhado só muda depois de inventário app-level e validação do contrato de encaminhamento. Se houver entrada comum, validar assinatura no raw body e persistir envelope durável antes do ACK. Gateway resolve identidade completa por ledger; ambiguidade vai para quarentena, nunca seleção por último login/token.
2. Evento ganha chave app/env + identidade do evento + item e owner/fence observados. Evento durante transição continua na inbox durável mesmo se roteamento estiver pausado. Não confirmar sucesso com descarte silencioso.
3. Antes de trocar writer: pausar claim, aguardar/revogar leases antigos, gravar high-water mark e fence, trocar ownership condicionalmente. Consumidor novo reclama itens incompletos apenas com owner/fence atual; replay é idempotente.
4. Em rollback, manter ingress validando/persistindo, pausar entrega, reconciliar outcomes confirmados/UNKNOWN e trocar ledger só depois do fence. Reprocessar pendentes idempotentemente, preservando ordem/versões/tombstones. Não repetir efeito externo ambíguo sem reconciliação segura.
5. Backlog válido não é descartado nem transferido a dois executores. Se ultrapassa retenção ou drain seguro, manter durável, pausar expansão, alertar responsável e quarentenar com motivo se necessário. Não assumir garantia de replay Meta nem mudar assinatura.

## Tabletop sintético — corte e rollback de API

Fixture: tools/m1-09/fixtures/tabletop.json. Verificador: python tools/m1-09/validate.py. Referências sintéticas opacas provam ownership único no baseline/cutover/rollback pela chave completa app_config_ref/version + credential_ref/version. Sem acesso a PHP, Meta, clientes, banco, fila ou produção.

| Passo/caso | Estado sintético | Decisão esperada | Invariante validada |
|---|---|---|---|
| A. Preparar corte | tenant-synthetic-1/WhatsApp/asset-synthetic-1 owner legacy; API nova saudável; evt-syn-101/item-1 persistido e pendente; lease antigo ainda existe | legado continua writer; persistir backlog, congelar claim e aguardar lease ou expirar fence | um escritor; ACK corresponde a item durável |
| B. Fencing/cutover | lease antigo sem conclusão; novo fence v42 preparado | não habilitar novo writer até antigo deixar de produzir; trocar owner/versão atomicamente; entregar pendente uma vez | evento não some nem chega a dois executores |
| C. API nova falha com backlog | erro na API; item pendente; outro item tem outcome externo UNKNOWN | pausar claim/novos writes, manter gateway/inbox, registrar UNKNOWN e pedir reconciliação | não ACK com perda, sem shadow-send, sem reenviar UNKNOWN |
| D. Rollback | novo owner fenced; legado compatível; evento pendente durável | fence novo, reconciliar writes/eventos locais, trocar ledger por versão; reentregar só pendentes idempotentes; preservar confirmados e quarentenar UNKNOWN | um writer após troca; efeito confirmado não é revertido/repetido cegamente |
| E. Saída | fila pendente preservada e drain calculado; nenhum item apagado | pausar coorte até API, backlog e projeção nos limiares ratificados; exigir novo go/no-go | ensaio sem dupla escrita/perda |

O ensaio local verifica consistência da fixture; não certifica fencing, assinatura, entrega, durabilidade ou comportamento real de PHP, Suite4, Meta, DB ou infraestrutura. Esses pontos exigem teste de integração autorizado e contrato verificado antes do piloto.
