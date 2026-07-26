mod git;
mod terminal;

use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        RwLock,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State, Url};
use tauri_plugin_updater::UpdaterExt;

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES: usize = 20_000;
const MAX_TREE_DEPTH: usize = 32;
const MIN_RESEARCH_DRAFTS: usize = 2;
const MAX_RESEARCH_DRAFTS: usize = 4;
const MAX_RESEARCH_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESEARCH_TOTAL_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESEARCH_STATE_BYTES: u64 = 40 * 1024 * 1024;
const RESEARCH_STATE_VERSION: u8 = 1;
const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/mkkima/NullPointerIDE/releases?per_page=20";
const GITHUB_RELEASE_RESPONSE_LIMIT: u64 = 2 * 1024 * 1024;
const UPDATE_MANIFEST_NAME: &str = "latest.json";
const PORTABLE_MARKER_NAME: &str = "portable.flag";
const PORTABLE_DATA_DIRECTORY: &str = "data";

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum GitCommitAction {
    Commit,
    CommitAmend,
    CommitPush,
    CommitSync,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitResult {
    workspace: git::GitWorkspace,
    warning: Option<String>,
}

#[derive(Default)]
struct AppState {
    project_root: RwLock<Option<PathBuf>>,
}

#[derive(Default)]
struct UpdateState {
    installing: AtomicBool,
}

#[derive(Clone, Debug, Default)]
struct RuntimeMode {
    portable_root: Option<PathBuf>,
}

impl RuntimeMode {
    fn detect() -> Self {
        #[cfg(windows)]
        {
            let portable_root = std::env::current_exe()
                .ok()
                .as_deref()
                .and_then(portable_root_for_executable);
            Self { portable_root }
        }

        #[cfg(not(windows))]
        {
            Self::default()
        }
    }

    fn is_portable(&self) -> bool {
        self.portable_root.is_some()
    }

    fn data_directory(&self) -> Option<PathBuf> {
        self.portable_root
            .as_ref()
            .map(|root| root.join(PORTABLE_DATA_DIRECTORY))
    }
}

struct UpdateInstallGuard<'a>(&'a AtomicBool);

