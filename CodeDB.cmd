@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Avvio "desktop" di CodeDB: se il server e' gia' attivo apre solo il browser,
rem altrimenti chiede la passphrase in una finestra di dialogo e avvia il server
rem in background (nessuna console da tenere aperta; log su codedb.log).
rem   CodeDB.cmd        avvia (o riusa l'istanza attiva) e apre il browser
rem   CodeDB.cmd stop   ferma il server in background
rem Porta configurabile con la variabile d'ambiente PORT (default 3030).
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3030
set URL=http://localhost:%PORT%
title CodeDB

if /i "%~1"=="stop" goto :stop

rem Istanza gia' in esecuzione? Allora basta il browser.
powershell -NoProfile -Command "if (Test-NetConnection 127.0.0.1 -Port %PORT% -InformationLevel Quiet -WarningAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 (
  echo CodeDB e' gia' in esecuzione: apro %URL%
  start "" "%URL%"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -File tools\avvio-nascosto.ps1
exit /b %errorlevel%

:stop
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
  echo CodeDB fermato.
  exit /b 0
)
echo Nessuna istanza di CodeDB in ascolto sulla porta %PORT%.
exit /b 0
