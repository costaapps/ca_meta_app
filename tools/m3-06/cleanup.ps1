$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$allowedRelativePaths = @('apps\api\dist', 'apps\api\dist-test')
foreach ($relativePath in $allowedRelativePaths) {
  $targetPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $relativePath))
  $prefix = $repoRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $targetPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing cleanup target outside the repository.'
  }
  if (-not (Test-Path -LiteralPath $targetPath)) { continue }
  $item = Get-Item -LiteralPath $targetPath -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'Refusing to remove a linked build output directory.'
  }
  Remove-Item -LiteralPath $targetPath -Recurse -Force
}
'Removed only API build output created by the M3.06 unit harness.'
