param(
  [string] $NodeImage = 'node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c',
  [string] $TestName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [guid]::NewGuid().ToString('N')
$rootNodeModulesVolume = "m202-sigterm-root-$runId"
$apiNodeModulesVolume = "m202-sigterm-api-$runId"
$createdVolumes = [System.Collections.Generic.List[string]]::new()
$exitCode = 1

Write-Output "M2.02 isolated signal-drain run: $runId"
Write-Output "Dependency volumes: $rootNodeModulesVolume, $apiNodeModulesVolume"

try {
  $nodeImageInfo = & docker run --rm $NodeImage node --version
  if ($LASTEXITCODE -ne 0 -or $nodeImageInfo.Trim() -ne 'v24.22.2') {
    throw 'The isolated signal-drain runner requires Node v24.22.2.'
  }
  $npmImageInfo = & docker run --rm $NodeImage npm --version
  if ($LASTEXITCODE -ne 0 -or $npmImageInfo.Trim() -ne '11.19.1') {
    throw 'The isolated signal-drain runner requires npm 11.19.1.'
  }

  & docker volume create $rootNodeModulesVolume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated root dependency volume.' }
  $createdVolumes.Add($rootNodeModulesVolume)
  & docker volume create $apiNodeModulesVolume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated API dependency volume.' }
  $createdVolumes.Add($apiNodeModulesVolume)

  $sourcePath = $repoRoot.Replace('\', '/')
  $mounts = @(
    '--mount', "type=bind,source=$sourcePath,target=/work",
    '--mount', "type=volume,source=$rootNodeModulesVolume,target=/work/node_modules",
    '--mount', "type=volume,source=$apiNodeModulesVolume,target=/work/apps/api/node_modules"
  )
  $install = @('run', '--rm') + $mounts + @(
    '--workdir', '/work',
    $NodeImage,
    'sh', '-lc',
    'npm ci --workspace=@ca-meta/api --include-workspace-root=false'
  )
  & docker @install
  if ($LASTEXITCODE -ne 0) { throw 'Isolated API dependency installation failed.' }

  if ($TestName -and $TestName -notmatch "^[A-Za-z0-9 ]+$") {
    throw 'The test name accepts letters, numbers, and spaces only.'
  }
  $testCommand = 'npm run test:api'
  if ($TestName) {
    $testCommand = "npm run build:api && npm exec --workspace=@ca-meta/api -- tsc -p tsconfig.test.json && node --test --test-name-pattern='.*$TestName.*' apps/api/dist-test/test/*.spec.js"
  }
  $verify = @('run', '--rm', '--network', 'none') + $mounts + @(
    '--workdir', '/work',
    $NodeImage,
    'sh', '-lc',
    $testCommand
  )
  & docker @verify
  $exitCode = $LASTEXITCODE
}
catch {
  Write-Warning $_.Exception.Message
  $exitCode = 1
}
finally {
  foreach ($volume in $createdVolumes) {
    & docker volume rm $volume | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not remove isolated dependency volume $volume"
      $exitCode = 1
    }
  }
}

exit $exitCode