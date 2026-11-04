$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runId = [Guid]::NewGuid().ToString('N')
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m303-tests-$runId"
$runtimeDirectory = $env:M3_NODE_RUNTIME_DIR
$previousNodePath = $env:NODE_PATH
if ([string]::IsNullOrWhiteSpace($runtimeDirectory)) {
  $runtimeDirectory = Join-Path $env:LOCALAPPDATA 'Codex\runtimes\node-v24.22.2'
}
$nodeCommand = Join-Path $runtimeDirectory 'node.exe'
$npmCommand = Join-Path $runtimeDirectory 'npm.cmd'
if (-not (Test-Path -LiteralPath $nodeCommand) -or -not (Test-Path -LiteralPath $npmCommand)) {
  throw 'Set M3_NODE_RUNTIME_DIR to the approved Node 24.22.2/npm 11.19.1 runtime directory.'
}
$env:Path = "$runtimeDirectory;$env:Path"
$nodeVersion = (& $nodeCommand --version).Trim()
$npmVersion = (& $npmCommand --version).Trim()
if ($nodeVersion -ne 'v24.22.2' -or $npmVersion -ne '11.19.1') {
  throw "M3.03 focused harness requires Node v24.22.2/npm 11.19.1; found $nodeVersion/$npmVersion."
}

function Invoke-Checked {
  param([string]$FilePath, [string[]]$ArgumentList)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE : $FilePath" }
}

Push-Location $repoRoot
try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $env:NODE_PATH = Join-Path $repoRoot 'node_modules'
  Write-Output "Runtime: Node $nodeVersion / npm $npmVersion"
  Write-Output 'Fixtures: in-memory identities, tenants, memberships, synthetic verified-email proof and local fake inbox only.'
  Invoke-Checked -FilePath $npmCommand -ArgumentList @('exec', '--workspace=@ca-meta/api', '--', 'tsc', '-p', 'tsconfig.test.json', '--outDir', $tempRoot)
  Invoke-Checked -FilePath $nodeCommand -ArgumentList @('--test', (Join-Path $tempRoot 'test\m3-03-magic-link.spec.js'))
} finally {
  Pop-Location
  if ($null -eq $previousNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue }
  else { $env:NODE_PATH = $previousNodePath }
  $expectedTempRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "ca-meta-m303-tests-$runId"))
  $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if ($resolvedTempRoot -ne $expectedTempRoot -or -not $resolvedTempRoot.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning 'Temporary cleanup safety check failed; leaving the generated directory untouched.'
  } elseif (Test-Path -LiteralPath $tempRoot) {
    $resolvedItem = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempRoot).Path)
    if ($resolvedItem -eq $expectedTempRoot -and $resolvedItem.StartsWith($tempParent, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedItem -Recurse -Force
    } else {
      Write-Warning 'Resolved temporary cleanup safety check failed; leaving the generated directory untouched.'
    }
  }
}
