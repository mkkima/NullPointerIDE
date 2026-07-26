use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{ipc::Channel, State};

const MAX_TERMINAL_SESSIONS: usize = 8;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MIN_TERMINAL_ROWS: u16 = 2;
const MAX_TERMINAL_ROWS: u16 = 500;
const MIN_TERMINAL_COLS: u16 = 2;
const MAX_TERMINAL_COLS: u16 = 1_000;

type TerminalResult<T> = Result<T, TerminalError>;

#[derive(Debug, Serialize)]
pub struct TerminalError {
    code: &'static str,
    message: String,
}

impl TerminalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn internal(context: &str, error: impl std::fmt::Display) -> Self {
        Self::new("terminal_error", format!("{context}: {error}"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalShell {
    Default,
    PowershellCore,
    WindowsPowershell,
    CommandPrompt,
    Bash,
    Zsh,
}

impl TerminalShell {
    fn id(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::PowershellCore => "powershell-core",
            Self::WindowsPowershell => "windows-powershell",
            Self::CommandPrompt => "command-prompt",
            Self::Bash => "bash",
            Self::Zsh => "zsh",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Default => "Default shell",
            Self::PowershellCore => "PowerShell",
            Self::WindowsPowershell => "Windows PowerShell",
            Self::CommandPrompt => "Command Prompt",
            Self::Bash => "Bash",
            Self::Zsh => "Zsh",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: String },
    Exit { code: u32, signal: Option<String> },
    Error { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    id: u64,
    shell: &'static str,
    label: &'static str,
    cwd: String,
    process_id: Option<u32>,
}

struct TerminalSession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl TerminalSession {
    fn terminate(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<u64, Arc<TerminalSession>>>>,
    next_id: AtomicU64,
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for session in sessions {
            session.terminate();
        }
    }
}

#[tauri::command]
pub fn terminal_start(
    shell: TerminalShell,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    on_event: Channel<TerminalEvent>,
    state: State<'_, TerminalManager>,
) -> TerminalResult<TerminalInfo> {
    validate_dimensions(rows, cols)?;
    let cwd = resolve_cwd(cwd.as_deref())?;

    {
        let sessions = state.sessions.lock().map_err(|_| {
            TerminalError::new("terminal_unavailable", "Terminal manager is unavailable.")
        })?;
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(TerminalError::new(
                "terminal_limit",
                format!("At most {MAX_TERMINAL_SESSIONS} terminal sessions can run at once."),
            ));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::internal("Failed to create terminal", error))?;

    let mut command = build_command(shell)?;
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair.slave.spawn_command(command).map_err(|error| {
        TerminalError::new(
            "shell_unavailable",
            format!("Could not start {}: {error}", shell.label()),
        )
    })?;
    drop(pair.slave);

    let process_id = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| TerminalError::internal("Failed to connect terminal output", error))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| TerminalError::internal("Failed to connect terminal input", error))?;

    let id = state
        .next_id
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    let session = Arc::new(TerminalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
    });

    state
        .sessions
        .lock()
        .map_err(|_| {
            TerminalError::new("terminal_unavailable", "Terminal manager is unavailable.")
        })?
        .insert(id, session);

    let output_channel = on_event.clone();
    let reader_thread = thread::Builder::new()
        .name(format!("terminal-{id}-output"))
        .spawn(move || {
            let mut buffer = vec![0_u8; 16 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if output_channel
                            .send(TerminalEvent::Output {
                                data: BASE64_STANDARD.encode(&buffer[..read]),
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        let _ = output_channel.send(TerminalEvent::Error {
                            message: format!("Terminal output stopped: {error}"),
                        });
                        break;
                    }
                }
            }
        });

    if let Err(error) = reader_thread {
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(session) = sessions.remove(&id) {
                session.terminate();
            }
        }
        return Err(TerminalError::internal(
            "Failed to start terminal output worker",
            error,
        ));
    }

    let sessions = Arc::clone(&state.sessions);
    thread::Builder::new()
        .name(format!("terminal-{id}-wait"))
        .spawn(move || {
            let event = match child.wait() {
                Ok(status) => TerminalEvent::Exit {
                    code: status.exit_code(),
                    signal: status.signal().map(str::to_owned),
                },
                Err(error) => TerminalEvent::Error {
                    message: format!("Failed to wait for terminal process: {error}"),
                },
            };
            let _ = on_event.send(event);
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&id);
            }
        })
        .map_err(|error| {
            if let Ok(mut sessions) = state.sessions.lock() {
                if let Some(session) = sessions.remove(&id) {
                    session.terminate();
                }
            }
            TerminalError::internal("Failed to start terminal process worker", error)
        })?;

    Ok(TerminalInfo {
        id,
        shell: shell.id(),
        label: shell.label(),
        cwd: display_path(&cwd),
        process_id,
    })
}

#[tauri::command]
pub fn terminal_write(
    id: u64,
    data: String,
    state: State<'_, TerminalManager>,
) -> TerminalResult<()> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(TerminalError::new(
            "terminal_input_too_large",
            "Terminal input chunk is too large.",
        ));
    }
    if data.is_empty() {
        return Ok(());
    }

    let session = get_session(&state, id)?;
    let mut writer = session.writer.lock().map_err(|_| {
        TerminalError::new("terminal_unavailable", "Terminal input is unavailable.")
    })?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| TerminalError::internal("Failed to write to terminal", error))
}

