# M1.04 ORM, MariaDB e worker PoC

Esta PoC privada do M1 exercita o stack em containers locais efêmeros. Usa somente strings e operações sintéticas; não chama Meta, Suite4, PHP legado ou bancos empresariais e não publica portas. Não é uma aplicação para deploy.

## Ambiente e versões fixadas

Executada no Desktop Windows 10 x64 com Docker Engine 28.3.0 / Compose 2.38.1. O container de build usa Node 24.22.2, npm 11.19.1 e a imagem `node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`. Banco é `mariadb:11.8.8@sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf` (InnoDB).

`package-lock.json` resolve workspaces em um só lockfile com duas toolchains:

| Workspace | Pacotes principais | Propósito |
|---|---|---|
| `@m1-04/web-toolchain` | `@angular/compiler`/`compiler-cli` 21.0.8; TypeScript 5.9.3 | Confere uma versão dentro da faixa Angular 21 |
| `@m1-04/api` | Nest core 12.3.2; CLI 12.0.11; schematics 12.0.12; `@nestjs/typeorm` 12.0.2; TypeORM 1.1.2; `mysql2` 3.24.6; TypeScript 6.0.3 | Compila API modular mínima e exercita driver/migrations/worker |

O Node 22.17.0 já instalado no host fica fora da PoC porque o CLI/schematics Nest 12 pede Node `^22.22.3 || ^24.15.0 || >=26.0.0`. Node 26.13.0 virou LTS em 2026-10-28, mas a faixa publicada de Angular 21 exclui Node 26. Node 24.22.2 é a interseção usada neste harness.

## Rodar em PowerShell

Na raiz do repositório, entre nesta pasta, gere um nome Compose exclusivo desta execução e forneça uma senha descartável em memória:

```powershell
Set-Location tools/m1-04
$runId = [guid]::NewGuid().ToString('N')
$projectName = "m104-local-poc-$runId"
$hadPreviousPassword = Test-Path Env:M104_DB_PASSWORD
$previousPassword = $env:M104_DB_PASSWORD
$env:M104_DB_PASSWORD = [guid]::NewGuid().ToString('N')
$result = 1
try {
  docker compose --project-name $projectName up --build --abort-on-container-exit --exit-code-from poc
  $result = $LASTEXITCODE
}
finally {
  docker compose --project-name $projectName down --volumes --remove-orphans
  if ($hadPreviousPassword) {
    $env:M104_DB_PASSWORD = $previousPassword
  }
  else {
    Remove-Item Env:M104_DB_PASSWORD -ErrorAction SilentlyContinue
  }
}
if ($result -ne 0) { exit $result }
```

`projectName` é gerado uma vez com UUID v4 e a mesma variável é usada no `up` e no `down`; cada execução usa seu próprio namespace. O comando `down --volumes` só recebe esse nome e remove containers/rede/volume pertencentes à execução atual, sem atingir uma execução anterior. A senha aleatória fica no environment do processo; não está versionada nem deve ser impressa. O arquivo Compose não publica a porta do MariaDB. O teste termina com `M1.04 MariaDB/worker PoC PASS` ou código diferente de zero.

Em bash, o equivalente é:

```bash
cd tools/m1-04
run_id="$(openssl rand -hex 16)"
project_name="m104-local-poc-$run_id"
previous_was_set="${M104_DB_PASSWORD+x}"
previous_password="${M104_DB_PASSWORD-}"
export M104_DB_PASSWORD="$(openssl rand -hex 32)"
docker compose --project-name "$project_name" up --build --abort-on-container-exit --exit-code-from poc
status=$?
docker compose --project-name "$project_name" down --volumes --remove-orphans
if [ -n "$previous_was_set" ]; then
  export M104_DB_PASSWORD="$previous_password"
else
  unset M104_DB_PASSWORD
fi
exit "$status"
```

Usar o mesmo `$projectName`/`$project_name` em `up` e `down`; não substituir por um nome fixo ou executar `down -v` sem o ID desta execução.

## Cenários e comandos efetivamente executados

Dentro da imagem Node, o comando de validação é `npm test`, que roda `npm run check:toolchains` e `npm run test:poc`. Build Docker roda `npm ci` estritamente pelo lockfile, checagem de workspaces e `nest build`.

Executado em 2026-10-28 no Desktop, em snapshot local do reparo P2:

```text
Compose project: m104-local-poc-1184eca0548647f4b419e4065b499a2a
docker compose --project-name m104-local-poc-1184eca0548647f4b419e4065b499a2a up --build --abort-on-container-exit --exit-code-from poc
exit code: 0
```

O log confirmou o guard de host/porta/usuário/database (overrides recusados antes de criar DataSource); MariaDB `11.8.8-MariaDB-ubu2404`; migrations `1 then 0`; Nest runtime com MariaDB e encerramento SIGTERM; JSON válido/inválido; `idx_m104_records_tenant_ref` escolhido (`EXPLAIN type=ref`); rollback DML; 2 claims distintos; lease renewal autorizado para token ativo; após expirar/reclamar, renewal e ACK do token velho rejeitados e ACK do novo owner aceito; crash/restart com attempts=2 e effect-count=1; worker filho real finalizado por SIGTERM após drenar um job, saída 0 e o job seguinte PENDING; resumo `external-calls=0 production-writes=0`; marcador `M1.04 MariaDB/worker PoC PASS`. O `finally` removeu apenas os containers, volume e rede do projeto UUID daquela execução.

