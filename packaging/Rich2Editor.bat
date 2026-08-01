@echo off
rem Rich2 Editor —— 雙擊這個檔案就會啟動編輯器。
rem 實際的啟動邏輯在 serve.ps1；這個 .bat 只是為了讓 PowerShell 用 Bypass 政策執行它
rem （Windows 預設不准直接雙擊 .ps1）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 pause
