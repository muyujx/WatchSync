//! 视频页签管理：多页签 WebView 的生命周期、布局、注入与指令通道。
//! 对应 Electron 版 videoView.ts（WebContentsView → Tauri 子 WebView）。
//!
//! 与 Electron 版的机制性差异：
//! - JS 执行：webview.eval() 无返回值 → 桥执行结果由页面主动上报（bridge.rs）
//! - 隐藏页签：webview.hide()（JS/音频照常运行，语义同 Electron setVisible）
//! - 页面标题/地址：桥 tick 上报（300ms），不走 Rust 轮询

use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use crate::state::{state, TabEntry};

/// Chrome 式标签行高度（px）；UI 侧 CSS 须保持一致（App.vue .tabstrip）
pub const TAB_HEIGHT: f64 = 36.0;
/// Chrome 式地址工具栏高度（px）；UI 侧 CSS 须保持一致（App.vue .toolbar）
pub const TOOLBAR_HEIGHT: f64 = 44.0;
/// 网页内容区顶部偏移 = 标签行 + 工具栏
pub const CHROME_TOP: f64 = TAB_HEIGHT + TOOLBAR_HEIGHT;

/// 跟随守卫开启脚本：写全局标记，并同步已安装桥的 setFollow（否则只改 flag 不会开关采集）
pub const GUARD_ON: &str =
    "window.__p2pGuard = true; if (window.__p2pBridge && window.__p2pBridge.setFollow) window.__p2pBridge.setFollow(true); \"ok\"";
/// 跟随守卫关闭脚本：转让成房主/交还控制权时显式复位
pub const GUARD_OFF: &str =
    "window.__p2pGuard = false; if (window.__p2pBridge && window.__p2pBridge.setFollow) window.__p2pBridge.setFollow(false); \"ok\"";

