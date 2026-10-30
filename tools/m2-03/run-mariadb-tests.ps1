$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m203-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m203-$runId"
$initSqlPath = Join-Path $tempRoot 'init.sql'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$keepEnvironment = $env:M2_03_KEEP_ENVIRONMENT -eq '1'
$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
$runtimeDirectory = $env:M2_NODE_RUNTIME_DIR
if ($isWindowsPlatform) {
  if ([string]::IsNullOrWhiteSpace($runtimeDirectory)) {
    $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'Codex\runtimes\node-v24.22.2'
  }
  $nodeCommand = Join-Path $runtimeDirectory 'node.exe'
  $npmCommand = Join-Path $runtimeDirectory 'npm.cmd'
  if (-not (Test-Path -LiteralPath $nodeCommand) -or -not (Test-Path -LiteralPath $npmCommand)) {
    throw 'Set M2_NODE_RUNTIME_DIR to the approved Node 24.22.2/npm 11.19.1 runtime directory.'
  }
  $env:Path = "$runtimeDirectory;$env:Path"
} else {
  $nodeCommand = (Get-Command node -ErrorAction Stop).Source
  $npmCommand = (Get-Command npm -ErrorAction Stop).Source
}
$nodeVersion = (& $nodeCommand --version).Trim()
$npmVersion = (& $npmCommand --version).Trim()
if ($nodeVersion -ne 'v24.22.2' -or $npmVersion -ne '11.19.1') {
  throw "M2.03 harness requires Node v24.22.2/npm 11.19.1; found $nodeVersion/$npmVersion."
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$dbPort = $listener.LocalEndpoint.Port
$listener.Stop()

function New-HexSecret {
  $bytes = [byte[]]::new(32)
  $generator = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Invoke-Checked {
  param([string]$FilePath, [string[]]$ArgumentList)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE : $FilePath" }
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null
$rootPassword = New-HexSecret
$apiPassword = New-HexSecret
$migrationPassword = New-HexSecret
$sql = @"
CREATE USER 'ca_meta_migrator'@'%' IDENTIFIED BY '$migrationPassword';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON ca_meta_m203.* TO 'ca_meta_migrator'@'%';
CREATE USER 'ca_meta_api'@'%' IDENTIFIED BY '$apiPassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON ca_meta_m203.* TO 'ca_meta_api'@'%';
"@
Set-Content -LiteralPath $initSqlPath -Value $sql -Encoding Ascii

$env:M2_ROOT_PASSWORD = $rootPassword
$env:M2_DB_PORT = [string]$dbPort
$env:M2_INIT_SQL_PATH = $initSqlPath.Replace('\', '/')
$env:MIGRATION_DATABASE_HOST = '127.0.0.1'
$env:MIGRATION_DATABASE_PORT = [string]$dbPort
$env:MIGRATION_DATABASE_NAME = 'ca_meta_m203'
$env:MIGRATION_DATABASE_USER = 'ca_meta_migrator'
$env:MIGRATION_DATABASE_PASSWORD = $migrationPassword
$env:MIGRATION_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:MIGRATION_LOCK_TIMEOUT_SECONDS = '2'
$env:MIGRATION_STATEMENT_TIMEOUT_SECONDS = '30'
$env:MIGRATION_MIN_SUPPORTED_API_VERSION = '1'
$env:API_DATABASE_USER = 'ca_meta_api'
$env:M2_API_DATABASE_PASSWORD = $apiPassword
$env:M2_MIGRATION_TEST = '1'

try {
  Write-Output "Compose project: $composeProject"
  Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'up', '-d', '--wait')
  Invoke-Checked -FilePath $npmCommand -ArgumentList @('--workspace=@ca-meta/api', 'run', 'test')
  Invoke-Checked -FilePath $npmCommand -ArgumentList @('--workspace=@ca-meta/api', 'run', 'migrate:deploy')
  Invoke-Checked -FilePath $npmCommand -ArgumentList @('--workspace=@ca-meta/api', 'run', 'migrate:status')

  # Back up the synthetic fixture with a transaction-consistent dump, restore into a fresh database,
  # then verify exact UTF-8 bytes, DATETIME(6), ledger state, and row counts without logging credentials.
  $backupPath = Join-Path $tempRoot 'mariadb-synthetic-backup.sql'
  $dumpOutput = & docker compose -p $composeProject -f $composeFile exec -T -e "MYSQL_PWD=$rootPassword" mariadb mariadb-dump --user=root --single-transaction --quick --hex-blob ca_meta_m203
  if ($LASTEXITCODE -ne 0) { throw "Synthetic database dump failed with exit code $LASTEXITCODE." }
  [System.IO.File]::WriteAllText(
    $backupPath,
    ([string]::Join([Environment]::NewLine, [string[]]$dumpOutput) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )

  Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'exec', '-T', '-e', "MYSQL_PWD=$rootPassword", 'mariadb', 'mariadb', '--user=root', '--execute', 'CREATE DATABASE ca_meta_m203_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')
  $containerId = (& docker compose -p $composeProject -f $composeFile ps -q mariadb).Trim()
  if ([string]::IsNullOrWhiteSpace($containerId)) { throw 'Synthetic restore could not find its own MariaDB container.' }
  Invoke-Checked -FilePath 'docker' -ArgumentList @('cp', $backupPath, "${containerId}:/tmp/m2-03-synthetic-backup.sql")
  Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'exec', '-T', '-e', "MYSQL_PWD=$rootPassword", 'mariadb', 'mariadb', '--user=root', '--database=ca_meta_m203_restore', '--execute', 'SOURCE /tmp/m2-03-synthetic-backup.sql')
  $ledgerSummaryQuery = "SET SESSION group_concat_max_len = 65535; SELECT CONCAT(COUNT(*),'|',COALESCE(SUM(state='APPLIED'),0),'|',COUNT(DISTINCT schema_version),'|',COALESCE(MAX(schema_version),0),'|',COALESCE(SHA2(GROUP_CONCAT(CONCAT_WS(':',schema_version,migration_id,checksum,state) ORDER BY schema_version,migration_id SEPARATOR ','),256),'empty')) FROM ca_meta_schema_migrations"
  $sourceLedgerSummary = & docker compose -p $composeProject -f $composeFile exec -T -e "MYSQL_PWD=$rootPassword" mariadb mariadb --user=root --database=ca_meta_m203 --batch --skip-column-names --execute $ledgerSummaryQuery
  if ($LASTEXITCODE -ne 0) { throw "Synthetic source migration-ledger verification failed with exit code $LASTEXITCODE." }
  $sourceLedgerValues = (($sourceLedgerSummary -join '').Trim() -split '\|')
  if ($sourceLedgerValues.Count -ne 5 -or [int]$sourceLedgerValues[0] -le 0 -or
      [int]$sourceLedgerValues[0] -ne [int]$sourceLedgerValues[1] -or
      [int]$sourceLedgerValues[0] -ne [int]$sourceLedgerValues[2]) {
    throw 'Synthetic source database does not have a complete applied migration ledger.'
  }
  $restoreQuery = "SET SESSION group_concat_max_len = 65535; SELECT CONCAT((SELECT COUNT(*) FROM ca_meta_assets),'|',(SELECT COUNT(*) FROM ca_meta_assets WHERE HEX(external_id)='3030302d3132337c5a61c5bcc3b3c582c48720f09fa7aa'),'|',(SELECT COUNT(*) FROM ca_meta_assets WHERE id='00000000-0000-4000-8000-000000010000' AND DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f')='2026-10-29 12:34:56.123456'),'|',(SELECT CONCAT(COUNT(*),'|',COALESCE(SUM(state='APPLIED'),0),'|',COUNT(DISTINCT schema_version),'|',COALESCE(MAX(schema_version),0),'|',COALESCE(SHA2(GROUP_CONCAT(CONCAT_WS(':',schema_version,migration_id,checksum,state) ORDER BY schema_version,migration_id SEPARATOR ','),256),'empty')) FROM ca_meta_schema_migrations))"
  $restoreSummary = & docker compose -p $composeProject -f $composeFile exec -T -e "MYSQL_PWD=$rootPassword" mariadb mariadb --user=root --database=ca_meta_m203_restore --batch --skip-column-names --execute $restoreQuery
  if ($LASTEXITCODE -ne 0) { throw "Synthetic database restore verification failed with exit code $LASTEXITCODE." }
  $expectedRestoreSummary = "10005|2|1|$($sourceLedgerValues -join '|')"
  if (($restoreSummary -join '').Trim() -ne $expectedRestoreSummary) {
    throw 'Synthetic database restore did not preserve the expected rows, Unicode IDs, UTC precision, and migration ledger.'
  }
  Write-Output "Synthetic backup/restore verified: 10005 assets, $($sourceLedgerValues[0]) applied versions, UTF-8 external ID bytes, DATETIME(6), and migration ledger preserved."
} finally {
  if (-not $keepEnvironment) {
    & docker compose -p $composeProject -f $composeFile down --volumes --remove-orphans
    $cleanupExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $tempRoot) {
      Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
    if ($cleanupExit -ne 0) { Write-Warning "Cleanup failed for own project $composeProject (exit $cleanupExit)." }
  } else {
    Write-Output "Preserved only this generated environment for local debugging: $composeProject"
    Write-Output "Cleanup: docker compose -p $composeProject -f `"$composeFile`" down --volumes --remove-orphans"
  }
}
