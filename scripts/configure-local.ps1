param(
    [string]$CredentialsPath = 'C:\Tool\SupabaseLocal\credentials.env',
    [string]$PrintAgentPath = 'C:\Tool\PrintAgentLocal'
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
$credentials = @{}
foreach ($line in [IO.File]::ReadAllLines($CredentialsPath)) {
    if ($line -match '^([A-Z_]+)=(.*)$') {
        $credentials[$matches[1]] = $matches[2]
    }
}
foreach ($key in @('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY')) {
    if (-not $credentials[$key]) { throw "Missing local credential: $key" }
}
function Set-LocalEnvironment($path, $values) {
    $lines = @()
    if (Test-Path -LiteralPath $path) {
        $lines = @([IO.File]::ReadAllLines($path) | Where-Object {
            $separator = $_.IndexOf('=')
            $separator -lt 0 -or -not $values.Contains($_.Substring(0, $separator).Trim())
        })
    }
    foreach ($key in $values.Keys) { $lines += "$key=$($values[$key])" }
    [IO.File]::WriteAllLines($path, $lines, [Text.UTF8Encoding]::new($false))
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $path /inheritance:r /grant:r "${user}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Cannot protect $path" }
}
Set-LocalEnvironment (Join-Path $projectPath '.env.local') ([ordered]@{
    NEXT_PUBLIC_SUPABASE_URL = $credentials.NEXT_PUBLIC_SUPABASE_URL
    NEXT_PUBLIC_SUPABASE_PROXY_PATH = '/supabase'
    NEXT_PUBLIC_SUPABASE_ANON_KEY = $credentials.NEXT_PUBLIC_SUPABASE_ANON_KEY
    SUPABASE_SERVICE_ROLE_KEY = $credentials.SUPABASE_SERVICE_ROLE_KEY
})
if (-not (Test-Path (Join-Path $PrintAgentPath 'index.js'))) { throw 'PrintAgent copy not found' }
Set-LocalEnvironment (Join-Path $PrintAgentPath '.env') ([ordered]@{
    SUPABASE_URL = $credentials.NEXT_PUBLIC_SUPABASE_URL
    SUPABASE_ANON_KEY = $credentials.NEXT_PUBLIC_SUPABASE_ANON_KEY
    PORT = '3003'
    HOST = '127.0.0.1'
    PRINT_JOB_MIN_ID = '28267'
    PRINT_JOB_CLEANUP_ENABLED = 'false'
})
Write-Output 'Website and PrintAgent configured for local Supabase. Rebuild Next.js after changing its public environment variables.'
