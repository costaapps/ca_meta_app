$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m205-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m205-$runId"
$initSqlPath = Join-Path $tempRoot 'init.sql'
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$keepEnvironment = $env:M2_05_KEEP_ENVIRONMENT -eq '1'
$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
$runtimeDirectory = $env:M2_NODE_RUNTIME_DIR
if ($isWindowsPlatform) {
  if ([string]::IsNullOrWhiteSpace($runtimeDirectory)) { $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'Codex\runtimes\node-v24.22.2' }
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
if ($nodeVersion -ne 'v24.22.2' -or $npmVersion -ne '11.19.1') { throw "M2.05 harness requires Node v24.22.2/npm 11.19.1; found $nodeVersion/$npmVersion." }
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
  'M2_ROOT_PASSWORD', 'M2_DB_PORT', 'M2_INIT_SQL_PATH',
  'MIGRATION_DATABASE_HOST', 'MIGRATION_DATABASE_PORT', 'MIGRATION_DATABASE_NAME',
  'MIGRATION_DATABASE_USER', 'MIGRATION_DATABASE_PASSWORD', 'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS',
  'MIGRATION_LOCK_TIMEOUT_SECONDS', 'MIGRATION_STATEMENT_TIMEOUT_SECONDS', 'MIGRATION_MIN_SUPPORTED_API_VERSION',
  'API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER', 'API_DATABASE_PASSWORD',
  'API_DATABASE_CONNECT_TIMEOUT_MS', 'API_PORT', 'API_BIND_ADDRESS', 'API_ALLOWED_HOSTS', 'API_TRUSTED_PROXIES',
  'NODE_ENV', 'M2_API_DATABASE_PASSWORD', 'M2_DURABLE_WORK_TEST', 'M2_MIGRATION_TEST'
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironment) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

New-Item -ItemType Directory -Path $tempRoot | Out-Null
$rootPassword = New-HexSecret
$apiPassword = New-HexSecret
$migrationPassword = New-HexSecret
$sql = @"
CREATE USER 'ca_meta_migrator'@'%' IDENTIFIED BY '$migrationPassword';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON ca_meta_m205.* TO 'ca_meta_migrator'@'%';
CREATE USER 'ca_meta_api'@'%' IDENTIFIED BY '$apiPassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON ca_meta_m205.* TO 'ca_meta_api'@'%';
"@
Set-Content -LiteralPath $initSqlPath -Value $sql -Encoding Ascii

$env:M2_ROOT_PASSWORD = $rootPassword
$env:M2_DB_PORT = [string]$dbPort
$env:M2_INIT_SQL_PATH = $initSqlPath.Replace('\', '/')
$env:MIGRATION_DATABASE_HOST = '127.0.0.1'
$env:MIGRATION_DATABASE_PORT = [string]$dbPort
$env:MIGRATION_DATABASE_NAME = 'ca_meta_m205'
$env:MIGRATION_DATABASE_USER = 'ca_meta_migrator'
$env:MIGRATION_DATABASE_PASSWORD = $migrationPassword
$env:MIGRATION_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:MIGRATION_LOCK_TIMEOUT_SECONDS = '2'
$env:MIGRATION_STATEMENT_TIMEOUT_SECONDS = '30'
$env:MIGRATION_MIN_SUPPORTED_API_VERSION = '1'
$env:API_DATABASE_HOST = '127.0.0.1'
$env:API_DATABASE_PORT = [string]$dbPort
$env:API_DATABASE_NAME = 'ca_meta_m205'
$env:API_DATABASE_USER = 'ca_meta_api'
$env:API_DATABASE_PASSWORD = $apiPassword
$env:M2_API_DATABASE_PASSWORD = $apiPassword
$env:API_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:NODE_ENV = 'test'
$env:API_PORT = '0'
$env:API_BIND_ADDRESS = '127.0.0.1'
$env:API_ALLOWED_HOSTS = 'localhost'
$env:API_TRUSTED_PROXIES = 'none'
$env:M2_DURABLE_WORK_TEST = '1'
$env:M2_MIGRATION_TEST = '0'

try {
  Write-Output "Compose project: $composeProject"
  Write-Output "Runtime: Node $nodeVersion / npm $npmVersion"
  Write-Output 'Database: isolated MariaDB 11.8.8; synthetic fixtures only.'
  Push-Location $repoRoot
  try {
    Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'up', '-d', '--wait')
    Invoke-Checked -FilePath $npmCommand -ArgumentList @('exec', '--workspace=@ca-meta/api', '--', 'tsc', '-p', 'tsconfig.test.json')
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @('tools/m2-08/prepare-test-reports.mjs')
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m2-05-durable-work.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m2-05-durable-work.lcov.info',
      'apps/api/dist-test/test/durable-work.integration.spec.js'
    )
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m3-06-meta-assets.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m3-06-meta-assets.lcov.info',
      'apps/api/dist-test/test/m3-06-meta-assets.integration.spec.js'
    )
  } finally { Pop-Location }
} finally {
  if (-not $keepEnvironment) {
    & docker compose -p $composeProject -f $composeFile down --volumes --remove-orphans
    $cleanupExit = $LASTEXITCODE
    $expectedTempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m205-$runId"))
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
    $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedTempRoot -ne $expectedTempRoot -or -not $resolvedTempRoot.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Warning 'Temporary directory cleanup safety check failed; leaving the generated directory untouched.'
    } elseif (Test-Path -LiteralPath $tempRoot) {
      $resolvedItem = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempRoot).Path)
      if ($resolvedItem -eq $expectedTempRoot -and $resolvedItem.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedItem -Recurse -Force
      } else {
        Write-Warning 'Resolved temporary directory cleanup safety check failed; leaving the generated directory untouched.'
      }
    }
    if ($cleanupExit -ne 0) { Write-Warning "Cleanup failed for own project $composeProject (exit $cleanupExit)." }
  } else {
    Write-Output "Preserved only this generated environment: $composeProject"
    Write-Output "Cleanup: docker compose -p $composeProject -f `"$composeFile`" down --volumes --remove-orphans"
  }
  foreach ($name in $managedEnvironment) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }
}
