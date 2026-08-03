use serde::Serialize;
#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::State;

const TOOL_TIMEOUT: Duration = Duration::from_secs(8);
const ADB_PROPERTY_TIMEOUT: Duration = Duration::from_secs(3);
const PENDING_LAUNCH_TTL: Duration = Duration::from_secs(180);
const MAX_AVDS: usize = 256;
const MAX_DEVICES: usize = 128;
const MAX_AVD_NAME_BYTES: usize = 160;
const MAX_TOOL_MESSAGE_BYTES: usize = 600;
const MAX_INI_BYTES: u64 = 1024 * 1024;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type EmulatorResult<T> = Result<T, EmulatorError>;

#[derive(Debug, Serialize)]
pub struct EmulatorError {
    code: &'static str,
    message: String,
}

impl EmulatorError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Default)]
struct EmulatorShared {
    operation: Mutex<()>,
    pending_launches: Mutex<HashMap<String, Instant>>,
}

#[derive(Default)]
pub struct EmulatorManager {
    shared: Arc<EmulatorShared>,
}

#[derive(Clone, Debug)]
struct AndroidTools {
    sdk_root: Option<PathBuf>,
    adb: Option<PathBuf>,
    emulator: Option<PathBuf>,
}

#[derive(Clone, Debug, Default)]
struct AvdMetadata {
    display_name: Option<String>,
    target: Option<String>,
    abi: Option<String>,
    device: Option<String>,
    resolution: Option<String>,
    play_store: bool,
}

