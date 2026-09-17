@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

call :stop .weibofav-server.pid vinext
call :stop .weibofav-api.pid library_server.py
del .weibofav-server.port >nul 2>nul
del .weibofav-api.port >nul 2>nul
exit /b 0

:stop
if not exist %~1 exit /b 0
set /p PROCESS_PID=<%~1
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%PROCESS_PID%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*%~2*') { Stop-Process -Id %PROCESS_PID% -Force; exit 0 }; exit 1"
if not errorlevel 1 echo WeiboFav Offline stopped (PID %PROCESS_PID%).
del %~1 >nul 2>nul
exit /b 0