O runner comprova:

1. Nest CLI compila com TypeScript 6.0.3 e o workspace Angular instalado separadamente conserva TypeScript 5.9.3.
2. `synchronize=false`, `migrationsRun=false` e classe TypeORM explícita: primeira chamada `runMigrations()` aplica uma migration; a segunda retorna zero. `migrationsTransactionMode=none` evita sugerir que DDL MariaDB é revertido atomicamente.
3. MariaDB aceita JSON válido, rejeita JSON inválido pelo check do alias e extrai `tenantRef` em coluna STORED gerada.
4. Insere 600 registros sintéticos e executa `EXPLAIN` sem `FORCE INDEX`; o plano deve escolher `idx_m104_records_tenant_ref` para uma busca seletiva.
5. Dois INSERTs DML dentro do mesmo transaction manager TypeORM são removidos após uma exceção deliberada; o count retorna ao mesmo valor.
6. Cada inserção de registro e intenção outbox ocorre na mesma transação central. Dois `claimNextJob()` simultâneos usam `SELECT … FOR UPDATE SKIP LOCKED` e adquirem linhas distintas.
7. Um child Node separado reclama um job, persiste o efeito no sink fake idempotente e encerra com código 73 antes de ACK. Após expirar a lease, outro processo é iniciado; ele reclama novamente, repete a operação, salva ACK e a chave única mantém um efeito aplicado com duas tentativas.
8. Uma lease pode ser renovada apenas pelo claim token dono ainda válido. Quando a lease expira, um novo worker substitui o token; o teste confirma que renewal e ACK do claim antigo retornam `false`, o estado continua RUNNING e apenas o token novo pode marcar DONE.
9. Um processo worker Node separado reclama o primeiro de dois jobs e emite um marcador sintético. O runner envia SIGTERM do sistema operacional durante um handler de 500 ms, confirma que o processo permanece ativo durante o drain, encerra com código 0 e nunca imprime o claim do segundo job; o primeiro fica DONE e o próximo continua PENDING.
10. Overrides de `DB_HOST`, `DB_PORT`, `DB_USER` ou `DB_NAME` causam erro antes de construir o DataSource; o runner testa cada override antes de abrir a conexão válida do Compose.

O coordenador repetiu o harness em worktree detached depois do commit candidato, com senha efêmera e projeto Compose independente `m104-local-12cc71dd1869438e975e55ddbbbe9b6f`. `config --quiet` e `up --build --abort-on-container-exit --exit-code-from poc` terminaram com exit code 0; o log repetiu os cenários acima e a chamada `down --volumes --remove-orphans` removeu somente esse projeto. A execução e o commit-fonte testado também constam do relatório de entrega da M1.

## Limites

Este é um ensaio curto em uma única instância descartável MariaDB 11.8.8. O guard recusa qualquer destino diferente do host, porta, usuário e database fixos do Compose antes de construir o DataSource; o Compose ainda exige senha temporária. Prova compatibilidade operacional dos pacotes fixados e cenários nomeados, incluindo fencing de ACK no banco local. A função de renovação é exercitada, mas o loop mínimo `runWorker` ainda não agenda heartbeat periódico durante um handler longo; em M2 o worker precisa renovar sob o claim token atual e parar/recuperar quando a renovação falhar, ou limitar a duração do handler abaixo do TTL. O teste de M2 deve manter um handler ativo além do TTL e provar fencing, redelivery e efeito idempotente entre os dois processos. Não prova production DDL/índices, schema legado, carga, fairness entre muitos tenants, HA, backup/restore, storage durability configurada para produção, recuperação de provider com resposta ambígua, que um fencing token local interrompa efeito externo já iniciado, Exactly Once, Redis/BullMQ, cloud KMS, Suite4, grants Meta, callbacks ou ingress TLS. Cada Compose run usa UUID aleatório e remove apenas seu próprio project namespace.

Referências oficiais verificadas em 2026-10-28: [Angular version compatibility](https://angular.dev/reference/versions), [Node 26.13.0](https://nodejs.org/en/blog/release/v26.13.0), [Node 24.22.2](https://nodejs.org/en/blog/release/v24.22.2), [Nest migration guide](https://docs.nestjs.com/migration-guide), [TypeORM driver MariaDB](https://typeorm.io/docs/drivers/mysql/), [TypeORM migrations](https://typeorm.io/docs/migrations/setup/), [TypeORM transactions](https://typeorm.io/docs/transactions/), [MariaDB JSON](https://mariadb.com/docs/server/reference/data-types/string-data-types/json), [MariaDB generated columns](https://mariadb.com/docs/server/reference/sql-statements/data-definition/create/generated-columns), [MariaDB SKIP LOCKED](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/select), [MariaDB implicit DDL commit](https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit).
