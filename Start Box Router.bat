@echo off
rem Starts the Midtown Box Router and opens it in your browser.
rem Keep this window open while you use the router; close it to stop.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
start "" http://localhost:5178
node server.mjs
pause