impl Drop for UpdateInstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, AtomicOrdering::Release);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(context: &str, error: std::io::Error) -> Self {
        Self::new("io_error", format!("{context}: {error}"))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
    root_path: String,
    name: String,
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    kind: EntryKind,
    is_symlink: bool,
    children: Vec<FileEntry>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDocument {
    path: String,
    content: String,
    modified_at_ms: u64,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    modified_at_ms: u64,
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppRelease {
    version: String,
    name: String,
    notes: String,
    published_at: Option<String>,
    release_url: String,
    update_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum AppUpdateEvent {
    Started { content_length: Option<u64> },
    Progress { chunk_length: usize },
    Finished,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ResearchModel {
    Chatgpt,
    Gemini,
    Claude,
    Deepseek,
    Grok,
    Qwen,
    Perplexity,
}

impl ResearchModel {
    fn file_stem(self) -> &'static str {
        match self {
            Self::Chatgpt => "chatgpt",
            Self::Gemini => "gemini",
            Self::Claude => "claude",
            Self::Deepseek => "deepseek",
            Self::Grok => "grok",
            Self::Qwen => "qwen",
            Self::Perplexity => "perplexity",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResearchDraftState {
    id: String,
    model: ResearchModel,
    content: String,
    #[serde(default)]
    height_px: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResearchSavedFile {
    model: ResearchModel,
    file_name: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResearchWorkspaceState {
    version: u8,
    folder_path: String,
    drafts: Vec<ResearchDraftState>,
    saved_files: Vec<ResearchSavedFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResearchFileInput {
    model: ResearchModel,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CreateKind {
    File,
    Directory,
}

struct TreeContext {
    seen: usize,
    truncated: bool,
    ignored_directories: HashSet<&'static str>,
}

impl TreeContext {
    fn new() -> Self {
        Self {
            seen: 0,
            truncated: false,
            ignored_directories: HashSet::from([
                ".git",
                ".next",
                ".turbo",
                ".cache",
                "node_modules",
                "target",
                "dist",
                "build",
                "coverage",
            ]),
        }
    }
}

#[tauri::command]
fn open_project(path: String, state: State<'_, AppState>) -> CommandResult<ProjectSnapshot> {
    let root = fs::canonicalize(Path::new(&path))
        .map_err(|error| CommandError::io("Could not open the selected folder", error))?;

    if !root.is_dir() {
        return Err(CommandError::new(
            "not_a_directory",
            "The selected path is not a directory.",
        ));
    }

    let snapshot = build_project_snapshot(&root)?;
    let mut project_root = state
        .project_root
        .write()
        .map_err(|_| CommandError::new("state_error", "Project state is unavailable."))?;
    *project_root = Some(root);
    Ok(snapshot)
}

#[tauri::command]
fn is_production_build() -> bool {
    !cfg!(debug_assertions)
}

#[tauri::command]
fn is_portable_build(mode: State<'_, RuntimeMode>) -> bool {
    mode.is_portable()
}

#[tauri::command]
async fn list_app_releases() -> CommandResult<Vec<AppRelease>> {
    ensure_tls_provider();
    let client = reqwest::Client::builder()
        .user_agent(format!("NullPointerIDE/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| {
            CommandError::new(
                "release_client_error",
                format!("Could not prepare the release request: {error}"),
            )
        })?;
    let response = client
        .get(GITHUB_RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| {
            CommandError::new(
                "release_network_error",
                format!("Could not load the release history: {error}"),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let message = if status.as_u16() == 403 {
            "GitHub temporarily refused the release request. Try again in a few minutes.".to_owned()
        } else {
            format!("GitHub returned {status} while loading the release history.")
        };
        return Err(CommandError::new("release_http_error", message));
    }
    if response
        .content_length()
        .is_some_and(|length| length > GITHUB_RELEASE_RESPONSE_LIMIT)
    {
        return Err(CommandError::new(
            "release_response_too_large",
            "The release history response exceeds the application limit.",
        ));
    }

    let bytes = response.bytes().await.map_err(|error| {
        CommandError::new(
            "release_network_error",
            format!("Could not read the release history: {error}"),
        )
    })?;
    if bytes.len() as u64 > GITHUB_RELEASE_RESPONSE_LIMIT {
        return Err(CommandError::new(
            "release_response_too_large",
            "The release history response exceeds the application limit.",
        ));
    }

    let releases: Vec<GitHubRelease> = serde_json::from_slice(&bytes).map_err(|error| {
        CommandError::new(
            "invalid_release_response",
            format!("GitHub returned an invalid release history: {error}"),
        )
    })?;
    Ok(releases
        .into_iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter_map(app_release_from_github)
        .collect())
}

#[tauri::command]
async fn install_app_version(
    version: String,
    on_event: Channel<AppUpdateEvent>,
    app: AppHandle,
    update_state: State<'_, UpdateState>,
    runtime_mode: State<'_, RuntimeMode>,
) -> CommandResult<()> {
    if cfg!(debug_assertions) {
        return Err(CommandError::new(
            "production_only",
            "Version installation is available only in a packaged production build.",
        ));
    }
    if runtime_mode.is_portable() {
        return Err(CommandError::new(
            "portable_update_unsupported",
            "Portable builds are updated by replacing the application folder with a newer portable release.",
        ));
    }

    let requested = semver::Version::parse(version.trim()).map_err(|_| {
        CommandError::new(
            "invalid_update_version",
            "The selected application version is invalid.",
        )
    })?;
    if update_state
        .installing
        .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
        .is_err()
    {
        return Err(CommandError::new(
            "update_in_progress",
            "Another application update is already in progress.",
        ));
    }
    let _guard = UpdateInstallGuard(&update_state.installing);

    let endpoint = update_manifest_url(&requested)?;
    let selected = requested.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not select the requested update: {error}"),
            )
        })?
        .version_comparator(move |current, release| {
            release.version == selected && release.version != current
        })
        .build()
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not prepare the updater: {error}"),
            )
        })?;
    let update = updater
        .check()
        .await
        .map_err(|error| {
            CommandError::new(
                "update_check_error",
                format!("Could not verify the selected version: {error}"),
            )
        })?
        .ok_or_else(|| {
            CommandError::new(
                "update_unavailable",
                "This version is already installed or no longer has a compatible updater.",
            )
        })?;
    if update.version != requested.to_string() {
        return Err(CommandError::new(
            "update_version_mismatch",
            "The signed updater does not match the selected version.",
        ));
    }

    let progress_events = on_event.clone();
    let finish_events = on_event;
    let mut started = false;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_events.send(AppUpdateEvent::Started { content_length });
                }
                let _ = progress_events.send(AppUpdateEvent::Progress { chunk_length });
            },
            move || {
                let _ = finish_events.send(AppUpdateEvent::Finished);
            },
        )
        .await
        .map_err(|error| {
            CommandError::new(
                "update_install_error",
                format!("Could not install the signed update: {error}"),
            )
        })?;

    app.restart();
}

#[tauri::command]
fn refresh_project(state: State<'_, AppState>) -> CommandResult<ProjectSnapshot> {
    let root = current_root(&state)?;
    build_project_snapshot(&root)
}

#[tauri::command]
fn read_project_file(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<FileDocument> {
    let root = current_root(&state)?;
    let normalized = normalize_relative(&relative_path)?;
    let path = resolve_existing_file(&root, &normalized)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| CommandError::io("Could not inspect the file", error))?;

    if metadata.len() > MAX_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            format!(
                "This file is larger than the {} MiB editor limit.",
                MAX_FILE_BYTES / 1024 / 1024
            ),
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(&path)
        .map_err(|error| CommandError::io("Could not open the file", error))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CommandError::io("Could not read the file", error))?;

    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "The file grew beyond the editor limit while it was being read.",
        ));
    }
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        return Err(CommandError::new(
            "binary_file",
            "Binary files cannot be opened in the text editor.",
        ));
    }

    let content = String::from_utf8(bytes).map_err(|_| {
        CommandError::new(
            "unsupported_encoding",
            "The file is not valid UTF-8. Convert it to UTF-8 before editing.",
        )
    })?;

    Ok(FileDocument {
        path: path_to_relative_string(&normalized),
        content,
        modified_at_ms: modified_at_ms(&metadata)?,
        size: metadata.len(),
    })
}

