@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "out\main\index.js" (
  echo Building Orkestrei...
  call npm run build
  if errorlevel 1 exit /b %errorlevel%
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  call npm start
)
