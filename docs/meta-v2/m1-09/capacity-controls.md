# M1.09 — Carga, limites, orçamento e controle de mudanças

As quantidades e limites deste documento são entradas sintéticas para tornar o modelo verificável. Não representam tráfego, orçamento, limite contratado, quota Meta ou janela de manutenção real. Valores e responsáveis reais permanecem **Not confirmed**. As planilhas estão em [workload-model.csv](workload-model.csv) e [cost-budget.csv](cost-budget.csv).

## Dimensões explícitas de carga

Para este exercício, um registro de company equivale a um tenant; essa correspondência para produção está **Not confirmed**.

| Cenário | Empresas | Ativos/empresa → total | Empresas com opt-in histórico | Itens/empresa com opt-in/dia × bytes/item × retenção | Bytes lógicos de histórico | API req/s | Webhooks/s | Envios/s | Operações de template/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Nominal | 10 | 3 → 30 | 2 | 100 × 2.048 × 30 dias | 12.288.000 | 10 | 5 | 1 | 0,2 |
| Pico (3×) | 30 | 3 → 90 | 6 | 100 × 2.048 × 30 dias | 36.864.000 | 30 | 15 | 3 | 0,6 |
| Crescimento (10×) | 100 | 3 → 300 | 20 | 100 × 2.048 × 30 dias | 122.880.000 | 100 | 50 | 10 | 2 |

Histórico modela apenas um subconjunto sintético com opt-in; a política segue desligada por padrão. Bytes lógicos omitem índices, réplicas, WAL e backups. O fluxo de 5/15/50 itens/s representa webhooks e é o único fluxo usado na conta de worker em capacity-model.csv. Envios e operações de templates são lanes separados, sem soma à taxa de worker acima; custo por chamada, latência e limites de conta exigem medição própria. Os mesmos 2.048 bytes das planilhas são hipóteses independentes e não afirmam um payload real.

## Capacidade e gatilhos de escala

Para cada lane, λ é o maior valor entre a taxa medida em cinco minutos e a previsão p95 aprovada. Teto por worker `s = concorrência / tempo médio de serviço`; teto de workers `Cw = workers ativos × s`. Serviço efetivo `Ce = min(Cw, taxa limitada pelo DB, taxa sustentável de fila/consumidor, quota do endpoint/provedor)`. Se algum termo for desconhecido, não declarar Ce medido. Fila só drena se `Ce > λ`; tempo ideal de dreno `Q / (Ce − λ)`. A planilha de capacidade calcula Cw; os outros termos dependem de benchmark/evidência.

| Gatilho candidato | Ação |
|---|---|
| `λ / Ce ≥ 0,70` por duas janelas consecutivas de 5 min, ou `Ce / λ < 1,5` com um worker indisponível | Congelar expansão; revisar DB, fila e provedor antes de aumentar capacidade. Workers totais mínimos: `ceil(λ / (0,70 × s medido)) + 1` para tolerar um indisponível. |
| `Ce ≤ λ` em amostra sustentada ou dreno indefinido/infinito | Abortar a lane, bloquear nova admissão onde seguro, preservar inbox/outbox duráveis e acionar responsável operacional. |
| Item durável mais antigo >60 s em cinco amostras consecutivas, uma por minuto | Congelar expansão e investigar a lane/tenant afetada. |
| Item mais antigo >300 s em duas amostras consecutivas, ou dreno previsto >600 s | Abortar coorte, conservar inbox webhook, pausar despacho com segurança e reconciliar antes de retomar. |
| Conexões ativas do DB ≥70% do limite aprovado por dez minutos | Congelar expansão de workers e revisar pools, reservas e serviço do banco. |
| Conexões ≥85% por um minuto, exaustão ou espera do pool impede persistência de webhook | Abortar rollout afetado; proteger ingress durável e nunca confirmar ACK após descartar evento. |

Com o modelo sintético `s=32 itens/s`, quatro workers totais, um indisponível e `Cw=96`, 70% do teto equivale a 67,2 itens/s. O crescimento de 50/s fica abaixo desse gatilho de worker, sem provar capacidade do DB, fila ou provedor. SRE/Operação devem ratificar limites e definições antes de alarmes de produção.

## Limites por tenant (noisy neighbor)

São limites candidatos da aplicação, não limites Meta. Aplicar por tenant e, para efeitos externos, também por configuração e referência/versão opaca da credencial.

| Recurso | Limite sintético por tenant | Quando atingir |
|---|---|---|
| API geral | Token bucket 10 req/s, burst 20 e até 16 requests simultâneas | responder com retry limitado na API interativa e manter outros tenants atendidos |
| Jobs | Até 4 leases concorrentes e fila de até 1.000 jobs esperando por tenant | scheduler pausa só aquele tenant; não apaga inbox/outbox já aceitos |
| Envio externo | Token bucket 2 operações/s, burst 5, por tenant + app config + credential ref/version | enfileirar/adiar antes da chamada, aplicar backoff e nunca declarar timeout como sucesso |
| Templates | Token bucket 1 operação/s, burst 5 pela mesma chave tenant/config/credential | adiar segundo nossa política; não somar à lane de envios ou webhooks |
| Histórico opcional | 10.000 itens e 1 GiB por tenant (primeiro limite), idade máxima proposta de 30 dias | suspender nova coleta de histórico e alertar; manter controle e webhook, sem truncamento silencioso |