/// 注入脚本模板（占位符替换，避免 format! 花括号转义地狱）：
/// __GUARD__ 守卫布尔 / __ADAPTER__ 适配器 id JSON / __TAB__ 页签 id / __SCRIPT__ 站点脚本+harness
const INJECT_TMPL: &str = r#"(() => {
  const b = window.__p2pBridge
  if (b && b.__adapterId === __ADAPTER__ && b.__guard === __GUARD__ && b.video && b.video.isConnected) return 'already'
  if (b && typeof b.dispose === 'function') b.dispose()
  window.__p2pBridge = null
})();
__SCRIPT__
(() => {
  const b = window.__p2pBridge
  if (b) { b.__adapterId = __ADAPTER__; b.__guard = __GUARD__ }
})();
(() => {
  // 桥结果上报器：eval 无返回值，tick/全屏/导航拦截经自定义协议回传 Rust（见 bridge.rs）
  if (window.__p2pReporter) return
  const TAB = __TAB__
  const send = (payload) => {
    try {
      payload.tab = TAB
      fetch('http://watchsync-bridge.localhost/report', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    } catch (e) {}
  }
  window.__p2pReport = send
  window.__p2pReporter = setInterval(() => {
    const b = window.__p2pBridge
    if (!b) { send({ kind: 'tick', events: [], status: null, title: document.title, url: location.href }); return }
    send({ kind: 'tick', events: b.drain(), status: b.status(), title: document.title, url: location.href })
  }, 300)
  document.addEventListener('fullscreenchange', () => {
    send({ kind: 'fullscreen', fullscreen: !!document.fullscreenElement })
  })
  // 拦截 window.open / target=_blank：改为当前页签内导航，保证桥与同步不逃逸。
  // 必须返回 stub 假窗口对象：B 站搜索等站点采用「window.open() 拿窗口引用 →
  // 再向 win.location.href 写目标地址」的模式，返回 null 会让后续写属性抛 TypeError
  // 导致点击搜索按钮/回车全部静默失效；stub 的 location setter 兜住该写法并在当前页签导航
  window.open = function (u) {
    // 协议判断须含协议相对形式（//host/...）：B 站搜索构造的正是 //search.bilibili.com/...，
    // 仅匹配 https?: 会导致回车/点击搜索静默失效
    const nav = function (t) { try { const s = String(t || ''); if (/^(https?:)?\/\//i.test(s)) location.href = s } catch (e) {} }
    nav(u)
    let cur = String(u || '')
    const stub = {
      closed: false,
      close: function () {},
      focus: function () {},
      blur: function () {},
      print: function () {},
      postMessage: function () {},
      opener: window,
    }
    Object.defineProperty(stub, 'location', {
      get: function () { return { href: cur, assign: nav, replace: nav, toString: function () { return cur } } },
      set: function (v) { cur = String(v || ''); nav(v) },
      configurable: true,
    })
    Object.defineProperty(stub, 'document', { get: function () { return null }, configurable: true })
    return stub
  }
  document.addEventListener('click', (e) => {
    const t = e.target
    const a = t && t.closest ? t.closest('a[target="_blank"]') : null
    if (a && a.href && /^https?:/.test(a.href)) { e.preventDefault(); location.href = a.href }
  }, true)
})()"#;

/// 取主窗口句柄
pub fn main_window(app: &tauri::AppHandle) -> tauri::Window {
    app.get_window("main").expect("主窗口不存在")
}

/// 拼装注入脚本（幂等：adapter/guard/视频元素均未变则由脚本内判断跳过）。
/// __SCRIPT__ 前后加分号：站点脚本结尾 `})()` 无分号时避免与相邻 IIFE 粘连成函数调用。
fn build_inject_script(tab_id: i64, adapter_id: &str, inject_script: &str, guard: bool) -> String {
    INJECT_TMPL
        .replace("__GUARD__", if guard { "true" } else { "false" })
        .replace("__ADAPTER__", &serde_json::to_string(adapter_id).unwrap())
        .replace("__TAB__", &tab_id.to_string())
        .replace("__SCRIPT__", &format!(";{};", inject_script))
}

/// 激活页签的布局（逻辑坐标）：HTML 全屏铺满整窗，否则顶部预留 UI 区
fn active_bounds(app: &tauri::AppHandle) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let fullscreen = state(app).html_fullscreen.lock().unwrap().clone();
    let win = main_window(app);
    let scale = win.scale_factor().unwrap_or(1.0);
    let sz = win.inner_size().unwrap_or_default();
    let (w, h) = (sz.width as f64 / scale, sz.height as f64 / scale);
    let top = if fullscreen { 0.0 } else { CHROME_TOP };
    (LogicalPosition::new(0.0, top), LogicalSize::new(w, h - top))
}

/// 设置指定页签 webview 的可见性（隐藏后 JS/媒体照常运行，与 Electron setVisible 语义一致）
fn set_tab_visible(app: &tauri::AppHandle, tab_id: i64, visible: bool) {
    let label = state(app).tabs.lock().unwrap().get(&tab_id).map(|t| t.label.clone());
    let Some(label) = label else { return };
    let Some(wv) = app.get_webview(&label) else { return };
    if visible {
        let _ = wv.show();
        let (pos, size) = active_bounds(app);
        let _ = wv.set_bounds(tauri::Rect { position: pos.into(), size: size.into() });
    } else {
        let _ = wv.hide();
    }
}

/// 激活页签随窗口尺寸/全屏状态调整布局
pub fn resize_active(app: &tauri::AppHandle) {
    let active = state(app).active_id.lock().unwrap().clone();
    let Some(id) = active else { return };
    set_tab_visible(app, id, true);
}

/// 显示/隐藏激活页签画面（打开 UI 弹窗时隐藏，露出下层 UI 界面）
pub fn set_visible(app: &tauri::AppHandle, visible: bool) {
    let active = state(app).active_id.lock().unwrap().clone();
    let Some(id) = active else { return };
    set_tab_visible(app, id, visible);
}

/// 构造统一 WebView2 附加参数（所有 webview 必须一致，否则 environment 冲突创建失败）
/// - disable-features：wry 默认项 + 窗口遮挡误判禁用（同 Electron 版 CalculateNativeWinOcclusion）
/// - 自动播放策略：成员端被动起播无用户手势
/// - 后台不被节流：隐藏页签照常运行（同步状态持续上报）
/// - CDP：联调驱动（e2e）附加调试端口
pub fn browser_args(cdp_port: u16) -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
         --autoplay-policy=no-user-gesture-required \
         --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
         --remote-debugging-port={cdp_port}"
    )
}

/// 创建视频页签 webview 并激活。
/// 参数：app 句柄；url 目标地址；tab_id 指定页签复用（原地导航），None 新建。
/// 返回值：实际承载页面的页签 id。
pub fn open(app: &tauri::AppHandle, url: &str, tab_id: Option<i64>, args: &str) -> i64 {
    let st = state(app);
    // 复用既有页签：原地导航（地址栏当前页导航 / 成员端跟随换剧集）
    if let Some(id) = tab_id {
        let exists = st.tabs.lock().unwrap().contains_key(&id);
        if exists {
            let label = st.tabs.lock().unwrap().get(&id).map(|t| t.label.clone());
            if let Some(label) = label {
                if let Some(wv) = app.get_webview(&label) {
                    let js = format!("location.href = {}", serde_json::to_string(url).unwrap());
                    let _ = wv.eval(&js);
                }
            }
            drop(st);
            set_active(app, Some(id));
            return id;
        }
    }
    let id = crate::state::seq_next(&st.next_id);
    let label = format!("video-{id}");
    let parsed: tauri::Url = url.parse().unwrap_or_else(|_| "about:blank".parse().unwrap());
    let win = main_window(app);
    let sz = win.inner_size().unwrap_or_default();
    let scale = win.scale_factor().unwrap_or(1.0);
    let (w, h) = (sz.width as f64 / scale, sz.height as f64 / scale);
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .additional_browser_args(args)
        .data_directory(crate::webview_data_dir(app));
    win.add_child(builder, LogicalPosition::new(0.0, CHROME_TOP), LogicalSize::new(w, h - CHROME_TOP))
        .expect("创建视频页签 webview 失败");
    st.tabs.lock().unwrap().insert(
        id,
        TabEntry {
            id,
            label: label.clone(),
            adapter_id: String::new(),
            guard: false,
            page_url: url.to_string(),
            title: String::new(),
        },
    );
    drop(st);
    // 新页签自动激活（浏览器习惯）
    set_active(app, Some(id));
    id
}

/// 切换显示页签：激活页签可见，其余移出窗口外（后台页签继续运行有声）；null = 回主页。
pub fn set_active(app: &tauri::AppHandle, tab_id: Option<i64>) {
    let st = state(app);
    if let Some(id) = tab_id {
        if !st.tabs.lock().unwrap().contains_key(&id) {
            return;
        }
    }
    // 切换前若处于 HTML 全屏，先复位（全屏属于上一个激活页签的显示状态）：
    // 状态、OS 全屏窗口、UI 顶栏三者必须同步恢复，否则窗口仍覆盖任务栏而顶栏已显示
    if *st.html_fullscreen.lock().unwrap() {
        *st.html_fullscreen.lock().unwrap() = false;
        let _ = main_window(app).set_fullscreen(false);
        let _ = app.emit_to("ui", "video-fullscreen", false);
    }
    let prev = st.active_id.lock().unwrap().clone();
    // 预取被切走页签的 webview label（drop st 前读取，避免锁冲突）
    let prev_label = prev
        .filter(|p| Some(*p) != tab_id)
        .and_then(|p| st.tabs.lock().unwrap().get(&p).map(|t| t.label.clone()));
    *st.active_id.lock().unwrap() = tab_id;
    drop(st);
    if let Some(label) = prev_label {
        if let Some(wv) = app.get_webview(&label) {
            // 与浏览器切页签行为一致：切走时让页面退出 HTML 全屏，
            // 否则全屏元素残留在后台页签，切回时出现"顶栏在但页面仍全屏"的怪状态
            let _ = wv.eval("document.exitFullscreen && document.exitFullscreen().catch(function(){});");
        }
    }
    if let Some(p) = prev {
        if Some(p) != tab_id {
            set_tab_visible(app, p, false);
        }
    }
    if let Some(id) = tab_id {
        set_tab_visible(app, id, true);
    }
}

/// 设置同步目标页签并迁移跟随守卫（旧同步页签解除守卫，新页签按 guard 挂守卫）。
/// 切换目标时清空事件缓存（旧页签积压事件不应串台）。
pub fn set_sync_tab(app: &tauri::AppHandle, tab_id: Option<i64>, guard: bool) {
    let st = state(app);
    let mut sync = st.sync_id.lock().unwrap();
    let prev = sync.clone();
    // 旧同步页签解除守卫
    if let Some(old) = prev {
        if Some(old) != tab_id {
            let old_label = st.tabs.lock().unwrap().get(&old).map(|t| t.label.clone());
            if let Some(label) = old_label {
                if let Some(wv) = app.get_webview(&label) {
                    let _ = wv.eval(GUARD_OFF);
                }
            }
            if let Some(e) = st.tabs.lock().unwrap().get_mut(&old) {
                e.guard = false;
            }
        }
    }
    *sync = tab_id;
    drop(sync);
    // 清空事件缓存与状态缓存（切目标 / 清除同步）
    st.events.lock().unwrap().clear();
    *st.last_status.lock().unwrap() = None;
    if let Some(id) = tab_id {
        let label = st.tabs.lock().unwrap().get(&id).map(|t| t.label.clone());
        if let Some(label) = label {
            if let Some(wv) = app.get_webview(&label) {
                // 显式写守卫标记：guard=false 也复位，避免残留
                let _ = wv.eval(if guard { GUARD_ON } else { GUARD_OFF });
                if let Some(e) = st.tabs.lock().unwrap().get_mut(&id) {
                    e.guard = guard;
                }
            }
        }
    }
}

/// 关闭页签：从窗口移除 webview 并清理指针（激活/同步页签被关时指针清空）。
pub fn close(app: &tauri::AppHandle, tab_id: i64) {
    let st = state(app);
    let label = st.tabs.lock().unwrap().remove(&tab_id).map(|t| t.label);
    {
        let mut sync = st.sync_id.lock().unwrap();
        if *sync == Some(tab_id) {
            *sync = None;
            st.events.lock().unwrap().clear();
            *st.last_status.lock().unwrap() = None;
        }
    }
    {
        let mut active = st.active_id.lock().unwrap();
        if *active == Some(tab_id) {
            *active = None;
            // 关闭的是激活页签且处于 HTML 全屏：同步退出 OS 全屏（状态/窗口/UI 三者一致）
            if *st.html_fullscreen.lock().unwrap() {
                *st.html_fullscreen.lock().unwrap() = false;
                let _ = main_window(app).set_fullscreen(false);
                let _ = app.emit_to("ui", "video-fullscreen", false);
            }
        }
    }
    drop(st);
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            // close：从窗口移除并销毁 webview
            let _ = wv.close();
        }
    }
}