#[tauri::command]
pub fn terminal_resize(
    id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, TerminalManager>,
) -> TerminalResult<()> {
    validate_dimensions(rows, cols)?;
    let session = get_session(&state, id)?;
    let master = session.master.lock().map_err(|_| {
        TerminalError::new("terminal_unavailable", "Terminal resize is unavailable.")
    })?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::internal("Failed to resize terminal", error))
}

#[tauri::command]
pub fn terminal_kill(id: u64, state: State<'_, TerminalManager>) -> TerminalResult<()> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| {
            TerminalError::new("terminal_unavailable", "Terminal manager is unavailable.")
        })?
        .remove(&id);
    if let Some(session) = session {
        session.terminate();
    }
    Ok(())
}

fn get_session(
    state: &State<'_, TerminalManager>,
    id: u64,
) -> TerminalResult<Arc<TerminalSession>> {
    state
        .sessions
        .lock()
        .map_err(|_| {
            TerminalError::new("terminal_unavailable", "Terminal manager is unavailable.")
        })?
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            TerminalError::new("terminal_not_found", "Terminal session has already exited.")
        })
}

fn validate_dimensions(rows: u16, cols: u16) -> TerminalResult<()> {
    if !(MIN_TERMINAL_ROWS..=MAX_TERMINAL_ROWS).contains(&rows)
        || !(MIN_TERMINAL_COLS..=MAX_TERMINAL_COLS).contains(&cols)
    {
        return Err(TerminalError::new(
            "invalid_terminal_size",
            format!(
                "Terminal size must be between {MIN_TERMINAL_COLS}x{MIN_TERMINAL_ROWS} and {MAX_TERMINAL_COLS}x{MAX_TERMINAL_ROWS}."
            ),
        ));
    }
    Ok(())
}

fn resolve_cwd(cwd: Option<&str>) -> TerminalResult<PathBuf> {
    let path = match cwd {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => std::env::current_dir().map_err(|error| {
            TerminalError::internal("Could not determine terminal folder", error)
        })?,
    };
    let canonical = fs::canonicalize(&path).map_err(|error| {
        TerminalError::new(
            "invalid_terminal_cwd",
            format!("Terminal folder is unavailable: {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(TerminalError::new(
            "invalid_terminal_cwd",
            "Terminal working directory must be a folder.",
        ));
    }
    Ok(canonical)
}

fn build_command(shell: TerminalShell) -> TerminalResult<CommandBuilder> {
    #[cfg(windows)]
    {
        let mut command = match shell {
            TerminalShell::Default => {
                if executable_on_path("pwsh.exe") {
                    CommandBuilder::new("pwsh.exe")
                } else {
                    CommandBuilder::new("powershell.exe")
                }
            }
            TerminalShell::PowershellCore => CommandBuilder::new("pwsh.exe"),
            TerminalShell::WindowsPowershell => CommandBuilder::new("powershell.exe"),
            TerminalShell::CommandPrompt => CommandBuilder::new("cmd.exe"),
            TerminalShell::Bash => CommandBuilder::new("bash.exe"),
            TerminalShell::Zsh => CommandBuilder::new("zsh.exe"),
        };
        if matches!(
            shell,
            TerminalShell::Default
                | TerminalShell::PowershellCore
                | TerminalShell::WindowsPowershell
        ) {
            command.arg("-NoLogo");
        }
        Ok(command)
    }

    #[cfg(not(windows))]
    {
        let command = match shell {
            TerminalShell::Default => CommandBuilder::new_default_prog(),
            TerminalShell::Bash => CommandBuilder::new("bash"),
            TerminalShell::Zsh => CommandBuilder::new("zsh"),
            TerminalShell::PowershellCore => CommandBuilder::new("pwsh"),
            TerminalShell::WindowsPowershell | TerminalShell::CommandPrompt => {
                return Err(TerminalError::new(
                    "unsupported_shell",
                    "This shell is only available on Windows.",
                ));
            }
        };
        Ok(command)
    }
}

#[cfg(windows)]
fn executable_on_path(name: &str) -> bool {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 {
        return candidate.is_file();
    }
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|directory| directory.join(name))
                .any(|executable| executable.is_file())
        })
        .unwrap_or(false)
}

fn display_path(path: &Path) -> String {
    let display = path.to_string_lossy();
    #[cfg(windows)]
    {
        return display
            .strip_prefix(r"\\?\UNC\")
            .map(|value| format!(r"\\{value}"))
            .or_else(|| display.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| display.into_owned());
    }
    #[cfg(not(windows))]
    {
        display.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unreasonable_terminal_sizes() {
        assert!(validate_dimensions(1, 80).is_err());
        assert!(validate_dimensions(24, 1).is_err());
        assert!(validate_dimensions(24, 80).is_ok());
        assert!(validate_dimensions(500, 1_000).is_ok());
    }

    #[test]
    fn rejects_a_file_as_terminal_working_directory() {
        let directory = tempfile::tempdir().expect("temp directory should be created");
        let file = directory.path().join("file.txt");
        fs::write(&file, b"fixture").expect("fixture should be written");
        assert!(resolve_cwd(file.to_str()).is_err());
    }

    #[test]
    fn shell_identifiers_are_stable() {
        assert_eq!(TerminalShell::Default.id(), "default");
        assert_eq!(TerminalShell::PowershellCore.id(), "powershell-core");
        assert_eq!(TerminalShell::CommandPrompt.id(), "command-prompt");
    }
}
