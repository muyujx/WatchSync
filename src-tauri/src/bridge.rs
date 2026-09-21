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
            // 心跳：事件入队（仅同步页签）+ 状态缓存
            "tick" => {
                let st = state(app);
                let sync = st.sync_id.lock().unwrap().clone();
                if sync == Some(tab) {
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
                    if let Some(s) = v.get("status") {
                        if s.is_object() {
                            *st.last_status.lock().unwrap() = Some(crate::state::BridgeStatus {
                                position: s.get("position").and_then(|x| x.as_f64()).unwrap_or(0.0),
                                paused: s.get("paused").and_then(|x| x.as_bool()).unwrap_or(true),
                                rate: s.get("rate").and_then(|x| x.as_f64()).unwrap_or(1.0),
                                duration: s.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0),
                                ready_state: s.get("readyState").and_then(|x| x.as_f64()).unwrap_or(0.0),
                            });
                        } else {
                            // 无桥/无视频：置 None（hasVideo=false，pageUrl 仍持续同步）
                            *st.last_status.lock().unwrap() = None;
                        }
                    }
                }
                // 标题/地址更新（所有页签，供页签标题与 pageUrl 同步）
                let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
                let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
                if !title.is_empty() || !url.is_empty() {
                    drop(st);
                    crate::tabs::on_tab_tick(app, tab, title, url);
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
                        // 主窗口进入/退出 OS 级全屏：仅隐藏顶栏不够（任务栏仍占底部一条），
                        // 必须覆盖任务栏才算"全屏"；退出时 Windows 自动恢复原窗口状态（最大化/还原）
                        let _ = crate::tabs::main_window(app).set_fullscreen(fs);
                        // 重排视频页签 bounds（窗口尺寸已变；Resized 事件另有兜底）
                        crate::tabs::resize_active(app);
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
