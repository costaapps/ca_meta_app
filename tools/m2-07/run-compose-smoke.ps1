param(
  [switch]$KeepEnvironment,
  [switch]$SkipDatabaseRestart
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m207-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m207-$runId"
$composeEnvPath = Join-Path $tempRoot 'compose.env'
$migrationFailureEnvPath = Join-Path $tempRoot 'compose-migration-failure.env'
$productionEnvPath = Join-Path $tempRoot 'compose-production.env'
$releaseLockPath = Join-Path $tempRoot 'release-lock.env'
$apiPasswordPath = Join-Path $tempRoot 'api-db-password'
$migrationPasswordPath = Join-Path $tempRoot 'migration-db-password'
$rootPasswordPath = Join-Path $tempRoot 'db-root-password'
$imageReference = "local/ca-meta-dev:$runId"
$createdImageId = $null
$databaseName = "ca_meta_m207_$($runId.Substring(0, 12))"
$webPortListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$webPortListener.Start()
$webPort = $webPortListener.LocalEndpoint.Port
$webPortListener.Stop()
$composeFiles = @(
  '--file', (Join-Path $repoRoot 'infra\compose.yaml'),
  '--file', (Join-Path $repoRoot 'infra\compose.dev.yaml')
)

function New-HexSecret {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function Write-PrivateSecretFile {
  param([string]$Path, [string]$Value)
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.Encoding]::ASCII)
}

function ConvertTo-ComposePath {
  param([string]$Path)
  return [System.IO.Path]::GetFullPath($Path).Replace('\', '/')
}

function Write-ComposeEnvironment {
  param([string]$Path, [string]$DatabaseHost = 'database')
  $lines = @(
    "COMPOSE_PROJECT_NAME=$composeProject",
    "DEV_IMAGE_TAG=$runId",
    'NODE_ENV=development',
    'API_PORT=3000',
    'API_BIND_ADDRESS=0.0.0.0',
    'API_ALLOWED_HOSTS=127.0.0.1,localhost',
    'API_TRUSTED_PROXIES=none',
    "API_DATABASE_HOST=$DatabaseHost",
    'API_DATABASE_PORT=3306',
    "API_DATABASE_NAME=$databaseName",
    'API_DATABASE_USER=ca_meta_api',
    'API_DATABASE_CONNECT_TIMEOUT_MS=3000',
    'MIGRATION_DATABASE_USER=ca_meta_migrator',
    'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS=10000',
    'MIGRATION_LOCK_TIMEOUT_SECONDS=30',
    'MIGRATION_STATEMENT_TIMEOUT_SECONDS=300',
    'MIGRATION_MIN_SUPPORTED_API_VERSION=1',
    'WEB_PUBLISH_ADDRESS=127.0.0.1',
    "WEB_PUBLISH_PORT=$webPort",
    'WEB_PUBLIC_META_API_BASE_URL=/api',
    "CA_META_API_DB_PASSWORD_FILE=$(ConvertTo-ComposePath $apiPasswordPath)",
    "CA_META_MIGRATOR_DB_PASSWORD_FILE=$(ConvertTo-ComposePath $migrationPasswordPath)",
    "CA_META_DEV_DB_ROOT_PASSWORD_FILE=$(ConvertTo-ComposePath $rootPasswordPath)"
  )
  [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.Encoding]::ASCII)
}

