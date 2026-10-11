# Probe test processes for shutdown.cjs (ASCII-only: PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
# Chinese comments corrupt parsing - keep this file ASCII-only)
# Two-way discovery:
#   1. ports: locate host process by listening port (WebView2 instance host is watchsync.exe,
#      must kill the host or the window stays as a black shell); stale TCP table entries
#      (port listening but process gone) are treated as down
#   2. strays: fallback by command line - watchsync.exe containing target\debug (dev build only,
#      won't touch installed release), node.exe containing both project name and vite
#      (won't touch chrome-devtools-mcp or other node services)
# Param: -Ports comma-separated port list string (default "9222,9223,4555"; string because
#        powershell -File cannot bind arrays)
# Output: JSON { ports: [{port, down, targetPid, targetName}], strays: [{pid, name, cmd}] } via stdout
param([string]$Ports = '9222,9223,4555')

$portList = $Ports.Split(',') | ForEach-Object { [int]$_.Trim() }

$portInfo = foreach ($p in $portList) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) {
    [PSCustomObject]@{ port = $p; down = $true; targetPid = $null; targetName = $null }
    continue
  }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)"
  if (-not $proc) {
    # stale TCP table entry: listening port whose owning process no longer exists
    [PSCustomObject]@{ port = $p; down = $true; targetPid = $null; targetName = $null }
    continue
  }
  # when listener is msedgewebview2, walk up to the non-WebView ancestor (watchsync.exe host);
  # otherwise the host is the listener itself (e.g. vite's node.exe)
  $target = $proc
  $cur = $proc
  while ($cur.Name -eq 'msedgewebview2.exe') {
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $par) { break }
    $cur = $par
    if ($cur.Name -ne 'msedgewebview2.exe') { $target = $cur }
  }
  [PSCustomObject]@{ port = $p; down = $false; targetPid = $target.ProcessId; targetName = $target.Name }
}

$strays = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'watchsync.exe' -and $_.CommandLine -match 'target\\+debug') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'watchsync' -and $_.CommandLine -match 'vite')
} | ForEach-Object {
  $c = $_.CommandLine
  [PSCustomObject]@{ pid = $_.ProcessId; name = $_.Name; cmd = $c.Substring(0, [Math]::Min(120, $c.Length)) }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject @{ ports = @($portInfo); strays = @($strays) } -Compress
