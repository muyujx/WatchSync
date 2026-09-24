//! 桥上报自定义协议：视频页内 reporter 脚本经 fetch POST 上报 tick/全屏事件。
//! 自定义协议在 Windows 侧挂载为 http://watchsync-bridge.localhost/report。
//! 为什么不用 webview eval 取返回值：Tauri eval 无返回值，故统一为页面主动推送。

use serde_json::Value;
use tauri::Emitter;

use crate::state::{state, VideoEvent};

/// 处理桥上报（注册于 Tauri Builder::register_uri_scheme_protocol）。
/// 请求：POST body = JSON {tab, kind, events?, status?, title?, fullscreen?}
/// 响应：200 空体 + CORS 头（跨域 fetch 必需）。
pub fn handle_report(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // 预检请求直接放行（text/plain 简单请求通常不触发，防御性兜底）
    if request.method() == "OPTIONS" {
        return cors(tauri::http::Response::builder().status(200).body(Vec::new()).unwrap());
    }
    let body = request.body();
    let parsed: Result<Value, _> = serde_json::from_slice(body);
    if let Ok(v) = parsed {
        let tab = v.get("tab").and_then(|x| x.as_i64()).unwrap_or(-1);
        let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            // 心跳：事件入队（仅同步页签）+ 状态缓存（所有页签）+ 历史记录
            "tick" => {
                let st = state(app);
                let sync = st.sync_id.lock().unwrap().clone();
                let has_status_key = v.get("status").is_some();
                // status 解析（所有页签；对象 = 有桥有视频，null = 无桥/无视频/无 metadata）
                let status = v.get("status").and_then(|s| {
                    if !s.is_object() {
                        return None;
                    }
                    Some(crate::state::BridgeStatus {
                        position: s.get("position").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        paused: s.get("paused").and_then(|x| x.as_bool()).unwrap_or(true),
                        rate: s.get("rate").and_then(|x| x.as_f64()).unwrap_or(1.0),
                        duration: s.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        ready_state: s.get("readyState").and_then(|x| x.as_f64()).unwrap_or(0.0),
                        src: s.get("src").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    })
                });
                // close 与在途 tick 的竞态防御：页签已销毁就不再插回死条目（否则永久残留）
                let tab_alive = st.tabs.lock().unwrap().contains_key(&tab);
                if tab_alive && has_status_key {
                    // 每页签状态缓存（续播轮询 tabStatus 用）
                    let mut ts = st.tab_status.lock().unwrap();
                    match &status {
                        Some(s) => {
                            ts.insert(tab, s.clone());
                        }
                        None => {
                            ts.remove(&tab);
                        }
                    }
                }
                if sync == Some(tab) {
                    // 同步页签：事件入队（保持原语义）
                    if let Some(evs) = v.get("events").and_then(|x| x.as_array()) {
                        let mut q = st.events.lock().unwrap();
                        for e in evs {
                            let ev = e.get("ev").and_then(|x| x.as_str()).unwrap_or("");
                            if ev.is_empty() {
                                continue;
                            }
                            q.push(VideoEvent {
                                ev: ev.to_string(),
                                position: e.get("position").and_then(|x| x.as_f64()).unwrap_or(0.0),
                                paused: e.get("paused").and_then(|x| x.as_bool()).unwrap_or(true),
                            });
                        }
                    }
                    // 同步页签状态缓存（保持原语义：status 键存在才覆盖；
                    // 无桥/无视频置 None，hasVideo=false 且 pageUrl 仍持续同步）
                    if has_status_key {
                        *st.last_status.lock().unwrap() = status.clone();
                    }
                }
                // 标题/地址/封面（所有页签）
                let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
                let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
                let cover = v
                    .get("cover")
                    .and_then(|x| x.as_str())
                    .and_then(crate::history::normalize_cover);
                let has_tick_data = !title.is_empty() || !url.is_empty();
                drop(st);
                if has_tick_data {
                    crate::tabs::on_tab_tick(app, tab, title, url);
                    // 播放历史：所有页签入账（仅播放写进度见 history.rs）
                    crate::history::on_tick(app, title, url, status.as_ref(), cover.as_deref());
                }
            }
            // HTML 全屏状态变化（仅激活页签可能触发）：调整布局并通知 UI
            "fullscreen" => {
                let st = state(app);
                let active = st.active_id.lock().unwrap().clone();
                if active == Some(tab) {
                    let fs = v.get("fullscreen").and_then(|x| x.as_bool()).unwrap_or(false);
                    let mut cur = st.html_fullscreen.lock().unwrap();
                    if *cur != fs {
                        *cur = fs;
                        drop(cur);
                        // OS 级全屏：铺满显示器（盖住任务栏）；最大化场景须先还原再全屏
                        crate::tabs::apply_window_fullscreen(app, fs);
                        // 立刻排一次 + 延时兜底（set_fullscreen 异步，最大化→全屏时尺寸增量小）
                        crate::tabs::resize_active(app);
                        crate::tabs::schedule_resize(app);
                        let _ = app.emit_to("ui", "video-fullscreen", fs);
                    }
                }
            }
            _ => {}
        }
    }
    cors(tauri::http::Response::builder().status(200).body(Vec::new()).unwrap())
}

/// 统一加 CORS 头（视频页跨域 fetch 必需）
fn cors(mut resp: tauri::http::Response<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS};
    let headers = resp.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    headers.insert(ACCESS_CONTROL_ALLOW_HEADERS, "*".parse().unwrap());
    headers.insert(ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS".parse().unwrap());
    resp
}
