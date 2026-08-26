@echo off
cd /d "%~dp0"
echo Starting Reezn Stremio add-on on http://localhost:7000 ...
echo Keep this window open while you use Stremio. Minimize is OK, don't close.
echo.
node server.js
pause