/// 对单个页签执行一次"确保注入"（幂等脚本，站点变化自动重装）。
pub fn ensure_inject_one(app: &tauri::AppHandle, tab_id: i64) {
    let st = state(app);
    let (label, cur_adapter, guard) = {
        let tabs = st.tabs.lock().unwrap();
        match tabs.get(&tab_id) {
            Some(e) => (e.label.clone(), e.adapter_id.clone(), e.guard),
            None => return,
        }
    };
    let Some(wv) = app.get_webview(&label) else { return };
    let url = st.tabs.lock().unwrap().get(&tab_id).map(|t| t.page_url.clone()).unwrap_or_default();
    let adapter = crate::state::select_adapter(&url);
    let _ = wv.eval(if guard { GUARD_ON } else { GUARD_OFF });
    let script = build_inject_script(tab_id, &adapter.id, &adapter.inject_script, guard);
    let _ = wv.eval(&script);
    // 记录当前适配器（日志/调试用）
    if cur_adapter != adapter.id {
        if let Some(e) = st.tabs.lock().unwrap().get_mut(&tab_id) {
            e.adapter_id = adapter.id.clone();
        }
    }
}

/// 常驻确保注入（定时线程每秒执行一次）：桥缺失（首次/SPA 重建/换剧集）自动补装。
pub fn start_ensure_loop(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let ids: Vec<i64> = state(&app).tabs.lock().unwrap().keys().cloned().collect();
        for id in ids {
            ensure_inject_one(&app, id);
        }
    });
}

