@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts/startLocal.mjs
if errorlevel 1 (
  echo.
  echo 启动未完成，请按上方提示处理后重试。
  pause
)