Validar esses valores contra custo de job, contrato, UX e termos do provedor antes de adotá-los. Ingress valida e persiste cada webhook antes de ACK de sucesso. Quota cheia pausa o despacho e alerta, sem descartar item aceito. Se armazenamento durável não aceitar o item, não confirmar sucesso. Comportamento de redelivery Meta e capacidade para esgotamento de storage são **Not confirmed** e bloqueiam desenho de ingress de produção.

## Planilha de custo e gate

Para cada item/cenário, quantidade deve corresponder ao período de cobrança: `Lᵢ = quantidadeᵢ × preço_unitário_aprovadoᵢ`; previsão total `F = ΣLᵢ + impostos/egress/câmbio aprovados + contingência aprovada`. Comparar apenas mesma moeda e período de cobrança. A planilha inclui worker, banco/conexões, histórico/raw storage, backup/chaves, fila, egress, observabilidade, envios e operações de template; acrescentar serviços da topologia escolhida.

A planilha está intencionalmente sem preços: quantidade por período/overhead, tarifa, moeda, imposto/câmbio, cap de budget, fonte de cotação e responsável nominal estão **NOT_CONFIRMED**, todos os gates estão OPEN. Não usar preço público nem rate card genérico da Meta no lugar das condições da conta/fluxo. Antes de staging com tenants reais ou produção, Produto/Finanças/Responsável técnico preenche consumo medido, cotação/contrato/rate card datado, unidade/período e owner; Segurança/SRE confirmam storage/restore/log; aprovador define cap `B` e contingência. Gate só passa se `F ≤ B` em nominal, pico, crescimento e cenário com um worker indisponível, nenhuma linha obrigatória for desconhecida e houver aceite registrado. Estado atual: **OPEN / Not confirmed**; não há alegação de custo ou budget de deployment.

## Gate de quota Meta

Não inserir taxa Meta assumida em Ce, limites por tenant ou estimativa de custo. Produto, família de token, endpoint, ativo/conta e nível de acesso podem afetar a quota; para os quatro fluxos Msg4 está **Not confirmed**. Em 28/10/2026, requisições diretas às páginas oficiais abaixo responderam HTTP 429; nenhuma quota/regra atual foi confirmada:

- [Graph API rate limiting — Meta for Developers](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [WhatsApp Cloud API overview — Meta for Developers](https://developers.facebook.com/docs/whatsapp/cloud-api/overview)
- [WhatsApp messaging limits — Meta for Developers](https://developers.facebook.com/docs/whatsapp/messaging-limits)
- [WhatsApp pricing — Meta for Developers](https://developers.facebook.com/docs/whatsapp/pricing)

Antes do piloto, responsável Meta/Integração registra referência oficial datada e evidência Sandbox por fluxo: endpoint/método/configuração app; família/escopo da credencial (somente referência opaca); dimensão de ativo/conta e nível de acesso; header/sinal/erro da quota; reset/backoff; throughput ou limite de template; ACK/retry de webhook; unidade de cobrança. Verificar Facebook, Instagram, WhatsApp exclusivo e Coexistence separadamente, sem tokens/IDs reais em docs. Se fonte ou conta estiver inacessível/ambígua, quota continua **Not confirmed** e a lane não abre; usar backoff/circuit breaker sem inventar uma taxa substituta.

## Política de janela de manutenção

- Mudança planejada precisa de operador responsável, escopo tenant/canal/app config/credential version, início/fim aprovados e aviso segundo contrato. Prazo de aviso, fuso do tenant e janela permitida **Not confirmed**; confirmar antes de marcar.
- Não cortar writer/config/credencial sem rollback testado, webhook durável, evidência atual de restore DB+chaves e plano de dreno. Congelar novas trocas de owner durante a janela; pausar claims com segurança e não ACKar descarte.
- Não excluir manutenção silenciosamente da disponibilidade/relato. Excluir só se contrato futuro permitir explicitamente e definir duração; até lá contar no SLO observado.
- Manutenção emergencial fora da janela exige autorização do comandante do incidente/operador e processo de aviso confirmado em contrato. Registrar owner, escopo, motivo, versões de fence/flags, início/fim, backlog e recuperação. Pessoas/processo **Not confirmed**.

## Critérios objetivos de abortar rollout

Fence/pausar escopo e declarar incidente imediatamente em acesso cross-tenant, segredo exposto, dois writers ativos para a mesma chave, writer antigo aceitando comando, efeito de negócio duplicado ou ACK de sucesso antes de inbox durável. Não aguardar janela de latência.

Para regressão sem incidente de segurança, pausar coorte se ocorrer qualquer limite sintético: API 5xx >2% em 5 min; API p95 >1 s por três janelas consecutivas de 5 min; webhook ACK durável p99 >3 s por duas janelas; conexões DB ≥85% por um minuto; throttle/rate-limit do provedor >5% das chamadas da lane em 5 min; limites de fila/dreno acima; ou `Ce ≤ λ`. Parar apenas tenant/config/credential se isolamento for provado; caso contrário, parar expansão global. Manter ingress durável, parar claims inseguras, aplicar fence antes da troca, reconciliar efeitos confirmados/UNKNOWN e cumprir aviso/manutenção. Ratificar limites com SRE/Produto: são guardrails sintéticos, não SLO de produção.