#[derive(Clone, Debug)]
struct ConnectedDevice {
    serial: String,
    state: String,
    model: Option<String>,
    product: Option<String>,
    device: Option<String>,
    is_emulator: bool,
    avd_name: Option<String>,
    booted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorSnapshot {
    sdk_root: Option<String>,
    adb_available: bool,
    emulator_available: bool,
    avds: Vec<AndroidAvd>,
    devices: Vec<AndroidDevice>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAvd {
    name: String,
    display_name: String,
    target: Option<String>,
    abi: Option<String>,
    device: Option<String>,
    resolution: Option<String>,
    play_store: bool,
    status: AndroidAvdStatus,
    serial: Option<String>,
    model: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AndroidAvdStatus {
    Stopped,
    Starting,
    Running,
    Offline,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    serial: String,
    state: String,
    model: Option<String>,
    product: Option<String>,
    device: Option<String>,
    is_emulator: bool,
    avd_name: Option<String>,
}

struct ToolOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[tauri::command]
pub async fn get_android_emulators(
    state: State<'_, EmulatorManager>,
) -> EmulatorResult<AndroidEmulatorSnapshot> {
    run_serialized(&state, build_snapshot).await
}

#[tauri::command]
pub async fn launch_android_emulator(
    name: String,
    cold_boot: bool,
    state: State<'_, EmulatorManager>,
) -> EmulatorResult<AndroidEmulatorSnapshot> {
    run_serialized(&state, move |shared| {
        launch_avd(shared, &name, cold_boot)?;
        build_snapshot(shared)
    })
    .await
}

#[tauri::command]
pub async fn stop_android_emulator(
    serial: String,
    state: State<'_, EmulatorManager>,
) -> EmulatorResult<AndroidEmulatorSnapshot> {
    run_serialized(&state, move |shared| {
        stop_emulator(shared, &serial)?;
        build_snapshot(shared)
    })
    .await
}

#[tauri::command]
pub async fn reboot_android_emulator(
    serial: String,
    state: State<'_, EmulatorManager>,
) -> EmulatorResult<AndroidEmulatorSnapshot> {
    run_serialized(&state, move |shared| {
        reboot_emulator(shared, &serial)?;
        build_snapshot(shared)
    })
    .await
}

async fn run_serialized<T, F>(state: &State<'_, EmulatorManager>, task: F) -> EmulatorResult<T>
where
    T: Send + 'static,
    F: FnOnce(&EmulatorShared) -> EmulatorResult<T> + Send + 'static,
{
    let shared = Arc::clone(&state.shared);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = shared.operation.lock().map_err(|_| {
            EmulatorError::new("emulator_unavailable", "Emulator manager is unavailable.")
        })?;
        task(&shared)
    })
    .await
    .map_err(|error| {
        EmulatorError::new(
            "emulator_task_error",
            format!("The emulator task failed: {error}"),
        )
    })?
}

fn build_snapshot(shared: &EmulatorShared) -> EmulatorResult<AndroidEmulatorSnapshot> {
    let tools = discover_android_tools();
    let mut warnings = Vec::new();

    if tools.sdk_root.is_none() {
        warnings.push(
            "Android SDK root was not found. Set ANDROID_SDK_ROOT or install Android Studio."
                .to_owned(),
        );
    }
    if tools.emulator.is_none() {
        warnings.push("Android Emulator is not installed in the selected SDK.".to_owned());
    }
    if tools.adb.is_none() {
        warnings.push("ADB is unavailable. Install Android SDK Platform-Tools.".to_owned());
    }

    let avd_names = match tools.emulator.as_deref() {
        Some(emulator) => match list_avds(emulator, tools.sdk_root.as_deref()) {
            Ok(names) => names,
            Err(error) => {
                warnings.push(error.message);
                Vec::new()
            }
        },
        None => Vec::new(),
    };
    let connected = match tools.adb.as_deref() {
        Some(adb) => match connected_devices(adb, tools.sdk_root.as_deref()) {
            Ok(devices) => devices,
            Err(error) => {
                warnings.push(error.message);
                Vec::new()
            }
        },
        None => Vec::new(),
    };

    let mut pending = shared.pending_launches.lock().map_err(|_| {
        EmulatorError::new(
            "emulator_unavailable",
            "Emulator launch state is unavailable.",
        )
    })?;
    pending.retain(|_, started| started.elapsed() < PENDING_LAUNCH_TTL);

    let mut avds = Vec::with_capacity(avd_names.len());
    for name in avd_names {
        let running = connected
            .iter()
            .find(|device| device.avd_name.as_deref() == Some(name.as_str()));
        if running.is_some() {
            pending.remove(&name);
        }
        let status = match running {
            Some(device) if device.state != "device" => AndroidAvdStatus::Offline,
            Some(device) if device.booted => AndroidAvdStatus::Running,
            Some(_) => AndroidAvdStatus::Starting,
            None if pending.contains_key(&name) => AndroidAvdStatus::Starting,
            None => AndroidAvdStatus::Stopped,
        };
        let metadata = read_avd_metadata(&name);
        avds.push(AndroidAvd {
            display_name: metadata
                .display_name
                .clone()
                .unwrap_or_else(|| name.replace('_', " ")),
            name,
            target: metadata.target,
            abi: metadata.abi,
            device: metadata.device,
            resolution: metadata.resolution,
            play_store: metadata.play_store,
            status,
            serial: running.map(|device| device.serial.clone()),
            model: running.and_then(|device| device.model.clone()),
        });
    }
    avds.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });

    let devices = connected
        .into_iter()
        .map(|device| AndroidDevice {
            serial: device.serial,
            state: device.state,
            model: device.model,
            product: device.product,
            device: device.device,
            is_emulator: device.is_emulator,
            avd_name: device.avd_name,
        })
        .collect();

    Ok(AndroidEmulatorSnapshot {
        sdk_root: tools.sdk_root.as_deref().map(display_path),
        adb_available: tools.adb.is_some(),
        emulator_available: tools.emulator.is_some(),
        avds,
        devices,
        warnings,
    })
}

