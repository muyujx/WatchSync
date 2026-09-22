# 一键启动开发环境脚本
# 流程：检查 exe → (未运行时)后台启动 vite dev server → 轮询端口就绪 → 启动 watchsync 实例
# 参数：
#   -Two  额外启动 B 实例（双开联调）；默认仅启动 A 实例
param(
  [switch]$Two
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "src-tauri\target\debug\watchsync.exe"
$logDir = Join-Path $root "logs"
$viteLog = Join-Path $logDir "dev-frontend.log"
$viteUrl = "http://127.0.0.1:4555"

# 端口探测：vite 可能仅绑定 IPv4(127.0.0.1) 或 IPv6([::1])，任一响应即视为就绪
function Test-ViteReady {
  foreach ($url in @("http://127.0.0.1:4555", "http://[::1]:4555")) {
    try {
      Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 | Out-Null
      return $true
    } catch { }
  }
  return $false
}

# exe 不存在则提示先编译 Rust 端
if (-not (Test-Path -LiteralPath $exe)) {
  Write-Host "错误: 未找到 $exe，请先执行 npm run build:rust" -ForegroundColor Red
  exit 1
}

# vite 未运行时才后台启动（cmd 包装以便重定向日志到文件）
if (-not (Test-ViteReady)) {
  if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c (npm run gen:adapters && vite --config vite.renderer.config.ts) > `"$viteLog`" 2>&1" `
    -WorkingDirectory $root -WindowStyle Hidden
  Write-Host "vite dev server 启动中（日志: $viteLog）..."
} else {
  Write-Host "vite dev server 已在运行，跳过启动"
}

# 轮询等待 4555 就绪，最多约 15 秒
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Test-ViteReady) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) {
  Write-Host "错误: vite dev server 未就绪，请查看 $viteLog" -ForegroundColor Red
  exit 1
}
Write-Host "vite dev server 就绪: $viteUrl"

# 启动实例 A（默认必开）
Start-Process -FilePath $exe -ArgumentList "--profile=A", "--cdp-port=9222" -WindowStyle Hidden
Write-Host "A 实例已启动 (cdp 9222)"

# -Two 时额外启动实例 B（双开联调）
if ($Two) {
  Start-Process -FilePath $exe -ArgumentList "--profile=B", "--cdp-port=9223" -WindowStyle Hidden
  Write-Host "B 实例已启动 (cdp 9223)"
}
