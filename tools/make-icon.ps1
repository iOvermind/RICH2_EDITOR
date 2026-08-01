# 產生應用程式圖示的來源圖（1024x1024 PNG），再交給 `npx tauri icon` 切成各尺寸。
#
#   powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#
# 設計：大富翁的棋盤 —— 深色圓角底 + 一圈棋格，中央一個「富」字。
# 字體刻意用細明體，跟遊戲自己那套點陣字同源（見 docs/runexe-re.md §7）。
# 配色取自 src/style.css 的 @theme，跟編輯器介面一致。

Add-Type -AssemblyName System.Drawing

$S = 1024
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

function Rounded([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$bg      = [System.Drawing.Color]::FromArgb(255, 0x1B, 0x1B, 0x1C)   # surface-container-low
$edge    = [System.Drawing.Color]::FromArgb(255, 0x3C, 0x3C, 0x3C)
$cell    = [System.Drawing.Color]::FromArgb(255, 0x2A, 0x2E, 0x35)
$primary = [System.Drawing.Color]::FromArgb(255, 0x9F, 0xCA, 0xFF)   # primary
$accent  = [System.Drawing.Color]::FromArgb(255, 0x66, 0xDD, 0x8B)   # tertiary

# 底
$body = Rounded 40 40 ($S - 80) ($S - 80) 180
$g.FillPath((New-Object System.Drawing.SolidBrush $bg), $body)
$g.DrawPath((New-Object System.Drawing.Pen $edge, 8), $body)

# 一圈棋格：每邊 5 格，四個角落用強調色（像棋盤的起點/機會格）
$m = 150; $n = 5
$span = $S - $m * 2
$cw = [int]($span / $n)
$positions = @()
for ($i = 0; $i -lt $n; $i++) {
  $positions += , @(($m + $i * $cw), $m)                      # 上
  $positions += , @(($m + $i * $cw), ($m + ($n - 1) * $cw))   # 下
  if ($i -gt 0 -and $i -lt $n - 1) {
    $positions += , @($m, ($m + $i * $cw))                    # 左
    $positions += , @(($m + ($n - 1) * $cw), ($m + $i * $cw)) # 右
  }
}
$corners = @("$m,$m", "$m,$($m + ($n-1)*$cw)", "$($m + ($n-1)*$cw),$m", "$($m + ($n-1)*$cw),$($m + ($n-1)*$cw)")
foreach ($p in $positions) {
  $isCorner = $corners -contains "$($p[0]),$($p[1])"
  $c = if ($isCorner) { $accent } else { $cell }
  $r = Rounded $p[0] $p[1] ($cw - 14) ($cw - 14) 18
  $g.FillPath((New-Object System.Drawing.SolidBrush $c), $r)
}

# 中央的「富」——用細明體，跟遊戲字型同源
$font = New-Object System.Drawing.Font("MingLiU", 380, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, 0, $S, $S
$g.DrawString("富", $font, (New-Object System.Drawing.SolidBrush $primary), $rect, $fmt)

$out = Join-Path $PSScriptRoot '..\src-tauri\icon-source.png'
$dir = Split-Path $out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $font.Dispose()
Write-Output "已寫出 $((Resolve-Path $out).Path)"