fn launch_avd(shared: &EmulatorShared, name: &str, cold_boot: bool) -> EmulatorResult<()> {
    validate_avd_name(name)?;
    let tools = discover_android_tools();
    let emulator = tools.emulator.as_deref().ok_or_else(|| {
        EmulatorError::new(
            "emulator_not_found",
            "Android Emulator is not installed or could not be found.",
        )
    })?;
    let installed = list_avds(emulator, tools.sdk_root.as_deref())?;
    if !installed.iter().any(|candidate| candidate == name) {
        return Err(EmulatorError::new(
            "avd_not_found",
            "The selected Android virtual device is no longer installed.",
        ));
    }

    if let Some(adb) = tools.adb.as_deref() {
        let devices = connected_devices(adb, tools.sdk_root.as_deref()).unwrap_or_default();
        if devices
            .iter()
            .any(|device| device.avd_name.as_deref() == Some(name))
        {
            return Err(EmulatorError::new(
                "avd_already_running",
                "The selected Android virtual device is already running.",
            ));
        }
    }

    let mut command = Command::new(emulator);
    command.arg("-avd").arg(name);
    if cold_boot {
        command.arg("-no-snapshot-load");
    }
    configure_android_command(&mut command, tools.sdk_root.as_deref());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| {
        EmulatorError::new(
            "emulator_launch_failed",
            format!("Could not start the Android emulator: {error}"),
        )
    })?;
    let process_id = child.id();
    let _ = thread::Builder::new()
        .name(format!("android-emulator-{process_id}-wait"))
        .spawn(move || {
            let _ = child.wait();
        });

    shared
        .pending_launches
        .lock()
        .map_err(|_| {
            EmulatorError::new(
                "emulator_unavailable",
                "Emulator launch state is unavailable.",
            )
        })?
        .insert(name.to_owned(), Instant::now());
    Ok(())
}

fn stop_emulator(shared: &EmulatorShared, serial: &str) -> EmulatorResult<()> {
    let tools = discover_android_tools();
    let adb = tools.adb.as_deref().ok_or_else(|| {
        EmulatorError::new(
            "adb_not_found",
            "ADB is not installed or could not be found.",
        )
    })?;
    let device = require_running_emulator(adb, tools.sdk_root.as_deref(), serial)?;
    let output = run_tool(
        adb,
        ["-s", serial, "emu", "kill"],
        tools.sdk_root.as_deref(),
        TOOL_TIMEOUT,
    )?;
    ensure_success("Could not stop the Android emulator", output)?;
    if let Some(name) = device.avd_name {
        shared
            .pending_launches
            .lock()
            .map_err(|_| {
                EmulatorError::new(
                    "emulator_unavailable",
                    "Emulator launch state is unavailable.",
                )
            })?
            .remove(&name);
    }
    Ok(())
}

fn reboot_emulator(shared: &EmulatorShared, serial: &str) -> EmulatorResult<()> {
    let tools = discover_android_tools();
    let adb = tools.adb.as_deref().ok_or_else(|| {
        EmulatorError::new(
            "adb_not_found",
            "ADB is not installed or could not be found.",
        )
    })?;
    let device = require_running_emulator(adb, tools.sdk_root.as_deref(), serial)?;
    let output = run_tool(
        adb,
        ["-s", serial, "reboot"],
        tools.sdk_root.as_deref(),
        TOOL_TIMEOUT,
    )?;
    ensure_success("Could not reboot the Android emulator", output)?;
    if let Some(name) = device.avd_name {
        shared
            .pending_launches
            .lock()
            .map_err(|_| {
                EmulatorError::new(
                    "emulator_unavailable",
                    "Emulator launch state is unavailable.",
                )
            })?
            .insert(name, Instant::now());
    }
    Ok(())
}

fn require_running_emulator(
    adb: &Path,
    sdk_root: Option<&Path>,
    serial: &str,
) -> EmulatorResult<ConnectedDevice> {
    validate_emulator_serial(serial)?;
    connected_devices(adb, sdk_root)?
        .into_iter()
        .find(|device| device.serial == serial && device.is_emulator)
        .ok_or_else(|| {
            EmulatorError::new(
                "emulator_not_running",
                "The selected Android emulator is no longer connected.",
            )
        })
}

