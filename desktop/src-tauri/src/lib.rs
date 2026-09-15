use serde::Deserialize;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

static FORGE_HOME: OnceLock<String> = OnceLock::new();
static SIDECAR_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

fn forge_home() -> &'static str {
    FORGE_HOME.get_or_init(|| {
        std::env::var("FORGE_HOME").unwrap_or_else(|_| {
            format!(
                "{}/.forge",
                std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
            )
        })
    })
}

fn forge_root() -> &'static str {
    static ROOT: OnceLock<String> = OnceLock::new();
    ROOT.get_or_init(|| {
        std::env::var("FORGE_ROOT").unwrap_or_else(|_| {
            // Dev layout: <repo>/desktop/src-tauri — the repo root is two
            // parents up. Fall back to the manifest dir when the serve script
            // is not found (packaged builds should set FORGE_ROOT explicitly).
            let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            let repo = manifest.parent().and_then(|p| p.parent());
            match repo {
                Some(dir) if dir.join("src/cli/serve.ts").exists() => {
                    dir.to_string_lossy().into_owned()
                }
                _ => manifest.to_string_lossy().into_owned(),
            }
        })
    })
}

/// Shape of `~/.forge/server.json`, written by the serve process. Read once at
/// startup to learn the auth token the frontend is injected with.
#[derive(Deserialize)]
pub struct Handshake {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    pub port: u16,
    pub host: String,
    pub token: String,
    pub pid: u32,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
}

fn sidecar_child_slot() -> &'static Mutex<Option<Child>> {
    SIDECAR_CHILD.get_or_init(|| Mutex::new(None))
}

fn spawn_sidecar(port: u16) -> Result<(), String> {
    let serve_script =
        std::env::var("FORGE_SERVE_SCRIPT").unwrap_or_else(|_| "src/cli/serve.ts".into());
    let root = forge_root();
    let runtime = std::env::var("FORGE_RUNTIME").unwrap_or_else(|_| "pi".into());
    // Delete any stale handshake from a previous run BEFORE spawning. If the
    // serve process fails to boot, wait_for_handshake would otherwise read the
    // old file and inject a dead port/token into the frontend (→ "Load failed").
    let hs_path = std::path::Path::new(forge_home()).join("server.json");
    let _ = std::fs::remove_file(&hs_path);

    // Kill orphaned sidecar instances from previous sessions. They hold the
    // port (a fresh serve would die with EADDRINUSE, silently) and a stale
    // auth token (the frontend would get 401 on every request).
    let _ = Command::new("pkill")
        .args(["-f", "src/cli/serve.ts"])
        .output();

    // Sidecar stdout/stderr go to a log file instead of being discarded —
    // a sidecar that dies on boot was previously undiagnosable.
    let log_path = std::path::Path::new(forge_home()).join("sidecar.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("failed to open sidecar log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("failed to clone sidecar log handle: {e}"))?;

    let child = Command::new("node")
        .args([
            "--import",
            "tsx/esm",
            &serve_script,
            "--port",
            &port.to_string(),
        ])
        .current_dir(root)
        .env("FORGE_HOME", forge_home())
        .env("FORGE_RUNTIME", &runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|e| format!("failed to spawn forge serve: {e}"))?;
    if let Ok(mut guard) = sidecar_child_slot().lock() {
        *guard = Some(child);
    }
    Ok(())
}

fn wait_for_handshake(timeout_ms: u64) -> Result<Handshake, String> {
    let path = std::path::Path::new(forge_home()).join("server.json");
    let start = std::time::Instant::now();
    let mut last_err: Option<String> = None;
    loop {
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<Handshake>(&raw) {
                    Ok(hs) => return Ok(hs),
                    Err(e) => last_err = Some(format!("invalid handshake json: {e}")),
                },
                Err(e) => last_err = Some(format!("read failed: {e}")),
            }
        }
        if start.elapsed().as_millis() > timeout_ms as u128 {
            let child_tracked = sidecar_child_slot()
                .lock()
                .map(|g| g.as_ref().is_some())
                .unwrap_or(false);
            let detail = last_err.unwrap_or_else(|| "server.json was never created".into());
            return Err(format!(
                "handshake timeout after {timeout_ms}ms ({detail}; sidecar child tracked={child_tracked})"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

pub fn run() {
    const PORT: u16 = 5300;
    if let Err(e) = spawn_sidecar(PORT) {
        eprintln!("forge-desktop: sidecar failed to start: {e}");
    }

    let token = match wait_for_handshake(10_000) {
        Ok(hs) => hs.token,
        Err(e) => {
            eprintln!("forge-desktop: {e}");
            String::new()
        }
    };

    let init_js = format!(
        "window.__FORGE_CONFIG__ = {{ baseUrl: 'http://127.0.0.1:{}', token: '{}' }};",
        PORT, token
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .append_invoke_initialization_script(&init_js)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
