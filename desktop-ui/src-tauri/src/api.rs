//! 与本地 daemon (http://127.0.0.1:47921) 的 HTTP 通信 + 自举。
//! 由 Tauri command 以 spawn_blocking 调用（阻塞请求不卡 UI 线程）。
//! 仅访问纯 HTTP 本地地址，故 ureq 关闭 TLS 特性（default-features = false）。

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const API_BASE: &str = "http://127.0.0.1:47921";

/// 读取 WorkPet daemon 的本地 API token。
/// 依次在 daemon.js 所在目录、exe 所在目录、%APPDATA%/WorkPet 尝试读取。
/// daemon 首次启动时生成；读不到时返回 None（请求将收到 401，重试即可）。
fn pet_token() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(daemon) = find_daemon_js() {
        if let Some(p) = daemon.parent() {
            candidates.push(p.join(".api-token"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent() {
            candidates.push(p.join(".api-token"));
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(Path::new(&appdata).join("WorkPet").join(".api-token"));
    }

    for path in candidates {
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
// CREATE_NO_WINDOW：后台拉起 node（控制台应用）时不弹出黑窗口
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type ApiResult = Result<Value, String>;

/// 发起一次 daemon 请求；业务失败统一转为 Err（临时限流错误带 RETRY 标记，
/// 由前端按「自动重试」处理）。
pub fn do_request(method: &str, path: &str, body: Option<&str>) -> ApiResult {
    let url = format!("{API_BASE}{path}");

    // ureq 3.4：ConfigBuilder 设置每请求总超时（switch 会重启 TraeWork，给足时间）
    let mut cb = ureq::Agent::config_builder();
    cb = cb.timeout_connect(Some(Duration::from_secs(4)));
    let per_call = if path.starts_with("/api/accounts/switch") || path.starts_with("/api/client/ca/switch") {
        // 切换 CodeArts 账号需停/重启客户端再写 vscdb，给足时间
        Duration::from_secs(40)
    } else {
        Duration::from_secs(12)
    };
    cb = cb.timeout_global(Some(per_call));
    // 不把 HTTP 状态码当 Error，统一拿到 body 再按 {ok} 判断业务失败
    cb = cb.http_status_as_error(false);
    let agent = ureq::Agent::new_with_config(cb.build());

    let token = pet_token();
    let result = match method {
        "GET" => {
            let mut r = agent.get(&url);
            if let Some(t) = &token {
                r = r.header("X-WorkPet-Token", t);
            }
            r.call()
        }
        "POST" => {
            let mut rb = agent.post(&url).content_type("application/json");
            if let Some(t) = &token {
                rb = rb.header("X-WorkPet-Token", t);
            }
            match body {
                Some(b) => rb.send(b.to_string()),
                None => rb.send_empty(),
            }
        }
        _ => return Err(format!("不支持的方法 {method}")),
    };

    match result {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let text = match resp.into_body().read_to_string() {
                Ok(s) => s,
                Err(e) => return Err(format!("读取 daemon 响应失败: {e}")),
            };
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => {
                    if (200..300).contains(&code) {
                        // 统一按 {ok:...} 结构判断业务成功
                        if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(true) {
                            Ok(v)
                        } else {
                            let err = v
                                .get("error")
                                .and_then(|e| e.as_str())
                                .unwrap_or("未知错误")
                                .to_string();
                            Err(err)
                        }
                    } else {
                        // 业务失败：可能带 retryable 标记（签到高峰限流等临时错误）
                        let retryable = v
                            .get("retryable")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false);
                        let err = v
                            .get("error")
                            .and_then(|e| e.as_str())
                            .or_else(|| {
                                v.get("data").and_then(|d| {
                                    d.get("message")
                                        .and_then(|m| m.as_str())
                                        .or_else(|| d.get("msg").and_then(|m| m.as_str()))
                                })
                            })
                            .unwrap_or("请求失败")
                            .to_string();
                        if retryable {
                            Err(format!("\u{0001}RETRY\u{0001}{err}"))
                        } else {
                            Err(err)
                        }
                    }
                }
                Err(_) => Err(format!("响应解析失败 (HTTP {code}): {text}")),
            }
        }
        Err(e) => Err(format!("daemon 未连接: {e}")),
    }
}

/// 快速探测 daemon 是否已就绪。
pub fn daemon_reachable() -> bool {
    let mut cb = ureq::Agent::config_builder();
    cb = cb.timeout_connect(Some(Duration::from_secs(2)));
    cb = cb.timeout_global(Some(Duration::from_secs(3)));
    cb = cb.http_status_as_error(false);
    let agent = ureq::Agent::new_with_config(cb.build());
    let mut r = agent.get(&format!("{API_BASE}/api/health"));
    if let Some(t) = pet_token() {
        r = r.header("X-WorkPet-Token", &t);
    }
    r.call().is_ok()
}

/// 在候选目录及常见资源子目录里查找 daemon.js。
fn find_daemon_js() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("daemon.js"),
        exe_dir.join("_up_").join("_up_").join("daemon.js"),
        exe_dir.join("resources").join("daemon.js"),
    ];
    for c in &candidates {
        if c.is_file() {
            return Some(c.clone());
        }
    }
    // 向上逐级兜底查找（针对开发调试模式）
    let mut d = Some(exe_dir);
    while let Some(dir) = d {
        let c = dir.join("daemon.js");
        if c.is_file() {
            return Some(c);
        }
        d = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

/// 在常见安装位置定位 node.exe。
fn find_node() -> String {
    let mut v: Vec<std::path::PathBuf> = Vec::new();
    // 优先使用随安装包捆绑的 node 运行时（用户无需自行安装 Node.js）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            v.push(dir.join("node.exe"));
            v.push(dir.join("binaries").join("node.exe"));
            // 开发环境：从 exe 目录向上找 binaries/node.exe
            let mut d = dir.to_path_buf();
            for _ in 0..5 {
                v.push(d.join("binaries").join("node.exe"));
                d = match d.parent() {
                    Some(p) => p.to_path_buf(),
                    None => break,
                };
            }
        }
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        v.push(Path::new(&pf).join("nodejs").join("node.exe"));
    }
    if let Ok(pf32) = std::env::var("ProgramFiles(x86)") {
        v.push(Path::new(&pf32).join("nodejs").join("node.exe"));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        v.push(Path::new(&la).join("Programs").join("nodejs").join("node.exe"));
    }
    for p in v {
        if p.is_file() {
            if let Some(s) = p.to_str() {
                return s.to_string();
            }
        }
    }
    "node".to_string()
}

