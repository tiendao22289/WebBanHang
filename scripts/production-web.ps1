param([ValidateSet('start','stop','status','logs')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$pointer = 'C:\Tool\SupabaseLocal\production-current.json'
$root = 'C:\Tool\WebBanHang'
if (Test-Path $pointer) { $root = (Get-Content $pointer -Raw | ConvertFrom-Json).path }
$resolved = [IO.Path]::GetFullPath($root)
if ($resolved -ne 'C:\Tool\WebBanHang' -and -not $resolved.StartsWith('C:\Tool\WebBanHangReleases\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Invalid production release path.'
}
& (Join-Path $resolved 'scripts\local-web.ps1') -Action $Action -Mode prod
