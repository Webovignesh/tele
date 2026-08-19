@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\post-release-cleanup.ps1"
if errorlevel 1 (
  echo.
  echo Repository cleanup stopped safely. Review the error above.
  pause
  exit /b 1
)
pause
exit /b 0
