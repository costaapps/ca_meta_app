$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m605-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m605-$runId"
$initSqlPath = Join-Path $tempRoot 'init.sql'
$backupPath = Join-Path $tempRoot 'm6-05-backup.aesgcm'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$runtimeDirectory = $env:M6_NODE_RUNTIME_DIR
if ([string]::IsNullOrWhiteSpace($runtimeDirectory)) {
  $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'ca-meta-runtimes\node-v24.22.2-win-x64'
}
$nodeCommand = Join-Path $runtimeDirectory 'node.exe'
$npmCommand = Join-Path $runtimeDirectory 'npm.cmd'
if (-not (Test-Path -LiteralPath $nodeCommand) -or -not (Test-Path -LiteralPath $npmCommand)) {
  throw 'Set M6_NODE_RUNTIME_DIR to the installed Node 24.22.2/npm 11.19.1 runtime.'
}
$nodeVersion = (& $nodeCommand --version).Trim()
$npmVersion = (& $npmCommand --version).Trim()
if ($nodeVersion -ne 'v24.22.2' -or $npmVersion -ne '11.19.1') {
  throw "M6.05 requires Node v24.22.2/npm 11.19.1; found $nodeVersion/$npmVersion."
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$dbPort = $listener.LocalEndpoint.Port
$listener.Stop()

function New-HexSecret {
  $bytes = [byte[]]::new(32)
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

function Invoke-Checked {
  param([string]$FilePath, [string[]]$ArgumentList)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE : $FilePath" }
}

$managedEnvironment = @(
  'M6_05_DB_ROOT_PASSWORD', 'M6_05_DB_PORT', 'M6_05_INIT_SQL_PATH', 'M6_05_COMPOSE_PROJECT', 'M6_05_COMPOSE_FILE',
  'M6_05_BACKUP_PATH', 'M6_05_TEMP_DIRECTORY', 'MIGRATION_DATABASE_HOST', 'MIGRATION_DATABASE_PORT', 'MIGRATION_DATABASE_NAME',
  'MIGRATION_DATABASE_USER', 'MIGRATION_DATABASE_PASSWORD', 'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS',
  'MIGRATION_LOCK_TIMEOUT_SECONDS', 'MIGRATION_STATEMENT_TIMEOUT_SECONDS', 'MIGRATION_MIN_SUPPORTED_API_VERSION',
  'API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER', 'API_DATABASE_PASSWORD',
  'API_DATABASE_CONNECT_TIMEOUT_MS', 'API_PORTAL_SESSION_RECOVERY_KEY', 'API_PORT', 'API_BIND_ADDRESS',
  'API_ALLOWED_HOSTS', 'API_ALLOWED_ORIGINS', 'API_TRUSTED_PROXIES', 'NODE_ENV', 'M6_05_TEST'
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironment) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
$previousPath = $env:Path
$composeStarted = $false

try {
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$rootPassword = New-HexSecret
$apiPassword = New-HexSecret
$migrationPassword = New-HexSecret
$sessionRecoveryKey = New-HexSecret
$sql = @"
CREATE USER 'ca_meta_migrator'@'%' IDENTIFIED BY '$migrationPassword';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON ca_meta_m605.* TO 'ca_meta_migrator'@'%';
CREATE USER 'ca_meta_api'@'%' IDENTIFIED BY '$apiPassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON ca_meta_m605.* TO 'ca_meta_api'@'%';
"@
Set-Content -LiteralPath $initSqlPath -Value $sql -Encoding Ascii

$env:M6_05_DB_ROOT_PASSWORD = $rootPassword
$env:M6_05_DB_PORT = [string]$dbPort
$env:M6_05_INIT_SQL_PATH = $initSqlPath.Replace('\', '/')
$env:M6_05_COMPOSE_PROJECT = $composeProject
$env:M6_05_COMPOSE_FILE = $composeFile
$env:M6_05_BACKUP_PATH = $backupPath
$env:M6_05_TEMP_DIRECTORY = $tempRoot
$env:MIGRATION_DATABASE_HOST = '127.0.0.1'
$env:MIGRATION_DATABASE_PORT = [string]$dbPort
$env:MIGRATION_DATABASE_NAME = 'ca_meta_m605'
$env:MIGRATION_DATABASE_USER = 'ca_meta_migrator'
$env:MIGRATION_DATABASE_PASSWORD = $migrationPassword
$env:MIGRATION_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:MIGRATION_LOCK_TIMEOUT_SECONDS = '2'
$env:MIGRATION_STATEMENT_TIMEOUT_SECONDS = '30'
$env:MIGRATION_MIN_SUPPORTED_API_VERSION = '1'
$env:API_DATABASE_HOST = '127.0.0.1'
$env:API_DATABASE_PORT = [string]$dbPort
$env:API_DATABASE_NAME = 'ca_meta_m605'
$env:API_DATABASE_USER = 'ca_meta_api'
$env:API_DATABASE_PASSWORD = $apiPassword
$env:API_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:API_PORTAL_SESSION_RECOVERY_KEY = $sessionRecoveryKey
$env:API_PORT = '0'
$env:API_BIND_ADDRESS = '127.0.0.1'
$env:API_ALLOWED_HOSTS = 'localhost'
$env:API_ALLOWED_ORIGINS = 'http://localhost'
$env:API_TRUSTED_PROXIES = 'none'
$env:NODE_ENV = 'test'
$env:M6_05_TEST = '1'
$env:Path = "$runtimeDirectory;$env:Path"

  Write-Output "M6.05 disposable Compose project: $composeProject"
  Write-Output "Runtime: Node $nodeVersion / npm $npmVersion; MariaDB 11.8.8; synthetic keyring and rows only."
  Push-Location $repoRoot
  try {
    $composeStarted = $true
    Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'up', '-d', '--wait')
    Invoke-Checked -FilePath $npmCommand -ArgumentList @('exec', '--workspace=@ca-meta/api', '--', 'tsc', '-p', 'tsconfig.test.json')
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @('tools/m6-05/prepare-current-schema.mjs')
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @('--test', '--test-concurrency=1', 'apps/api/dist-test/test/m6-05-restore.integration.spec.js')
  } finally { Pop-Location }
} finally {
  if ($composeStarted) {
    & docker compose -p $composeProject -f $composeFile down --volumes --remove-orphans
    if ($LASTEXITCODE -ne 0) { Write-Warning "Cleanup failed for the owned Compose project $composeProject." }
  }
  $expectedTempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m605-$runId"))
  $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if ($resolvedTempRoot -eq $expectedTempRoot -and $resolvedTempRoot.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  } else {
    Write-Warning 'Temporary directory safety check failed; generated backup files were left untouched.'
  }
  foreach ($name in $managedEnvironment) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }
  $env:Path = $previousPath
}
