@echo off
rem 雙擊我就會建置桌面版，產物放到 release\ 。
rem 邏輯在 tools\build-app.ps1（Windows 預設不准直接雙擊 .ps1，所以用這個 .bat 包一層）。
rem 想跳過測試：build-app.bat -SkipTests
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-app.ps1" %*
echo.
pause
