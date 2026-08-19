@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-filegram.ps1"
if errorlevel 1 (
  echo.
  echo FileGram installation failed. Review the error above.
  pause
  exit /b 1
)
exit /b 0
