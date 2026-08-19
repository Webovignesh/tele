@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-filegram.ps1"
if errorlevel 1 (
  echo.
  echo FileGram uninstall step failed. Review the error above.
  pause
  exit /b 1
)
pause
exit /b 0
