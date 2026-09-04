@echo off
setlocal
cd /d "%~dp0"
echo Pokrecem Bwin + WezaBet merenje (samo Chrome)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-wezabet.ps1"
echo.
echo Compare: http://localhost:3302/
echo (Sokabet merenje se NE dira. Za gasenje: STOP-WEZABET-KASNJENJE.bat)
pause
endlocal
