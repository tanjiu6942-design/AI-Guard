#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CheckResult {
    key: String,
    title: String,
    state: String,
    detail: String,
}

// 前端 gui/src/ipc.ts 的 Status 用 camelCase (tunEnabled/exitIp/exitCountry),
// 不转换会让前端读到 undefined 而显示空白。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Status {
    running: bool,
    mode: String,
    tun_enabled: bool,
    exit_ip: Option<String>,
    exit_country: Option<String>,
}

struct AppState {
    child: Mutex<Option<Child>>,
    mode: Mutex<String>,
    tun_enabled: Mutex<bool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            mode: Mutex::new("strict".into()),
            tun_enabled: Mutex::new(false),
        }
    }
}

/// 定位 aiguard 项目根目录(含 bin/ 与 dist/ 的那一层)。
/// 开发期是 gui/src-tauri 的上两级; 打包后可用 AIGUARD_ROOT 覆盖。
fn project_root() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("AIGUARD_ROOT") {
        return std::path::PathBuf::from(p);
    }
    // 开发期: <root>/gui/src-tauri/target/release/aiguard.exe → 上溯到 <root>
    let exe = std::env::current_exe().unwrap_or_default();
    let mut p = exe.as_path();
    for _ in 0..4 {
        if let Some(parent) = p.parent() {
            p = parent;
        }
    }
    if p.join("bin").is_dir() {
        return p.to_path_buf();
    }
    // 回退: 相对于编译期源码位置
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn node_bridge(script: &str, args: &[&str]) -> Result<String, String> {
    let root = project_root();
    // script 形如 "bin/doctor.js", 相对于项目根执行, 而非 core/ 目录
    let path = root.join(script);
    if !path.exists() {
        return Err(format!("找不到脚本: {}", path.display()));
    }
    let out = Command::new("node")
        .arg(&path)
        .args(args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("无法启动 node: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// 读 settings.json 里的真实配置, 避免 GUI 显示与实际不符。
/// 解析失败时返回 None, 由调用方回退到内存状态。
fn read_settings_field(field: &str) -> Option<String> {
    let path = std::path::PathBuf::from(
        std::env::var("APPDATA").ok()?,
    )
    .join("aiguard")
    .join("settings.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    match v.get(field)? {
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Status {
    let running = state.child.lock().unwrap().is_some();

    // 优先反映 settings.json 的真实值; 读不到才用内存状态
    let mode = read_settings_field("mode")
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|| state.mode.lock().unwrap().clone());

    let tun_enabled = read_settings_field("tunEnabled")
        .map(|s| s == "true")
        .unwrap_or_else(|| *state.tun_enabled.lock().unwrap());

    Status {
        running,
        mode,
        tun_enabled,
        exit_ip: None,
        exit_country: None,
    }
}

#[tauri::command]
fn start_core(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    // 复用 bin/start.js: 它已处理 mihomo 路径解析、geodata 投放、TUN/DNS 联动。
    // 必须用绝对路径 + 显式 cwd, 否则 GUI 从任意目录启动会找不到脚本。
    let root = project_root();
    let script = root.join("bin").join("start.js");
    if !script.exists() {
        return Err(format!("找不到启动脚本: {}", script.display()));
    }
    let child = Command::new("node")
        .arg(&script)
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动失败: {e}"))?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_core(state: tauri::State<AppState>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

#[tauri::command]
fn set_mode(state: tauri::State<AppState>, mode: String) -> Result<(), String> {
    if mode != "strict" && mode != "precise" {
        return Err("模式只能是 strict 或 precise".into());
    }
    node_bridge("bin/set-mode.js", &[&mode])?;
    *state.mode.lock().unwrap() = mode;
    Ok(())
}

#[tauri::command]
fn run_doctor() -> Result<Vec<CheckResult>, String> {
    let out = node_bridge("bin/doctor.js", &["--json"])?;
    serde_json::from_str(&out).map_err(|e| format!("解析检测结果失败: {e}"))
}

#[tauri::command]
fn tail_logs(lines: usize) -> Result<Vec<String>, String> {
    let out = node_bridge("bin/logs.js", &[&lines.to_string()])?;
    Ok(out.lines().map(|s| s.to_string()).collect())
}

#[tauri::command]
fn apply_patch(rule: String) -> Result<(), String> {
    node_bridge("bin/patch.js", &[&rule])?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_core,
            stop_core,
            set_mode,
            run_doctor,
            tail_logs,
            apply_patch
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
