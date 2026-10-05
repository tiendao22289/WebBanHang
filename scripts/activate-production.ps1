param([Parameter(Mandatory=$true)][string]$Release)
$ErrorActionPreference = 'Stop'
$Release = [IO.Path]::GetFullPath($Release)
if (-not $Release.StartsWith('C:\Tool\WebBanHangReleases\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid release path.' }
$result = Join-Path $Release 'activation-result.json'
$log = Join-Path $Release 'activation.log'
$pointer = 'C:\Tool\SupabaseLocal\production-current.json'
$manager = 'C:\Tool\SupabaseLocal\production-web.ps1'
$mutex = New-Object System.Threading.Mutex($false, 'Local\WebBanHangSupabaseAutostart')
$locked = $false
$switched = $false
$previous = $null
try {
    try { $locked = $mutex.WaitOne(300000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another startup/deployment is still running.' }
    if (Test-Path $pointer) { $previous = Get-Content $pointer -Raw }
    & $manager stop | Out-File $log -Append
    $switched = $true
    @{path=$Release; activatedAt=(Get-Date -Format o)} | ConvertTo-Json | Set-Content $pointer
    & $manager start | Out-File $log -Append
    $response = Invoke-WebRequest 'http://127.0.0.1:3000/admin/status' -UseBasicParsing -TimeoutSec 30
    if ($response.StatusCode -ne 200) { throw 'Production health check failed.' }
    @{success=$true; path=$Release} | ConvertTo-Json | Set-Content $result
} catch {
    $failure = $_.Exception.Message
    $failure | Out-File $log -Append
    if ($switched) {
        try {
            & $manager stop | Out-File $log -Append
            if ($previous) { $previous | Set-Content $pointer } else { Remove-Item -LiteralPath $pointer -ErrorAction SilentlyContinue }
            & $manager start | Out-File $log -Append
            'Previous production restored.' | Out-File $log -Append
        } catch { "Rollback failed: $($_.Exception.Message)" | Out-File $log -Append }
    }
    @{success=$false; error=$failure} | ConvertTo-Json | Set-Content $result
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
