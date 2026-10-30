@echo off
chcp 65001 >nul
cd /d "%~dp0"
set GUI=node bin\gui.mjs

REM Node.js is the only prerequisite. Check it early with a clear message.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   ============================================================
  echo     Node.js is not installed
  echo   ============================================================
  echo.
  echo     This tool needs Node.js 18 or newer.
  echo.
  echo     1. Go to  https://nodejs.org/
  echo     2. Download the LTS version and install it
  echo        ^(keep clicking Next, defaults are fine^)
  echo     3. Close this window, then double-click start.cmd again
  echo.
  pause
  exit /b 1
)

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

REM The GUI itself handles first-time setup in the browser, so a non-zero
REM exit here is a real failure. Show the diagnostic banner and let the user
REM read it instead of closing the window immediately.
if errorlevel 1 %GUI% --failed
%GUI% --stopped
pause
