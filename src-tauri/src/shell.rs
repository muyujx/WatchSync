//! Shell 联动：资源管理器定位文件（explorer /select 的引号陷阱统一在此处理）。

/// 用资源管理器打开文件所在目录并选中该文件。
/// 参数：path 文件绝对路径。返回值：true = 已发起打开。
/// 说明：explorer /select 的路径必须整体带引号；`Command::arg` 的自动引号会把
/// 含空格路径拆坏（退化为打开默认目录），必须用 `raw_arg` 原样传命令行。
pub fn reveal_in_explorer(path: &std::path::Path) -> bool {
    use std::os::windows::process::CommandExt as _;
    let select = format!("/select,\"{}\"", path.display());
    match std::process::Command::new("explorer").raw_arg(select).spawn() {
        Ok(_) => true,
        Err(e) => {
            crate::applog::write(
                "WARN",
                &format!("reveal_in_explorer 打开失败 path={} err={e}", path.display()),
            );
            false
        }
    }
}