function Write-ProductionEnvironment {
  param([string]$Path)
  $lines = @(
    "COMPOSE_PROJECT_NAME=$($composeProject)-prod",
    'NODE_ENV=staging',
    'API_PORT=3000',
    'API_BIND_ADDRESS=0.0.0.0',
    'API_ALLOWED_HOSTS=staging.example.test',
    'API_TRUSTED_PROXIES=10.0.0.0/8',
    'API_DATABASE_HOST=private-db.example.test',
    'API_DATABASE_PORT=3306',
    'API_DATABASE_NAME=ca_meta_smoke',
    'API_DATABASE_USER=ca_meta_api',
    'API_DATABASE_CONNECT_TIMEOUT_MS=3000',
    'MIGRATION_DATABASE_USER=ca_meta_migrator',
    'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS=10000',
    'MIGRATION_LOCK_TIMEOUT_SECONDS=30',
    'MIGRATION_STATEMENT_TIMEOUT_SECONDS=300',
    'MIGRATION_MIN_SUPPORTED_API_VERSION=1',
    'WEB_PUBLISH_ADDRESS=0.0.0.0',
    'WEB_PUBLISH_PORT=8080',
    'WEB_PUBLIC_META_API_BASE_URL=/api',
    "CA_META_API_DB_PASSWORD_FILE=$(ConvertTo-ComposePath $apiPasswordPath)",
    "CA_META_MIGRATOR_DB_PASSWORD_FILE=$(ConvertTo-ComposePath $migrationPasswordPath)"
  )
  [System.IO.File]::WriteAllLines($Path, $lines, [System.Text.Encoding]::ASCII)
}

function Write-SyntheticReleaseLock {
  $sourceRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  $lines = @(
    "RELEASE_ID=0.0.0+$($sourceRevision.Substring(0, 12))",
    "SOURCE_REVISION=$sourceRevision",
    "CA_META_WEB_IMAGE=registry.invalid/ca-meta-web@sha256:$('0' * 64)",
    "CA_META_API_IMAGE=registry.invalid/ca-meta-api@sha256:$('1' * 64)",
    "WEB_SOURCE_REVISION=$sourceRevision",
    "API_SOURCE_REVISION=$sourceRevision",
    'SCHEMA_VERSION=3',
    'SCHEMA_MIN_COMPATIBLE=3',
    'SCHEMA_MAX_COMPATIBLE=3'
  )
  [System.IO.File]::WriteAllLines($releaseLockPath, $lines, [System.Text.Encoding]::ASCII)
}

function Invoke-Compose {
  param([string[]]$Arguments, [switch]$ExpectFailure)
  $output = & docker compose --project-name $composeProject --env-file $composeEnvPath @composeFiles @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($ExpectFailure) {
    if ($exitCode -eq 0) { throw "Expected docker compose $($Arguments -join ' ') to fail, but it succeeded." }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
  }
  if ($exitCode -ne 0) {
    throw "docker compose $($Arguments -join ' ') failed with exit code $exitCode. Review the command locally; output was suppressed to avoid leaking configuration."
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
}

function Get-ContainerInfo {
  param([string]$Service, [switch]$IncludeStopped)
  $arguments = @('ps', '--quiet')
  if ($IncludeStopped) { $arguments = @('ps', '--all', '--quiet') }
  $arguments += $Service
  $result = Invoke-Compose -Arguments $arguments
  $ids = @($result.Output | ForEach-Object { "$($_)".Trim() } | Where-Object { $_.Length -gt 0 })
  if ($ids.Count -ne 1) { throw "Expected one container for service $Service; found $($ids.Count)." }
  $inspect = & docker inspect $ids[0] 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect this harness's $Service container." }
  return (@($inspect | ConvertFrom-Json -Depth 30)[0])
}

function Assert-NoPublishedPorts {
  param([string]$Service)
  $container = Get-ContainerInfo -Service $Service -IncludeStopped
  foreach ($entry in $container.NetworkSettings.Ports.PSObject.Properties) {
    if ($null -ne $entry.Value -and @($entry.Value).Count -gt 0) {
      throw "Service $Service unexpectedly publishes a host port."
    }
  }
}

function Invoke-DbQuery {
  param([string]$Sql)
  $container = Get-ContainerInfo -Service 'database'
  $clientCommand = @'
set -eu
umask 077
defaults_file="$(mktemp /tmp/ca-meta-mariadb-smoke.XXXXXX)"
trap 'rm -f "$defaults_file"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
{
  printf '%s\n' '[client]' 'user=root' 'protocol=socket'
  printf 'password=%s\n' "$(cat /run/secrets/mariadb_root_password)"
} > "$defaults_file"
chmod 600 "$defaults_file"
mariadb --defaults-extra-file="$defaults_file" --protocol=socket --user=root --database "$1" --batch --skip-column-names --execute "$2"
'@
  $output = & docker exec --user root $container.Id sh -ec $clientCommand -- $databaseName $Sql 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw 'The isolated development database query failed; output suppressed.' }
  return (@($output) -join '').Trim()
}

