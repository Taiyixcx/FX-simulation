@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts/startLocal.mjs
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
