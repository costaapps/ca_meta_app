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
$createdContainers = [System.Collections.Generic.List[object]]::new()
$createdImages = [System.Collections.Generic.List[object]]::new()
$createdNetwork = $null
$layerScanRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m206-layer-scan-$runId"
$layerScanCreated = $false
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

function Assert-DockerNameFree {
  param([ValidateSet('container', 'network', 'image')][string] $Kind, [string] $Name)
  & docker $Kind inspect $Name 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Generated Docker $Kind name is already in use." }
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return [int] $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Send-Http {
  param([string] $Uri, [string] $Method = 'GET', [byte[]] $Body, [string] $ContentType = 'application/octet-stream')
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  if ($null -ne $Body) {
    $request.Content = [System.Net.Http.ByteArrayContent]::new($Body)
    $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($ContentType)
  }
  try {
    $response = $httpClient.SendAsync($request).GetAwaiter().GetResult()
  } catch [System.Net.Http.HttpRequestException] {
    return [pscustomobject]@{ Status = 0; Body = ''; Headers = ''; Error = 'connection not ready' }
  }
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [pscustomobject]@{
    Status = [int] $response.StatusCode
    Body = $text
    Headers = $response.Headers.ToString() + $response.Content.Headers.ToString()
    Error = $null
  }
}

function Get-ContainerInfo {
  param([string] $Name)
  $json = Invoke-Docker -Arguments @('inspect', $Name)
  return @($json | ConvertFrom-Json)[0]
}

function Test-AppLayerPath {
  param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][ValidateSet('web', 'api')][string] $ImageKind)
  $path = $Name.Replace('\', '/').TrimStart('/')
  $webApp = if ($ImageKind -eq 'web') {
    $path.StartsWith('usr/share/nginx/html/', [System.StringComparison]::OrdinalIgnoreCase) -or
      $path.StartsWith('etc/nginx/', [System.StringComparison]::OrdinalIgnoreCase) -or
      $path -eq 'usr/local/bin/web-entrypoint.sh'
  } else {
    $false
  }
  $apiWorkspace = $ImageKind -eq 'api' -and $path.StartsWith('workspace/', [System.StringComparison]::OrdinalIgnoreCase)
  $apiAppContent = $apiWorkspace -and ($path.StartsWith('workspace/apps/api/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $path.StartsWith('workspace/packages/contracts/', [System.StringComparison]::OrdinalIgnoreCase))
  if (-not $webApp -and -not $apiWorkspace) { return }

  $sensitivePath = $path -match '(^|/)\.env(?:\..*)?$' -or
    $path -match '(^|/)backend(?:/|$)' -or
    $path -match '(^|/)connect(?:_old)?\.php$'
  $appArtifact = ($webApp -and ($path -match '\.(?:key|pem|map)$')) -or
    ($apiAppContent -and ($path -match '\.(?:key|pem)$' -or $path -match '^workspace/apps/api/dist/.*\.map$'))
  if ($sensitivePath -or $appArtifact) {
    throw "Prohibited application path found in a final image layer ($ImageKind)."
  }
}

function Test-AppTextContent {
  param([Parameter(Mandatory)][string] $Name, [Parameter(Mandatory)][string] $Content, [Parameter(Mandatory)][ValidateSet('web', 'api')][string] $ImageKind)
  $path = $Name.Replace('\', '/')
  $inApp = if ($ImageKind -eq 'web') {
    $path -eq 'workspace/image-metadata.json' -or
      $path -match '^(?:usr/share/nginx/html/|etc/nginx/|usr/local/bin/web-entrypoint\.sh$)'
  } else {
    $path -eq 'workspace/image-metadata.json' -or
      $path -match '^(?:workspace/apps/api/|workspace/packages/contracts/)'
  }
  if (-not $inApp) { return }

  $credentialPattern = '(?i)-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA) )?PRIVATE KEY-----|\bEA[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:META_APP_SECRET|META_ACCESS_TOKEN|API_DATABASE_PASSWORD|MARIADB_ROOT_PASSWORD)\s*[:=]\s*["'']?(?!change_me|replace_me|placeholder|synthetic_unused|your_|<)[A-Za-z0-9_./+=-]{8,}'
  if ($Content -match $credentialPattern) {
    throw "Credential marker found in a final image application file ($ImageKind); value suppressed."
  }
}

function Test-ImageArchiveLayers {
  param([Parameter(Mandatory)][string] $Image, [Parameter(Mandatory)][ValidateSet('web', 'api')][string] $ImageKind)
  $archivePath = Join-Path $layerScanRoot "$ImageKind-image.tar"
  Invoke-Docker -Arguments @('image', 'save', '--output', $archivePath, $Image) | Out-Null
  $archiveStream = [System.IO.File]::OpenRead($archivePath)
  $archiveReader = [System.Formats.Tar.TarReader]::new($archiveStream, $true)
  $layerCount = 0
  try {
    while ($null -ne ($outerEntry = $archiveReader.GetNextEntry())) {
      if ($null -eq $outerEntry.DataStream) { continue }
      if ($outerEntry.Name -match '(^|/)layer\.tar$') {
        $layerCount++
        $layerPath = Join-Path $layerScanRoot "$ImageKind-layer-$layerCount.tar"
        $layerOutput = [System.IO.File]::Create($layerPath)
        try { $outerEntry.DataStream.CopyTo($layerOutput) } finally { $layerOutput.Dispose() }
        $layerStream = [System.IO.File]::OpenRead($layerPath)
        $layerReader = [System.Formats.Tar.TarReader]::new($layerStream, $true)
        try {
          while ($null -ne ($layerEntry = $layerReader.GetNextEntry())) {
            Test-AppLayerPath -Name $layerEntry.Name -ImageKind $ImageKind
            if ($null -eq $layerEntry.DataStream) { continue }
            $textFile = $layerEntry.Name -match '(?i)(?:\.\w{1,12}|/json)$' -or $layerEntry.Name -match '(^|/)(?:Dockerfile|\.npmrc)$'
            $appTextPath = if ($ImageKind -eq 'web') {
              $layerEntry.Name -match '^(?:usr/share/nginx/html/|etc/nginx/|usr/local/bin/web-entrypoint\.sh$)'
            } else {
              $layerEntry.Name -match '^workspace/(?:apps/api/|packages/contracts/)'
            }
            if ($textFile -and $appTextPath) {
              $reader = [System.IO.StreamReader]::new($layerEntry.DataStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
              try {
                $content = $reader.ReadToEnd()
                Test-AppTextContent -Name $layerEntry.Name -Content $content -ImageKind $ImageKind
              } finally { $reader.Dispose() }
            } else {
              $layerEntry.DataStream.CopyTo([System.IO.Stream]::Null)
            }
          }
        } finally {
          $layerReader.Dispose()
          $layerStream.Dispose()
          Remove-Item -LiteralPath $layerPath -Force
        }
      } elseif ($outerEntry.Name -match '\.json$') {
        $reader = [System.IO.StreamReader]::new($outerEntry.DataStream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
        try {
          $metadata = $reader.ReadToEnd()
          Test-AppTextContent -Name 'workspace/image-metadata.json' -Content $metadata -ImageKind $ImageKind
        } finally { $reader.Dispose() }
      }
    }
  } finally {
    $archiveReader.Dispose()
    $archiveStream.Dispose()
  }
  Assert-True ($layerCount -gt 0) "Docker save returned no layers for the final $ImageKind image."
  Write-Output "PASS: scanned $layerCount saved $ImageKind image layers for prohibited app paths and credential markers."
}

try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required.' }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to label the tested revision.' }
  if (-not $ociRevision -or $LASTEXITCODE -ne 0) { throw 'Could not resolve the tested Git revision.' }
  $dirty = & git -C $repoRoot status --porcelain
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Run this harness from a clean Git worktree so image labels match the tested source.' }
  Invoke-Docker -Arguments @('info') | Out-Null
  foreach ($name in @($webContainer, $apiContainer, $workerContainer)) { Assert-DockerNameFree -Kind container -Name $name }
  Assert-DockerNameFree -Kind network -Name $networkName
  foreach ($name in @($webImage, $apiImage)) { Assert-DockerNameFree -Kind image -Name $name }

  $tempPath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $resolvedLayerScanRoot = [System.IO.Path]::GetFullPath($layerScanRoot)
  $expectedLayerScanRoot = [System.IO.Path]::GetFullPath((Join-Path $tempPath "ca-meta-m206-layer-scan-$runId"))
  Assert-True ($resolvedLayerScanRoot -eq $expectedLayerScanRoot -and $runId -match '^[0-9a-f]{32}$') 'Layer scan path is outside its UUID temporary directory.'
  Assert-True (-not (Test-Path -LiteralPath $resolvedLayerScanRoot)) 'Generated layer scan directory already exists; refusing to use or clean it.'
  New-Item -ItemType Directory -Path $resolvedLayerScanRoot | Out-Null
  $layerScanCreated = $true

  Write-Output "M2.06 smoke run: $runId"
  Write-Output "Candidate: $ociRevision"
  Write-Output 'Building images from the npm lockfile with digest-pinned ECR Public bases.'

  Invoke-Docker -Arguments @('build', '--file', 'infra/docker/web.Dockerfile', '--build-arg', "OCI_VERSION=$ociVersion", '--build-arg', "OCI_REVISION=$ociRevision", '--tag', $webImage, '.') | Out-Null
  $webImageInfo = @(Invoke-Docker -Arguments @('image', 'inspect', $webImage) | ConvertFrom-Json)[0]
  $createdImages.Add([pscustomobject]@{ Name = $webImage; Id = $webImageInfo.Id })
  Test-ImageArchiveLayers -Image $webImage -ImageKind web
  Invoke-Docker -Arguments @('build', '--file', 'infra/docker/api.Dockerfile', '--build-arg', "OCI_VERSION=$ociVersion", '--build-arg', "OCI_REVISION=$ociRevision", '--tag', $apiImage, '.') | Out-Null
  $apiImageInfo = @(Invoke-Docker -Arguments @('image', 'inspect', $apiImage) | ConvertFrom-Json)[0]
  $createdImages.Add([pscustomobject]@{ Name = $apiImage; Id = $apiImageInfo.Id })
  Test-ImageArchiveLayers -Image $apiImage -ImageKind api

  $networkId = (Invoke-Docker -Arguments @('network', 'create', $networkName) | Out-String).Trim()
  Assert-True ($networkId -match '^[0-9a-f]{64}$') 'Docker did not confirm creation of the isolated network.'
  $createdNetwork = [pscustomobject]@{ Name = $networkName; Id = $networkId }
  $networkInfo = @(Invoke-Docker -Arguments @('network', 'inspect', $networkName) | ConvertFrom-Json)[0]
  Assert-True ($networkInfo.Id -eq $networkId) 'The isolated network name resolved to an unexpected resource.'
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
  $apiId = (Invoke-Docker -Arguments $apiArgs | Out-String).Trim()
  Assert-True ($apiId -match '^[0-9a-f]{64}$') 'Docker did not confirm creation of the API container.'
  $createdContainers.Add([pscustomobject]@{ Name = $apiContainer; Id = $apiId })
  Assert-True ((Get-ContainerInfo -Name $apiContainer).Id -eq $apiId) 'The API container name resolved to an unexpected resource.'

  $webArgs = @('run', '--detach', '--name', $webContainer, '--network', $networkName,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true',
    '--publish', "127.0.0.1:${webPort}:8080", '--env', 'WEB_PUBLIC_META_API_BASE_URL=/api', $webImage)
  $webId = (Invoke-Docker -Arguments $webArgs | Out-String).Trim()
  Assert-True ($webId -match '^[0-9a-f]{64}$') 'Docker did not confirm creation of the web container.'
  $createdContainers.Add([pscustomobject]@{ Name = $webContainer; Id = $webId })
  Assert-True ((Get-ContainerInfo -Name $webContainer).Id -eq $webId) 'The web container name resolved to an unexpected resource.'

  $baseUri = "http://127.0.0.1:$webPort"
  # Treat connection refusal as transient until the same bounded readiness deadline.
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
  Assert-True ($index.Body -match '<base href="/">') 'Container index must resolve Angular assets from the root.'
  Assert-True ($index.Headers -match '(?im)^X-Content-Type-Options:\s*nosniff' -and $index.Headers -match '(?im)^Referrer-Policy:\s*no-referrer') 'index.html security headers are missing.'
  $runtimeConfig = Send-Http -Uri "$baseUri/runtime-config.js"
  Assert-True ($runtimeConfig.Status -eq 200 -and $runtimeConfig.Headers -match '(?i)Cache-Control:\s*[^\r\n]*no-store') 'Runtime config must be uncached.'
  Assert-True ($runtimeConfig.Headers -match '(?im)^X-Content-Type-Options:\s*nosniff' -and $runtimeConfig.Headers -match '(?im)^Referrer-Policy:\s*no-referrer') 'Runtime config security headers are missing.'
  Assert-True ($runtimeConfig.Body -match '"metaApiBaseUrl":"/api"' -and $runtimeConfig.Body -notmatch '(?i)secret|token|password|dsn') 'Runtime config did not match its public allowlist.'

  $callbackPath = '/setup/whatsapp/callback'
  $callbackPage = Send-Http -Uri "$baseUri$callbackPath"
  Assert-True ($callbackPage.Status -eq 200 -and $callbackPage.Body -match '<app-root') 'WhatsApp callback route failed on deep refresh.'
  $baseMatch = [regex]::Match($callbackPage.Body, '<base href="([^"]+)"')
  $assetMatch = [regex]::Match($callbackPage.Body, 'src="([^" ]+-[A-Za-z0-9_-]{8,}\.js)"')
  Assert-True ($baseMatch.Success -and $assetMatch.Success) 'Deep route response lacks a root base or hashed Angular JavaScript asset.'
  $documentUri = [System.Uri]::new("$baseUri$callbackPath")
  $assetBaseUri = [System.Uri]::new($documentUri, $baseMatch.Groups[1].Value)
  $assetUri = [System.Uri]::new($assetBaseUri, $assetMatch.Groups[1].Value)
  Assert-True ($assetUri.AbsolutePath -eq "/$($assetMatch.Groups[1].Value.TrimStart('/'))") 'Deep route resolved its Angular bundle below the callback path.'
  $asset = Send-Http -Uri $assetUri.AbsoluteUri
  Assert-True ($asset.Status -eq 200 -and $asset.Headers -match '(?i)Cache-Control:\s*[^\r\n]*immutable') 'Hashed Angular assets must have immutable caching.'
  Assert-True ($asset.Headers -match '(?im)^X-Content-Type-Options:\s*nosniff' -and $asset.Headers -match '(?im)^Referrer-Policy:\s*no-referrer') 'Hashed bundle security headers are missing.'

  $largeBody = [byte[]]::new(65_537)
  $tooLargeJson = Send-Http -Uri "$baseUri/api/v1/unused" -Method 'POST' -Body $largeBody -ContentType 'application/json'
  Assert-True ($tooLargeJson.Status -eq 413) 'The default NGINX proxy limit must reject a 65,537-byte ordinary API request.'
  $webhookOversizeForApi = Send-Http -Uri "$baseUri/api/v1/webhooks/meta/synthetic-config" -Method 'POST' -Body $largeBody
  Assert-True ($webhookOversizeForApi.Status -ne 413 -and $webhookOversizeForApi.Headers -match '(?im)^X-Request-Id:\s*[^\r\n]+') 'A 65,537-byte octet-stream webhook body must pass the NGINX proxy to the API.'
  $tooLargeWebhook = Send-Http -Uri "$baseUri/api/v1/webhooks/meta/synthetic-config" -Method 'POST' -Body ([byte[]]::new(1_048_577))
  Assert-True ($tooLargeWebhook.Status -eq 413) 'The NGINX webhook body limit must reject 1,048,577 bytes.'

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

  $webScan = @'
set -eu
if grep -R -q -E -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' /usr/share/nginx/html /etc/nginx /usr/local/bin/web-entrypoint.sh; then exit 41; fi
for root in /usr/share/nginx/html /etc/nginx; do
  if find "$root" -type f \( -name '.env' -o -name '.env.*' -o -name '*.map' -o -name '*.key' -o -name '*.pem' \) -print -quit | grep -q .; then exit 42; fi
done
test ! -e /usr/share/nginx/html/backend
'@
  Invoke-Docker -Arguments @('exec', $webContainer, '/bin/sh', '-c', $webScan) | Out-Null
  $apiScan = @'
const fs = require('node:fs');
const path = require('node:path');
let found = false;
function walk(root, relativeRoot = '') {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (/^backend(?:[/\\]|$)/i.test(relative)) found = true;
      walk(full, relative);
      continue;
    }
    if (/^\.env(?:\..*)?$/i.test(entry.name) || /\.(?:key|pem)$/i.test(entry.name)) found = true;
    if (/^(?:connect|connect_old)\.php$/i.test(entry.name)) found = true;
    if (/^apps[/\\]api[/\\]dist[/\\]/i.test(relative) && entry.name.endsWith('.map')) found = true;
    if (/\.(?:js|cjs|json)$/i.test(entry.name) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(fs.readFileSync(full, 'utf8'))) found = true;
  }
}
walk('/workspace');
if (fs.existsSync('/workspace/backend') || found) process.exit(43);
'@
  Invoke-Docker -Arguments @('exec', $apiContainer, 'node', '-e', $apiScan) | Out-Null

  Invoke-Docker -Arguments @('stop', '--time', '10', $apiContainer) | Out-Null
  $apiExit = (Get-ContainerInfo -Name $apiContainer).State.ExitCode
  Assert-True ($apiExit -eq 0) 'API did not exit cleanly after SIGTERM.'

  $workerArgs = @('run', '--detach', '--name', $workerContainer, '--network', $networkName,
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true')
  foreach ($entry in $apiEnvironment) { $workerArgs += @('--env', $entry) }
  $workerArgs += @($apiImage, 'node', 'dist/worker/main.js')
  $workerId = (Invoke-Docker -Arguments $workerArgs | Out-String).Trim()
  Assert-True ($workerId -match '^[0-9a-f]{64}$') 'Docker did not confirm creation of the worker container.'
  $createdContainers.Add([pscustomobject]@{ Name = $workerContainer; Id = $workerId })
  Assert-True ((Get-ContainerInfo -Name $workerContainer).Id -eq $workerId) 'The worker container name resolved to an unexpected resource.'
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
  foreach ($resource in $createdContainers) {
    $current = & docker container inspect $resource.Name 2>$null
    if ($LASTEXITCODE -eq 0) {
      $info = @($current | ConvertFrom-Json)[0]
      if ($info.Id -eq $resource.Id) { & docker container rm --force $resource.Id *> $null }
      else { Write-Warning 'Skipped a container name that no longer identifies this smoke run.' }
    }
  }
  if ($null -ne $createdNetwork) {
    $current = & docker network inspect $createdNetwork.Name 2>$null
    if ($LASTEXITCODE -eq 0) {
      $info = @($current | ConvertFrom-Json)[0]
      if ($info.Id -eq $createdNetwork.Id) { & docker network rm $createdNetwork.Id *> $null }
      else { Write-Warning 'Skipped a network name that no longer identifies this smoke run.' }
    }
  }
  foreach ($resource in $createdImages) {
    $current = & docker image inspect $resource.Name 2>$null
    if ($LASTEXITCODE -eq 0) {
      $info = @($current | ConvertFrom-Json)[0]
      if ($info.Id -eq $resource.Id) { & docker image rm $resource.Name *> $null }
      else { Write-Warning 'Skipped an image tag that no longer identifies this smoke run.' }
    }
  }
  if ($layerScanCreated) {
    $tempPath = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $resolvedLayerScanRoot = [System.IO.Path]::GetFullPath($layerScanRoot)
    $expectedLayerScanRoot = [System.IO.Path]::GetFullPath((Join-Path $tempPath "ca-meta-m206-layer-scan-$runId"))
    if ($resolvedLayerScanRoot -eq $expectedLayerScanRoot -and $runId -match '^[0-9a-f]{32}$' -and
        (Test-Path -LiteralPath $resolvedLayerScanRoot -PathType Container)) {
      $attributes = [System.IO.File]::GetAttributes($resolvedLayerScanRoot)
      if (-not ($attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $resolvedLayerScanRoot -Recurse -Force
      } else {
        Write-Warning 'Skipped temporary layer files because the UUID directory became a reparse point.'
      }
    } else {
      Write-Warning 'Skipped temporary layer files because their UUID path no longer matches the created directory.'
    }
  }
  $httpClient.Dispose()
}

if ($exitCode -ne 0) { exit $exitCode }
