@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

set UI_PID_FILE=.weibofav-server.pid
set API_PID_FILE=.weibofav-api.pid
set UI_PORT_FILE=.weibofav-server.port
set API_PORT_FILE=.weibofav-api.port

if exist %UI_PID_FILE% if exist %API_PID_FILE% (
  set /p UI_PID=<%UI_PID_FILE%
  set /p API_PID=<%API_PID_FILE%
  powershell -NoProfile -Command "$ui = Get-CimInstance Win32_Process -Filter 'ProcessId=%UI_PID%' -ErrorAction SilentlyContinue; $api = Get-CimInstance Win32_Process -Filter 'ProcessId=%API_PID%' -ErrorAction SilentlyContinue; if ($ui -and $api -and $ui.CommandLine -like '*vinext*' -and $api.CommandLine -like '*library_server.py*') { exit 0 }; exit 1"
  if not errorlevel 1 (
    set UI_PORT=4319
    if exist %UI_PORT_FILE% set /p UI_PORT=<%UI_PORT_FILE%
    echo WeiboFav Offline is already running: http://127.0.0.1:%UI_PORT%
    start "" "http://127.0.0.1:%UI_PORT%"
    exit /b 0
  )
)

call scripts\stop-windows.cmd >nul 2>nul
where node >nul 2>nul || (echo Node.js 22+ is required. Install it with: winget install OpenJS.NodeJS.LTS & exit /b 1)
where pnpm >nul 2>nul || (echo pnpm 12.4.2 is required. Install it with: npm install --global pnpm@12.4.2 & exit /b 1)
where python >nul 2>nul || (echo Python 3 is required. Install Python 3 first. & exit /b 1)
for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%V
for /f "tokens=1 delims=." %%V in ('pnpm --version') do set PNPM_MAJOR=%%V
if %NODE_MAJOR% LSS 22 (echo Node.js 22+ is required. & exit /b 1)
if %PNPM_MAJOR% LSS 12 (echo pnpm 12.4.2+ is required. & exit /b 1)

for /f %%P in ('powershell -NoProfile -Command "$port = 4319; while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port += 1 }; $port"') do set UI_PORT=%%P
for /f %%P in ('powershell -NoProfile -Command "$port = %UI_PORT% + 1; while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port += 1 }; $port"') do set API_PORT=%%P
call pnpm install --frozen-lockfile || exit /b 1
set NEXT_PUBLIC_WEIBOFAV_LIBRARY_URL=http://127.0.0.1:%API_PORT%
call pnpm build || exit /b 1
if not exist data\logs mkdir data\logs

for /f %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath 'python' -ArgumentList 'library_server.py --port %API_PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%CD%\data\logs\library-server.log' -RedirectStandardError '%CD%\data\logs\library-server-error.log' -PassThru; $p.Id"') do set API_PID=%%P
if not defined API_PID exit /b 1
> %API_PID_FILE% echo %API_PID%
> %API_PORT_FILE% echo %API_PORT%
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%API_PORT%/api/posts?page=1&pageSize=10' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :failed

for /f %%P in ('powershell -NoProfile -Command "$p = Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'exec vinext start --port %UI_PORT%' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%CD%\data\logs\web-server.log' -RedirectStandardError '%CD%\data\logs\web-server-error.log' -PassThru; $p.Id"') do set UI_PID=%%P
if not defined UI_PID goto :failed
> %UI_PID_FILE% echo %UI_PID%
> %UI_PORT_FILE% echo %UI_PORT%
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:%UI_PORT%/' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :failed
start "" "http://127.0.0.1:%UI_PORT%"
echo WeiboFav Offline is running: http://127.0.0.1:%UI_PORT%
exit /b 0

:failed
call scripts\stop-windows.cmd >nul 2>nul
echo The service did not start. See data\logs\library-server-error.log and web-server-error.log
exit /b 1
