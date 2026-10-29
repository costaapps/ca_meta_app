param(
  [string] $NodeExe = 'C:\Users\user\AppData\Local\Codex\runtimes\node-v24.22.2\node.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $PSScriptRoot 'docker-compose.readiness.yml'
$runId = [guid]::NewGuid().ToString('N')
$projectName = "m202-api-ready-$runId"
$databaseName = "m2_02_$runId"
$databaseUser = "m2_02_$($runId.Substring(0, 12))"
$databasePassword = [guid]::NewGuid().ToString('N')
$rootPassword = [guid]::NewGuid().ToString('N')
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$databaseHostPort = ([Net.IPEndPoint] $portProbe.LocalEndpoint).Port
$portProbe.Stop()
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$logDirectory = [IO.Path]::GetFullPath((Join-Path $tempRoot "m2-02-readiness-$runId"))
$stdoutPath = Join-Path $logDirectory 'api.stdout.log'
$stderrPath = Join-Path $logDirectory 'api.stderr.log'
$apiProcess = $null
$httpClient = $null
$composeStarted = $false
$exitCode = 1
$savedEnvironment = @{}
$environmentNames = @(
  'NODE_ENV', 'API_PORT', 'API_BIND_ADDRESS', 'API_TRUSTED_PROXIES',
  'API_DATABASE_HOST', 'API_DATABASE_PORT', 'API_DATABASE_NAME', 'API_DATABASE_USER',
  'API_DATABASE_PASSWORD', 'API_DATABASE_CONNECT_TIMEOUT_MS',
  'M2_02_DB_ROOT_PASSWORD', 'M2_02_DB_NAME', 'M2_02_DB_USER', 'M2_02_DB_PASSWORD',
  'M2_02_DB_HOST_PORT'
)

function Invoke-Compose([string[]] $Arguments) {
  & docker compose --project-name $projectName --file $composeFile @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'The isolated readiness Compose command failed.'
  }
}

function Get-ReadyResponse([string] $Url) {
  try {
    $response = $httpClient.GetAsync($Url).GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $status = [int] $response.StatusCode
    $parsed = $body | ConvertFrom-Json -ErrorAction Stop
    $bodyStatus = if ($null -ne $parsed.status) { [string] $parsed.status } else { 'missing' }
    return @{ Kind = 'http'; Status = $status; BodyStatus = $bodyStatus; Body = $parsed }
  }
  catch [System.Threading.Tasks.TaskCanceledException] {
    return @{ Kind = 'timeout' }
  }
  catch [System.Net.Http.HttpRequestException] {
    $socketError = $_.Exception.InnerException -as [System.Net.Sockets.SocketException]
    if ($null -ne $socketError -and $socketError.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) {
      return @{ Kind = 'connection-refused' }
    }
    return @{ Kind = 'transport-error' }
  }
  catch {
    return @{ Kind = 'invalid-response' }
  }
}

function Wait-Ready([string] $Url, [int] $ExpectedStatus, [int] $TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastStatus = 'no response'
  while ([DateTime]::UtcNow -lt $deadline) {
    $result = Get-ReadyResponse $Url
    if ($result.Kind -eq 'http') {
      $lastStatus = "HTTP $($result.Status) body.status=$($result.BodyStatus)"
    }
    else {
      $lastStatus = [string] $result.Kind
    }
    if ($result.Kind -eq 'http' -and $result.Status -eq $ExpectedStatus) {
      if ($ExpectedStatus -eq 200 -and $result.BodyStatus -ne 'ok') { throw 'Readiness body mismatch.' }
      if ($ExpectedStatus -eq 503 -and $result.BodyStatus -ne 'unavailable') { throw 'Readiness body mismatch.' }
      if (@($result.Body.PSObject.Properties.Name).Count -ne 1) { throw 'Readiness exposed unexpected fields.' }
      return $lastStatus
    }
    Start-Sleep -Milliseconds 250
  }
  $health = Get-DatabaseHealth
  throw "The API did not reach expected readiness status $ExpectedStatus; last result: $lastStatus; MariaDB health: $health."
}

function Get-DatabaseHealth {
  $containerId = (& docker compose --project-name $projectName --file $composeFile ps --quiet db).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) { return 'missing' }
  $health = (& docker inspect --format '{{.State.Health.Status}}' $containerId).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($health)) { return 'unknown' }
  return $health
}

function Wait-DatabaseHealthy([int] $TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastHealth = 'unknown'
  while ([DateTime]::UtcNow -lt $deadline) {
    $lastHealth = Get-DatabaseHealth
    if ($lastHealth -eq 'healthy') { return $lastHealth }
    Start-Sleep -Milliseconds 500
  }
  throw "MariaDB did not become healthy; last container health: $lastHealth."
}