fn discover_android_tools() -> AndroidTools {
    let mut sdk_candidates = Vec::new();
    push_env_path(&mut sdk_candidates, "ANDROID_SDK_ROOT");
    push_env_path(&mut sdk_candidates, "ANDROID_HOME");
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        sdk_candidates.push(PathBuf::from(local_app_data).join("Android").join("Sdk"));
    }
    if let Some(home) = user_home() {
        sdk_candidates.push(home.join("Library").join("Android").join("sdk"));
        sdk_candidates.push(home.join("Android").join("Sdk"));
    }

    let sdk_root = sdk_candidates.into_iter().find_map(|candidate| {
        let canonical = fs::canonicalize(candidate).ok()?;
        let root = command_compatible_path(&canonical);
        let contains_tools = sdk_adb_path(&root).is_file() || sdk_emulator_path(&root).is_file();
        (root.is_dir() && contains_tools).then_some(root)
    });
    let adb = sdk_root
        .as_deref()
        .map(sdk_adb_path)
        .filter(|path| path.is_file())
        .or_else(|| executable_on_path(adb_executable_name()));
    let emulator = sdk_root
        .as_deref()
        .map(sdk_emulator_path)
        .filter(|path| path.is_file())
        .or_else(|| executable_on_path(emulator_executable_name()));

    AndroidTools {
        sdk_root,
        adb,
        emulator,
    }
}

pub(crate) fn android_platform_tools_directory() -> Option<PathBuf> {
    discover_android_tools()
        .adb
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn list_avds(emulator: &Path, sdk_root: Option<&Path>) -> EmulatorResult<Vec<String>> {
    let output = run_tool(emulator, ["-list-avds"], sdk_root, TOOL_TIMEOUT)?;
    ensure_success("Could not list Android virtual devices", output)
        .map(|output| parse_avd_list(&String::from_utf8_lossy(&output.stdout)))
}

fn connected_devices(adb: &Path, sdk_root: Option<&Path>) -> EmulatorResult<Vec<ConnectedDevice>> {
    let output = run_tool(adb, ["devices", "-l"], sdk_root, TOOL_TIMEOUT)?;
    let output = ensure_success("Could not list Android devices", output)?;
    let mut devices = parse_adb_devices(&String::from_utf8_lossy(&output.stdout));
    for device in devices.iter_mut().filter(|device| device.is_emulator) {
        device.avd_name = query_avd_name(adb, sdk_root, &device.serial);
        if device.state == "device" {
            device.booted = query_boot_completed(adb, sdk_root, &device.serial);
        }
    }
    Ok(devices)
}

fn query_avd_name(adb: &Path, sdk_root: Option<&Path>, serial: &str) -> Option<String> {
    let output = run_tool(
        adb,
        ["-s", serial, "emu", "avd", "name"],
        sdk_root,
        ADB_PROPERTY_TIMEOUT,
    )
    .ok()?;
    if !output.success {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "OK" && is_safe_avd_name(line))
        .map(str::to_owned)
}

fn query_boot_completed(adb: &Path, sdk_root: Option<&Path>, serial: &str) -> bool {
    run_tool(
        adb,
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        sdk_root,
        ADB_PROPERTY_TIMEOUT,
    )
    .ok()
    .filter(|output| output.success)
    .is_some_and(|output| String::from_utf8_lossy(&output.stdout).trim() == "1")
}

fn parse_avd_list(output: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.is_empty() || !is_safe_avd_name(line) || names.iter().any(|name| name == line) {
            continue;
        }
        names.push(line.to_owned());
        if names.len() >= MAX_AVDS {
            break;
        }
    }
    names
}

fn parse_adb_devices(output: &str) -> Vec<ConnectedDevice> {
    let mut devices = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("List of devices attached") || line.starts_with('*')
        {
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(serial) = fields.next() else {
            continue;
        };
        let Some(state) = fields.next() else {
            continue;
        };
        if serial.len() > 160 || serial.chars().any(char::is_control) {
            continue;
        }
        let properties = fields
            .filter_map(|field| field.split_once(':'))
            .collect::<HashMap<_, _>>();
        devices.push(ConnectedDevice {
            serial: serial.to_owned(),
            state: state.to_owned(),
            model: properties.get("model").map(|value| (*value).to_owned()),
            product: properties.get("product").map(|value| (*value).to_owned()),
            device: properties.get("device").map(|value| (*value).to_owned()),
            is_emulator: serial.starts_with("emulator-"),
            avd_name: None,
            booted: false,
        });
        if devices.len() >= MAX_DEVICES {
            break;
        }
    }
    devices
}

