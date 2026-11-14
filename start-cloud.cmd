@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-cloud.ps1" --open %*
if errorlevel 1 (
    pause
    exit /b 1
)
