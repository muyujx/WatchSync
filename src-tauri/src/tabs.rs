//! 视频页签管理：多页签 WebView 的生命周期、注入与指令通道。
//! 对应 Electron 版 videoView.ts（WebContentsView → Tauri 子 WebView）。
//!
//! 布局权威在 UI 壳（Vue）：本模块不持有任何几何常量，页签 webview 的内容区
//! 留白由 UI 经 set_tab_insets 上报，这里只按当前窗口尺寸套用。
//! 本地媒体页签（file:// / 本机回环媒体地址）不创建 webview：播放面由 UI 壳渲染。
//!
//! 与 Electron 版的机制性差异：
//! - JS 执行：webview.eval() 无返回值 → 桥执行结果由页面主动上报（bridge.rs）
//! - 隐藏页签：webview.hide()（JS/音频照常运行，语义同 Electron setVisible）
//! - 页面标题/地址：桥 tick 上报（300ms），不走 Rust 轮询

use std::sync::{Mutex, OnceLock};

use serde_json::json;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

use crate::state::{state, TabEntry};

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
  // 媒体文档（本地视频 / 成员流：Chromium 原生 <video> 播放页）默认黑底 → 改白，
  // 与下方页面操作区一起形成「白底 + 视频」的播放页；视频铺满页签视口且画面贴底
  // （object-position:bottom），画面下缘紧贴底部的状态/速度条，不留居中空档；
  // 仅对 video/*/audio/* 文档生效，站点网页不受影响
  if (!window.__p2pMediaWhite) {
    window.__p2pMediaWhite = true
    try {
      if (/^(video|audio)\//.test(document.contentType)) {
        const st = document.createElement('style')
        // 跟随应用主题（窗口 PreferredColorScheme → prefers-color-scheme）：
        // 浅色 #fff、深色 #1e1f20，均与 UI 侧 --ws-surface 一致，与下方操作区无缝
        st.textContent = 'html,body{background:#fff !important;margin:0 !important;height:100% !important;overflow:hidden !important}' +
          'video{background:transparent !important;display:block !important;width:100vw !important;height:100vh !important;object-fit:contain !important;object-position:center bottom !important}' +
          '@media (prefers-color-scheme: dark){html,body{background:#1e1f20 !important}}'
        ;(document.head || document.documentElement).appendChild(st)
      }
    } catch (e) {}
  }
  // 页内提示条：网页页签盖住 UI 壳，应用 Toast 由 Rust 经 page_toast 命令投递到这里渲染
  // （纯信息传递；Vue 本地媒体页签由 UI 壳直接渲染，不经过此助手）
  if (!window.__p2pToast) {
    let toastTimer = null
    window.__p2pToast = (text) => {
      try {
        let tip = document.getElementById('__ws-toast')
        if (!tip) {
          tip = document.createElement('div')
          tip.id = '__ws-toast'
          tip.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
            'max-width:70vw;padding:8px 18px;border-radius:17px;background:rgba(32,33,36,.88);color:#fff;' +
            'font:13px/1.5 system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            'pointer-events:none;transition:opacity .25s;opacity:0'
          ;(document.body || document.documentElement).appendChild(tip)
        }
        tip.textContent = text
        tip.style.opacity = '1'
        if (toastTimer) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => { tip.style.opacity = '0' }, 3000)
      } catch (e) {}
    }
  }
  window.__p2pReporter = setInterval(() => {
    const b = window.__p2pBridge
    // 封面：og:image 优先，退 video.poster；由 Rust 侧归一化/过滤（见 history.rs）
    const cover = () => {
      try {
        const m = document.querySelector('meta[property="og:image"]')
        if (m && m.content) return m.content
        if (b && b.video && b.video.poster) return b.video.poster
      } catch (e) {}
      return ''
    }
    if (!b) { send({ kind: 'tick', events: [], status: null, title: document.title, url: location.href, cover: cover() }); return }
    send({ kind: 'tick', events: b.drain(), status: b.status(), title: document.title, url: location.href, cover: cover() })
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

/// 是否为本地媒体页签（Vue 壳内渲染，不建 webview）：
/// 本地文件（file://）与本机回环媒体服务地址（推流回放/成员收流）。
/// 判定须与 UI 侧 core/mediaSource 的 isVuePlaybackUrl 保持一致。
pub fn is_local_media_tab(url: &str) -> bool {
    if url.starts_with("file:") {
        return true;
    }
    let port = crate::media_server::port();
    port > 0 && url.starts_with(&format!("http://127.0.0.1:{port}/media/"))
}

/// UI 壳上报内容区留白（逻辑 px：(顶栏高度, 底部预留)）并重排激活页签。
/// 这是页签 webview 布局的唯一权威来源；UI 壳在挂载/尺寸变化/全屏切换时调用。
pub fn set_tab_insets(app: &tauri::AppHandle, top: f64, bottom: f64) {
    *state(app).tab_insets.lock().unwrap() = Some((top, bottom));
    resize_active(app);
}

/// 激活页签 webview 的内容区（逻辑坐标）：按 UI 上报的留白与当前窗口尺寸计算。
/// UI 尚未上报留白时返回 None（调用方应保持 webview 隐藏）。
fn content_bounds(app: &tauri::AppHandle) -> Option<(LogicalPosition<f64>, LogicalSize<f64>)> {
    let st = state(app);
    let Some((top, bottom)) = *st.tab_insets.lock().unwrap() else {
        return None;
    };
    let win = main_window(app);
    let scale = win.scale_factor().unwrap_or(1.0);
    let sz = win.inner_size().unwrap_or_default();
    let (w, h) = (sz.width as f64 / scale, sz.height as f64 / scale);
    Some((
        LogicalPosition::new(0.0, top),
        LogicalSize::new(w, (h - top - bottom).max(0.0)),
    ))
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

/// 将主窗口切入/切出 OS 级全屏，并强制铺满当前显示器。
/// 参数：app 句柄；fs true=进入全屏，false=退出全屏（退出时恢复进入前的最大化状态）。
/// 返回值：无。
pub fn apply_window_fullscreen(app: &tauri::AppHandle, fs: bool) {
    let win = main_window(app);
    let st = state(app);
    if fs {
        // 记录进入前最大化状态；Windows 上 maximize 与 set_fullscreen 争抢尺寸，
        // 须先还原再全屏，否则 inner_size 停在工作区、底部露出约任务栏高度空白
        let was_max = win.is_maximized().unwrap_or(false);
        *st.was_maximized_before_fs.lock().unwrap() = was_max;
        if was_max {
            let _ = win.unmaximize();
        }
        let _ = win.set_fullscreen(true);
        // set_fullscreen 异步生效：立即按显示器物理边界对齐，避免依赖随后的 Resized
        if let Ok(Some(mon)) = win.current_monitor() {
            let _ = win.set_position(*mon.position());
            let _ = win.set_size(*mon.size());
        }
    } else {
        let _ = win.set_fullscreen(false);
        // 退出后恢复进入前的最大化（unmaximize 过则系统不会自动还原）
        if *st.was_maximized_before_fs.lock().unwrap() {
            *st.was_maximized_before_fs.lock().unwrap() = false;
            let _ = win.maximize();
        }
    }
}

/// 延时重排激活页签（兜底）：set_fullscreen/set_size 异步生效，立即读尺寸可能是旧值。
/// 参数：app 句柄。
/// 返回值：无。
pub fn schedule_resize(app: &tauri::AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        resize_active(&handle);
    });
}

/// 设置指定页签 webview 的可见性（隐藏后 JS/媒体照常运行，与 Electron setVisible 语义一致）
fn set_tab_visible(app: &tauri::AppHandle, tab_id: i64, visible: bool) {
    let Some(entry) = state(app).tabs.lock().unwrap().get(&tab_id).cloned() else {
        return;
    };
    if entry.is_vue() {
        return; // Vue 本地媒体页签：无 webview，显隐由 UI 布局层处理
    }
    let Some(wv) = app.get_webview(&entry.label) else { return };
    if visible {
        let Some((pos, size)) = content_bounds(app) else { return };
        let _ = wv.show();
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

/// 创建视频页签 webview（隐藏创建；激活时由 set_tab_visible 显示并套用内容区）。
fn create_webview(app: &tauri::AppHandle, tab_id: i64, url: &str, args: &str) -> String {
    let label = format!("video-{tab_id}");
    let parsed: tauri::Url = url.parse().unwrap_or_else(|_| "about:blank".parse().unwrap());
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .additional_browser_args(args)
        .data_directory(crate::webview_data_dir(app));
    // UI 未上报留白时以 1x1 占位创建（正常流程 Vue 先挂载上报，不会走到）
    let (pos, size) = content_bounds(app)
        .unwrap_or_else(|| (LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0)));
    main_window(app)
        .add_child(builder, pos, size)
        .expect("创建视频页签 webview 失败");
    label
}

/// 创建视频页签并激活。本地媒体页签（file:// / 本机回环媒体）不建 webview——
/// 播放面由 UI 壳渲染；其余创建子 webview。复用页签且类型（本地/网页）变化时转换承载方式。
/// 参数：app 句柄；url 目标地址；tab_id 指定页签复用（原地导航），None 新建。
/// 返回值：实际承载页面的页签 id。
pub fn open(app: &tauri::AppHandle, url: &str, tab_id: Option<i64>, args: &str) -> i64 {
    let st = state(app);
    // 复用既有页签：原地导航（地址栏当前页导航 / 成员端跟随换剧集）
    if let Some(id) = tab_id {
        let entry = st.tabs.lock().unwrap().get(&id).cloned();
        if let Some(entry) = entry {
            let target_vue = is_local_media_tab(url);
            if entry.is_vue() && !target_vue {
                // 本地媒体页签 → 网页页签：补建 webview 承载
                let label = create_webview(app, id, url, args);
                {
                    let mut tabs = st.tabs.lock().unwrap();
                    if let Some(e) = tabs.get_mut(&id) {
                        e.label = label;
                        e.adapter_id = String::new();
                        e.guard = false;
                        e.page_url = url.to_string();
                    }
                }
                st.tab_status.lock().unwrap().remove(&id);
            } else if !entry.is_vue() && target_vue {
                // 网页页签 → 本地媒体页签：销毁 webview，改由 UI 壳渲染
                if let Some(wv) = app.get_webview(&entry.label) {
                    let _ = wv.close();
                }
                {
                    let mut tabs = st.tabs.lock().unwrap();
                    if let Some(e) = tabs.get_mut(&id) {
                        e.label = String::new();
                        e.adapter_id = String::from("vue");
                        e.guard = false;
                        e.page_url = url.to_string();
                    }
                }
                st.tab_status.lock().unwrap().remove(&id);
            } else if entry.is_vue() {
                // 本地媒体页签原地导航：仅更新登记地址（UI 壳响应页签 url 变化换源）
                if let Some(e) = st.tabs.lock().unwrap().get_mut(&id) {
                    e.page_url = url.to_string();
                }
            } else if let Some(wv) = app.get_webview(&entry.label) {
                let js = format!("location.href = {}", serde_json::to_string(url).unwrap());
                let _ = wv.eval(&js);
                // 原地导航：清掉旧页状态缓存，防止新文档未就绪期间被调用方当成就绪（续播提前 seek 会静默失败）；
                // 残余 ≤300ms 的在途 tick 无法根除，但窗口已最小——续播方仍须新开页签（见 spec §5）
                st.tab_status.lock().unwrap().remove(&id);
            }
            drop(st);
            set_active(app, Some(id));
            return id;
        }
    }
    let id = crate::state::seq_next(&st.next_id);
    let (label, adapter) = if is_local_media_tab(url) {
        // 本地媒体页签：登记后直接激活，播放面由 UI 壳按页签 url 渲染
        (String::new(), String::from("vue"))
    } else {
        (create_webview(app, id, url, args), String::new())
    };
    st.tabs.lock().unwrap().insert(
        id,
        TabEntry {
            label,
            adapter_id: adapter,
            guard: false,
            page_url: url.to_string(),
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
        apply_window_fullscreen(app, false);
        schedule_resize(app);
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
        let entry = st.tabs.lock().unwrap().get(&id).cloned();
        if let Some(entry) = entry {
            if !entry.is_vue() {
                if let Some(wv) = app.get_webview(&entry.label) {
                    // 显式写守卫标记：guard=false 也复位，避免残留
                    let _ = wv.eval(if guard { GUARD_ON } else { GUARD_OFF });
                }
            }
            if let Some(e) = st.tabs.lock().unwrap().get_mut(&id) {
                e.guard = guard;
            }
        }
    }
}

/// 关闭页签：从窗口移除 webview 并清理指针（激活/同步页签被关时指针清空）。
pub fn close(app: &tauri::AppHandle, tab_id: i64) {
    let st = state(app);
    let label = st.tabs.lock().unwrap().remove(&tab_id).map(|t| t.label);
    st.tab_status.lock().unwrap().remove(&tab_id);
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
                apply_window_fullscreen(app, false);
                schedule_resize(app);
                let _ = app.emit_to("ui", "video-fullscreen", false);
            }
        }
    }
    drop(st);
    // 关页签即落盘：页签存活期间的播放进度立即持久化（不等 10s 节流）
    crate::history::flush(app, true);
    if let Some(label) = label {
        if label.is_empty() {
            return; // Vue 本地媒体页签：无 webview 可销毁
        }
        if let Some(wv) = app.get_webview(&label) {
            // close：从窗口移除并销毁 webview
            let _ = wv.close();
        }
    }
}

