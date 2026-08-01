# Rich2 Editor 啟動器
#
# 為什麼需要伺服器：編輯器靠 File System Access API（showDirectoryPicker）直接讀寫
# 遊戲資料夾，那個 API 只有 Chromium 系瀏覽器有。而且 Vite 的輸出用 ES module，
# 從 file:// 載入會被 CORS 擋掉 —— 所以不能雙擊 HTML，一定要跑在 http:// 上。
#
# 為什麼用 PowerShell 而不是打包成 exe：Node 的單一執行檔要 100 MB 左右，發佈給人
# 下載太肥，而且未簽章的 exe 會被 SmartScreen 擋。PowerShell 是 Windows 內建的，
# 整包下載只有應用程式本身的大小。
#
# 為什麼用 TcpListener 而不是 HttpListener：HttpListener 的網址前綴在非管理員權限下
# 常常會 Access Denied（要先 netsh add urlacl）。TcpListener 綁 127.0.0.1 沒這問題。

param([switch]$NoBrowser)   # -NoBrowser：只起伺服器不開瀏覽器（除錯用）

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path $root)) { Write-Host "找不到 app 資料夾，這個壓縮檔可能沒解完整。"; Read-Host "按 Enter 結束"; exit 1 }

# ── 挑一個沒被占用的埠 ────────────────────────────────────────────────────
$listener = $null
foreach ($p in 17325..17345) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
    $l.Start(); $listener = $l; $port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host "17325~17345 這些埠全被占用了，請關掉其他程式再試。"; Read-Host "按 Enter 結束"; exit 1 }
$url = "http://127.0.0.1:$port/"

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml';            '.png' = 'image/png'
  '.woff2' = 'font/woff2';              '.ico' = 'image/x-icon'
  '.bin'  = 'application/octet-stream'
}

# ── 開瀏覽器 ──────────────────────────────────────────────────────────────
# --app= 是無網址列的視窗，看起來像獨立應用程式。
# 用專屬的 user-data-dir 有兩個理由：(1) 就算使用者已經開著 Edge，也保證會生出一個
# 我們抓得到的新行程，關掉視窗才偵測得到要結束；(2) 資料夾授權會記在這個設定檔裡，
# 不會跟平常上網的設定檔混在一起。
$profileDir = Join-Path $env:LOCALAPPDATA 'Rich2Editor\browser'
$args = "--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check'
$browser = $null
if (-not $NoBrowser) {
  foreach ($exe in 'msedge', 'chrome') {
    try { $browser = Start-Process $exe -ArgumentList $args -PassThru; break } catch { }
  }
}
if (-not $browser -and -not $NoBrowser) {
  Write-Host "找不到 Edge 或 Chrome。編輯器需要 Chromium 系瀏覽器才能直接讀寫遊戲資料夾。"
  Write-Host "請手動用 Edge/Chrome 開啟：$url"
  Start-Process $url
}

Write-Host ""
Write-Host "  Rich2 Editor 已啟動：$url"
Write-Host "  關掉編輯器視窗就會自動結束（也可以直接關掉這個黑視窗）。"
Write-Host ""

# ── 極簡靜態檔伺服器 ──────────────────────────────────────────────────────
# 用 Pending() 輪詢而不是阻塞式 AcceptTcpClient，這樣同一個迴圈也能順便檢查
# 瀏覽器視窗是不是被關掉了。
function Send-Response($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

try {
  while ($true) {
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 60
      if ($browser -and $browser.HasExited) { break }
      continue
    }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $stream = $client.GetStream()
      # 讀到第一個空行為止就夠了：我們只服務 GET，不需要 body
      $buf = New-Object byte[] 8192
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { continue }
      $req = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
      $line = ($req -split "`r`n")[0]
      $path = ($line -split ' ')[1]
      if (-not $path) { continue }
      $path = ($path -split '\?')[0]
      $path = [System.Uri]::UnescapeDataString($path)
      if ($path -eq '/') { $path = '/index.html' }

      # 防目錄穿越：組出絕對路徑後，必須仍在 app 底下
      $full = [System.IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/') -replace '/', '\')))
      if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
        Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes("404 $path"))
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        Send-Response $stream 200 'OK' $ct ([System.IO.File]::ReadAllBytes($full))
      }
    } catch { } finally { $client.Close() }
  }
} finally {
  $listener.Stop()
}