try {
  if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Node 24.22.2 was not found at the configured runtime path.'
  }
  $nodeVersion = (& $NodeExe --version).Trim()
  if ($nodeVersion -ne 'v24.22.2') { throw 'The readiness harness requires Node v24.22.2.' }
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps\api\dist\main.js') -PathType Leaf)) {
    throw 'Build the API first with npm run build:api.'
  }
  New-Item -ItemType Directory -Path $logDirectory | Out-Null
  Write-Output "M2.02 isolated Compose project: $projectName"

  foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  $env:NODE_ENV = 'test'
  $env:API_PORT = 'invalid-port'
  $env:API_DATABASE_PASSWORD = 'synthetic-config-marker-never-print'
  $invalidConfigProcess = Start-Process -FilePath $NodeExe -ArgumentList @('apps/api/dist/main.js') `
    -WorkingDirectory $repoRoot -PassThru -Wait -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDirectory 'invalid.stdout.log') `
    -RedirectStandardError (Join-Path $logDirectory 'invalid.stderr.log')
  $invalidConfigOutput = Get-Content -LiteralPath (Join-Path $logDirectory 'invalid.stderr.log') -Raw
  if ($invalidConfigProcess.ExitCode -ne 1 -or $invalidConfigOutput -notmatch 'configuration.invalid' -or
      $invalidConfigOutput -notmatch 'API_PORT' -or $invalidConfigOutput -match 'synthetic-config-marker-never-print') {
    throw 'Invalid configuration did not fail safely with field names only.'
  }

  $env:NODE_ENV = 'test'
  $env:API_PORT = '0'
  $env:API_BIND_ADDRESS = '127.0.0.1'
  $env:API_TRUSTED_PROXIES = 'none'
  $env:API_DATABASE_HOST = '127.0.0.1'
  $env:API_DATABASE_PORT = '1'
  $env:API_DATABASE_NAME = $databaseName
  $env:API_DATABASE_USER = $databaseUser
  $env:API_DATABASE_PASSWORD = $databasePassword
  $env:API_DATABASE_CONNECT_TIMEOUT_MS = '1000'
  $env:M2_02_DB_ROOT_PASSWORD = $rootPassword
  $env:M2_02_DB_NAME = $databaseName
  $env:M2_02_DB_USER = $databaseUser
  $env:M2_02_DB_PASSWORD = $databasePassword
  $env:M2_02_DB_HOST_PORT = [string] $databaseHostPort

  Invoke-Compose @('config', '--quiet')
  $composeStarted = $true
  Invoke-Compose @('up', '--detach', '--wait', '--wait-timeout', '75')
  $env:API_DATABASE_PORT = [string] $databaseHostPort

  $apiProcess = Start-Process -FilePath $NodeExe -ArgumentList @('apps/api/dist/main.js') `
    -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $startupPort = $null
  $startupDeadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $startupDeadline -and $null -eq $startupPort) {
    if ($apiProcess.HasExited) { throw 'The API process exited before startup completed.' }
    if (Test-Path -LiteralPath $stdoutPath) {
      foreach ($line in (Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue)) {
        try {
          $entry = $line | ConvertFrom-Json -ErrorAction Stop
          if ($entry.event -eq 'api.started') { $startupPort = [int] $entry.port; break }
        }
        catch { }
      }
    }
    if ($null -eq $startupPort) { Start-Sleep -Milliseconds 200 }
  }
  if ($null -eq $startupPort) { throw 'The API did not report a safe startup status in time.' }

  $httpClient = [Net.Http.HttpClient]::new()
  $httpClient.Timeout = [TimeSpan]::FromSeconds(3)
  $readyUrl = "http://127.0.0.1:$startupPort/ready"
  $readyInitially = Wait-Ready $readyUrl 200 30

  Invoke-Compose @('stop', 'db')
  $livenessDuringDatabaseOutage = Get-ReadyResponse "http://127.0.0.1:$startupPort/health"
  if ($livenessDuringDatabaseOutage.Kind -ne 'http' -or $livenessDuringDatabaseOutage.Status -ne 200 -or
      $livenessDuringDatabaseOutage.BodyStatus -ne 'ok' -or
      @($livenessDuringDatabaseOutage.Body.PSObject.Properties.Name).Count -ne 1) {
    throw "Liveness did not remain healthy while MariaDB was stopped; last result: $($livenessDuringDatabaseOutage.Kind)."
  }
  $readyDuringOutage = Wait-Ready $readyUrl 503 30

  Invoke-Compose @('start', 'db')
  $databaseHealthAfterRestart = Wait-DatabaseHealthy 60
  $readyAfterRestart = Wait-Ready $readyUrl 200 30

  Write-Output 'M2.02 startup configuration PASS: invalid settings exited with field names only.'
  Write-Output "M2.02 MariaDB readiness PASS: initial $readyInitially; outage $readyDuringOutage; /health 200 while DB was stopped; MariaDB health $databaseHealthAfterRestart; recovered $readyAfterRestart."
  $exitCode = 0
}
catch {
  Write-Error $_.Exception.Message
  $exitCode = 1
}
finally {
  if ($null -ne $httpClient) { $httpClient.Dispose() }
  if ($null -ne $apiProcess -and -not $apiProcess.HasExited) {
    Stop-Process -Id $apiProcess.Id -Force -ErrorAction SilentlyContinue
    $apiProcess.WaitForExit(5000) | Out-Null
  }
  if ($composeStarted) {
    & docker compose --project-name $projectName --file $composeFile down --volumes --remove-orphans
    if ($LASTEXITCODE -ne 0) {
      Write-Error 'Cleanup of this run isolated Compose project failed.'
      $exitCode = 1
    }
  }
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
  $normalizedTempRoot = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if ($exitCode -ne 0) {
    Write-Output "Sanitized runner logs retained under: $logDirectory"
  }
  elseif ($logDirectory.StartsWith($normalizedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $logDirectory) -eq "m2-02-readiness-$runId" -and
      (Test-Path -LiteralPath $logDirectory)) {
    Remove-Item -LiteralPath $logDirectory -Recurse -Force
  }
}

exit $exitCode