/// 对单个页签执行一次"确保注入"（幂等脚本，站点变化自动重装）。
pub fn ensure_inject_one(app: &tauri::AppHandle, tab_id: i64) {
    let st = state(app);
    let entry = st.tabs.lock().unwrap().get(&tab_id).cloned();
    let Some(entry) = entry else { return };
    if entry.is_vue() {
        return; // Vue 本地媒体页签：无 webview 无桥
    }
    let (label, cur_adapter, guard) = (entry.label.clone(), entry.adapter_id.clone(), entry.guard);
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

/// 向激活网页页签下发提示文本（页面内 __p2pToast 渲染；Vue 本地媒体页签无 webview，跳过——
/// 其 Toast 由 UI 壳直接渲染）
pub fn page_toast(app: &tauri::AppHandle, text: &str) {
    let st = state(app);
    let active = st.active_id.lock().unwrap().clone();
    let Some(id) = active else { return };
    let entry = st.tabs.lock().unwrap().get(&id).cloned();
    let Some(entry) = entry else { return };
    if entry.is_vue() {
        return;
    }
    let Some(wv) = app.get_webview(&entry.label) else { return };
    let script = format!(
        "window.__p2pToast && window.__p2pToast({})",
        serde_json::to_string(text).unwrap()
    );
    let _ = wv.eval(&script);
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

/// 向指定页签下发 seek（历史续播用；区别于 video_cmd 的同步页签限定）。
/// 无桥/页签不存在时静默（页面侧 cmd 自带存在性判断）。
pub fn seek_tab(app: &tauri::AppHandle, tab_id: i64, position: f64) {
    let st = state(app);
    let label = st.tabs.lock().unwrap().get(&tab_id).map(|t| t.label.clone());
    let Some(label) = label else { return };
    let Some(wv) = app.get_webview(&label) else { return };
    let _ = wv.eval(&format!(
        "window.__p2pBridge && window.__p2pBridge.cmd(\"seek\", {})",
        position
    ));
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
            src: s.src.clone(),
        },
        None => crate::state::VideoStatusFull {
            position: 0.0,
            paused: true,
            rate: 1.0,
            duration: 0.0,
            ready_state: 0.0,
            page_url,
            has_video: false,
            src: String::new(),
        },
    })
}

/// 桥 tick 里的标题/URL 更新（由 bridge.rs 调用）：标题或地址变化时 emit page-title 给 UI。
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
        // 标题或地址任一变化都上报：纯地址变化（媒体页/换集不改标题）也要让 UI 走导航联动
        let sig = format!("{title}\u{1}{url}");
        if m.get(&tab_id).map(String::as_str) != Some(sig.as_str()) {
            m.insert(tab_id, sig);
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
