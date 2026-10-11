# 枚举资源管理器窗口（GUI 测试 TC-X-003 断言用）
# 功能：列出当前所有资源管理器窗口的文件夹位置与当前选中项，输出 JSON 数组
# 参数：无
# 返回：无返回值；stdout 输出 JSON：[{ location: "file:///D:/xx", selections: ["文件名", ...] }]
$shell = New-Object -ComObject Shell.Application
$result = @($shell.Windows() | ForEach-Object {
    # Document 可能在窗口加载中为空，逐窗口容错
    $sels = @()
    try {
      if ($_.Document -and $_.Document.SelectedItems()) {
        $sels = @($_.Document.SelectedItems() | ForEach-Object { $_.Name })
      }
    } catch {}
    [PSCustomObject]@{ location = $_.LocationURL; selections = $sels }
  })
# 空数组 ConvertTo-Json 会输出空串，统一补成 [] 便于下游解析；
# 必须用 -InputObject 传数组：管道方式会把单元素数组展开成单对象导致下游 JSON.parse 拿不到数组
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if ($result.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $result -Compress }
