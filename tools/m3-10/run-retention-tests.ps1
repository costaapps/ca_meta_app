$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m310-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m310-$runId"
$initSqlPath = Join-Path $tempRoot 'init.sql'
$composeFile = Join-Path $PSScriptRoot '..\m2-03\compose.yaml'
$keepEnvironment = $env:M3_10_KEEP_ENVIRONMENT -eq '1'
$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)

if ($isWindowsPlatform) {
  $runtimeDirectory = $env:M2_NODE_RUNTIME_DIR
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
  throw "M3.10 harness requires Node v24.22.2/npm 11.19.1; found $nodeVersion/$npmVersion."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$dbPort = $listener.LocalEndpoint.Port
$listener.Stop()

function New-HexSecret {
  return [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
}
function Invoke-Checked {
  param([string]$FilePath, [string[]]$ArgumentList)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE : $FilePath" }
}

try {
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
$env:M3_10_TEST = '1'
$env:MIGRATION_DATABASE_HOST = '127.0.0.1'
$env:MIGRATION_DATABASE_PORT = [string]$dbPort
$env:MIGRATION_DATABASE_NAME = 'ca_meta_m203'
$env:MIGRATION_DATABASE_USER = 'ca_meta_migrator'
$env:MIGRATION_DATABASE_PASSWORD = $migrationPassword
$env:MIGRATION_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:MIGRATION_LOCK_TIMEOUT_SECONDS = '2'
$env:MIGRATION_STATEMENT_TIMEOUT_SECONDS = '30'
$env:MIGRATION_MIN_SUPPORTED_API_VERSION = '1'
$env:API_DATABASE_HOST = '127.0.0.1'
$env:API_DATABASE_PORT = [string]$dbPort
$env:API_DATABASE_NAME = 'ca_meta_m203'
$env:API_DATABASE_USER = 'ca_meta_api'
$env:API_DATABASE_PASSWORD = $apiPassword
$env:API_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:API_PORT = '0'
$env:API_BIND_ADDRESS = '127.0.0.1'
$env:API_ALLOWED_HOSTS = 'localhost'
$env:API_TRUSTED_PROXIES = 'none'
$env:API_PORTAL_SESSION_RECOVERY_KEY = $apiPassword
$env:API_ALLOWED_ORIGINS = ''
$env:NODE_ENV = 'test'
$env:API_PORTAL_ENTRY_TICKET_ENABLED = 'false'
$env:M2_API_DATABASE_PASSWORD = $apiPassword

  Write-Output "Disposable Compose project: $composeProject"
  Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'up', '-d', '--wait')
  Invoke-Checked -FilePath $npmCommand -ArgumentList @('--workspace=@ca-meta/api', 'run', 'test:m3-10')
} finally {
  if (-not $keepEnvironment) {
    & docker compose -p $composeProject -f $composeFile down --volumes --remove-orphans
    $cleanupExit = $LASTEXITCODE
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
    if ($cleanupExit -ne 0) { Write-Warning "Cleanup failed for own project $composeProject (exit $cleanupExit)." }
  } else {
    Write-Output "Preserved only this generated environment for local debugging: $composeProject"
    Write-Output "Cleanup: docker compose -p $composeProject -f `"$composeFile`" down --volumes --remove-orphans"
  }
}