#[tauri::command]
fn write_project_file(
    relative_path: String,
    content: String,
    expected_modified_at_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<SaveResult> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            format!(
                "The document exceeds the {} MiB editor limit.",
                MAX_FILE_BYTES / 1024 / 1024
            ),
        ));
    }

    let root = current_root(&state)?;
    let normalized = normalize_relative(&relative_path)?;
    let path = resolve_existing_file(&root, &normalized)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| CommandError::io("Could not inspect the file", error))?;

    if let Some(expected) = expected_modified_at_ms {
        let current = modified_at_ms(&metadata)?;
        if current != expected {
            return Err(CommandError::new(
                "file_changed",
                "The file changed on disk after it was opened. Reopen it before saving.",
            ));
        }
    }

    let parent = path.parent().ok_or_else(|| {
        CommandError::new("invalid_path", "The file has no writable parent directory.")
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| CommandError::io("Could not create a temporary file", error))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| CommandError::io("Could not preserve file permissions", error))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| CommandError::io("Could not write the file", error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| CommandError::io("Could not flush the file", error))?;
    temporary
        .persist(&path)
        .map_err(|error| CommandError::io("Could not replace the original file", error.error))?;

    let saved_metadata = fs::metadata(&path)
        .map_err(|error| CommandError::io("Could not inspect the saved file", error))?;
    Ok(SaveResult {
        modified_at_ms: modified_at_ms(&saved_metadata)?,
        size: saved_metadata.len(),
    })
}

#[tauri::command]
fn create_project_entry(
    relative_path: String,
    kind: CreateKind,
    state: State<'_, AppState>,
) -> CommandResult<ProjectSnapshot> {
    let root = current_root(&state)?;
    let normalized = normalize_relative(&relative_path)?;
    let parent_relative = normalized.parent().unwrap_or_else(|| Path::new(""));
    let parent = fs::canonicalize(root.join(parent_relative))
        .map_err(|error| CommandError::io("The parent directory does not exist", error))?;
    if !parent.starts_with(&root) {
        return Err(CommandError::new(
            "path_escape",
            "The parent directory resolves outside the open project.",
        ));
    }
    if !parent.is_dir() {
        return Err(CommandError::new(
            "invalid_parent",
            "The parent path is not a directory.",
        ));
    }

    let file_name = normalized.file_name().ok_or_else(|| {
        CommandError::new("invalid_path", "The new entry must have a valid name.")
    })?;
    let target = parent.join(file_name);
    match kind {
        CreateKind::File => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| CommandError::io("Could not create the file", error))?;
        }
        CreateKind::Directory => {
            fs::create_dir(&target)
                .map_err(|error| CommandError::io("Could not create the directory", error))?;
        }
    }

    build_project_snapshot(&root)
}

#[tauri::command]
async fn load_research_state(
    app: AppHandle,
    runtime_mode: State<'_, RuntimeMode>,
) -> CommandResult<Option<ResearchWorkspaceState>> {
    let path = research_state_path(&app, &runtime_mode)?;
    run_io_task(move || {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(CommandError::io(
                    "Could not inspect the saved research state",
                    error,
                ))
            }
        };
        if metadata.len() > MAX_RESEARCH_STATE_BYTES {
            return Err(CommandError::new(
                "research_state_too_large",
                "The saved research state exceeds the application limit.",
            ));
        }

        let bytes = fs::read(&path)
            .map_err(|error| CommandError::io("Could not read the research state", error))?;
        let mut state: ResearchWorkspaceState =
            serde_json::from_slice(&bytes).map_err(|error| {
                CommandError::new(
                    "invalid_research_state",
                    format!("The saved research state is invalid: {error}"),
                )
            })?;
        // Version 1 originally allowed five drafts. Keep the first four when
        // loading that legacy state instead of rejecting the entire workspace.
        state.drafts.truncate(MAX_RESEARCH_DRAFTS);
        state.saved_files.truncate(MAX_RESEARCH_DRAFTS);
        validate_research_state(&state)?;
        Ok(Some(state))
    })
    .await
}