/// 显式注入同步页签（成员端建立/重申跟随模式）。
/// 返回值：'ok'（eval 已发出；实际安装结果由桥上报异步确认）。
pub fn inject_sync(app: &tauri::AppHandle, guard: bool) -> String {
    let st = state(app);
    let sync = st.sync_id.lock().unwrap().clone();
    let Some(id) = sync else { return String::from("noview") };
    let Some(entry) = st.tabs.lock().unwrap().get(&id).cloned() else {
        return String::from("noview");
    };
    let Some(wv) = app.get_webview(&entry.label) else {
        return String::from("noview");
    };
    let adapter = crate::state::select_adapter(&entry.page_url);
    let _ = wv.eval(if guard { GUARD_ON } else { GUARD_OFF });
    let _ = wv.eval(&build_inject_script(id, &adapter.id, &adapter.inject_script, guard));
    String::from("ok")
}

/// 向同步页签下发指令：action = play|pause|seek|rate（eval fire-and-forget）。
pub fn video_cmd(app: &tauri::AppHandle, action: &str, arg: Option<f64>) {
    let st = state(app);
    let sync = st.sync_id.lock().unwrap().clone();
    let Some(id) = sync else { return };
    let label = st.tabs.lock().unwrap().get(&id).map(|t| t.label.clone());
    let Some(label) = label else { return };
    let Some(wv) = app.get_webview(&label) else { return };
    let script = format!(
        "window.__p2pBridge && window.__p2pBridge.cmd({}, {})",
        serde_json::to_string(action).unwrap(),
        arg.map(|a| a.to_string()).unwrap_or_else(|| "null".into())
    );
    let _ = wv.eval(&script);
}

