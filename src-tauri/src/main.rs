#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[derive(Clone, Serialize, Deserialize)]
struct Connection {
    protocol: u32,
    port: u16,
    token: String,
}
struct Backend {
    process: Mutex<Option<Child>>,
    connection: Connection,
}
impl Backend {
    fn shutdown(&self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut child) = guard.take() {
                let _ = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .and_then(|c| {
                        c.post(format!(
                            "http://127.0.0.1:{}/v1/shutdown",
                            self.connection.port
                        ))
                        .bearer_auth(&self.connection.token)
                        .json(&serde_json::json!({}))
                        .send()
                    });
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(12) {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
#[tauri::command]
fn connection(state: tauri::State<Backend>) -> Connection {
    state.connection.clone()
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![connection])
        .setup(|app| {
            let home = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&home)?;
            let mut command;
            if cfg!(debug_assertions) {
                let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap();
                let python = std::env::var_os("LISTEN_LOCAL_CORE_PYTHON")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| root.join(".qa/desktop-build/Scripts/python.exe"));
                command = Command::new(python);
                command.arg(root.join("desktop/backend/host.py"));
            } else {
                command = Command::new(app.path().resource_dir()?.join("binaries/listen-core.exe"));
            }
            command
                .arg("--home")
                .arg(&home)
                .stdout(Stdio::piped())
                .stderr(Stdio::from(std::fs::File::create(home.join("core.log"))?));
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command.spawn()?;
            let mut line = String::new();
            BufReader::new(child.stdout.take().unwrap()).read_line(&mut line)?;
            let connection: Connection = serde_json::from_str(&line)?;
            if connection.protocol != 1 {
                return Err("Unsupported core protocol".into());
            }
            app.manage(Backend {
                process: Mutex::new(Some(child)),
                connection,
            });
            let show = MenuItem::with_id(app, "show", "打开听见", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出并保存任务", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("听见 · 本地有声书");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    app.state::<Backend>().shutdown();
                    app.exit(0);
                }
                _ => (),
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to start Listen Local")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<Backend>().shutdown();
            }
        });
}