/// 隐藏后台拉起 daemon 子进程；detached 常驻，退出桌面端后继续运行。
/// 不经 shell：Command 参数列表式调用，node 路径来自固定安装位置探测，
/// 脚本路径来自 exe 同级目录逐级上溯，均无外部输入参与。
fn spawn_daemon() -> Result<(), String> {
    let daemon = find_daemon_js()
        .ok_or_else(|| "未找到 daemon.js（请保持 daemon.js 与桌面客户端同包）".to_string())?;
    let node = find_node();

    let mut cmd = std::process::Command::new(node);
    cmd.arg(&daemon);
    // 便携数据目录：账号备份/设置/积分缓存存到 exe 同目录（不写 C 盘 AppData）
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        cmd.env("WORKPET_DATA_DIR", &exe_dir);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动后台服务失败: {e}"))
}

/// 期望的 daemon 版本（与桌面端 exe 同版本发布）。
fn expected_daemon_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 探测 47921 上的 daemon 是否为本包同版本（旧版本安装残留会返回不匹配）。
pub fn daemon_version_matches() -> bool {
    let mut cb = ureq::Agent::config_builder();
    cb = cb.timeout_connect(Some(Duration::from_secs(2)));
    cb = cb.timeout_global(Some(Duration::from_secs(4)));
    cb = cb.http_status_as_error(false);
    let agent = ureq::Agent::new_with_config(cb.build());
    let mut r = agent.get(&format!("{API_BASE}/api/health"));
    if let Some(t) = pet_token() {
        r = r.header("X-WorkPet-Token", t);
    }
    match r.call() {
        Ok(resp) => {
            let text = resp
                .into_body()
                .read_to_string()
                .unwrap_or_default();
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            v.get("version")
                .and_then(|x| x.as_str())
                .map(|ver| ver.trim_start_matches('v') == expected_daemon_version())
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

/// 确保 daemon 在运行且版本与本包一致：
///  - 47921 上没有 daemon → 拉起新的；
///  - 有 daemon 但版本不匹配（升级/降级后旧常驻进程残留）→ 先 /api/shutdown 旧进程，
///    等端口释放后再拉起本包 daemon，避免前端一直连到旧逻辑。
/// 若多个 exe 同时启动，daemon 已对端口冲突做过容错（EADDRINUSE 退出），属正常。
pub fn ensure_daemon() -> Result<(), String> {
    if daemon_reachable() {
        if daemon_version_matches() {
            return Ok(());
        }
        // 旧版本残留 daemon：先优雅停机，再等端口释放
        let _ = do_request("POST", "/api/shutdown", None);
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline && daemon_reachable() {
            std::thread::sleep(Duration::from_millis(300));
        }
        if daemon_reachable() {
            return Err("旧版后台服务未能停止，请手动结束残留的 node 进程后重启 Work Pet".to_string());
        }
    }
    spawn_daemon()?;
    // 等待本包 daemon 起来（版本一致才算就绪）；最多 ~20s
    std::thread::sleep(Duration::from_millis(500));
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if daemon_reachable() && daemon_version_matches() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(800));
    }
    Err("后台服务启动超时，请确认已安装 Node.js".to_string())
}

/// 发送请求终止本地常驻 daemon（避免安装更新时 node.exe 被锁定）
pub fn stop_daemon() {
    let _ = do_request("POST", "/api/shutdown", None);
}

