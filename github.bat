@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set GIT_SSH_COMMAND=ssh -i "%USERPROFILE%\.ssh\id_ed25519" -o IdentitiesOnly=yes

set REPO_NAME=RICH2_EDITOR
set REPO_URL=git@github.com:iOvermind/RICH2_EDITOR.git

echo ==================================
echo   🚀 Git 自動化助手 (SSH 懶人版)
echo   💻 Repo: %REPO_NAME%
echo ==================================

:: 🌟 如果沒有 .git 就初始化
if not exist ".git" (
    echo 📁 偵測到這還不是 Git 專案，正在初始化...
    git init
    git branch -m main 2>nul || git checkout -b main 2>nul
    echo ✅ 初始化完成！
    echo ----------------------------------
)

echo 請選擇功能：
echo   [1] ⬇️  下載更新 (Pull)
echo   [2] ⬆️  上傳備份 (Push)
echo ==================================
set /p choice=請輸入選項 [1/2]: 

if "%choice%"=="1" goto PULL
if "%choice%"=="2" goto PUSH
echo ❌ 選項錯誤
goto END

:: =============================
:: Pull 區段
:: =============================
:PULL
echo ----------------------------------
echo ⬇️ 正在強制拉取更新 (認親模式)...
git pull %REPO_URL% main --allow-unrelated-histories
echo ✅ 完成！
goto END

:: =============================
:: Push 區段
:: =============================

:PUSH
echo ----------------------------------
echo 📦 準備上傳...

rem 1. 先產生 requirements (如果需要)
if exist "requirements.txt" (pip freeze > requirements.txt 2>nul)
if not exist "requirements.txt" if exist ".venv" (pip freeze > requirements.txt 2>nul)

rem 2. 先檢查變更，此時還沒 git add，所以 temp_git.txt 不會被追蹤
git status --porcelain > temp_git.txt
set FILE_SIZE=0
for %%i in (temp_git.txt) do set FILE_SIZE=%%~zi

if "%FILE_SIZE%"=="0" goto NO_CHANGES
del temp_git.txt
goto DO_COMMIT_LOGIC

:NO_CHANGES
echo ⚠️ 沒有變更，跳過 commit
if exist "temp_git.txt" del temp_git.txt
goto PUSH_CLOUD

:DO_COMMIT_LOGIC
rem 確定有變更，先刪除暫存檔再 add，或是直接 add 排除它
if exist "temp_git.txt" del temp_git.txt
git add .
set /p input_msg=請輸入 Commit 訊息 (Enter 自動時間):

set FILE_SIZE=0
for %%i in (temp_git.txt) do set FILE_SIZE=%%~zi

if "%FILE_SIZE%"=="0" goto NO_CHANGES
goto DO_COMMIT_LOGIC

:NO_CHANGES
echo ⚠️ 沒有變更，跳過 commit
if exist "temp_git.txt" del temp_git.txt
goto PUSH_CLOUD

:DO_COMMIT_LOGIC
set /p input_msg=請輸入 Commit 訊息 (Enter 自動時間): 

if not "!input_msg!"=="" (
    set "commit_msg=!input_msg!"
    goto GIT_COMMIT
)

rem 這裡把時間獨立抓出來，完全避開在 if 區塊內解析冒號
for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"`) do set "CURRENT_TIME=%%t"
set "commit_msg=Auto update: !CURRENT_TIME!"

:GIT_COMMIT
git commit -m "!commit_msg!"
if exist "temp_git.txt" del temp_git.txt

:PUSH_CLOUD
echo ☁️ 推送中...
git push %REPO_URL% main

if errorlevel 1 (
    echo ❌ 推送失敗
) else (
    echo ✅ 上傳成功！
)
goto END
:END
echo.
pause