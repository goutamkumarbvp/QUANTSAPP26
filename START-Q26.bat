@echo off
REM ============================================================
REM  Q26 Options - one-click start (Windows)
REM  Double-click this file. First run installs and builds
REM  (a few minutes); later runs start straight away.
REM ============================================================
setlocal
cd /d "%~dp0"
title Q26 Options

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo A new .env file was created. Fill in your NEO_* values, AUTH_SECRET and OPS_ADMIN_EMAILS,
  echo save it, close Notepad, then press any key here.
  notepad ".env"
  pause
)

if not exist "node_modules" (
  echo Installing packages ^(first run only^)...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. & pause & exit /b 1 )
)

if not exist "apps\server\dist\server.mjs" (
  echo Building ^(first run only^)...
  call npm.cmd run build
  if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
)

echo.
echo Starting Q26 Options. The dashboard opens at http://localhost:8787
echo Keep this window open. Press Ctrl+C here to stop the server.
echo.
start "" cmd /c "timeout /t 8 >nul & start "" http://localhost:8787"
call npm.cmd run start:supervised
pause
