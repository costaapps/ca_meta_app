$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$composeProject = "m205-$runId"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m205-$runId"
$m3_09DiagnosticPath = Join-Path $tempRoot 'm3-09-safe-diagnostic.txt'
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
  if ($LASTEXITCODE -ne 0) {
    $junitArgument = $ArgumentList | Where-Object { $_ -match '^--test-reporter-destination=(.+\.junit\.xml)$' } | Select-Object -First 1
    if ($null -ne $junitArgument) {
      $relativeReportPath = $junitArgument -replace '^--test-reporter-destination=', ''
      $reportPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $relativeReportPath))
      $reportRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'artifacts\test-results')) +
        [System.IO.Path]::DirectorySeparatorChar
      if ($reportPath.StartsWith($reportRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
        try {
          [xml]$report = Get-Content -LiteralPath $reportPath -Raw
          $failedCases = @($report.SelectNodes('//testcase[failure or error or @failure or @error]'))
          foreach ($case in $failedCases) {
            $testFile = [System.IO.Path]::GetFileName([string]$case.file)
            Write-Output "Failed test case: $($case.name) ($testFile)."
            $failureNode = $case.SelectSingleNode('failure|error')
            if ($null -ne $failureNode) {
              $location = [regex]::Match([string]$failureNode.InnerText,
                '(?m)^\s*at .*[/\\]apps[/\\]api[/\\]dist-test[/\\]test[/\\](?<file>[A-Za-z0-9_.-]+\.spec\.js):(?<line>\d+):(?<column>\d+)')
              if ($location.Success) {
                Write-Output "Failure location: $($location.Groups['file'].Value):$($location.Groups['line'].Value):$($location.Groups['column'].Value)."
              }
              $diagnosticParts = [System.Collections.Generic.List[string]]::new()
              foreach ($diagnosticNode in @($case.SelectNodes('.//system-out|.//system-err|failure|error'))) {
                $diagnosticParts.Add([string]$diagnosticNode.InnerText)
                foreach ($attribute in $diagnosticNode.Attributes) { $diagnosticParts.Add([string]$attribute.Value) }
              }
              if ($env:M3_09_DIAGNOSTIC_PATH -eq $m3_09DiagnosticPath -and
                  (Test-Path -LiteralPath $m3_09DiagnosticPath -PathType Leaf)) {
                $diagnosticParts.Add([string](Get-Content -LiteralPath $m3_09DiagnosticPath -Raw))
              }
              $diagnosticText = [string]::Join("`n", $diagnosticParts)
              $diagnostic = [regex]::Match($diagnosticText,
                '\[M3\.09 safe diagnostic\] stage=(?<stage>claim|handler|finish|credential-finalizer|finish-write) code=(?<code>ER_BAD_FIELD_ERROR|ER_BAD_NULL_ERROR|ER_CANNOT_ADD_FOREIGN|ER_DATA_TOO_LONG|ER_DUP_ENTRY|ER_LOCK_DEADLOCK|ER_LOCK_WAIT_TIMEOUT|ER_NO_DEFAULT_FOR_FIELD|ER_NO_REFERENCED_ROW_2|ER_NO_SUCH_TABLE|ER_PARSE_ERROR|ER_ROW_IS_REFERENCED_2|ER_TABLE_EXISTS_ERROR|ER_TRUNCATED_WRONG_VALUE|ER_WRONG_VALUE_COUNT_ON_ROW|UNCLASSIFIED)(?=\s|$)')
              if ($diagnostic.Success) {
                Write-Output "M3.09 safe diagnostic: stage=$($diagnostic.Groups['stage'].Value) code=$($diagnostic.Groups['code'].Value)."
              }
            }
          }
          if ($failedCases.Count -eq 0) {
            Write-Output "JUnit report recorded no failed case: $([System.IO.Path]::GetFileName($reportPath))."
          }
        } catch {
          Write-Output "Could not parse sanitized JUnit failure names from $([System.IO.Path]::GetFileName($reportPath))."
        }
      }
    }
    throw "Command failed with exit code $LASTEXITCODE : $FilePath"
  }
}

