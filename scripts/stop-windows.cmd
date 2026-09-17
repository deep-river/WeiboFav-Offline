@echo off
setlocal
cd /d "%~dp0.."

if not exist .weibofav-server.pid (
  echo No WeiboFav Offline service was started by this project.
  exit /b 0
)

set /p SERVER_PID=<.weibofav-server.pid
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%SERVER_PID%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*library_server.py*') { Stop-Process -Id %SERVER_PID% -Force; exit 0 }; exit 1"
set STOP_RESULT=%ERRORLEVEL%
del .weibofav-server.pid
if exist .weibofav-server.port del .weibofav-server.port
if not "%STOP_RESULT%"=="0" (
  echo The recorded service is no longer running; no process was stopped.
) else (
  echo WeiboFav Offline stopped.
)
