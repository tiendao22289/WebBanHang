@echo off
setlocal
set "MANAGER=C:\Tool\SupabaseDev\manage.ps1"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%MANAGER%" (
    echo ERROR: DEV database manager not found: %MANAGER%
    echo Run this file on the database host, not the remote coding machine.
    if "%~1"=="" pause
    exit /b 1
)

if /i "%~1"=="start" goto cli_start
if /i "%~1"=="stop" goto cli_stop
if /i "%~1"=="status" goto cli_status
if not "%~1"=="" (
    echo Usage: database-dev.bat [start^|stop^|status]
    exit /b 2
)

:menu
cls
echo ========================================
echo           SUPABASE DEV DATABASE
echo ========================================
echo Host: this Windows computer
echo API: localhost:8001 - PostgreSQL: 5433
echo Only DEV is managed. PROD is untouched.
echo.
echo [1] Start DEV database
echo [2] Stop DEV database - keep all data
echo [3] Show DEV container status
echo [0] Exit
echo.
choice /c 1230 /n /m "Select: "
if errorlevel 4 exit /b 0
if errorlevel 3 goto menu_status
if errorlevel 2 goto menu_stop
if errorlevel 1 goto menu_start
goto menu

:menu_start
call :manage start
pause
goto menu

:menu_stop
echo Stopping DEV disconnects other developers using this database.
call :manage stop
pause
goto menu

:menu_status
call :manage status
pause
goto menu

:cli_start
call :manage start
exit /b %ERRORLEVEL%

:cli_stop
call :manage stop
exit /b %ERRORLEVEL%

:cli_status
call :manage status
exit /b %ERRORLEVEL%

:manage
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%MANAGER%" -Action "%~1"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
    echo OK: DEV %~1 finished.
) else (
    echo ERROR: DEV %~1 failed. Exit code: %RESULT%
)
echo Stopping DEV does not stop PROD, Docker, WSL, web or PrintAgent.
exit /b %RESULT%
