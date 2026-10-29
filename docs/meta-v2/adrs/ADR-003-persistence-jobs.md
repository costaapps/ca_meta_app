# ADR-003 · Persistência, ORM e jobs

Status: aceita como direção inicial, ORM/fila validados apenas pelo escopo da PoC local. Issues: [M1.04 / #13](https://github.com/costaapps/ca_meta_app/issues/13). Data: 2026-10-28.

## Contexto comprovado

O blueprint mantém MariaDB como opção inicial para reduzir uma migração simultânea. A M1.02 mapeia somente campos observados no PHP versionado; DDL/índices e ownership físicos permanecem **Not confirmed**. Logo, o experimento aqui cria tabelas próprias e descartáveis e não as apresenta como schema de produção.

TypeORM 1.1.2 é testado pelo driver MariaDB `mariadb` usando o pacote `mysql2` 3.24.6 listado pela documentação atual. A compatibilidade exata de `mysql2` + TypeORM 1.1.2 + MariaDB 11.8.8 é evidenciada pelo PoC, não inferida do nome do driver. MariaDB implementa JSON como alias `LONGTEXT` com validação; a coluna gerada tipada torna possível indexar um atributo consultado. Um plano `EXPLAIN` prova que o otimizador selecionou o índice naquele dado/snapshot, não que uma consulta tenha baixa latência de produção.

DDL como `CREATE TABLE`, `ALTER TABLE` e `CREATE INDEX` provoca commit implícito no MariaDB. Não alegar que o modo transacional do runner torna migration DDL atômica/reversível. Usar migrations explícitas, lock/ledger, instruções pequenas e compatíveis com N/N-1, preflight e estratégia de compensação/forward-fix. DML InnoDB dentro do transaction manager ainda suporta rollback local.

## Opções

| Opção | Benefício | Custo/risco | Evidência/experimento |
|---|---|---|---|
| TypeORM + MariaDB | Integra com Nest e suporta migrations/transações por driver | A versão exata precisa comprovar generated/index/driver e migrations com MariaDB; `synchronize` é proibido fora de prova descartável | Executado com TypeORM 1.1.2, MariaDB 11.8.8 e `mysql2` 3.24.6 em tools/m1-04 |
| Query builder próprio / SQL manual | Controle explícito do SQL e sem abstrações de ORM | Mais código de mapeamento/transação e disciplina de migration | Não foi implementado nem comparado nesta PoC |
| PostgreSQL | Alternativa relacional com ecossistema amplo | Introduz migração operacional e de schema sem requisito demonstrado | Não necessário para manter DB empresarial legado; sem PoC comparável |
| Outbox no MariaDB + worker que reclama linhas | Uma transação persiste estado + intenção; menos serviço no primeiro release | Polling e `SKIP LOCKED` pedem fairness, índices, leases, limite por tenant e monitoramento | Harness testa dois claims concorrentes, lease e processo que morre antes do ACK |
| Redis/BullMQ como broker primário | Fila independente e modelo worker pronto | Infra e persistência adicional; enfileirar após commit pode perder intenção sem outbox; efeito externo ainda pode duplicar | Nenhum benchmark/PoC Redis foi executado; Redis fica alternativa |

## Decisão e consequência

Manter MariaDB central como fonte de intenção/integração. Banco empresarial é projeção por tenant, não fonte transacional coordenada com o central. Persistir estado central e outbox na mesma transação InnoDB. Cada claim gera um token de fencing aleatório por job. ACK e renovação são updates condicionais ao token atual, status RUNNING e lease ainda não expirada; renovar depois de expirar falha e não recupera propriedade. Após reclaim, o token substituído não pode ACKar a linha, mesmo que o processo antigo volte. Entrega é pelo menos uma vez após crash/lease expirado; “exactly once” para efeito Meta/empresa não é prometido. `operation_key` idempotente e resultado UNKNOWN/reconciliação tratam a janela entre efeito externo e ACK.

Escalar API por demanda HTTP e worker por backlog/tempo de drenagem, com limites de concorrência e quotas por tenant/ativo. A API não envia todo webhook/evento externamente na requisição; primeiro valida/persiste inbox/outbox e confirma. Redis/BullMQ só pode ser introduzido quando benchmark/latência/backlog/custo operacional justificarem; MariaDB outbox segue fonte recuperável e é necessário provar rebuild da fila.

Shutdown: SIGTERM impede novos claims no próximo boundary; o worker drena a unidade já reclamada dentro do grace period configurado. Se o processo termina sem ACK, o lease expira e outro worker pode repetir. Depois do grace period, o supervisor encerra; qualquer efeito com resultado ambíguo exige reconciliação, não retry cego. Durabilidade de produção exige configurar disco/backup/restore/failover e medir carga, ainda **Not confirmed**.

Fontes primárias consultadas em 2026-10-28: [TypeORM 1.0 release](https://typeorm.io/blog/typeorm-1-0/), [TypeORM 1.1.2](https://www.npmjs.com/package/typeorm/v/1.1.2), [Nest TypeORM 12.0.2](https://www.npmjs.com/package/@nestjs/typeorm/v/12.0.2), [`mysql2` 3.24.6](https://www.npmjs.com/package/mysql2/v/3.24.6), [driver MySQL/MariaDB](https://typeorm.io/docs/drivers/mysql/), [migrations](https://typeorm.io/docs/migrations/setup/), [transações](https://typeorm.io/docs/transactions/), [MariaDB JSON](https://mariadb.com/docs/server/reference/data-types/string-data-types/json), [colunas geradas](https://mariadb.com/docs/server/reference/sql-statements/data-definition/create/generated-columns), [SKIP LOCKED](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/select), [implicit DDL commit](https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit), [BullMQ entrega](https://docs.bullmq.io/bull/important-notes), [BullMQ shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), [Redis persistence](https://redis.io/docs/latest/management/persistence/).

## Prova, implantação e recuperação

O [harness](../../../tools/m1-04/README.md) está em Node 24.22.2 + npm 11.19.1, MariaDB 11.8.8/InnoDB, Docker Compose, TypeORM 1.1.2 e fixture gerada no próprio teste. Executa duas vezes `runMigrations`; testa JSON válido/inválido, índice `EXPLAIN`, rollback DML, transação de outbox, dois claims concorrentes, renew/ACK cercados pelo token, stale claimant sobreposto ao novo dono, crash real de child process após fake sink e antes de ACK, expiração/reentrega após iniciar outro processo, deduplicação do efeito e drain em SIGTERM. Target config só aceita host/port/user/database do Compose antes de construir DataSource. Nenhuma mensagem ou chamada Meta é gerada.

Recuperação de schema em MariaDB é forward-fix ou migration compensatória testada; não presumir rollback DDL transacional. Cada execução da PoC recebe projeto Compose aleatório independente e faz cleanup apenas desse nome; uma execução antiga não é removida por um `down --volumes` subsequente. O ACK inclui a claim token e exige lease ainda válida; a renewal também só funciona antes de expirar e para o dono atual. O ensaio cobre renewal, expiry, reclaim, rejeição de ACK do dono antigo e ACK do dono novo. Ele não prova HA, backup/restore, throughput, fairness sob carga, consumo de RAM, nem política de dead-letter pronta para produção. Token de fencing protege ACK/lease do banco local, mas não bloqueia um efeito externo tardio por si só; idempotência e UNKNOWN/reconciliação continuam necessárias.

## Revisão futura

Revisar ORM quando houver migrations reais do domínio, constraints compostas de tenant, carga JSON/queries, requisitos de locks ou limitações de driver. Revisar escolha de fila com métricas de backlog/latência, pressão de polling, throughput, fairness, custo do broker e política de rebuild. Nenhuma métrica real está disponível na M1.