$managedEnvironment = @(
  'M2_ROOT_PASSWORD', 'M2_DB_PORT', 'M2_INIT_SQL_PATH', 'M2_COMPOSE_PROJECT', 'M2_COMPOSE_FILE',
  'MIGRATION_DATABASE_HOST', 'MIGRATION_DATABASE_PORT', 'MIGRATION_DATABASE_NAME',
  'MIGRATION_DATABASE_USER', 'MIGRATION_DATABASE_PASSWORD', 'MIGRATION_DATABASE_CONNECT_TIMEOUT_MS',
  'MIGRATION_LOCK_TIMEOUT_SECONDS', 'MIGRATION_STATEMENT_TIMEOUT_SECONDS', 'MIGRATION_MIN_SUPPORTED_API_VERSION',
  'API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER', 'API_DATABASE_PASSWORD',
  'API_DATABASE_CONNECT_TIMEOUT_MS', 'API_PORT', 'API_BIND_ADDRESS', 'API_ALLOWED_HOSTS', 'API_TRUSTED_PROXIES',
  'NODE_ENV', 'M2_API_DATABASE_PASSWORD', 'M2_DURABLE_WORK_TEST', 'M2_MIGRATION_TEST', 'M3_02_DB_TEST', 'M3_09_TEST',
  'M3_09_DIAGNOSTIC_PATH', 'M3_TEST_CREDENTIAL_KEY_V3'
)
$previousEnvironment = @{}
foreach ($name in $managedEnvironment) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }

New-Item -ItemType Directory -Path $tempRoot | Out-Null
$rootPassword = New-HexSecret
$apiPassword = New-HexSecret
$migrationPassword = New-HexSecret
$credentialKeyV3 = New-HexSecret
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
$env:M2_COMPOSE_PROJECT = $composeProject
$env:M2_COMPOSE_FILE = $composeFile
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
$env:M3_TEST_CREDENTIAL_KEY_V3 = $credentialKeyV3
$env:API_DATABASE_CONNECT_TIMEOUT_MS = '5000'
$env:NODE_ENV = 'test'
$env:API_PORT = '0'
$env:API_BIND_ADDRESS = '127.0.0.1'
$env:API_ALLOWED_HOSTS = 'localhost'
$env:API_TRUSTED_PROXIES = 'none'
$env:M2_DURABLE_WORK_TEST = '1'
$env:M2_MIGRATION_TEST = '0'
$env:M3_02_DB_TEST = '1'
$env:M3_09_TEST = '1'

try {
  Write-Output "Compose project: $composeProject"
  Write-Output "Runtime: Node $nodeVersion / npm $npmVersion"
  Write-Output 'Database: isolated MariaDB 11.8.8; synthetic fixtures only.'
  Push-Location $repoRoot
  try {
    Invoke-Checked -FilePath 'docker' -ArgumentList @('compose', '-p', $composeProject, '-f', $composeFile, 'up', '-d', '--wait')
    Invoke-Checked -FilePath $npmCommand -ArgumentList @('exec', '--workspace=@ca-meta/api', '--', 'tsc', '-p', 'tsconfig.test.json')
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @('tools/m2-08/prepare-test-reports.mjs')
    Write-Output 'M2.05 fixture: durable work and M3.05 onboarding.'
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m2-05-durable-work.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m2-05-durable-work.lcov.info',
      'apps/api/dist-test/test/durable-work.integration.spec.js',
      'apps/api/dist-test/test/m3-05-onboarding.integration.spec.js'
    )
    Write-Output 'M2.05 fixture: M3.06 Meta assets.'
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m3-06-meta-assets.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m3-06-meta-assets.lcov.info',
      'apps/api/dist-test/test/m3-06-meta-assets.integration.spec.js'
    )
    Write-Output 'M2.05 fixture: M3.02 portal session.'
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m3-02-portal-session.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m3-02-portal-session.lcov.info',
      'apps/api/dist-test/test/m3-02-db.integration.spec.js'
    )
    Write-Output 'M2.05 fixture: M3.07 credential vault.'
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m3-07-credential-vault.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m3-07-credential-vault.lcov.info',
      'apps/api/dist-test/test/m3-07-credential-vault.integration.spec.js'
    )
    Write-Output 'M2.05 fixture: M3.09 credential lifecycle.'
    $env:M3_09_DIAGNOSTIC_PATH = $m3_09DiagnosticPath
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @(
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=junit',
      '--test-reporter=lcov',
      '--test-reporter-destination=artifacts/test-results/m3-09-credential-lifecycle.junit.xml',
      '--test-reporter-destination=artifacts/test-results/m3-09-credential-lifecycle.lcov.info',
      'apps/api/dist-test/test/m3-09-credential-lifecycle.integration.spec.js'
    )
    Invoke-Checked -FilePath $nodeCommand -ArgumentList @('tools/m3-07/check-vault-artifact-redaction.mjs')
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
