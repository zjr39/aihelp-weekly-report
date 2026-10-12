@echo off
chcp 65001 >nul
cd /d "%~dp0"
set GUI=node bin\gui.mjs

REM If the server is already running, just open the browser.
%GUI% --probe
if %errorlevel%==0 (
  %GUI% --already
  start "" http://127.0.0.1:8791
  ping -n 3 127.0.0.1 >nul
  exit /b
)

%GUI% --banner

REM Open the browser first, then run the server in this window.
REM The page connects via SSE and shows a "connection lost" banner if the
REM server is not up yet, so a slow first paint is handled gracefully.
start "" http://127.0.0.1:8791
%GUI% --port 8791

if errorlevel 1 %GUI% --failed
%GUI% --stopped
pause