function Assert-HttpStatus {
  param([string]$Uri, [int]$ExpectedStatus)
  $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 10 -SkipHttpErrorCheck
  if ([int]$response.StatusCode -ne $ExpectedStatus) {
    throw "HTTP smoke expected $ExpectedStatus from $Uri; got $([int]$response.StatusCode)."
  }
}

try {
  if ($PSVersionTable.PSVersion -lt [version]'7.0') { throw 'Run this harness with PowerShell 7 or later.' }
  $dockerVersionOutput = & docker version --format '{{.Server.Version}}' 2>$null
  $dockerVersionExitCode = $LASTEXITCODE
  $dockerVersion = $dockerVersionOutput | Select-Object -First 1
  if ($dockerVersionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($dockerVersion)) {
    throw 'Docker Engine is unavailable to this shell. Start the authorized local Docker service and retry.'
  }
  $composeVersionOutput = & docker compose version --short 2>$null
  $composeVersionExitCode = $LASTEXITCODE
  $composeVersion = $composeVersionOutput | Select-Object -First 1
  if ($composeVersionExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($composeVersion)) {
    throw 'Docker Compose v2 is required.'
  }
  if ($composeVersion -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { throw 'Could not read the Docker Compose semantic version.' }
  $composeSemver = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  if ($composeSemver -lt [version]'2.23.0') { throw 'Docker Compose 2.23.0 or later is required for JSON model inspection and --wait.' }
  $existingImage = & docker image inspect --format '{{.Id}}' $imageReference 2>$null
  if ($LASTEXITCODE -eq 0) { throw 'The generated UUID development image tag already exists; refusing to reuse it.' }

  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $apiPassword = New-HexSecret
  $migrationPassword = New-HexSecret
  $rootPassword = New-HexSecret
  Write-PrivateSecretFile -Path $apiPasswordPath -Value $apiPassword
  Write-PrivateSecretFile -Path $migrationPasswordPath -Value $migrationPassword
  Write-PrivateSecretFile -Path $rootPasswordPath -Value $rootPassword
  Write-ComposeEnvironment -Path $composeEnvPath
  Write-ComposeEnvironment -Path $migrationFailureEnvPath -DatabaseHost 'm207-unavailable.invalid'
  Write-ProductionEnvironment -Path $productionEnvPath
  Write-SyntheticReleaseLock
  $apiPassword = $null
  $migrationPassword = $null
  $rootPassword = $null

  Push-Location $repoRoot
  try {
    $null = Invoke-Compose -Arguments @('config', '--quiet')
    Write-Output "Compose config: valid (Docker Engine $dockerVersion; Compose $composeVersion)."

    $checkerPath = Join-Path $PSScriptRoot 'check-release-lock.ps1'
    $lockCheck = & pwsh -NoProfile -File $checkerPath -Path $releaseLockPath 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'The synthetic release-lock metadata was rejected by the promotion checker.' }
    $prodComposeFiles = @('--file', (Join-Path $repoRoot 'infra\compose.yaml'), '--file', (Join-Path $repoRoot 'infra\compose.prod.yaml'))
    $prodConfigJson = & docker compose --project-name "$($composeProject)-prod" --env-file $productionEnvPath --env-file $releaseLockPath @prodComposeFiles config --format json 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'The production Compose model did not resolve with the synthetic, valid lock.' }
    $prodConfigText = @($prodConfigJson) -join "`n"
    foreach ($secretPath in @($apiPasswordPath, $migrationPasswordPath, $rootPasswordPath)) {
      $secretValue = [System.IO.File]::ReadAllText($secretPath)
      if ($secretValue.Length -gt 0 -and $prodConfigText.Contains($secretValue)) {
        throw 'A synthetic DB password appeared in the rendered production Compose model.'
      }
    }
    $prodModel = $prodConfigText | ConvertFrom-Json -Depth 50
    $prodServices = @($prodModel.services.PSObject.Properties.Name)
    if ($prodServices -contains 'database' -or $prodServices -contains 'db') { throw 'Production Compose unexpectedly includes a local database.' }
    $webPorts = @($prodModel.services.web.ports | Where-Object { $null -ne $_ })
    if ($webPorts.Count -ne 1) {
      throw 'The production model must publish only its web ingress on all host interfaces by default.'
    }
    if ($webPorts[0].host_ip -ne '0.0.0.0') {
      throw 'The production model must publish only its web ingress on all host interfaces by default.'
    }
    foreach ($service in @('api', 'worker', 'migrate')) {
      $serviceModel = $prodModel.services.PSObject.Properties[$service].Value
      $servicePorts = @($serviceModel.ports | Where-Object { $null -ne $_ })
      if ($servicePorts.Count -gt 0) { throw "Production service $service publishes a host port." }
    }
    $apiEnvironment = @($prodModel.services.api.environment.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" } | Sort-Object)
    $workerEnvironment = @($prodModel.services.worker.environment.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" } | Sort-Object)
    if (Compare-Object -ReferenceObject $apiEnvironment -DifferenceObject $workerEnvironment) {
      throw 'API and worker do not receive identical runtime domain configuration.'
    }
    foreach ($field in @('HOST', 'PORT', 'NAME')) {
      $apiEndpoint = $prodModel.services.api.environment.PSObject.Properties["API_DATABASE_$field"].Value
      $migrationEndpoint = $prodModel.services.migrate.environment.PSObject.Properties["MIGRATION_DATABASE_$field"].Value
      if ($apiEndpoint -ne $migrationEndpoint) { throw "API and migration DB $field differ in the rendered production model." }
    }
    $apiHealthcheck = @($prodModel.services.api.healthcheck.test) -join ' '
    if ($apiHealthcheck -notmatch '/ready' -or $apiHealthcheck -notmatch 'API_ALLOWED_HOSTS') {
      throw 'Production API healthcheck must gate readiness and derive its Host header from API_ALLOWED_HOSTS.'
    }
    Write-Output 'Production model: managed DB only, web ingress published, API/worker/migration private, shared DB endpoint, readiness healthcheck, valid release lock, and DB passwords absent.'

    # Build before any service start so nested app node_modules volumes seed from the image.
    $devImageBuildOutput = & docker compose --project-name $composeProject --env-file $composeEnvPath @composeFiles build api 2>&1
    $devImageBuildExitCode = $LASTEXITCODE
    $imageInspect = & docker image inspect --format '{{.Id}}' $imageReference 2>$null
    $imageInspectExitCode = $LASTEXITCODE
    if ($imageInspectExitCode -eq 0) { $createdImageId = "$imageInspect".Trim() }
    if ($devImageBuildExitCode -ne 0 -or -not $createdImageId) {
      throw 'The isolated development image could not be built before the migration gate scenario.'
    }

    # Exercise the migration dependency before any API or worker is promoted; Compose starts the DB through migrate.
    $bad = & docker compose --project-name $composeProject --env-file $migrationFailureEnvPath @composeFiles up --detach --wait --wait-timeout 45 api worker 2>&1
    $badExitCode = $LASTEXITCODE
    if ($badExitCode -eq 0) { throw 'The deliberately unavailable migration target did not block service startup.' }
    $failedMigration = Get-ContainerInfo -Service 'migrate' -IncludeStopped
    if ($failedMigration.State.Status -ne 'exited' -or [int]$failedMigration.State.ExitCode -eq 0) {
      throw 'The unavailable target did not produce a failed migration container; refusing to count the gate scenario.'
    }
    $failedMigrationEnvironment = @($failedMigration.Config.Env)
    if (-not ($failedMigrationEnvironment -contains 'MIGRATION_DATABASE_HOST=m207-unavailable.invalid')) {
      throw 'The expected unavailable shared database endpoint was not applied to the one-off service.'
    }
    foreach ($service in @('api', 'worker')) {
      $ps = Invoke-Compose -Arguments @('ps', '--quiet', $service)
      if (@($ps.Output | Where-Object { "$($_)".Trim().Length -gt 0 }).Count -gt 0) {
        throw "Migration failure allowed service $service to start."
      }
    }
    Write-Output 'Migration gate: failed preflight prevented API and worker startup.'

    $null = Invoke-Compose -Arguments @('up', '--detach', '--wait', '--wait-timeout', '180', 'web', 'api', 'worker')
    Write-Output 'Development stack: web, API, worker, one-off migration, and local MariaDB started.'

    $baseUri = "http://127.0.0.1:$webPort"
    Assert-HttpStatus -Uri "$baseUri/healthz" -ExpectedStatus 200
    Assert-HttpStatus -Uri "$baseUri/api/health" -ExpectedStatus 200
    Assert-HttpStatus -Uri "$baseUri/api/ready" -ExpectedStatus 200
    Write-Output 'Ingress smoke: web health, API liveness, and API readiness all returned HTTP 200.'

    $runtimeSecretValues = @(
      [System.IO.File]::ReadAllText($apiPasswordPath),
      [System.IO.File]::ReadAllText($migrationPasswordPath),
      [System.IO.File]::ReadAllText($rootPasswordPath)
    )
    $runtimeRepresentations = @()
    foreach ($service in @('web', 'api', 'worker', 'migrate', 'database')) {
      $container = Get-ContainerInfo -Service $service -IncludeStopped
      $runtimeRepresentations += @($container.Config.Env)
      $runtimeRepresentations += @($container.Config.Cmd)
      $runtimeRepresentations += @($container.Config.Entrypoint)
    }
    $logs = Invoke-Compose -Arguments @('logs', '--no-color', 'web', 'api', 'worker', 'migrate', 'database')
    $runtimeRepresentations += @($logs.Output)
    foreach ($secretValue in $runtimeSecretValues) {
      if ($secretValue.Length -gt 0 -and (@($runtimeRepresentations) -join "`n").Contains($secretValue)) {
        throw 'A synthetic DB password appeared in container environment, command configuration, or stack logs.'
      }
    }
    Write-Output 'Secret smoke: runtime passwords were absent from container environment, command configuration, and stack logs.'

    $web = Get-ContainerInfo -Service 'web'
    $published = @($web.NetworkSettings.Ports.'8080/tcp')
    if ($published.Count -ne 1 -or $published[0].HostIp -ne '127.0.0.1' -or [int]$published[0].HostPort -ne $webPort) {
      throw 'The local harness web port is not bound to its isolated loopback port.'
    }
    foreach ($service in @('api', 'worker', 'migrate', 'database')) { Assert-NoPublishedPorts -Service $service }
    $worker = Get-ContainerInfo -Service 'worker'
    $workerHealthTest = @($worker.Config.Healthcheck.Test)
    if ($workerHealthTest.Count -gt 0 -and $workerHealthTest[0] -ne 'NONE') {
      throw 'Worker unexpectedly has an HTTP healthcheck enabled.'
    }
    Write-Output 'Network smoke: only web has a published port; worker HTTP healthcheck is disabled.'

    $tenantId = [Guid]::NewGuid().ToString()
    $jobId = [Guid]::NewGuid().ToString()
    $seedSql = @"
INSERT INTO ca_meta_tenants (id, created_at, updated_at)
VALUES ('$tenantId', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6));
INSERT INTO ca_meta_jobs
  (id, tenant_id, job_type, schema_version, lane, effect_mode, resource_scope_ref,
   idempotency_key, correlation_id, causation_id, payload_hash, payload_json, status,
   attempt, max_attempts, next_run_at, created_at, updated_at)
VALUES
  ('$jobId', '$tenantId', 'PROJECTION_RECONCILE', 1, 'HISTORICAL_PROJECTION', 'SAFE_RETRY',
   'm207-compose-smoke', 'm207-compose-smoke-$runId', 'm207-compose-smoke-$runId', NULL,
   UNHEX(SHA2('synthetic m207 compose smoke', 256)),
   JSON_OBJECT('kind', 'PROJECTION_RECONCILE', 'projectionRef', 'm207-compose-smoke', 'sourceVersion', 1),
   'QUEUED', 0, 5, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6));
SELECT CONCAT((SELECT COUNT(*) FROM ca_meta_jobs WHERE id = '$jobId'), ':',
              (SELECT schema_version FROM ca_meta_schema_migrations ORDER BY schema_version DESC LIMIT 1));
"@
    if ((Invoke-DbQuery -Sql $seedSql) -ne '1:3') { throw 'The synthetic queued job or schema-v3 ledger was not present after migration.' }
    $null = Invoke-Compose -Arguments @('up', '--detach', '--wait', '--wait-timeout', '90', '--force-recreate', '--no-deps', 'api', 'worker')
    $preserved = Invoke-DbQuery -Sql "SELECT CONCAT(status, ':', (SELECT MAX(schema_version) FROM ca_meta_schema_migrations)) FROM ca_meta_jobs WHERE id = '$jobId';"
    if ($preserved -ne 'QUEUED:3') { throw 'API/worker recreation did not preserve the synthetic job and schema-v3 data.' }
    Write-Output 'Persistence smoke: recreating API and worker preserved the queued job and schema v3.'

    if (-not $SkipDatabaseRestart) {
      $null = Invoke-Compose -Arguments @('stop', 'database')
      Start-Sleep -Seconds 3
      $null = Invoke-Compose -Arguments @('up', '--detach', '--wait', '--wait-timeout', '90', 'database')
      $null = Invoke-Compose -Arguments @('up', '--detach', '--wait', '--wait-timeout', '90', 'api', 'worker')
      Assert-HttpStatus -Uri "$baseUri/api/health" -ExpectedStatus 200
      Assert-HttpStatus -Uri "$baseUri/api/ready" -ExpectedStatus 200
      if ((Invoke-DbQuery -Sql "SELECT CONCAT(status, ':', (SELECT MAX(schema_version) FROM ca_meta_schema_migrations)) FROM ca_meta_jobs WHERE id = '$jobId';") -ne 'QUEUED:3') {
        throw 'The queued job was lost after a temporary database stop/restart.'
      }
      Write-Output 'Database recovery smoke: the stack recovered after a local DB restart and retained the queued job.'
    }
  } finally {
    Pop-Location
  }
  Write-Output "Harness passed for isolated Compose project $composeProject."
} finally {
  if (-not $KeepEnvironment) {
    $cleanupExit = 0
    if ([System.IO.File]::Exists($composeEnvPath)) {
      $cleanupOutput = & docker compose --project-name $composeProject --env-file $composeEnvPath @composeFiles down --volumes --remove-orphans 2>$null
      $cleanupExit = $LASTEXITCODE
      $null = $cleanupOutput
    }
    if ($createdImageId) {
      $currentImageId = & docker image inspect --format '{{.Id}}' $imageReference 2>$null
      if ($LASTEXITCODE -eq 0 -and "$currentImageId".Trim() -eq $createdImageId) {
        $imageRemoveOutput = & docker image rm $imageReference 2>$null
        $imageRemoveExit = $LASTEXITCODE
        $null = $imageRemoveOutput
        if ($imageRemoveExit -ne 0) { Write-Warning "Could not remove only the harness image tag $imageReference." }
      }
    }
    $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $expectedTempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m207-$runId"))
    if ([System.IO.Directory]::Exists($tempRoot)) {
      $resolvedTempRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempRoot).Path)
      if ($resolvedTempRoot -eq $expectedTempRoot -and $resolvedTempRoot.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
      } else {
        Write-Warning 'Temporary cleanup path failed the exact UUID and temp-root checks; the directory was left untouched.'
      }
    }
    if ($cleanupExit -ne 0) { Write-Warning "Cleanup of isolated project $composeProject failed with exit code $cleanupExit." }
  } else {
    Write-Output "Preserved only this isolated project: $composeProject"
    Write-Output "Cleanup: docker compose --project-name $composeProject --env-file `"$composeEnvPath`" --file `"$(Join-Path $repoRoot 'infra\compose.yaml')`" --file `"$(Join-Path $repoRoot 'infra\compose.dev.yaml')`" down --volumes --remove-orphans"
    Write-Output "Image cleanup after stopping the project: docker image rm $imageReference"
  }
}
