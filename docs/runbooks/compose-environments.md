# Runbook de Compose para M2.07

Este runbook prepara e opera uma stack isolada da nova plataforma. O modo de produção usa imagens por digest e banco MariaDB gerenciado; somente o override dev/test inclui MariaDB local. A fila durável da M2.05 reside nas tabelas MariaDB e não há Redis/RabbitMQ declarado. O volume local contém schema e jobs sintéticos/desenvolvimento; não é compartilhado entre projetos Compose.

## Estado e limites

O desenho segue a documentação oficial do [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Compose secrets](https://docs.docker.com/reference/compose-file/secrets/), [service health/restart/resources](https://docs.docker.com/reference/compose-file/services/) e [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/). O comando de configuração e o modo JSON do harness seguem [`docker compose config`](https://docs.docker.com/reference/cli/docker/compose/config/). Essas fontes documentam semântica do Compose; não confirmam firewall, KMS, DB gerenciado, ingress TLS ou restauração deste host.

- `infra/compose.yaml` declara web, API, worker e migration one-off; não cria banco de produção.
- `infra/compose.dev.yaml` adiciona build com Node 24.22.2, mounts de código, MariaDB 11.8.8 pinado por digest e volume exclusivo do projeto.
- `infra/compose.prod.yaml` seleciona os digests web/API do release lock; não adiciona serviços de banco/fila nem portas.
- Somente web publica a porta de ingress. API, worker, migration e DB não publicam portas do host.
- `edge` permite web → API; `internal` mantém o banco privado; `outbound` fornece saída do API/worker/migration para serviços externos autorizados. Regras reais de egress, firewall, DNS, TLS e ingress reverso são **Not confirmed**.
- API e worker recebem o mesmo bloco de configuração e o mesmo segredo de runtime em `/run/secrets`. O worker não escuta HTTP e seu healthcheck HTTP do Dockerfile da API fica desativado.
- A stack Compose no host único tem SPOF. Compose sozinho não oferece HA, failover, armazenamento replicado ou backup verificado. Capacidade, RPO/RTO, hostname, região, ingress e banco gerenciado são **Not confirmed**.
- O lock entregue é template: imagens publicadas, namespace Docker Hub e proveniência verificável dependem de M2.09. Ele registra schema v3 e a compatibilidade atual exata v3. Até que M2.09 o preencha e a revisão/validação aceite o release, não há release implantável.

## Preparar um ambiente local descartável

Pré-requisitos: Docker Engine iniciado, Docker Compose 2.23.0 ou posterior, PowerShell 7 ou posterior e acesso ao registry público da imagem MariaDB quando não houver cache. O harness não requer Node/npm no host; a imagem dev usa Node 24.22.2 e o lockfile npm versionado.

Do diretório raiz do checkout:

```powershell
pwsh -NoProfile -File tools/m2-07/run-compose-smoke.ps1
```

O harness cria project name UUID `m207-*`, tag de imagem UUID, senhas sintéticas temporárias, MariaDB e volumes próprios; valida o gate de falha de migration, stack local, ingress, ausência de portas em serviços internos, schema/job persistido, recriação de API/worker e recuperação de uma parada curta do MariaDB. Não usa o container `db-migrations-mariadb-1`, banco externo, credencial real ou endpoint Meta. O teardown remove somente o projeto UUID do harness, a tag de imagem criada se ela ainda aponta ao ID construído nesta execução, e sua pasta temporária confirmada; ali, `down --volumes --remove-orphans` é limitado aos recursos recém-criados. `-KeepEnvironment` preserva esse projeto identificado para inspeção; a saída mostra o comando específico de cleanup.

Para desenvolvimento interativo, use um nome de projeto diferente para cada stack, preencha uma cópia externa de `infra/env/compose.dev.env.example`, forneça três arquivos de senha aleatórios diferentes e defina os caminhos em `CA_META_*_FILE`. O exemplo não contém credenciais que funcionem. O dev web roda Angular dev-server com proxy `/api` → `api:3000`; API e worker montam `apps/api`/contratos e têm dependências no volume do próprio projeto. Para dependências alteradas no lockfile, recrie o volume node_modules removendo apenas o stack dev conhecido após encerrar seus containers; não remova o volume MariaDB se quiser manter dados.

## Preparar a primeira promoção

**Staging e produção reais ainda não estão configurados.** M2.10 define staging/DNS/TLS/callbacks; o secret manager e ingress permanecem **Not confirmed**. Antes de executar comandos no host alvo:

1. Obtenha o mesmo `release-lock.env` imutável que relaciona web/API digest, SHA de origem, `RELEASE_ID` e schema. A cópia versionada `infra/release-lock.env.example` é apenas template. O checker recusa placeholders e digests malformados:

   ```powershell
   pwsh -NoProfile -File tools/m2-07/check-release-lock.ps1 -Path C:\secure\ca-meta\release-lock.env
   ```

   O web digest e API digest devem referenciar imagens distintas; a revisão e a proveniência de cada imagem devem corresponder a `SOURCE_REVISION`. Para a baseline M2.07, `SCHEMA_VERSION=3`, com `SCHEMA_MIN_COMPATIBLE` e `SCHEMA_MAX_COMPATIBLE` contendo 3. O checker não confirma assinatura, SBOM, registry authorization ou build provenance; gates de M2.09 e validação de release continuam necessários.

2. Fora do checkout, prepare `compose.prod.env` conforme `infra/env/compose.prod.env.example`, `release-lock.env` preenchido pela etapa de release, segredo do DB runtime, segredo distinto de migrator e a política aprovada de leitura/rotação. As duas contas devem apontar para o mesmo database privado: runtime limitado a `SELECT, INSERT, UPDATE, DELETE`; migrator limitado a `SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER` nesse database, sem grants globais ou `GRANT OPTION`. Configure host allowlist exato e CIDRs reais do ingress.

3. Instale DNS, certificados e firewall/ingress externo antes de publicar o web. A porta publicada em produção escuta em todas as interfaces (`WEB_PUBLISH_ADDRESS=0.0.0.0`) por padrão; o host/provider deve restringir acesso de acordo com o desenho de ingress. **Não** use `127.0.0.1` como a única fronteira: [Engine 28 release notes](https://docs.docker.com/engine/release-notes/28/) documentam a correção de acesso de hosts vizinhos a portas em loopback. O ambiente informado pelo coordenador anuncia `DOCKER_INSECURE_NO_IPTABLES_RAW`, que reduz a proteção de portas publicadas; firewall externo e efeito dessa flag na máquina permanecem **Not confirmed**. Não habilite produção até essa superfície ser aprovada.

4. Garanta que o banco está acessível pela rede privada e tenha backup recuperável. O serviço `migrate` exige grants e seu runner valida MariaDB/schema; PostgreSQL ou MariaDB incompatível deve falhar fechado. Não criar credenciais em linha de comando nem gravar segredo em env file/log. Arquivos de segredo file-backed de Compose são lidos por Compose; use apenas caminhos confiáveis e não compartilhe a saída bruta de `docker compose config`.

## Install e promoção com migration gate

Exemplo PowerShell no host de operação, adaptando somente caminhos seguros fora do checkout:

```powershell
$envFile = 'C:\secure\ca-meta\compose.prod.env'
$lockFile = 'C:\secure\ca-meta\release-lock.env'
$composeFiles = @('--file', 'infra/compose.yaml', '--file', 'infra/compose.prod.yaml')

pwsh -NoProfile -File tools/m2-07/check-release-lock.ps1 -Path $lockFile
docker compose --project-name ca-meta-prod --env-file $envFile --env-file $lockFile @composeFiles config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration is invalid.' }

docker compose --project-name ca-meta-prod --env-file $envFile --env-file $lockFile @composeFiles pull web api worker migrate
if ($LASTEXITCODE -ne 0) { throw 'Image pull failed; do not promote.' }

docker compose --project-name ca-meta-prod --env-file $envFile --env-file $lockFile @composeFiles up --force-recreate --exit-code-from migrate migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; leave the current application release in place.' }

docker compose --project-name ca-meta-prod --env-file $envFile --env-file $lockFile @composeFiles up --detach --wait --wait-timeout 180 web api worker
if ($LASTEXITCODE -ne 0) { throw 'Application health gate failed; follow rollback guidance.' }
```

Use `config --quiet` only in ordinary terminal/CI output. Docker Compose can read host files while resolving a Compose model; never redirect or paste a full resolved model, `docker inspect` secret data or secret-store output to shared logs. The explicit one-off `up --force-recreate --exit-code-from migrate migrate` must exit 0 before the app promotion command is reached. It leaves the successful migration container as the completion record consumed by `api`/`worker` dependencies. The base Compose also declares those services dependent on `migrate` with `service_completed_successfully`; on failure, the command exits nonzero and no promotion command runs. Preserve logs with sensitive values redacted; investigate and repair/forward-fix before retrying.

`depends_on` controls startup order only. The application and database client need bounded connect/retry/backoff behavior for later connection loss. Do not infer successful DB readiness from API liveness alone: `/health` is liveness; `/ready` is separate. The migration succeeds only after connecting and applying/confirming the versioned migration chain. A queue broker is not present; MariaDB outbox/jobs are durable state.

## Update

1. Retain the currently deployed release lock, config version/reference and compatible DB backup/point-in-time recovery marker. Never include secret bytes in that record.
2. Obtain a new complete lock with immutable image digests and matching source SHA. Run the lock checker and Compose `config --quiet` under the protected environment.
3. Pull the new web/API digests. Confirm the database backup and that the target schema is in the candidate API's declared compatibility bounds.
4. Run the one-off `up --force-recreate --exit-code-from migrate migrate` and check its exit status. Only then run `up --detach --wait` for web/API/worker. The service dependency also prevents API/worker start if migration fails.
5. Check web ingress, API `/health` and `/ready`, worker process/log state, queue backlog, DB connectivity, and release provenance through the approved observability path. M2.07 does not choose SLO thresholds or certify external Meta callbacks.

Do not use `docker compose down --volumes`, `docker volume prune`, or recreate a DB volume during routine update. Updating API/worker containers leaves the DB host and jobs in MariaDB intact. For a local dev stack, the project-prefixed `dev_mariadb_data` named volume survives API/worker rebuild and `down` without `--volumes`.

## Stop

Gracefully stop application services and preserve database resources:

```powershell
docker compose --project-name ca-meta-prod --env-file $envFile --env-file $lockFile @composeFiles stop worker api web
```

To remove only stateless Compose containers/networks while preserving attached volumes, use `down` without `--volumes`; managed DBs are outside Compose. Do not delete secrets or backups as part of stop. DB and job data deletion requires its separate data-retention/authorization procedure.

## Backup and restore

Production is expected to use a managed DB, so backup/PITR must use its verified provider procedure, access policy, retention, encryption, and key recovery. Provider, policy, measured RPO/RTO, and successful restore are **Not confirmed**; M6.05 owns the restore evidence. A file copy or backup command succeeding does not prove restorability. Include DB schema and queued jobs consistently; retain the external secret/key version through its approved recovery process.

For the dev-only MariaDB service, a synthetic snapshot may be created without copying secrets or logs:

```sh
docker compose --project-name "$project" --env-file "$devEnv" --file infra/compose.yaml --file infra/compose.dev.yaml exec --user root -T database sh -ec 'mariadb-dump --protocol=socket --user=root --single-transaction --routines --events --triggers "$MARIADB_DATABASE"' > "$backupPath"
```

Use a separate disposable project/volume for restore rehearsal, then stream the approved dump into its local database after it has initialized. Confirm the schema ledger and job/inbox/outbox/checkpoint counts in that isolated environment before considering the file useful. Never restore a dev snapshot into production or overwrite a live DB as a rollback shortcut. File encoding/streaming syntax differs across PowerShell versions; the smoke harness does not certify backup/restore. **Not confirmed:** a completed production backup/restore drill.

## Rollback

Rollback is release-lock/image selection plus compatibility checking, not erasing migrations or database volumes:

1. Stop widening traffic/cohorts and preserve current release/config/DB evidence.
2. Check the old release lock against the *current* schema version and compatibility bounds. Do not start an old digest against a schema outside its declared bounds.
3. If compatible, set the old immutable image digests and promote them through the same health gate. Re-run the idempotent migration status/apply command only if the release procedure requires it; never edit the ledger/checksum.
4. If incompatible or uncertain, keep service gated and use forward-fix/reconciliation or a reviewed restore into an isolated target. MariaDB DDL can implicitly commit; the M2.05 runner does not make schema rollback transactional.
5. Reconcile pending/ambiguous jobs and external outcomes. A Docker image rollback cannot undo Meta effects, revive revoked credentials, or prove a repeated send safe.

Never use `down --volumes` for update, stop, backup, restore, or rollback. The only automated volume deletion in M2.07 is the harness cleanup of its UUID project created during that same invocation.