fn read_avd_metadata(name: &str) -> AvdMetadata {
    let Some(avd_root) = android_avd_home() else {
        return AvdMetadata::default();
    };
    let Ok(entries) = fs::read_dir(avd_root) else {
        return AvdMetadata::default();
    };
    let ini_path = entries.flatten().map(|entry| entry.path()).find(|path| {
        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("ini"))
            && path.file_stem().is_some_and(|stem| stem == name)
    });
    let Some(ini_path) = ini_path else {
        return AvdMetadata::default();
    };
    let ini = read_ini(&ini_path);
    let config_path = ini
        .get("path")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .map(|path| path.join("config.ini"));
    let config = config_path.as_deref().map(read_ini).unwrap_or_default();
    let width = config.get("hw.lcd.width").filter(|value| is_decimal(value));
    let height = config
        .get("hw.lcd.height")
        .filter(|value| is_decimal(value));

    AvdMetadata {
        display_name: config.get("avd.ini.displayname").cloned(),
        target: config.get("target").or_else(|| ini.get("target")).cloned(),
        abi: config
            .get("abi.type")
            .or_else(|| config.get("hw.cpu.arch"))
            .cloned(),
        device: config.get("hw.device.name").cloned(),
        resolution: width
            .zip(height)
            .map(|(width, height)| format!("{width} × {height}")),
        play_store: config
            .get("PlayStore.enabled")
            .is_some_and(|value| value.eq_ignore_ascii_case("true")),
    }
}

fn read_ini(path: &Path) -> HashMap<String, String> {
    let Ok(metadata) = fs::metadata(path) else {
        return HashMap::new();
    };
    if !metadata.is_file() || metadata.len() > MAX_INI_BYTES {
        return HashMap::new();
    }
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            let value = value.trim();
            (!key.is_empty() && value.len() <= 4096).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn run_tool<const N: usize>(
    program: &Path,
    arguments: [&str; N],
    sdk_root: Option<&Path>,
    timeout: Duration,
) -> EmulatorResult<ToolOutput> {
    let mut command = Command::new(program);
    command.args(arguments);
    configure_android_command(&mut command, sdk_root);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        EmulatorError::new(
            "android_tool_failed",
            format!("Could not start {}: {error}", program.display()),
        )
    })?;
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EmulatorError::new(
                    "android_tool_timeout",
                    format!("{} did not respond in time.", program.display()),
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(EmulatorError::new(
                    "android_tool_failed",
                    format!("Could not wait for {}: {error}", program.display()),
                ));
            }
        }
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout).map_err(|error| {
            EmulatorError::new(
                "android_tool_failed",
                format!("Could not read Android tool output: {error}"),
            )
        })?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr).map_err(|error| {
            EmulatorError::new(
                "android_tool_failed",
                format!("Could not read Android tool errors: {error}"),
            )
        })?;
    }
    Ok(ToolOutput {
        success,
        stdout,
        stderr,
    })
}

fn ensure_success(context: &str, output: ToolOutput) -> EmulatorResult<ToolOutput> {
    if output.success {
        return Ok(output);
    }
    let stderr = bounded_message(&output.stderr);
    let stdout = bounded_message(&output.stdout);
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(EmulatorError::new(
        "android_tool_failed",
        if detail.is_empty() {
            context.to_owned()
        } else {
            format!("{context}: {detail}")
        },
    ))
}

fn configure_android_command(command: &mut Command, sdk_root: Option<&Path>) {
    if let Some(root) = sdk_root {
        command
            .env("ANDROID_SDK_ROOT", root)
            .env("ANDROID_HOME", root);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn validate_avd_name(name: &str) -> EmulatorResult<()> {
    if !is_safe_avd_name(name) {
        return Err(EmulatorError::new(
            "invalid_avd_name",
            "The Android virtual device name is invalid.",
        ));
    }
    Ok(())
}

fn is_safe_avd_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= MAX_AVD_NAME_BYTES
        && !name.contains(['/', '\\', '\0', '\r', '\n'])
}

fn validate_emulator_serial(serial: &str) -> EmulatorResult<()> {
    let valid = serial
        .strip_prefix("emulator-")
        .is_some_and(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()));
    if !valid {
        return Err(EmulatorError::new(
            "invalid_emulator_serial",
            "The Android emulator identifier is invalid.",
        ));
    }
    Ok(())
}