/// 工具栏导航：back | forward | reload，作用于激活页签。
pub fn video_nav(app: &tauri::AppHandle, action: &str) {
    let st = state(app);
    let active = st.active_id.lock().unwrap().clone();
    let Some(id) = active else { return };
    let label = st.tabs.lock().unwrap().get(&id).map(|t| t.label.clone());
    let Some(label) = label else { return };
    let Some(wv) = app.get_webview(&label) else { return };
    match action {
        "back" => {
            let _ = wv.eval("history.back()");
        }
        "forward" => {
            let _ = wv.eval("history.forward()");
        }
        "reload" => {
            let _ = wv.eval("location.reload()");
        }
        _ => {}
    }
}

/// 查询同步页签状态（缓存读；pageUrl 由桥 tick 上报，SPA 路由同步）。
pub fn video_status(app: &tauri::AppHandle) -> Option<crate::state::VideoStatusFull> {
    let st = state(app);
    let sync = st.sync_id.lock().unwrap().clone();
    let id = sync?;
    let (cached, page_url) = {
        let tabs = st.tabs.lock().unwrap();
        let page_url = tabs.get(&id).map(|t| t.page_url.clone()).unwrap_or_default();
        (st.last_status.lock().unwrap().clone(), page_url)
    };
    Some(match cached {
        Some(s) => crate::state::VideoStatusFull {
            position: s.position,
            paused: s.paused,
            rate: s.rate,
            duration: s.duration,
            ready_state: s.ready_state,
            page_url,
            has_video: true,
        },
        None => crate::state::VideoStatusFull {
            position: 0.0,
            paused: true,
            rate: 1.0,
            duration: 0.0,
            ready_state: 0.0,
            page_url,
            has_video: false,
        },
    })
}

/// 桥 tick 里的标题/URL 更新（由 bridge.rs 调用）：标题变化时 emit page-title 给 UI。
pub fn on_tab_tick(app: &tauri::AppHandle, tab_id: i64, title: &str, url: &str) {
    static LAST: OnceLock<Mutex<std::collections::HashMap<i64, String>>> = OnceLock::new();
    let last = LAST.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    {
        let st = state(app);
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(e) = tabs.get_mut(&tab_id) {
            e.page_url = url.to_string();
        }
    }
    let changed = {
        let mut m = last.lock().unwrap();
        if m.get(&tab_id).map(|s| s.as_str()) != Some(title) {
            m.insert(tab_id, title.to_string());
            true
        } else {
            false
        }
    };
    if changed {
        let _ = app.emit_to(
            "ui",
            "page-title",
            json!({ "tabId": tab_id, "title": title, "url": url }),
        );
    }
}
