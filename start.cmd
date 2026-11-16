@echo off
cd /d "%~dp0"
if not exist app.js (
  echo 正在构建前端资源...
  call npm run build
)
node server.mjs
pause
