@echo off
setlocal
cd /d "%~dp0.."
set PORT=4319

if exist .weibofav-server.pid (
  set /p SERVER_PID=<.weibofav-server.pid
  powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%SERVER_PID%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*library_server.py*') { exit 0 }; exit 1"
  if not errorlevel 1 (
    if exist .weibofav-server.port set /p PORT=<.weibofav-server.port
    echo WeiboFav Offline is already running: http://127.0.0.1:%PORT%
    start "" "http://127.0.0.1:%PORT%"
    exit /b 0
  )
  del .weibofav-server.pid
  if exist .weibofav-server.port del .weibofav-server.port
)

for /f %%P in ('powershell -NoProfile -Command "$port = 4319; while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port += 1 }; $port"') do set PORT=%%P

where pnpm >nul 2>nul || (echo pnpm is required. Install pnpm first. & exit /b 1)
where python >nul 2>nul || (echo Python 3 is required. Install Python 3 first. & exit /b 1)

if not exist node_modules call pnpm install --frozen-lockfile || exit /b 1
call pnpm build || exit /b 1
if not exist data\logs mkdir data\logs

set SERVER_PID=
for /f %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath 'python' -ArgumentList 'library_server.py --port %PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%CD%\data\logs\library-server.log' -RedirectStandardError '%CD%\data\logs\library-server-error.log' -PassThru; $p.Id"') do set SERVER_PID=%%P
if not defined SERVER_PID exit /b 1
> .weibofav-server.pid echo %SERVER_PID%
> .weibofav-server.port echo %PORT%
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%PORT%/api/posts?page=1&pageSize=10' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%SERVER_PID%' -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine -like '*library_server.py*') { Stop-Process -Id %SERVER_PID% -Force }"
  del .weibofav-server.pid
  del .weibofav-server.port
  echo The service did not start. See data\logs\library-server-error.log
  exit /b 1
)
start "" "http://127.0.0.1:%PORT%"
echo WeiboFav Offline is running: http://127.0.0.1:%PORT%