#[tauri::command]
async fn save_research_state(
    research_state: ResearchWorkspaceState,
    app: AppHandle,
    runtime_mode: State<'_, RuntimeMode>,
) -> CommandResult<()> {
    validate_research_state(&research_state)?;
    let path = research_state_path(&app, &runtime_mode)?;
    run_io_task(move || {
        let parent = path.parent().ok_or_else(|| {
            CommandError::new(
                "invalid_research_state_path",
                "The research state path has no parent directory.",
            )
        })?;
        let payload = serde_json::to_vec(&research_state).map_err(|error| {
            CommandError::new(
                "research_state_error",
                format!("Could not encode the research state: {error}"),
            )
        })?;
        if payload.len() as u64 > MAX_RESEARCH_STATE_BYTES {
            return Err(CommandError::new(
                "research_state_too_large",
                "The research state exceeds the application limit.",
            ));
        }

        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| CommandError::io("Could not create a research state file", error))?;
        temporary
            .write_all(&payload)
            .map_err(|error| CommandError::io("Could not write the research state", error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| CommandError::io("Could not flush the research state", error))?;
        temporary.persist(&path).map_err(|error| {
            CommandError::io("Could not replace the research state", error.error)
        })?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn save_research_files(
    folder_path: String,
    entries: Vec<ResearchFileInput>,
) -> CommandResult<Vec<ResearchSavedFile>> {
    validate_research_entries(&entries)?;
    run_io_task(move || {
        let root = fs::canonicalize(Path::new(folder_path.trim()))
            .map_err(|error| CommandError::io("Could not open the research folder", error))?;
        if !root.is_dir() {
            return Err(CommandError::new(
                "not_a_directory",
                "The selected research path is not a directory.",
            ));
        }

        let mut next_indices = HashMap::<ResearchModel, u64>::new();
        let mut created_paths = Vec::<PathBuf>::with_capacity(entries.len());
        let mut saved_files = Vec::<ResearchSavedFile>::with_capacity(entries.len());

        for entry in entries {
            let next_index = match next_indices.get_mut(&entry.model) {
                Some(index) => index,
                None => {
                    let index = next_research_index(&root, entry.model)?;
                    next_indices.entry(entry.model).or_insert(index)
                }
            };
            match create_research_file(&root, entry.model, &entry.content, next_index) {
                Ok((path, file_name)) => {
                    saved_files.push(ResearchSavedFile {
                        model: entry.model,
                        file_name,
                        path: path_to_display_string(&path),
                    });
                    created_paths.push(path);
                }
                Err(error) => {
                    for created_path in &created_paths {
                        let _ = fs::remove_file(created_path);
                    }
                    return Err(error);
                }
            }
        }

        Ok(saved_files)
    })
    .await
}

#[tauri::command]
async fn get_git_workspace(state: State<'_, AppState>) -> CommandResult<git::GitWorkspace> {
    let root = current_root(&state)?;
    run_git_task(move || git::workspace(&root)).await
}

#[tauri::command]
async fn git_stage_file(
    repository: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let root = current_root(&state)?;
    run_git_task(move || {
        git::stage_file(&root, &repository, &path)?;
        git::workspace(&root)
    })
    .await
}

#[tauri::command]
async fn git_unstage_file(
    repository: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let root = current_root(&state)?;
    run_git_task(move || {
        git::unstage_file(&root, &repository, &path)?;
        git::workspace(&root)
    })
    .await
}

#[tauri::command]
async fn git_stage_all(
    repository: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let root = current_root(&state)?;
    run_git_task(move || {
        git::stage_all(&root, &repository)?;
        git::workspace(&root)
    })
    .await
}

#[tauri::command]
async fn git_commit_repository(
    repository: String,
    message: String,
    action: GitCommitAction,
    state: State<'_, AppState>,
) -> CommandResult<GitCommitResult> {
    let root = current_root(&state)?;
    run_git_task(move || {
        let warning = match action {
            GitCommitAction::Commit => {
                git::commit(&root, &repository, &message)?;
                None
            }
            GitCommitAction::CommitAmend => {
                git::amend(&root, &repository, &message)?;
                None
            }
            GitCommitAction::CommitPush => {
                git::commit(&root, &repository, &message)?;
                git::push(&root, &repository)
                    .err()
                    .map(|error| format!("Commit created, but push failed: {error}"))
            }
            GitCommitAction::CommitSync => {
                git::commit(&root, &repository, &message)?;
                git::sync(&root, &repository)
                    .err()
                    .map(|error| format!("Commit created, but sync failed: {error}"))
            }
        };
        Ok(GitCommitResult {
            workspace: git::workspace(&root)?,
            warning,
        })
    })
    .await
}

async fn run_io_task<T, F>(task: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| {
            CommandError::new(
                "research_task_error",
                format!("Research file task failed: {error}"),
            )
        })?
}

async fn run_git_task<T, F>(task: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| CommandError::new("git_task_error", format!("Git task failed: {error}")))?
        .map_err(|message| CommandError::new("git_error", message))
}

fn app_release_from_github(release: GitHubRelease) -> Option<AppRelease> {
    let version = release_version(&release.tag_name)?;
    let update_available = release
        .assets
        .iter()
        .any(|asset| asset.name.eq_ignore_ascii_case(UPDATE_MANIFEST_NAME));
    let default_name = format!("NullPointer {version}");
    Some(AppRelease {
        version,
        name: truncate_text(
            release
                .name
                .as_deref()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(&default_name),
            200,
        ),
        notes: truncate_text(release.body.as_deref().unwrap_or(""), 30_000),
        published_at: release.published_at,
        release_url: release.html_url,
        update_available,
    })
}

fn ensure_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        // A concurrent updater check may win this race; either provider is valid.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

fn release_version(tag: &str) -> Option<String> {
    let candidate = tag
        .trim()
        .strip_prefix("app-v")
        .or_else(|| tag.trim().strip_prefix('v'))?;
    semver::Version::parse(candidate)
        .ok()
        .map(|version| version.to_string())
}

fn update_manifest_url(version: &semver::Version) -> CommandResult<Url> {
    Url::parse(&format!(
        "https://github.com/mkkima/NullPointerIDE/releases/download/app-v{version}/{UPDATE_MANIFEST_NAME}"
    ))
    .map_err(|error| {
        CommandError::new(
            "update_configuration_error",
            format!("Could not build the selected update URL: {error}"),
        )
    })
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut characters = value.chars();
    let truncated = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn research_state_path(app: &AppHandle, runtime_mode: &RuntimeMode) -> CommandResult<PathBuf> {
    let directory = match runtime_mode.data_directory() {
        Some(directory) => directory,
        None => app.path().app_data_dir().map_err(|error| {
            CommandError::new(
                "research_state_path_error",
                format!("Could not locate the application data directory: {error}"),
            )
        })?,
    };
    fs::create_dir_all(&directory).map_err(|error| {
        CommandError::io("Could not create the application state directory", error)
    })?;
    Ok(directory.join("research-state.json"))
}

fn portable_root_for_executable(executable: &Path) -> Option<PathBuf> {
    let root = executable.parent()?;
    root.join(PORTABLE_MARKER_NAME)
        .is_file()
        .then(|| root.to_path_buf())
}

fn validate_research_state(state: &ResearchWorkspaceState) -> CommandResult<()> {
    if state.version != RESEARCH_STATE_VERSION {
        return Err(CommandError::new(
            "unsupported_research_state",
            "The saved research state uses an unsupported version.",
        ));
    }
    if state.folder_path.len() > 32_768 {
        return Err(CommandError::new(
            "invalid_research_folder",
            "The saved research folder path is too long.",
        ));
    }
    if !(MIN_RESEARCH_DRAFTS..=MAX_RESEARCH_DRAFTS).contains(&state.drafts.len()) {
        return Err(CommandError::new(
            "invalid_research_count",
            "Research must contain between 2 and 4 drafts.",
        ));
    }

    let mut ids = HashSet::with_capacity(state.drafts.len());
    let mut total_bytes = 0usize;
    for draft in &state.drafts {
        if draft.id.is_empty() || draft.id.len() > 128 || !ids.insert(draft.id.as_str()) {
            return Err(CommandError::new(
                "invalid_research_draft",
                "Research draft identifiers must be unique and valid.",
            ));
        }
        if draft.height_px != 0 && !(180..=1_000).contains(&draft.height_px) {
            return Err(CommandError::new(
                "invalid_research_draft",
                "Research draft height is outside the supported range.",
            ));
        }
        validate_research_text_size(&draft.content, &mut total_bytes)?;
    }
    if state.saved_files.len() > MAX_RESEARCH_DRAFTS {
        return Err(CommandError::new(
            "invalid_research_results",
            "The saved research result list is too large.",
        ));
    }
    if state.saved_files.iter().any(|file| {
        file.file_name.is_empty()
            || file.file_name.len() > 255
            || file.path.is_empty()
            || file.path.len() > 32_768
    }) {
        return Err(CommandError::new(
            "invalid_research_results",
            "A saved research result contains an invalid path.",
        ));
    }
    Ok(())
}

fn validate_research_entries(entries: &[ResearchFileInput]) -> CommandResult<()> {
    if !(MIN_RESEARCH_DRAFTS..=MAX_RESEARCH_DRAFTS).contains(&entries.len()) {
        return Err(CommandError::new(
            "invalid_research_count",
            "Save between 2 and 4 research drafts at a time.",
        ));
    }
    let mut total_bytes = 0usize;
    for entry in entries {
        if entry.content.trim().is_empty() {
            return Err(CommandError::new(
                "empty_research",
                "Every research draft must contain text before saving.",
            ));
        }
        validate_research_text_size(&entry.content, &mut total_bytes)?;
    }
    Ok(())
}

fn validate_research_text_size(content: &str, total_bytes: &mut usize) -> CommandResult<()> {
    if content.len() > MAX_RESEARCH_TEXT_BYTES {
        return Err(CommandError::new(
            "research_too_large",
            format!(
                "A research draft exceeds the {} MiB limit.",
                MAX_RESEARCH_TEXT_BYTES / 1024 / 1024
            ),
        ));
    }
    *total_bytes = total_bytes.checked_add(content.len()).ok_or_else(|| {
        CommandError::new(
            "research_too_large",
            "The research text size is out of range.",
        )
    })?;
    if *total_bytes > MAX_RESEARCH_TOTAL_TEXT_BYTES {
        return Err(CommandError::new(
            "research_too_large",
            format!(
                "The combined research text exceeds the {} MiB limit.",
                MAX_RESEARCH_TOTAL_TEXT_BYTES / 1024 / 1024
            ),
        ));
    }
    Ok(())
}

fn next_research_index(root: &Path, model: ResearchModel) -> CommandResult<u64> {
    let prefix = format!("{}-research-", model.file_stem());
    let mut highest = 0u64;
    let entries = fs::read_dir(root)
        .map_err(|error| CommandError::io("Could not inspect the research folder", error))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(number) = name
            .strip_prefix(&prefix)
            .and_then(|value| value.strip_suffix(".md"))
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        highest = highest.max(number);
    }
    highest.checked_add(1).ok_or_else(|| {
        CommandError::new(
            "research_sequence_exhausted",
            "The research file sequence has no available numbers.",
        )
    })
}

fn create_research_file(
    root: &Path,
    model: ResearchModel,
    content: &str,
    next_index: &mut u64,
) -> CommandResult<(PathBuf, String)> {
    for _ in 0..100_000 {
        let index = *next_index;
        *next_index = next_index.checked_add(1).ok_or_else(|| {
            CommandError::new(
                "research_sequence_exhausted",
                "The research file sequence has no available numbers.",
            )
        })?;
        let file_name = format!("{}-research-{index}.md", model.file_stem());
        let path = root.join(&file_name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CommandError::io(
                    "Could not create a research Markdown file",
                    error,
                ))
            }
        };

        if let Err(error) = file.write_all(content.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(CommandError::io(
                "Could not write a research Markdown file",
                error,
            ));
        }
        if let Err(error) = file.sync_all() {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(CommandError::io(
                "Could not flush a research Markdown file",
                error,
            ));
        }
        return Ok((path, file_name));
    }

    Err(CommandError::new(
        "research_sequence_exhausted",
        "Could not find an available research file number.",
    ))
}

