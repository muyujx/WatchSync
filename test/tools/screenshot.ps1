# 全屏截图（GUI 测试系统级断言用）
# 功能：截取整个虚拟屏幕（多显示器全覆盖），保存为 PNG
# 参数：-Out 输出 png 路径（必填，目录须已存在）
# 返回：无返回值；stdout 输出保存路径供调用方确认
param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# VirtualScreen 而非 PrimaryScreen：多显示器时覆盖全部屏幕
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $Out"
