Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [guid]::NewGuid().ToString('N')
$suffix = $runId.Substring(0, 12)
$networkName = "m206-$suffix"
$webContainer = "m206-web-$suffix"
$apiContainer = "m206-api-$suffix"
$workerContainer = "m206-worker-$suffix"
$webImage = "ca-meta-web:m206-$suffix"
$apiImage = "ca-meta-api:m206-$suffix"
$ociVersion = '0.0.0-m2-06'
$ociRevision = (& git -C $repoRoot rev-parse HEAD).Trim()
$createdContainers = [System.Collections.Generic.List[string]]::new()
$createdImages = [System.Collections.Generic.List[string]]::new()
$networkCreated = $false
$exitCode = 0
$httpClient = [System.Net.Http.HttpClient]::new()

function Invoke-Docker {
  param([Parameter(Mandatory)][string[]] $Arguments)
  $result = & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed with exit code $LASTEXITCODE." }
  return $result
}

function Assert-True {
  param([bool] $Condition, [string] $Message)
  if (-not $Condition) { throw $Message }
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return [int] $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Send-Http {
  param([string] $Uri, [string] $Method = 'GET', [byte[]] $Body)
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  if ($null -ne $Body) {
    $request.Content = [System.Net.Http.ByteArrayContent]::new($Body)
    $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
  }
  $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [pscustomobject]@{
    Status = [int] $response.StatusCode
    Body = $text
    Headers = $response.Headers.ToString() + $response.Content.Headers.ToString()
  }
}

function Get-ContainerInfo {
  param([string] $Name)
  $json = Invoke-Docker -Arguments @('inspect', $Name)
  return @($json | ConvertFrom-Json)[0]
}

try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required.' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to label the tested revision.' }
  if (-not $ociRevision -or $LASTEXITCODE -ne 0) { throw 'Could not resolve the tested Git revision.' }
  $dirty = & git -C $repoRoot status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Run this harness from a clean Git worktree so image labels match the tested source.' }
  Invoke-Docker -Arguments @('info') | Out-Null

  Write-Output "M2.06 smoke run: $runId"
  Write-Output "Candidate: $ociRevision"
  Write-Output 'Building images from the npm lockfile with digest-pinned ECR Public bases.'

  $createdImages.Add($webImage)
  Invoke-Docker -Arguments @('build', '--file', 'infra/docker/web.Dockerfile', '--build-arg', "OCI_VERSION=$ociVersion", '--build-arg', "OCI_REVISION=$ociRevision", '--tag', $webImage, '.') | Out-Null
  $createdImages.Add($apiImage)
  Invoke-Docker -Arguments @('build', '--file', 'infra/docker/api.Dockerfile', '--build-arg', "OCI_VERSION=$ociVersion", '--build-arg', "OCI_REVISION=$ociRevision", '--tag', $apiImage, '.') | Out-Null

  Invoke-Docker -Arguments @('network', 'create', $networkName) | Out-Null
  $networkCreated = $true
  $webPort = Get-FreeLoopbackPort

  $apiEnvironment = @(
    'NODE_ENV=production', 'API_PORT=3000', 'API_BIND_ADDRESS=0.0.0.0',
    'API_ALLOWED_HOSTS=127.0.0.1,localhost', 'API_TRUSTED_PROXIES=none',
    'API_DATABASE_HOST=127.0.0.1', 'API_DATABASE_PORT=3306', 'API_DATABASE_NAME=ca_meta_m206',
    'API_DATABASE_USER=synthetic_unused', 'API_DATABASE_PASSWORD=synthetic_unused',
    'API_DATABASE_CONNECT_TIMEOUT_MS=1000'
  )
  $apiArgs = @('run', '--detach', '--name', $apiContainer, '--network', $networkName, '--network-alias', 'api',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true')
  foreach ($entry in $apiEnvironment) { $apiArgs += @('--env', $entry) }
  $apiArgs += $apiImage
  $createdContainers.Add($apiContainer)
  Invoke-Docker -Arguments $apiArgs | Out-Null

  $webArgs = @('run', '--detach', '--name', $webContainer, '--network', $networkName,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true',
    '--publish', "127.0.0.1:${webPort}:8080", '--env', 'WEB_PUBLIC_META_API_BASE_URL=/api', $webImage)
  $createdContainers.Add($webContainer)
  Invoke-Docker -Arguments $webArgs | Out-Null

  $baseUri = "http://127.0.0.1:$webPort"
  $deadline = (Get-Date).AddSeconds(45)
  do {
    $probe = Send-Http -Uri "$baseUri/api/health"
    if ($probe.Status -eq 200) { break }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Assert-True ($probe.Status -eq 200 -and $probe.Body -match '"status"\s*:\s*"ok"') 'API liveness did not pass through the web proxy.'
  Assert-True ($probe.Headers -match '(?im)^X-Request-Id:\s*[^\r\n]+') 'API response correlation header was not preserved.'
  $versionedHealth = Send-Http -Uri "$baseUri/api/v1/health"
  Assert-True ($versionedHealth.Status -eq 200 -and $versionedHealth.Body -match '"status"\s*:\s*"ok"') 'Versioned API health route was not mapped correctly.'

  foreach ($path in @('/setup', '/channels', '/templates', '/setup/callback')) {
    $page = Send-Http -Uri "$baseUri$path"
    Assert-True ($page.Status -eq 200 -and $page.Body -match '<app-root') "Angular fallback failed for $path."
  }

  $index = Send-Http -Uri "$baseUri/index.html"
  Assert-True ($index.Status -eq 200 -and $index.Headers -match '(?i)Cache-Control:\s*[^\r\n]*no-store') 'index.html must be uncached.'
  $runtimeConfig = Send-Http -Uri "$baseUri/runtime-config.js"
  Assert-True ($runtimeConfig.Status -eq 200 -and $runtimeConfig.Headers -match '(?i)Cache-Control:\s*[^\r\n]*no-store') 'Runtime config must be uncached.'
  Assert-True ($runtimeConfig.Body -match '"metaApiBaseUrl":"/api"' -and $runtimeConfig.Body -notmatch '(?i)secret|token|password|dsn') 'Runtime config did not match its public allowlist.'

  $assetMatch = [regex]::Match($index.Body, 'src="([^" ]+-[A-Za-z0-9_-]{8,}\.js)"')
  Assert-True $assetMatch.Success 'Could not find a hashed Angular JavaScript asset in index.html.'
  $asset = Send-Http -Uri "$baseUri/$($assetMatch.Groups[1].Value.TrimStart('/'))"
  Assert-True ($asset.Status -eq 200 -and $asset.Headers -match '(?i)Cache-Control:\s*[^\r\n]*immutable') 'Hashed Angular assets must have immutable caching.'

  $largeBody = [byte[]]::new(65_537)
  $tooLarge = Send-Http -Uri "$baseUri/api/v1/unused" -Method 'POST' -Body $largeBody
  Assert-True ($tooLarge.Status -eq 413) 'Proxy must reject API bodies above 64 KiB.'

  $webInfo = Get-ContainerInfo -Name $webContainer
  $apiInfo = Get-ContainerInfo -Name $apiContainer
  Assert-True ($webInfo.HostConfig.ReadonlyRootfs -and $apiInfo.HostConfig.ReadonlyRootfs) 'Containers must run with read-only root filesystems.'
  Assert-True ($webInfo.Config.User -match '^(?!0(?::|$)|root$).+' -and $apiInfo.Config.User -match '^(?!0(?::|$)|root$).+') 'Images must default to non-root users.'
  foreach ($imageName in @($webImage, $apiImage)) {
    $imageInfo = @(Invoke-Docker -Arguments @('image', 'inspect', $imageName) | ConvertFrom-Json)[0]
    Assert-True ($imageInfo.Config.Labels.'org.opencontainers.image.version' -eq $ociVersion) "$imageName version label is missing."
    Assert-True ($imageInfo.Config.Labels.'org.opencontainers.image.revision' -eq $ociRevision) "$imageName revision label is missing."
    $envText = $imageInfo.Config.Env -join "`n"
    Assert-True ($envText -notmatch '(?i)API_DATABASE_PASSWORD|META_APP_SECRET|ACCESS_TOKEN|SECRET_KEY') "$imageName image environment contains a secret key."
    $history = Invoke-Docker -Arguments @('history', '--no-trunc', $imageName) | Out-String
    Assert-True ($history -notmatch '(?i)API_DATABASE_PASSWORD|META_APP_SECRET|ACCESS_TOKEN|SECRET_KEY') "$imageName history contains a secret key."
  }

  $webScan = 'if grep -R -q -E -i "META_APP_SECRET|ACCESS_TOKEN|API_DATABASE_PASSWORD|SECRET_KEY" /usr/share/nginx/html; then exit 41; fi; test -z "$(find /usr/share/nginx/html -type f -name "*.map" -print -quit)"; test ! -e /usr/share/nginx/html/backend'
  Invoke-Docker -Arguments @('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '--entrypoint', '/bin/sh', $webImage, '-c', $webScan) | Out-Null
  $apiScan = "const fs=require('node:fs'); if (fs.existsSync('/workspace/backend') || fs.readdirSync('/workspace/apps/api/dist',{recursive:true}).some(p=>p.endsWith('.map'))) process.exit(42);"
  Invoke-Docker -Arguments @('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '--entrypoint', 'node', $apiImage, '-e', $apiScan) | Out-Null

  Invoke-Docker -Arguments @('stop', '--time', '10', $apiContainer) | Out-Null
  $apiExit = (Get-ContainerInfo -Name $apiContainer).State.ExitCode
  Assert-True ($apiExit -eq 0) 'API did not exit cleanly after SIGTERM.'

  $workerArgs = @('run', '--detach', '--name', $workerContainer, '--network', $networkName,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true')
  foreach ($entry in $apiEnvironment) { $workerArgs += @('--env', $entry) }
  $workerArgs += @($apiImage, 'node', 'dist/worker/main.js')
  $createdContainers.Add($workerContainer)
  Invoke-Docker -Arguments $workerArgs | Out-Null
  $workerDeadline = (Get-Date).AddSeconds(15)
  $workerLogs = ''
  do {
    $workerLogs = (Invoke-Docker -Arguments @('logs', $workerContainer) 2>$null | Out-String)
    $workerState = Get-ContainerInfo -Name $workerContainer
    if ($workerLogs -match 'worker.started' -or -not $workerState.State.Running) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $workerDeadline)
  Assert-True ($workerLogs -match 'worker.started' -and $workerState.State.Running) 'Worker command did not reach its idle loop.'
  Invoke-Docker -Arguments @('stop', '--time', '10', $workerContainer) | Out-Null
  $workerExit = (Get-ContainerInfo -Name $workerContainer).State.ExitCode
  Assert-True ($workerExit -eq 0) 'Worker did not exit cleanly after SIGTERM.'

  Write-Output 'PASS: image build, SPA/cache/proxy/limits, runtime config, non-root/read-only, layer checks, API SIGTERM, worker command/SIGTERM.'
}
catch {
  Write-Warning $_.Exception.Message
  $exitCode = 1
}
finally {
  foreach ($containerName in $createdContainers) {
    & docker rm --force $containerName *> $null
  }
  if ($networkCreated) { & docker network rm $networkName *> $null }
  foreach ($imageName in $createdImages) { & docker image rm $imageName *> $null }
  $httpClient.Dispose()
}

if ($exitCode -ne 0) { exit $exitCode }
