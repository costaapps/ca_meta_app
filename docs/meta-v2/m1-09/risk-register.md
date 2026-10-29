# M1.09 — Registro de riscos operacionais

Probabilidade/impacto são triagem qualitativa, não frequência medida. Responsabilidades são funcionais, sem assignee presumido. Gatilhos, flags e evidências reais precisam ser confirmados antes de produção.

| ID | Risco / gatilho | Prob. / impacto | Sinal | Tratamento / recuperação | Dono funcional / gate |
|---|---|---|---|---|---|
| M109-R01 | Tráfego, payload ou serviço real supera cenários sintéticos | Alta / alto | chegada, CPU, pool, atraso e custo divergem | medir por evento/coorte; carga isolada; recalcular com worker indisponível e orçamento; pausar expansão se capacidade líquida ≤ chegada | SRE/Produto; M6 carga/capacidade |
| M109-R02 | Quota, indisponibilidade ou resposta Meta desconhecida | Alta / alto | throttling, timeout após efeito possível, UNKNOWN crescente | retry limitado/backoff, idempotency e reconciliação; não repetir envio ambíguo; separar SLI externo | Integração Meta; Sandbox/contrato, quota Not confirmed |
| M109-R03 | Callback comum roteia para consumidor antigo e novo ou perde evento | Média / crítico | item com duas claims, ACK sem inbox, contagem divergente | gateway durável, ledger por chave completa, fence único, dedupe por envelope/item, fila pendente no cutover/rollback | Backend/DevOps; inventário e tabletop integrado |
| M109-R04 | Banco restaurado sem chave deixa credential refs indecifráveis | Média / crítico | restore verde sem chave/version; canário falha decrypt | cópia versionada e recovery separado; decriptar canário antes de abrir serviço; revogar acesso comprometido sem recuperar token revogado | SRE/Segurança; restore isolado DB+keys |
| M109-R05 | Worker/fila cai e lease expirado duplica ou impede conclusão | Média / alto | idade cresce, leases repetem, retries/dead-letter crescem | claim condicional/lease/fence, idempotência, drain calculado; pausar ingress/expansão, não apagar item | Backend/SRE; crash/redelivery M2/M6 |
| M109-R06 | Projeção lenta bloqueia tenants ou checkpoint regressivo ressuscita estado | Média / alto | atraso por destino, checkpoint regressivo, tombstone antigo | isolar lane/destino, versão monotônica/tombstone/replay; pausar destino individual | Dados/Suite4; contrato/benchmark |
| M109-R07 | Histórico coleta sem opt-in, excede limite ou viola contrato | Média / crítico | falta de consent evidence/version ou purge | desligado por padrão, opt-in/out separado, limite atômico, retenção/purge; bloquear produção até aprovação | Produto/Dados/Privacidade; aceite pendente, prazos Not confirmed |
| M109-R08 | Retenção conflita com obrigação, hold ou localização | Média / crítico | cliente/revisão jurídica aponta incompatibilidade | resolver jurisdição, contrato, classe e hold; versionar policy; sem histórico até aceite; provar purge | Jurídico/privacidade/owner dados; gate antes de conteúdo real |
| M109-R09 | Restore falha RPO/RTO por depender de KMS, DB, provedor ou acesso operacional | Média / crítico | exercício excede alvo, chave indisponível ou operador ausente | exercício da cadeia completa, objetivos por dependência, backup fora de domínio, manutenção e reconciliação | SRE/Segurança; M6 restore/go-no-go |
| M109-R10 | Writer flag diverge do ledger ou rollback usa schema/credential incompatível | Média / crítico | dois owners, fence antigo aceita comando, migration destrutiva | exclusividade transacional/ACL, versão/fence, matriz por chave; parar writes e voltar só para versão compatível; não presumir reversão de efeito | Arquitetura/Migração; ensaio integrado |
| M109-R11 | Capacidade/retenção introduz custo ou limite não autorizado | Média / alto | bytes/index/backup/conexões ultrapassam orçamento | fórmula/sensibilidade em capacity-controls e cost-budget; medir overhead/budget, limitar coleta e parar expansão | Produto/Finanças/SRE; owner, tarifa e cap Not confirmed |
| M109-R12 | Indicador sem denominador/owner/ação cria alerta sem resposta/falsa segurança | Média / alto | painel sem tráfego, lag/fonte ausente, alerta órfão | owner/runbook, fonte/janela/exclusões, teste sintético, ratificar baseline e budget antes de SLA | Operação/SRE/Produto; M6 observabilidade |

## Gates abertos

- Tráfego, mix de eventos, payload médio/tail, quotas, custos, infraestrutura e hosting: **Not confirmed**.
- Retenção por categoria, opt-in válido, obrigação legal/contratual, jurisdição/hold e exclusão: **Not confirmed**; conteúdo opcional fica desligado.
- Callback Meta, fanout, contrato do adaptador PHP e fencing do ledger: **Not confirmed**; não cortar produção só com esta tabela.
- KMS/cofre, frequência/local de backup, DB/fila, conexão máxima e restore: **Not confirmed**; RPO/RTO são hipóteses, não compromissos.
- Não há datas prometidas. Estimar após confirmar escopo, dependências, revisores e capacidade.
