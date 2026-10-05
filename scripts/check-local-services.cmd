@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\Tool\SupabaseLocal\check-services.ps1"
set "CHECK_EXIT=%ERRORLEVEL%"
echo.
echo Log: C:\Tool\SupabaseLocal\check-services.log
pause
exit /b %CHECK_EXIT%