fn current_root(state: &State<'_, AppState>) -> CommandResult<PathBuf> {
    state
        .project_root
        .read()
        .map_err(|_| CommandError::new("state_error", "Project state is unavailable."))?
        .clone()
        .ok_or_else(|| CommandError::new("no_project", "Open a project folder first."))
}

fn build_project_snapshot(root: &Path) -> CommandResult<ProjectSnapshot> {
    let mut context = TreeContext::new();
    let entries = walk_directory(root, root, 0, &mut context)?;
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());

    Ok(ProjectSnapshot {
        root_path: path_to_display_string(root),
        name,
        entries,
        truncated: context.truncated,
    })
}

fn walk_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    context: &mut TreeContext,
) -> CommandResult<Vec<FileEntry>> {
    if depth >= MAX_TREE_DEPTH {
        context.truncated = true;
        return Ok(Vec::new());
    }

    let read_dir = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(Vec::new()),
        Err(error) => {
            return Err(CommandError::io(
                "Could not read a project directory",
                error,
            ))
        }
    };

    let mut entries = Vec::new();
    for entry_result in read_dir {
        if context.seen >= MAX_TREE_ENTRIES {
            context.truncated = true;
            break;
        }

        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let is_symlink = file_type.is_symlink();
        let is_directory = if is_symlink {
            entry
                .metadata()
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
        } else {
            file_type.is_dir()
        };

        if is_directory && context.ignored_directories.contains(name.as_str()) {
            continue;
        }

        let path = entry.path();
        let relative = match path.strip_prefix(root) {
            Ok(relative) => relative,
            Err(_) => continue,
        };
        context.seen += 1;

        let children = if is_directory && !is_symlink {
            walk_directory(root, &path, depth + 1, context)?
        } else {
            Vec::new()
        };

        entries.push(FileEntry {
            name,
            path: path_to_relative_string(relative),
            kind: if is_directory {
                EntryKind::Directory
            } else {
                EntryKind::File
            },
            is_symlink,
            children,
        });
    }

    entries.sort_by(|left, right| match (left.kind, right.kind) {
        (EntryKind::Directory, EntryKind::File) => Ordering::Less,
        (EntryKind::File, EntryKind::Directory) => Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
    Ok(entries)
}

fn normalize_relative(input: &str) -> CommandResult<PathBuf> {
    let value = input.trim();
    if value.is_empty() {
        return Err(CommandError::new(
            "invalid_path",
            "The path cannot be empty.",
        ));
    }

    let path = Path::new(value);
    if path.is_absolute() {
        return Err(CommandError::new(
            "invalid_path",
            "Only project-relative paths are allowed.",
        ));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                if part.is_empty() {
                    return Err(CommandError::new("invalid_path", "The path is invalid."));
                }
                #[cfg(windows)]
                if part.to_string_lossy().contains(':') {
                    return Err(CommandError::new(
                        "invalid_path",
                        "Windows alternate data streams are not allowed.",
                    ));
                }
                normalized.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(CommandError::new(
                    "invalid_path",
                    "The path must stay inside the open project.",
                ));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err(CommandError::new(
            "invalid_path",
            "The path cannot be empty.",
        ));
    }
    Ok(normalized)
}

fn resolve_existing_file(root: &Path, relative: &Path) -> CommandResult<PathBuf> {
    let candidate = fs::canonicalize(root.join(relative))
        .map_err(|error| CommandError::io("The file does not exist", error))?;
    ensure_inside_root(root, &candidate)?;
    if !candidate.is_file() {
        return Err(CommandError::new(
            "not_a_file",
            "The selected path is not a regular file.",
        ));
    }
    Ok(candidate)
}

fn ensure_inside_root(root: &Path, candidate: &Path) -> CommandResult<()> {
    if candidate.starts_with(root) && candidate != root {
        Ok(())
    } else {
        Err(CommandError::new(
            "path_escape",
            "The requested path resolves outside the open project.",
        ))
    }
}

fn modified_at_ms(metadata: &fs::Metadata) -> CommandResult<u64> {
    let modified = metadata
        .modified()
        .map_err(|error| CommandError::io("Could not read the modification time", error))?;
    let duration = modified.duration_since(UNIX_EPOCH).map_err(|_| {
        CommandError::new(
            "invalid_timestamp",
            "The file modification time is before the Unix epoch.",
        )
    })?;
    u64::try_from(duration.as_millis()).map_err(|_| {
        CommandError::new(
            "invalid_timestamp",
            "The file modification time is out of range.",
        )
    })
}

fn path_to_relative_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn path_to_display_string(path: &Path) -> String {
    let display = path.to_string_lossy();

    #[cfg(windows)]
    {
        if let Some(unc_path) = display.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc_path}");
        }
        if let Some(regular_path) = display.strip_prefix(r"\\?\") {
            return regular_path.to_owned();
        }
    }

    display.into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime_mode = RuntimeMode::detect();
    let portable_webview_directory = runtime_mode
        .data_directory()
        .map(|directory| directory.join("webview"));
    let mut context = tauri::generate_context!();
    if portable_webview_directory.is_some() {
        for window in &mut context.config_mut().app.windows {
            window.create = false;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            if let Some(data_directory) = portable_webview_directory {
                let window_config = app.config().app.windows.first().cloned().ok_or_else(|| {
                    std::io::Error::other("Portable mode requires a configured application window.")
                })?;
                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                    .data_directory(data_directory)
                    .build()?;
            }
            Ok(())
        })
        .manage(AppState::default())
        .manage(terminal::TerminalManager::default())
        .manage(UpdateState::default())
        .manage(runtime_mode)
        .invoke_handler(tauri::generate_handler![
            is_production_build,
            is_portable_build,
            list_app_releases,
            install_app_version,
            open_project,
            refresh_project,
            read_project_file,
            write_project_file,
            create_project_entry,
            load_research_state,
            save_research_state,
            save_research_files,
            get_git_workspace,
            git_stage_file,
            git_unstage_file,
            git_stage_all,
            git_commit_repository,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill
        ])
        .run(context)
        .expect("failed to run NullPointer IDE");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_safe_relative_paths() {
        let result = normalize_relative("src/./main.rs").expect("path should be valid");
        assert_eq!(result, PathBuf::from("src").join("main.rs"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let error = normalize_relative("../secret.txt").expect_err("path should be rejected");
        assert_eq!(error.code, "invalid_path");
    }

    #[test]
    fn rejects_absolute_paths() {
        let absolute = if cfg!(windows) {
            "C:\\secret.txt"
        } else {
            "/secret.txt"
        };
        assert!(normalize_relative(absolute).is_err());
    }

    #[test]
    fn detects_portable_layout_only_when_marker_is_next_to_executable() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let executable = directory.path().join("NullPointer.exe");
        fs::write(&executable, b"fixture").expect("fixture executable should be written");
        assert_eq!(portable_root_for_executable(&executable), None);

        fs::write(directory.path().join(PORTABLE_MARKER_NAME), b"portable")
            .expect("portable marker should be written");
        assert_eq!(
            portable_root_for_executable(&executable),
            Some(directory.path().to_path_buf())
        );
    }

    #[test]
    fn accepts_release_tags_created_by_the_release_workflow() {
        assert_eq!(release_version("app-v0.42.1"), Some("0.42.1".to_owned()));
        assert_eq!(release_version("v1.2.3"), Some("1.2.3".to_owned()));
        assert_eq!(release_version("nightly"), None);
    }

    #[test]
    fn builds_a_version_specific_update_manifest_url() {
        let version = semver::Version::parse("1.2.3").expect("fixture should be valid");
        let url = update_manifest_url(&version).expect("URL should be valid");
        assert_eq!(
            url.as_str(),
            "https://github.com/mkkima/NullPointerIDE/releases/download/app-v1.2.3/latest.json"
        );
    }

    #[test]
    fn converts_paths_to_slash_separated_strings() {
        let path = PathBuf::from("src").join("editor").join("mod.rs");
        assert_eq!(path_to_relative_string(&path), "src/editor/mod.rs");
    }

    #[test]
    fn research_files_continue_after_the_highest_existing_number() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        fs::write(directory.path().join("chatgpt-research-2.md"), "existing")
            .expect("fixture should be written");
        let mut next = next_research_index(directory.path(), ResearchModel::Chatgpt)
            .expect("next research index should be found");

        let (_, file_name) = create_research_file(
            directory.path(),
            ResearchModel::Chatgpt,
            "new text",
            &mut next,
        )
        .expect("research file should be created");

        assert_eq!(file_name, "chatgpt-research-3.md");
        assert_eq!(
            fs::read_to_string(directory.path().join(file_name))
                .expect("research file should be readable"),
            "new text"
        );
    }

    #[test]
    fn rejects_empty_research_entries() {
        let entries = vec![
            ResearchFileInput {
                model: ResearchModel::Chatgpt,
                content: "valid".to_owned(),
            },
            ResearchFileInput {
                model: ResearchModel::Gemini,
                content: "  ".to_owned(),
            },
        ];
        let error = validate_research_entries(&entries).expect_err("empty text should be rejected");
        assert_eq!(error.code, "empty_research");
    }

    #[test]
    fn legacy_research_drafts_default_to_automatic_height() {
        let state: ResearchWorkspaceState = serde_json::from_str(
            r#"{
                "version": 1,
                "folderPath": "",
                "drafts": [
                    {"id": "one", "model": "chatgpt", "content": ""},
                    {"id": "two", "model": "gemini", "content": ""}
                ],
                "savedFiles": []
            }"#,
        )
        .expect("legacy state should remain readable");

        assert!(state.drafts.iter().all(|draft| draft.height_px == 0));
        validate_research_state(&state).expect("legacy state should be valid");
    }

    #[test]
    fn rejects_more_than_four_research_entries() {
        let entries = [
            ResearchModel::Chatgpt,
            ResearchModel::Gemini,
            ResearchModel::Claude,
            ResearchModel::Deepseek,
            ResearchModel::Grok,
        ]
        .into_iter()
        .map(|model| ResearchFileInput {
            model,
            content: "research".to_owned(),
        })
        .collect::<Vec<_>>();

        let error =
            validate_research_entries(&entries).expect_err("fifth draft should be rejected");
        assert_eq!(error.code, "invalid_research_count");
    }

    #[cfg(windows)]
    #[test]
    fn removes_windows_verbatim_prefix_for_display() {
        let path = Path::new(r"\\?\C:\workspace\project");
        assert_eq!(path_to_display_string(path), r"C:\workspace\project");
    }
}
