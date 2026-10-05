$ErrorActionPreference = 'Stop'
$root = 'C:\Tool\GitHubRunner'
if (-not (Test-Path (Join-Path $root '.runner'))) { throw 'GitHub runner has not been registered.' }
$mutex = New-Object System.Threading.Mutex($false, 'Local\WebBanHangGitHubRunnerStart')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { exit 0 }
    $existing = Get-CimInstance Win32_Process -Filter "Name = 'Runner.Listener.exe'" | Where-Object { $_.ExecutablePath -eq (Join-Path $root 'bin\Runner.Listener.exe') }
    if ($existing) { Write-Output 'GitHub runner is already running.'; exit 0 }
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $command = 'C:\Windows\System32\cmd.exe /d /c ""C:\Tool\GitHubRunner\run.cmd" >> "C:\Tool\GitHubRunner\runner.log" 2>&1"'
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$command;CurrentDirectory=$root;ProcessStartupInformation=$startup}
    if ($created.ReturnValue -ne 0) { throw 'Cannot start GitHub runner.' }
    Write-Output "Started GitHub runner launcher: $($created.ProcessId)"
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
