@echo off
setlocal
cd /d "%~dp0"

if not exist "client\dist\index.html" (
  echo Frontend build not found. Building client first...
  call npm.cmd --prefix client run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo.
echo Nebula Insight is starting...
echo Open: http://127.0.0.1:3001
echo Keep this window open while using the website.
echo Press Ctrl+C to stop.
echo.

node server\src\index.js
