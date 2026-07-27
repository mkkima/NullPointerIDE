use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const HELPER_ARGUMENT: &str = "--portable-update-helper";
const HEALTH_ARGUMENT: &str = "--portable-update-health";
const PORTABLE_MARKER_NAME: &str = "portable.flag";
const PORTABLE_DATA_DIRECTORY: &str = "data";
const UPDATE_DIRECTORY: &str = "updates";
const STAGED_EXECUTABLE_NAME: &str = "NullPointer.exe.next";
const HELPER_EXECUTABLE_NAME: &str = "NullPointer-update-helper.exe";
const BACKUP_EXECUTABLE_NAME: &str = "NullPointer.exe.backup";
const HEALTH_FILE_NAME: &str = "ready";
const COMPLETED_FILE_NAME: &str = "completed";
const LOG_FILE_NAME: &str = "updater.log";
const FAILED_FILE_NAME: &str = "failed";
const MIN_EXECUTABLE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_EXECUTABLE_BYTES: usize = 128 * 1024 * 1024;
const FILE_OPERATION_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_INTERVAL: Duration = Duration::from_millis(100);
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
pub(crate) struct PortableUpdateError(String);

impl std::fmt::Display for PortableUpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PortableUpdateError {}

impl PortableUpdateError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    fn io(context: &str, error: std::io::Error) -> Self {
        Self::new(format!("{context}: {error}"))
    }
}

#[derive(Debug)]
struct HelperPlan {
    root: PathBuf,
    staged_executable: PathBuf,
    target_executable: PathBuf,
    health_file: PathBuf,
    completed_file: PathBuf,
    log_file: PathBuf,
    session_directory: PathBuf,
}

impl HelperPlan {
    fn parse(arguments: &[OsString]) -> Result<Self, PortableUpdateError> {
        if arguments.len() != 7 || arguments[0] != HELPER_ARGUMENT {
            return Err(PortableUpdateError::new(
                "The portable update helper received invalid arguments.",
            ));
        }

        let root = canonical_directory(Path::new(&arguments[1]), "portable root")?;
        if !root.join(PORTABLE_MARKER_NAME).is_file() {
            return Err(PortableUpdateError::new(
                "The portable marker is missing from the update target.",
            ));
        }

        let update_directory = canonical_directory(
            &root.join(PORTABLE_DATA_DIRECTORY).join(UPDATE_DIRECTORY),
            "update directory",
        )?;
        let staged_executable =
            canonical_file(Path::new(&arguments[2]), "staged portable executable")?;
        let session_directory = staged_executable
            .parent()
            .ok_or_else(|| PortableUpdateError::new("The update session path is invalid."))?
            .to_path_buf();
        if session_directory.parent() != Some(update_directory.as_path())
            || staged_executable.file_name() != Some(STAGED_EXECUTABLE_NAME.as_ref())
        {
            return Err(PortableUpdateError::new(
                "The staged executable is outside the portable update directory.",
            ));
        }

        let target_executable =
            canonical_file(Path::new(&arguments[3]), "current portable executable")?;
        if target_executable.parent() != Some(root.as_path()) {
            return Err(PortableUpdateError::new(
                "The executable selected for replacement is outside the portable folder.",
            ));
        }

        let health_file = validate_session_file(
            Path::new(&arguments[4]),
            &session_directory,
            HEALTH_FILE_NAME,
        )?;
        let completed_file = validate_session_file(
            Path::new(&arguments[5]),
            &session_directory,
            COMPLETED_FILE_NAME,
        )?;
        let log_file =
            validate_session_file(Path::new(&arguments[6]), &session_directory, LOG_FILE_NAME)?;

        Ok(Self {
            root,
            staged_executable,
            target_executable,
            health_file,
            completed_file,
            log_file,
            session_directory,
        })
    }
}

pub(crate) fn run_helper_if_requested() -> bool {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments
        .first()
        .is_none_or(|value| value != HELPER_ARGUMENT)
    {
        return false;
    }

    if let Ok(plan) = HelperPlan::parse(&arguments) {
        append_log(&plan.log_file, "Portable update helper started.");
        if let Err(error) = execute_helper(&plan) {
            append_log(&plan.log_file, &format!("Update failed: {error}"));
            let _ = write_marker(
                &plan.session_directory.join(FAILED_FILE_NAME),
                error.to_string().as_bytes(),
            );
        }
    }
    true
}

