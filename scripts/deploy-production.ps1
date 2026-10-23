param([string]$Commit = 'HEAD', [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot -Parent
$sha = (& git -C $source rev-parse "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid deployment commit.' }
$branch = ((& git -C $source branch --show-current) -join '').Trim()
if ($branch -ne 'master' -and $env:GITHUB_REF -ne 'refs/heads/master') { throw 'Only master may deploy production.' }
if ($ValidateOnly) { Write-Output $sha; exit 0 }
# Remove old release folders (each holds a full build; the shop disk filled up).
# Keep the running release and the 3 newest; skip cleanup if the running one is unknown.
$releases = 'C:\Tool\WebBanHangReleases'
$current = $null
try { $current = [IO.Path]::GetFullPath((Get-Content 'C:\Tool\SupabaseLocal\production-current.json' -Raw | ConvertFrom-Json).path).TrimEnd('\') } catch { $current = $null }
if ($current -and (Test-Path $releases)) {
    $old = @(Get-ChildItem -LiteralPath $releases -Directory | Sort-Object CreationTime -Descending | Select-Object -Skip 3 |
        Where-Object { $_.FullName.TrimEnd('\') -ne $current })
    $removed = 0
    foreach ($dir in $old) {
        try { Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop; $removed++ } catch { Write-Warning "Cannot remove old release $($dir.Name)" }
    }
    $free = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
    Write-Output "Old releases removed: $removed of $($old.Count); free on C: $free GB"
}
$release = "C:\Tool\WebBanHangReleases\$($sha.Substring(0,12))-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Path $release -Force | Out-Null
$archive = Join-Path $release 'source.zip'
& git -C $source archive --format=zip --output=$archive $sha
if ($LASTEXITCODE -ne 0) { throw 'Cannot export deployment source.' }
Expand-Archive -LiteralPath $archive -DestinationPath $release
Remove-Item -LiteralPath $archive
Copy-Item -LiteralPath 'C:\Tool\SupabaseLocal\production.env' -Destination (Join-Path $release '.env.production.local')
Push-Location $release
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; production is unchanged.' }
    $tests = @(Get-ChildItem -LiteralPath tests -Filter '*.test.*' | ForEach-Object FullName)
    # Few test files at a time: the shop server runs out of memory when all start together.
    & node --test --test-concurrency=3 @tests
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed; production is unchanged.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; production is unchanged.' }
} finally { Pop-Location }
# WMI starts the server outside the runner/Codex process job so job cleanup cannot kill it.
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
$command = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Release "{1}"' -f (Join-Path $release 'scripts\activate-production.ps1'), $release
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$release;ProcessStartupInformation=$startup}
if ($created.ReturnValue -ne 0) { throw 'Cannot start production activation.' }
$result = Join-Path $release 'activation-result.json'
$deadline = (Get-Date).AddMinutes(7)
while (-not (Test-Path $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $result)) { throw "Activation timed out. Check $release\activation.log" }
$activation = Get-Content $result -Raw | ConvertFrom-Json
if (-not $activation.success) { throw "Deployment failed: $($activation.error). Check activation.log for rollback result." }
Write-Output "Production deployed: $sha ($release)"
