@echo off
rem Run this file as administrator. Only AI Guard WFP objects are removed.
"%~dp0aiguard-guard-filter.exe" unlock
if errorlevel 1 (
  echo Unlock failed. Run this file as administrator and read the error above.
  pause
  exit /b 1
)
echo AI Guard network filters removed. Protection is stopped.
pause
