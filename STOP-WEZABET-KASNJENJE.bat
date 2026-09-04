@echo off
setlocal
cd /d "%~dp0"
echo Gasim samo WezaBet merenje (Bwin ostaje)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-wezabet.ps1"
echo.
pause
endlocal