pub(crate) fn stage_and_launch(
    portable_root: &Path,
    executable_bytes: &[u8],
    version: &str,
) -> Result<(), PortableUpdateError> {
    validate_portable_executable(executable_bytes)?;

    let root = canonical_directory(portable_root, "portable root")?;
    if !root.join(PORTABLE_MARKER_NAME).is_file() {
        return Err(PortableUpdateError::new(
            "The portable marker is missing from the application folder.",
        ));
    }

    let current_executable = canonical_file(
        &std::env::current_exe()
            .map_err(|error| PortableUpdateError::io("Could not locate NullPointer", error))?,
        "current executable",
    )?;
    if current_executable.parent() != Some(root.as_path()) {
        return Err(PortableUpdateError::new(
            "The running executable is outside the portable folder.",
        ));
    }

    let update_directory = root.join(PORTABLE_DATA_DIRECTORY).join(UPDATE_DIRECTORY);
    fs::create_dir_all(&update_directory)
        .map_err(|error| PortableUpdateError::io("Could not create the update directory", error))?;
    cleanup_completed_sessions(&root);

    let session_directory = create_session_directory(&update_directory, version)?;
    let staged_executable = session_directory.join(STAGED_EXECUTABLE_NAME);
    let helper_executable = session_directory.join(HELPER_EXECUTABLE_NAME);
    let health_file = session_directory.join(HEALTH_FILE_NAME);
    let completed_file = session_directory.join(COMPLETED_FILE_NAME);
    let log_file = session_directory.join(LOG_FILE_NAME);

    let preparation = (|| {
        write_new_file(&staged_executable, executable_bytes)?;
        fs::copy(&current_executable, &helper_executable).map_err(|error| {
            PortableUpdateError::io("Could not prepare the portable update helper", error)
        })?;

        let mut command = Command::new(&helper_executable);
        command
            .arg(HELPER_ARGUMENT)
            .arg(&root)
            .arg(&staged_executable)
            .arg(&current_executable)
            .arg(&health_file)
            .arg(&completed_file)
            .arg(&log_file);
        configure_background_command(&mut command);
        command.spawn().map_err(|error| {
            PortableUpdateError::io("Could not start the portable update helper", error)
        })?;
        Ok(())
    })();

    if preparation.is_err() {
        let _ = fs::remove_dir_all(&session_directory);
    }
    preparation
}

pub(crate) fn health_file_argument() -> Option<PathBuf> {
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == HEALTH_ARGUMENT {
            return arguments.next().map(PathBuf::from);
        }
    }
    None
}

pub(crate) fn acknowledge_healthy_launch(portable_root: &Path, health_file: Option<PathBuf>) {
    cleanup_completed_sessions(portable_root);
    let Some(health_file) = health_file else {
        return;
    };
    let Ok((session_directory, completed_file)) = validate_health_file(portable_root, &health_file)
    else {
        return;
    };

    thread::spawn(move || {
        // Reaching Tauri setup is necessary but waiting briefly also catches immediate
        // startup failures before the previous executable is discarded.
        thread::sleep(Duration::from_millis(1_500));
        if write_marker(&health_file, b"ready").is_err() {
            return;
        }

        for _ in 0..300 {
            if completed_file.is_file() {
                thread::sleep(Duration::from_secs(1));
                remove_directory_with_retries(&session_directory);
                return;
            }
            thread::sleep(RETRY_INTERVAL);
        }
    });
}

fn execute_helper(plan: &HelperPlan) -> Result<(), PortableUpdateError> {
    let backup_executable = plan.session_directory.join(BACKUP_EXECUTABLE_NAME);
    retry_io(FILE_OPERATION_TIMEOUT, || {
        fs::rename(&plan.target_executable, &backup_executable)
    })
    .map_err(|error| {
        PortableUpdateError::io("Could not unlock the running portable executable", error)
    })?;

    if let Err(error) = fs::rename(&plan.staged_executable, &plan.target_executable) {
        let _ = fs::rename(&backup_executable, &plan.target_executable);
        return Err(PortableUpdateError::io(
            "Could not place the new portable executable",
            error,
        ));
    }

    append_log(
        &plan.log_file,
        &format!("Executable replaced in {}.", plan.root.to_string_lossy()),
    );

    let mut child = match launch_updated_application(&plan.target_executable, &plan.health_file) {
        Ok(child) => child,
        Err(error) => {
            rollback(plan, &backup_executable, None)?;
            return Err(error);
        }
    };

    match wait_for_health(&mut child, &plan.health_file) {
        Ok(()) => {
            write_marker(&plan.completed_file, b"completed")?;
            append_log(
                &plan.log_file,
                "The updated application reported a healthy launch.",
            );
            Ok(())
        }
        Err(error) => {
            rollback(plan, &backup_executable, Some(&mut child))?;
            Err(error)
        }
    }
}

