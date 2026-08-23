use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

struct ServerChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // hanya izinkan http/https — jangan biarkan webview memanggil skema arbitrer
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("skema tidak diizinkan".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

fn data_dir(app: &tauri::AppHandle) -> std::io::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(std::io::Error::other)?;
    std::fs::create_dir_all(&dir)?;
    #[cfg(windows)]
    {
        // sembunyikan folder (attrib +h) tanpa flash console window
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("attrib")
            .args(["+h", &format!("{}", dir.display())])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    Ok(dir)
}

fn spawn_server(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = data_dir(app)?;
    let sidecar = app.shell().sidecar("hidden-audio-server")?;
    let (mut rx, child) = sidecar
        .args(["--port", "55502", "--host", "127.0.0.1"])
        .env("HIDDEN_AUDIO_DATA_DIR", &dir)
        .spawn()?;
    app.manage(ServerChild(Mutex::new(Some(child))));

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[server] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Error(err) => eprintln!("[server] error: {err}"),
                CommandEvent::Terminated(status) => {
                    eprintln!("[server] terminated: {status:?}")
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn kill_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerChild>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                // PyInstaller onefile: exe menjalankan proses anak dengan nama sama.
                // child.kill() hanya mematikan bootloader — pakai taskkill /T untuk
                // membunuh seluruh pohon proses.
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &child.pid().to_string()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                }
                #[cfg(not(windows))]
                let _ = child.kill();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_external])
        .setup(|app| {
            spawn_server(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal menjalankan aplikasi Tauri");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => kill_server(app_handle),
        tauri::RunEvent::Exit => kill_server(app_handle),
        _ => {}
    });
}
