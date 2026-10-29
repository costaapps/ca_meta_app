$ErrorActionPreference = 'Stop'
$oldLocation = Get-Location
$hadPassword = Test-Path Env:M105_DB_PASSWORD
$previousPassword = $env:M105_DB_PASSWORD
$projectName = "m105-local-poc-$([guid]::NewGuid().ToString('N'))"
$result = 1
$cleanupResult = 0

try {
  Set-Location $PSScriptRoot
  $env:M105_DB_PASSWORD = [guid]::NewGuid().ToString('N')
  docker compose --project-name $projectName config --quiet
  if ($LASTEXITCODE -ne 0) {
    $result = $LASTEXITCODE
  }
  else {
    docker compose --project-name $projectName up --build --abort-on-container-exit --exit-code-from poc
    $result = $LASTEXITCODE
  }
}
catch {
  Write-Error $_
  $result = 1
}
finally {
  if (Test-Path (Join-Path $PSScriptRoot 'compose.yml')) {
    try {
      docker compose --project-name $projectName down --volumes --remove-orphans
      $cleanupResult = $LASTEXITCODE
    }
    catch {
      Write-Warning "Compose cleanup attempt failed for isolated project $projectName."
      $cleanupResult = 1
    }
  }
  if ($hadPassword) {
    $env:M105_DB_PASSWORD = $previousPassword
  }
  else {
    Remove-Item Env:M105_DB_PASSWORD -ErrorAction SilentlyContinue
  }
  Set-Location $oldLocation
}

if ($cleanupResult -ne 0) {
  Write-Error "Compose cleanup failed for isolated project $projectName (exit $cleanupResult)."
  if ($result -eq 0) { $result = $cleanupResult }
}
exit $result
