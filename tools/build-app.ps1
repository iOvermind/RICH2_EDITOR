# 建置桌面版（Tauri），把產物收進 release\。
#
#   powershell -ExecutionPolicy Bypass -File tools\build-app.ps1
#   或直接雙擊根目錄的 build-app.bat
#
#   -SkipTests   跳過回歸測試
#   -Sign        用自簽憑證簽章
#   -Clean       先清掉 Rust 的建置快取（很少需要；清掉後第一次要重編十幾分鐘）
#
# 為什麼要這支而不是直接 `npm run app:build`：rustup 裝完不會即時進到既有 shell 的
# PATH，`cargo not found` 是最常見的第一個坑。這裡會自己去 ~\.cargo\bin 找。
#
# 產物命名依 docs/rules/RELEASE_RULES.md §2.1。

param([switch]$SkipTests, [switch]$Sign, [switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$ProjectName = 'RICH2_EDITOR'
$AppLabel = 'Rich2 Editor'

function Fail($msg) { Write-Host ""; Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host ""; Write-Host "── $msg " -ForegroundColor Cyan }

# PowerShell 5.1 會把原生指令寫到 stderr 的每一行包成 ErrorRecord；配上
# ErrorActionPreference='Stop'，即使指令成功（npm、cargo 都把進度訊息寫到 stderr）
# 也會被當成失敗而中止。原生指令一律走這裡，成敗只看離開碼。
function Invoke-Native {
    param([scriptblock]$Command, [string]$What)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Command
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous

    if ($code -ne 0) { Fail "$What 失敗（離開碼 $code）" }
}

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
  # ⚠ 不能用 npm ci：vite-plugin-node-polyfills 尚未宣告支援 vite 8，peer 檢查會擋下來
  Invoke-Native { npm install --legacy-peer-deps } 'npm install'
}

# ── 版本號一致性 ──────────────────────────────────────────────────────────
# 發佈門檻。單一來源是 package.json；這裡只讀不寫，負責攔住漏改的那一處。
Step "檢查版本號一致性"

$version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$tauriVersion = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$cargoVersion = (Select-String (Join-Path $root 'src-tauri\Cargo.toml') -Pattern '^version\s*=\s*"(.+)"' |
    Select-Object -First 1).Matches.Groups[1].Value

$sources = [ordered]@{
    'package.json (單一來源)'    = $version
    'src-tauri/tauri.conf.json' = $tauriVersion
    'src-tauri/Cargo.toml'      = $cargoVersion
}
$sources.GetEnumerator() | ForEach-Object { Write-Host ('    {0,-28} {1}' -f $_.Key, $_.Value) }
if ($sources.Values | Where-Object { $_ -ne $version }) {
    Fail "版本號不一致，發佈前必須先對齊（見 docs/rules/VERSION_RULES.md §2.3）"
}

Write-Host ""
Write-Host "  $AppLabel v$version" -ForegroundColor White
Write-Host "  cargo $((cargo --version) -replace '^cargo ')" -ForegroundColor DarkGray

if ($Clean) { Step "清掉 Rust 建置快取"; cargo clean --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') }

# ── 回歸測試 ──────────────────────────────────────────────────────────────
# 放在建置**之前**：測試掛了就別浪費那幾分鐘去編 Rust。
if (-not $SkipTests) {
  Step "回歸測試"
  Invoke-Native { npm test } '測試'
}

# ── 建置 ──────────────────────────────────────────────────────────────────
Step "建置（第一次要編十幾分鐘，之後有快取會快很多）"
Invoke-Native { npx tauri build } 'tauri build'

# ── 收產物 ────────────────────────────────────────────────────────────────
Step "收進 release\"
$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$targets = Join-Path $root 'src-tauri\target\release'
$artifacts = @(
  @{ From = Join-Path $targets 'rich2-editor.exe';                                  To = "$ProjectName-v$version-Portable.exe" }
  @{ From = Join-Path $targets "bundle\nsis\Rich2 Editor_${version}_x64-setup.exe"; To = "$ProjectName-v$version-Setup.exe" }
)

$made = @()
foreach ($item in $artifacts) {
  if (-not (Test-Path -LiteralPath $item.From)) { Fail "找不到產物：$($item.From)" }
  Copy-Item -LiteralPath $item.From -Destination (Join-Path $outDir $item.To) -Force
  $made += $item.To
  Write-Host "    $($item.To)"
}

# ── 簽章（選用）───────────────────────────────────────────────────────────
# 自簽憑證只是讓 EXE 帶上發行者名稱，不具信任價值，使用者仍會看到 SmartScreen 警告。
if ($Sign) {
  Step "簽章"

  if (-not (Test-Path (Join-Path $root 'Overmind.pfx'))) {
    # 先找存放區裡既有的憑證再用，避免每次都簽發一張新的、在存放區裡越積越多
    $cert = Get-ChildItem Cert:\CurrentUser\My |
      Where-Object { $_.Subject -eq 'CN=Overmind' -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
      Sort-Object NotAfter -Descending | Select-Object -First 1

    if ($cert) {
      Write-Host "    沿用既有憑證（有效期至 $($cert.NotAfter.ToString('yyyy-MM-dd'))）"
    } else {
      Write-Host "    存放區沒有可用憑證，簽發一張新的自簽憑證"
      $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Overmind' `
        -KeyExportPolicy Exportable -KeySpec Signature -KeyLength 2048 `
        -KeyAlgorithm RSA -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10) `
        -CertStoreLocation 'Cert:\CurrentUser\My'
    }
    $pfxPwd = ConvertTo-SecureString -String 'overmind' -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath (Join-Path $root 'Overmind.pfx') -Password $pfxPwd | Out-Null
    Write-Host "    已匯出 Overmind.pfx（已在 .gitignore 內）"
  }

  $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1

  if ($signtool) {
    foreach ($name in $made) {
      $path = Join-Path $outDir $name
      $previous = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & $signtool.FullName sign /f (Join-Path $root 'Overmind.pfx') /p 'overmind' /fd SHA256 `
        /t http://timestamp.digicert.com /d $AppLabel $path
      $code = $LASTEXITCODE
      $ErrorActionPreference = $previous
      if ($code -ne 0) { Write-Host "  ⚠ $name 簽章失敗（離開碼 $code）" -ForegroundColor Yellow }
    }
  } else {
    Write-Host "  ⚠ 找不到 signtool.exe，跳過簽章。" -ForegroundColor Yellow
  }
}

# ── 校驗碼 ────────────────────────────────────────────────────────────────
# RELEASE_RULES §4.3 規定為必附項。必須在簽章之後計算，否則對不上實際上傳的檔案。
Step "產生 SHA256SUMS.txt"

$lines = foreach ($name in $made) {
  $hash = (Get-FileHash -LiteralPath (Join-Path $outDir $name) -Algorithm SHA256).Hash.ToLower()
  "$hash  $name"
}
[System.IO.File]::WriteAllLines(
  (Join-Path $outDir 'SHA256SUMS.txt'),
  $lines,
  (New-Object System.Text.UTF8Encoding($false))
)
$lines | ForEach-Object { Write-Host "    $_" }

# ── 回報 ──────────────────────────────────────────────────────────────────
Write-Host ""
foreach ($name in $made) {
  $size = (Get-Item -LiteralPath (Join-Path $outDir $name)).Length / 1MB
  Write-Host ('  {0,-42} {1,6:N2} MB' -f $name, $size)
}
Write-Host ""
Write-Host "  → $outDir" -ForegroundColor Green
Write-Host "  Portable 版直接執行；Setup 版是安裝檔（裝到使用者目錄，不需要管理員）。" -ForegroundColor DarkGray
if (-not $Sign) { Write-Host "  （未簽章。要簽章請加 -Sign）" -ForegroundColor DarkGray }
