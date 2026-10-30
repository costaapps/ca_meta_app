param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$lockPath = (Resolve-Path -LiteralPath $Path).Path
$values = @{}
foreach ($line in Get-Content -LiteralPath $lockPath) {
  $trimmed = $line.Trim()
  if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) { continue }
  $separator = $trimmed.IndexOf('=')
  if ($separator -lt 1) { throw 'Release lock contains a malformed entry.' }
  $key = $trimmed.Substring(0, $separator).Trim()
  $value = $trimmed.Substring($separator + 1).Trim()
  if ($values.ContainsKey($key)) { throw "Release lock repeats key $key." }
  $values[$key] = $value
}

$required = @(
  'RELEASE_ID', 'SOURCE_REVISION', 'CA_META_WEB_IMAGE', 'CA_META_API_IMAGE',
  'WEB_SOURCE_REVISION', 'API_SOURCE_REVISION', 'SCHEMA_VERSION',
  'SCHEMA_MIN_COMPATIBLE', 'SCHEMA_MAX_COMPATIBLE'
)
foreach ($key in $required) {
  if (-not $values.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($values[$key])) {
    throw "Release lock is missing $key."
  }
  if ($values[$key] -match '<|>|REPLACE|NOT_CONFIRMED|PENDING') {
    throw "Release lock is a template; $key must be resolved before promotion."
  }
}

if ($values.SOURCE_REVISION -notmatch '^[0-9a-f]{40}$') { throw 'SOURCE_REVISION must be a full lowercase Git SHA.' }
if ($values.WEB_SOURCE_REVISION -ne $values.SOURCE_REVISION -or $values.API_SOURCE_REVISION -ne $values.SOURCE_REVISION) {
  throw 'Web and API image provenance must match SOURCE_REVISION.'
}
foreach ($key in @('CA_META_WEB_IMAGE', 'CA_META_API_IMAGE')) {
  if ($values[$key] -notmatch '^\S+@sha256:[0-9a-f]{64}$') {
    throw "$key must be a registry image reference pinned to a lowercase sha256 digest."
  }
}
if ($values.CA_META_WEB_IMAGE -eq $values.CA_META_API_IMAGE) { throw 'Web and API must have separate image digests.' }
$releaseMatch = [regex]::Match($values.RELEASE_ID, '^\d+\.\d+\.\d+\+([0-9a-f]{12})$')
if (-not $releaseMatch.Success -or $releaseMatch.Groups[1].Value -ne $values.SOURCE_REVISION.Substring(0, 12)) {
  throw 'RELEASE_ID must be semver plus the first 12 characters of SOURCE_REVISION.'
}

foreach ($key in @('SCHEMA_VERSION', 'SCHEMA_MIN_COMPATIBLE', 'SCHEMA_MAX_COMPATIBLE')) {
  if ($values[$key] -notmatch '^(0|[1-9][0-9]*)$') { throw "$key must be a non-negative integer." }
}
$schema = [int]$values.SCHEMA_VERSION
$minimum = [int]$values.SCHEMA_MIN_COMPATIBLE
$maximum = [int]$values.SCHEMA_MAX_COMPATIBLE
if ($schema -ne 3 -or $minimum -ne 3 -or $maximum -ne 3) {
  throw 'This release candidate currently declares exact schema-v3 compatibility; changing bounds requires a separately verified API/schema contract.'
}

Write-Output "Release lock accepted: $($values.RELEASE_ID), source $($values.SOURCE_REVISION), schema v$schema ($minimum..$maximum)."
