# 建置桌面版（Tauri），把產物收進 release\。
#
#   powershell -ExecutionPolicy Bypass -File tools\build-app.ps1
#   或直接雙擊根目錄的 build-app.bat
#
#   -SkipTests   跳過回歸測試
#   -Clean       先清掉 Rust 的建置快取（很少需要；清掉後第一次要重編十幾分鐘）
#
# 為什麼要這支而不是直接 `npm run app:build`：rustup 裝完不會即時進到既有 shell 的
# PATH，`cargo not found` 是最常見的第一個坑。這裡會自己去 ~\.cargo\bin 找。

param([switch]$SkipTests, [switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Fail($msg) { Write-Host ""; Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host ""; Write-Host "── $msg " -ForegroundColor Cyan }

# ── 前置檢查 ──────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "找不到 node。請先安裝 Node.js。" }

# rustup 裝完不會進到已經開著的 shell 的 PATH，所以自己補上去
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
    $env:PATH = "$cargoBin;$env:PATH"
    Write-Host "  （cargo 不在 PATH 裡，已從 $cargoBin 補上）" -ForegroundColor DarkGray
  } else {
    Fail "找不到 cargo。請先安裝 Rust：winget install Rustlang.Rustup"
  }
}
# Tauri 在 Windows 要 MSVC 連結器
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  $vc = & $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
  if (-not $vc) { Fail "Visual Studio Build Tools 缺少「使用 C++ 的桌面開發」工作負載，Rust 會連結失敗。" }
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Step "安裝 npm 相依"
  npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install 失敗。" }
}

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "  Rich2 Editor v$version" -ForegroundColor White
Write-Host "  cargo $((cargo --version) -replace '^cargo ')" -ForegroundColor DarkGray

if ($Clean) { Step "清掉 Rust 建置快取"; cargo clean --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') }

# ── 回歸測試 ──────────────────────────────────────────────────────────────
# 放在建置**之前**：測試掛了就別浪費那幾分鐘去編 Rust。
if (-not $SkipTests) {
  Step "回歸測試"
  npm test
  if ($LASTEXITCODE -ne 0) { Fail "測試沒過，先修好再建置（真的要跳過就加 -SkipTests）。" }
}

# ── 建置 ──────────────────────────────────────────────────────────────────
Step "建置（第一次要編十幾分鐘，之後有快取會快很多）"
npx tauri build
if ($LASTEXITCODE -ne 0) { Fail "tauri build 失敗，訊息看上面。" }

# ── 收產物 ────────────────────────────────────────────────────────────────
Step "收進 release\"
$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$targets = Join-Path $root 'src-tauri\target\release'
$made = @()
foreach ($item in @(
  @{ src = Join-Path $targets 'rich2-editor.exe';                                 dst = "Rich2Editor-v$version-portable.exe" },
  @{ src = Join-Path $targets "bundle\nsis\Rich2 Editor_${version}_x64-setup.exe"; dst = "Rich2Editor-v$version-setup.exe" }
)) {
  if (Test-Path $item.src) {
    $d = Join-Path $outDir $item.dst
    Copy-Item $item.src $d -Force
    $made += [PSCustomObject]@{ 檔案 = $item.dst; 大小 = '{0:N2} MB' -f ((Get-Item $d).Length / 1MB) }
  } else {
    Write-Host "  ⚠ 找不到 $($item.src)" -ForegroundColor Yellow
  }
}

Write-Host ""
if ($made.Count -eq 0) { Fail "建置看似成功，但找不到任何產物。" }
$made | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "  → $outDir" -ForegroundColor Green
Write-Host ""
Write-Host "  portable 版直接執行；setup 版是安裝檔（裝到使用者目錄，不需要管理員）。" -ForegroundColor DarkGray
