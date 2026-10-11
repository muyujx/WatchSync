/**
 * 资源管理器窗口枚举工具：包装同目录 explorer-windows.ps1，解析 JSON 并把 file:/// URL 转成本地路径。
 * 用法：node test/tools/explorer-windows.cjs
 * 参数：无
 * 返回：无返回值；stdout 输出 JSON 数组 [{ location: "D:\\xx", selections: ["a.txt"] }]，location 已 URL 解码并转为反斜杠路径，便于与本地路径直接比对
 */
const { spawnSync } = require('child_process')
const path = require('path')

const r = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(__dirname, 'explorer-windows.ps1'),
], { encoding: 'utf8' })
if (r.status !== 0) {
  console.error(r.stderr || r.stdout)
  process.exit(r.status || 1)
}
const list = JSON.parse(r.stdout.trim() || '[]').map((w) => ({
  // file:///F:/a%20b → F:\a b：去掉前缀、URL 解码、正斜杠转反斜杠
  location: w.location
    ? decodeURIComponent(w.location.replace(/^file:\/\/\//, '')).replace(/\//g, '\\')
    : '',
  selections: w.selections || [],
}))
console.log(JSON.stringify(list, null, 2))
