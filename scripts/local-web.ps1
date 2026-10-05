param(
    [ValidateSet('start', 'stop', 'status', 'logs')]
    [string]$Action = 'status',
    [int]$Port = 0,
    [ValidateSet('prod', 'dev')]
    [string]$Mode = 'prod'
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
$runtimePath = if ($Mode -eq 'dev') { 'C:\Tool\SupabaseDev' } else { 'C:\Tool\SupabaseLocal' }
if ($Port -eq 0) { $Port = if ($Mode -eq 'dev') { 3001 } else { 3000 } }
$stateFile = Join-Path $runtimePath 'website-process.json'
$stdout = Join-Path $runtimePath 'website.log'
$stderr = Join-Path $runtimePath 'website-error.log'
$nextCli = Join-Path $projectPath 'node_modules\next\dist\bin\next'
$url = "http://localhost:$Port"
$managedProcess = $null
if (Test-Path $stateFile) {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.processId)"
    if ($candidate -and $candidate.CommandLine.Contains($nextCli)) { $managedProcess = $candidate }
}
switch ($Action) {
    'start' {
        if ($managedProcess) { Write-Output "Website already running: $url (PID $($managedProcess.ProcessId))"; break }
        if ($Mode -eq 'prod' -and -not (Test-Path (Join-Path $projectPath '.next\BUILD_ID'))) { throw 'Run npm run build first.' }
        if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port is occupied." }
        $node = (Get-Command node.exe).Source
        $env:NODE_ENV = if ($Mode -eq 'dev') { 'development' } else { 'production' }
        foreach ($key in @('APP_ENV','NEXT_PUBLIC_APP_ENV','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','NEXT_PUBLIC_SUPABASE_PROXY_PATH','ADMIN_SESSION_SECRET')) {
            Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
        }
        $command = if ($Mode -eq 'dev') { 'dev' } else { 'start' }
        $process = Start-Process $node -ArgumentList "`"$nextCli`" $command --hostname 127.0.0.1 --port $Port" `
            -WorkingDirectory $projectPath -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        @{ processId = $process.Id; port = $Port; url = $url; mode = $Mode } | ConvertTo-Json | Set-Content $stateFile
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($process.HasExited) { throw "Website exited. See $stderr" }
            try {
                $response = Invoke-WebRequest "$url/" -UseBasicParsing -TimeoutSec 3
                if ($response.StatusCode -eq 200) { $ready = $true; break }
            } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $ready) { throw "Website not ready. See $stderr" }
        Write-Output "Website running: $url (PID $($process.Id))"
    }
    'stop' {
        if ($managedProcess) { Stop-Process -Id $managedProcess.ProcessId; Write-Output 'Website stopped.' }
        else { Write-Output 'Website is not running.' }
    }
    'status' {
        if ($managedProcess) { Write-Output "Website running: $($state.url) (PID $($managedProcess.ProcessId))" }
        else { Write-Output 'Website is not running.' }
    }
    'logs' {
        Get-Content $stdout, $stderr -Tail 60 -ErrorAction SilentlyContinue
    }
}