fn rollback(
    plan: &HelperPlan,
    backup_executable: &Path,
    mut child: Option<&mut Child>,
) -> Result<(), PortableUpdateError> {
    if let Some(child) = child.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }

    retry_io(FILE_OPERATION_TIMEOUT, || {
        if plan.target_executable.exists() {
            fs::remove_file(&plan.target_executable)
        } else {
            Ok(())
        }
    })
    .map_err(|error| PortableUpdateError::io("Could not remove the failed update", error))?;
    retry_io(FILE_OPERATION_TIMEOUT, || {
        fs::rename(backup_executable, &plan.target_executable)
    })
    .map_err(|error| {
        PortableUpdateError::io("Could not restore the previous portable executable", error)
    })?;

    append_log(
        &plan.log_file,
        "The previous portable executable was restored.",
    );
    let mut command = Command::new(&plan.target_executable);
    configure_background_command(&mut command);
    command.spawn().map_err(|error| {
        PortableUpdateError::io(
            "The previous version was restored but could not be restarted",
            error,
        )
    })?;
    Ok(())
}

fn wait_for_health(child: &mut Child, health_file: &Path) -> Result<(), PortableUpdateError> {
    let started = std::time::Instant::now();
    while started.elapsed() < HEALTH_TIMEOUT {
        if health_file.is_file() {
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(|error| {
            PortableUpdateError::io("Could not monitor the updated application", error)
        })? {
            return Err(PortableUpdateError::new(format!(
                "The updated application exited before startup completed ({status})."
            )));
        }
        thread::sleep(RETRY_INTERVAL);
    }
    Err(PortableUpdateError::new(
        "The updated application did not confirm startup in time.",
    ))
}

fn launch_updated_application(
    executable: &Path,
    health_file: &Path,
) -> Result<Child, PortableUpdateError> {
    let mut command = Command::new(executable);
    command.arg(HEALTH_ARGUMENT).arg(health_file);
    configure_background_command(&mut command);
    command.spawn().map_err(|error| {
        PortableUpdateError::io("Could not launch the updated portable application", error)
    })
}

fn configure_background_command(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    command
}

fn validate_portable_executable(bytes: &[u8]) -> Result<(), PortableUpdateError> {
    if !(MIN_EXECUTABLE_BYTES..=MAX_EXECUTABLE_BYTES).contains(&bytes.len()) {
        return Err(PortableUpdateError::new(
            "The signed portable executable has an invalid size.",
        ));
    }
    if !bytes.starts_with(b"MZ") {
        return Err(PortableUpdateError::new(
            "The signed portable update is not a Windows executable.",
        ));
    }
    Ok(())
}

fn create_session_directory(
    update_directory: &Path,
    version: &str,
) -> Result<PathBuf, PortableUpdateError> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let safe_version = version
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let directory = update_directory.join(format!(
        "session-{safe_version}-{}-{timestamp}",
        std::process::id()
    ));
    fs::create_dir(&directory)
        .map_err(|error| PortableUpdateError::io("Could not create the update session", error))?;
    Ok(directory)
}

fn validate_health_file(
    portable_root: &Path,
    health_file: &Path,
) -> Result<(PathBuf, PathBuf), PortableUpdateError> {
    let root = canonical_directory(portable_root, "portable root")?;
    let update_directory = root.join(PORTABLE_DATA_DIRECTORY).join(UPDATE_DIRECTORY);
    let update_directory = canonical_directory(&update_directory, "update directory")?;
    let session_directory = health_file
        .parent()
        .ok_or_else(|| PortableUpdateError::new("The update health path is invalid."))?;
    let session_directory = canonical_directory(session_directory, "update session")?;
    if session_directory.parent() != Some(update_directory.as_path())
        || health_file.file_name() != Some(HEALTH_FILE_NAME.as_ref())
    {
        return Err(PortableUpdateError::new(
            "The update health file is outside the current update session.",
        ));
    }
    Ok((
        session_directory.clone(),
        session_directory.join(COMPLETED_FILE_NAME),
    ))
}

