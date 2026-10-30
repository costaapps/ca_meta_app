param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath,

  [Parameter(Mandatory = $true)]
  [ValidateRange(0, 2147483647)]
  [int]$CurrentSchemaVersion,

  [Parameter(Mandatory = $true)]
  [string]$OutputLockPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$manifestPathResolved = (Resolve-Path -LiteralPath $ManifestPath).Path
$outputFullPath = [System.IO.Path]::GetFullPath($OutputLockPath)
$repoPrefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if ($outputFullPath.StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Write the generated release lock outside the repository checkout.'
}
if (Test-Path -LiteralPath $outputFullPath) {
  throw 'The output lock already exists. Preserve it and choose a new path for this release selection.'
}

$verifier = Join-Path $PSScriptRoot 'verify-release-manifest.mjs'
node $verifier $manifestPathResolved
if ($LASTEXITCODE -ne 0) { throw 'Release manifest validation failed.' }

$manifest = Get-Content -LiteralPath $manifestPathResolved -Raw | ConvertFrom-Json
$minimum = [int]$manifest.databaseSchema.minCompatible
$maximum = [int]$manifest.databaseSchema.maxCompatible
if ($CurrentSchemaVersion -lt $minimum -or $CurrentSchemaVersion -gt $maximum) {
  throw "Current schema v$CurrentSchemaVersion is outside release compatibility range $minimum..$maximum. No lock was written."
}

$values = @(
  '# Generated from a verified release manifest. No credentials are included.',
  "RELEASE_ID=$($manifest.release.releaseId)",
  "SOURCE_REVISION=$($manifest.sourceRevision)",
  "CA_META_WEB_IMAGE=$($manifest.images.web.reference)",
  "CA_META_API_IMAGE=$($manifest.images.api.reference)",
  "WEB_SOURCE_REVISION=$($manifest.images.web.sourceRevision)",
  "API_SOURCE_REVISION=$($manifest.images.api.sourceRevision)",
  "SCHEMA_VERSION=$($manifest.databaseSchema.version)",
  "SCHEMA_MIN_COMPATIBLE=$minimum",
  "SCHEMA_MAX_COMPATIBLE=$maximum"
)

$tempLock = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($tempLock, (($values -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
  $lockChecker = Join-Path $repoRoot 'tools\m2-07\check-release-lock.ps1'
  if (-not (Test-Path -LiteralPath $lockChecker)) { throw 'M2.07 release-lock checker is unavailable in this checkout.' }
  & pwsh -NoLogo -NoProfile -File $lockChecker -Path $tempLock
  if ($LASTEXITCODE -ne 0) { throw 'Generated release lock did not pass the M2.07 checker.' }

  $parent = Split-Path -Parent $outputFullPath
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText($outputFullPath, (($values -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
  & pwsh -NoLogo -NoProfile -File $lockChecker -Path $outputFullPath
  if ($LASTEXITCODE -ne 0) { throw 'The written release lock did not pass the M2.07 checker.' }
  Write-Output "Release lock written for $($manifest.release.releaseId); image digests are unchanged."
} finally {
  Remove-Item -LiteralPath $tempLock -Force -ErrorAction SilentlyContinue
}