fn bounded_message(bytes: &[u8]) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_TOOL_MESSAGE_BYTES)])
        .trim()
        .to_owned()
}

fn is_decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn push_env_path(paths: &mut Vec<PathBuf>, name: &str) {
    if let Some(value) = env::var_os(name).filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value));
    }
}

fn user_home() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn android_avd_home() -> Option<PathBuf> {
    env::var_os("ANDROID_AVD_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("ANDROID_USER_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|path| path.join("avd"))
        })
        .or_else(|| user_home().map(|path| path.join(".android").join("avd")))
}

fn executable_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

fn sdk_adb_path(root: &Path) -> PathBuf {
    root.join("platform-tools").join(adb_executable_name())
}

fn sdk_emulator_path(root: &Path) -> PathBuf {
    root.join("emulator").join(emulator_executable_name())
}

fn adb_executable_name() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

fn emulator_executable_name() -> &'static str {
    if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    }
}

fn display_path(path: &Path) -> String {
    let display = path.to_string_lossy();
    #[cfg(windows)]
    {
        display
            .strip_prefix(r"\\?\UNC\")
            .map(|value| format!(r"\\{value}"))
            .or_else(|| display.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| display.into_owned())
    }
    #[cfg(not(windows))]
    {
        display.into_owned()
    }
}

fn command_compatible_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};

        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return path.to_path_buf();
        };
        let mut normalized = match prefix.kind() {
            Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:\\", char::from(drive))),
            Prefix::VerbatimUNC(server, share) => {
                let mut root = OsString::from(r"\\");
                root.push(server);
                root.push(r"\");
                root.push(share);
                PathBuf::from(root)
            }
            _ => return path.to_path_buf(),
        };
        for component in components {
            if !matches!(component, Component::RootDir) {
                normalized.push(component.as_os_str());
            }
        }
        normalized
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_deduplicates_bounded_avd_names() {
        let names = parse_avd_list("Pixel_8\nPixel_Tablet\nPixel_8\n../escape\n\n");
        assert_eq!(names, vec!["Pixel_8", "Pixel_Tablet"]);
    }

    #[test]
    fn parses_adb_devices_without_treating_the_header_as_a_device() {
        let output = "List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 device:emu transport_id:1\nphone offline transport_id:2\n";
        let devices = parse_adb_devices(output);

        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "emulator-5554");
        assert!(devices[0].is_emulator);
        assert_eq!(devices[0].model.as_deref(), Some("Pixel_8"));
        assert_eq!(devices[1].state, "offline");
    }

    #[test]
    fn rejects_unsafe_avd_names_and_non_emulator_serials() {
        assert!(validate_avd_name("Pixel_10_Pro").is_ok());
        assert!(validate_avd_name("../Pixel").is_err());
        assert!(validate_avd_name("Pixel\nInjected").is_err());
        assert!(validate_emulator_serial("emulator-5554").is_ok());
        assert!(validate_emulator_serial("device-5554").is_err());
        assert!(validate_emulator_serial("emulator-5554 --help").is_err());
    }

    #[test]
    fn parses_bounded_ini_values() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("config.ini");
        fs::write(&path, "target=android-36\nabi.type=x86_64\ninvalid\n")
            .expect("fixture should be written");

        let values = read_ini(&path);
        assert_eq!(values.get("target").map(String::as_str), Some("android-36"));
        assert_eq!(values.get("abi.type").map(String::as_str), Some("x86_64"));
        assert!(!values.contains_key("invalid"));
    }

    #[cfg(windows)]
    #[test]
    fn removes_windows_verbatim_prefixes_from_android_tool_paths() {
        assert_eq!(
            command_compatible_path(Path::new(r"\\?\C:\Android\Sdk")),
            PathBuf::from(r"C:\Android\Sdk")
        );
        assert_eq!(
            command_compatible_path(Path::new(r"\\?\UNC\server\sdk\Android")),
            PathBuf::from(r"\\server\sdk\Android")
        );
    }
}