fn cleanup_completed_sessions(portable_root: &Path) {
    let update_directory = portable_root
        .join(PORTABLE_DATA_DIRECTORY)
        .join(UPDATE_DIRECTORY);
    let Ok(entries) = fs::read_dir(update_directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir()
            && !file_type.is_symlink()
            && entry.path().join(COMPLETED_FILE_NAME).is_file()
        {
            remove_directory_with_retries(&entry.path());
        }
    }
}

fn remove_directory_with_retries(directory: &Path) {
    for _ in 0..30 {
        match fs::remove_dir_all(directory) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => thread::sleep(RETRY_INTERVAL),
        }
    }
}

fn validate_session_file(
    path: &Path,
    session_directory: &Path,
    expected_name: &str,
) -> Result<PathBuf, PortableUpdateError> {
    if path.parent() != Some(session_directory) || path.file_name() != Some(expected_name.as_ref())
    {
        return Err(PortableUpdateError::new(
            "A portable update session file has an invalid path.",
        ));
    }
    Ok(path.to_path_buf())
}

fn canonical_directory(path: &Path, description: &str) -> Result<PathBuf, PortableUpdateError> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        PortableUpdateError::io(&format!("Could not locate the {description}"), error)
    })?;
    if !canonical.is_dir() {
        return Err(PortableUpdateError::new(format!(
            "The {description} is not a directory."
        )));
    }
    Ok(canonical)
}

fn canonical_file(path: &Path, description: &str) -> Result<PathBuf, PortableUpdateError> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        PortableUpdateError::io(&format!("Could not locate the {description}"), error)
    })?;
    if !canonical.is_file() {
        return Err(PortableUpdateError::new(format!(
            "The {description} is not a file."
        )));
    }
    Ok(canonical)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), PortableUpdateError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| PortableUpdateError::io("Could not create the staged update", error))?;
    file.write_all(bytes)
        .map_err(|error| PortableUpdateError::io("Could not write the staged update", error))?;
    file.sync_all()
        .map_err(|error| PortableUpdateError::io("Could not flush the staged update", error))
}

fn write_marker(path: &Path, bytes: &[u8]) -> Result<(), PortableUpdateError> {
    match write_new_file(path, bytes) {
        Ok(()) => Ok(()),
        Err(_) if path.is_file() => Ok(()),
        Err(error) => Err(error),
    }
}

fn append_log(path: &Path, message: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {message}");
        let _ = file.flush();
    }
}

fn retry_io<T>(
    timeout: Duration,
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let started = std::time::Instant::now();
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if started.elapsed() < timeout => {
                thread::sleep(RETRY_INTERVAL);
                let _ = error;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_windows_payloads() {
        let payload = vec![0_u8; MIN_EXECUTABLE_BYTES];
        let error = validate_portable_executable(&payload).expect_err("payload must be rejected");
        assert!(error.to_string().contains("not a Windows executable"));
    }

    #[test]
    fn accepts_bounded_pe_payloads() {
        let mut payload = vec![0_u8; MIN_EXECUTABLE_BYTES];
        payload[..2].copy_from_slice(b"MZ");
        validate_portable_executable(&payload).expect("payload should be accepted");
    }

    #[test]
    fn helper_plan_rejects_paths_outside_the_update_session() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let root = directory.path().join("portable");
        let update_directory = root.join(PORTABLE_DATA_DIRECTORY).join(UPDATE_DIRECTORY);
        let session = update_directory.join("session-test");
        fs::create_dir_all(&session).expect("session should be created");
        fs::write(root.join(PORTABLE_MARKER_NAME), b"portable").expect("marker should be written");
        let target = root.join("NullPointer.exe");
        let staged = session.join(STAGED_EXECUTABLE_NAME);
        fs::write(&target, b"MZ").expect("target should be written");
        fs::write(&staged, b"MZ").expect("stage should be written");

        let arguments = vec![
            HELPER_ARGUMENT.into(),
            root.as_os_str().to_owned(),
            staged.as_os_str().to_owned(),
            target.as_os_str().to_owned(),
            directory.path().join(HEALTH_FILE_NAME).into_os_string(),
            session.join(COMPLETED_FILE_NAME).into_os_string(),
            session.join(LOG_FILE_NAME).into_os_string(),
        ];
        let error = HelperPlan::parse(&arguments).expect_err("outside path must be rejected");
        assert!(error.to_string().contains("invalid path"));
    }
}
