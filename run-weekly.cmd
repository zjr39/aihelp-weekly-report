@echo off
chcp 65001 >nul
cd /d "%~dp0"
set GUI=node bin\gui.mjs

REM With arguments: command-line mode (for scheduling / automation)
if NOT "%~1"=="" (
  if /i "%~1"=="last" (
    node bin\run-weekly.mjs --week last
  ) else if /i "%~1"=="this" (
    node bin\run-weekly.mjs --week this
  ) else (
    node bin\run-weekly.mjs --start %~1 --end %~2
  )
  echo.
  pause
  exit /b
)

REM Without arguments: open the visual interface
%GUI% --probe
if %errorlevel%==0 (
  %GUI% --already
  start "" http://127.0.0.1:8791
  ping -n 3 127.0.0.1 >nul
  exit /b
)

%GUI% --banner

start "" http://127.0.0.1:8791
%GUI% --port 8791

if errorlevel 1 %GUI% --failed
%GUI% --stopped
pause
