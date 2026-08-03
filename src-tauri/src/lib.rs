mod emulator;
mod git;
#[cfg(windows)]
mod portable_update;
mod terminal;

use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fmt::Write as FmtWrite,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        RwLock,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State, Url};
use tauri_plugin_updater::UpdaterExt;

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HEX_VIEW_BYTES: usize = 512 * 1024;
const HEX_VIEW_BYTES_PER_LINE: usize = 16;
const MAX_STANDALONE_FILES: usize = 256;
const MAX_TREE_ENTRIES: usize = 20_000;
const MAX_TREE_DEPTH: usize = 32;
const MAX_WORKSPACE_ROOTS: usize = 8;
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
const PORTABLE_UPDATE_MANIFEST_NAME: &str = "portable-latest.json";
const PORTABLE_UPDATE_TARGET: &str = "windows-x86_64";
const PORTABLE_LATEST_UPDATE_URL: &str =
    "https://github.com/mkkima/NullPointerIDE/releases/latest/download/portable-latest.json";
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
    workspace_roots: RwLock<Vec<WorkspaceRoot>>,
    next_workspace_root_id: AtomicU64,
    standalone_files: RwLock<HashMap<String, PathBuf>>,
    next_standalone_file_id: AtomicU64,
}

#[derive(Clone, Debug)]
struct WorkspaceRoot {
    id: String,
    path: PathBuf,
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

    #[cfg(windows)]
    fn portable_root(&self) -> Option<&Path> {
        self.portable_root.as_deref()
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
    id: String,
    root_path: String,
    name: String,
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSnapshot {
    roots: Vec<ProjectSnapshot>,
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
    read_only: bool,
    truncated: bool,
    view_mode: FileViewMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum FileViewMode {
    Text,
    Utf16,
    Hex,
}

struct DecodedFileView {
    content: String,
    read_only: bool,
    truncated: bool,
    view_mode: FileViewMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StandaloneFileDocument {
    file_id: String,
    display_path: String,
    document: FileDocument,
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
fn open_project(path: String, state: State<'_, AppState>) -> CommandResult<WorkspaceSnapshot> {
    let root = canonicalize_workspace_root(&path)?;
    let id = next_workspace_root_id(&state);
    let workspace_root = WorkspaceRoot { id, path: root };
    let mut workspace_roots = state
        .workspace_roots
        .write()
        .map_err(|_| CommandError::new("state_error", "Workspace state is unavailable."))?;
    let snapshot = build_workspace_snapshot(std::slice::from_ref(&workspace_root))?;
    *workspace_roots = vec![workspace_root];
    Ok(snapshot)
}

#[tauri::command]
fn add_workspace_folder(
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<WorkspaceSnapshot> {
    let root = canonicalize_workspace_root(&path)?;
    let mut stored = state
        .workspace_roots
        .write()
        .map_err(|_| CommandError::new("state_error", "Workspace state is unavailable."))?;
    let mut roots = stored.clone();
    if roots.iter().any(|candidate| candidate.path == root) {
        return build_workspace_snapshot(&roots);
    }
    if roots.len() >= MAX_WORKSPACE_ROOTS {
        return Err(CommandError::new(
            "workspace_root_limit",
            format!("A workspace can contain at most {MAX_WORKSPACE_ROOTS} folders."),
        ));
    }
    roots.push(WorkspaceRoot {
        id: next_workspace_root_id(&state),
        path: root,
    });
    let snapshot = build_workspace_snapshot(&roots)?;
    *stored = roots;
    Ok(snapshot)
}

#[tauri::command]
fn remove_workspace_folder(
    root_id: String,
    state: State<'_, AppState>,
) -> CommandResult<WorkspaceSnapshot> {
    let mut stored = state
        .workspace_roots
        .write()
        .map_err(|_| CommandError::new("state_error", "Workspace state is unavailable."))?;
    let mut roots = stored.clone();
    let original_length = roots.len();
    roots.retain(|root| root.id != root_id);
    if roots.len() == original_length {
        return Err(CommandError::new(
            "workspace_root_not_found",
            "The workspace folder no longer exists.",
        ));
    }
    let snapshot = build_workspace_snapshot(&roots)?;
    *stored = roots;
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
async fn list_app_releases(runtime_mode: State<'_, RuntimeMode>) -> CommandResult<Vec<AppRelease>> {
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
        .filter_map(|release| app_release_from_github(release, runtime_mode.is_portable()))
        .collect())
}

#[tauri::command]
async fn check_portable_update(
    app: AppHandle,
    runtime_mode: State<'_, RuntimeMode>,
) -> CommandResult<Option<String>> {
    if cfg!(debug_assertions) || !runtime_mode.is_portable() {
        return Ok(None);
    }

    let endpoint = Url::parse(PORTABLE_LATEST_UPDATE_URL).map_err(|error| {
        CommandError::new(
            "update_configuration_error",
            format!("Could not build the portable update URL: {error}"),
        )
    })?;
    let updater = app
        .updater_builder()
        .target(PORTABLE_UPDATE_TARGET)
        .endpoints(vec![endpoint])
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not select the portable update feed: {error}"),
            )
        })?
        .build()
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not prepare the portable updater: {error}"),
            )
        })?;
    updater
        .check()
        .await
        .map(|update| update.map(|update| update.version))
        .map_err(|error| {
            CommandError::new(
                "update_check_error",
                format!("Could not check for a signed portable update: {error}"),
            )
        })
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

    if runtime_mode.is_portable() {
        #[cfg(windows)]
        {
            let portable_root = runtime_mode.portable_root().ok_or_else(|| {
                CommandError::new(
                    "portable_update_error",
                    "Could not locate the portable application folder.",
                )
            })?;
            return install_portable_app_version(&app, portable_root, requested, on_event).await;
        }
        #[cfg(not(windows))]
        {
            return Err(CommandError::new(
                "portable_update_unsupported",
                "Portable updates are currently available only on Windows.",
            ));
        }
    }

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

#[cfg(windows)]
async fn install_portable_app_version(
    app: &AppHandle,
    portable_root: &Path,
    requested: semver::Version,
    on_event: Channel<AppUpdateEvent>,
) -> CommandResult<()> {
    let endpoint = portable_update_manifest_url(&requested)?;
    let selected = requested.clone();
    let updater = app
        .updater_builder()
        .target(PORTABLE_UPDATE_TARGET)
        .endpoints(vec![endpoint])
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not select the requested portable update: {error}"),
            )
        })?
        .version_comparator(move |current, release| {
            release.version == selected && release.version != current
        })
        .build()
        .map_err(|error| {
            CommandError::new(
                "update_configuration_error",
                format!("Could not prepare the portable updater: {error}"),
            )
        })?;
    let update = updater
        .check()
        .await
        .map_err(|error| {
            CommandError::new(
                "update_check_error",
                format!("Could not verify the selected portable version: {error}"),
            )
        })?
        .ok_or_else(|| {
            CommandError::new(
                "update_unavailable",
                "This portable version is already installed or no longer available.",
            )
        })?;
    if update.version != requested.to_string() {
        return Err(CommandError::new(
            "update_version_mismatch",
            "The signed portable update does not match the selected version.",
        ));
    }

    let progress_events = on_event.clone();
    let mut started = false;
    let executable = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_events.send(AppUpdateEvent::Started { content_length });
                }
                let _ = progress_events.send(AppUpdateEvent::Progress { chunk_length });
            },
            || {},
        )
        .await
        .map_err(|error| {
            CommandError::new(
                "update_download_error",
                format!("Could not download and verify the portable update: {error}"),
            )
        })?;
    if executable.len() > portable_update::MAX_EXECUTABLE_BYTES {
        return Err(CommandError::new(
            "update_too_large",
            "The signed portable update exceeds the application size limit.",
        ));
    }

    portable_update::stage_and_launch(portable_root, &executable, &requested.to_string()).map_err(
        |error| {
            CommandError::new(
                "portable_update_error",
                format!("Could not prepare the portable update: {error}"),
            )
        },
    )?;
    let _ = on_event.send(AppUpdateEvent::Finished);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn refresh_project(state: State<'_, AppState>) -> CommandResult<WorkspaceSnapshot> {
    build_workspace_snapshot(&workspace_roots(&state)?)
}

#[tauri::command]
async fn read_project_file(
    root_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<FileDocument> {
    let root = workspace_root_by_id(&state, &root_id)?.path;
    let normalized = normalize_relative(&relative_path)?;
    tauri::async_runtime::spawn_blocking(move || load_project_file(&root, &normalized))
        .await
        .map_err(|error| {
            CommandError::new(
                "file_task_error",
                format!("The file preview task failed: {error}"),
            )
        })?
}

fn load_project_file(root: &Path, normalized: &Path) -> CommandResult<FileDocument> {
    let path = resolve_existing_file(root, normalized)?;
    load_file_document(&path, path_to_relative_string(normalized))
}

fn load_file_document(path: &Path, document_path: String) -> CommandResult<FileDocument> {
    let metadata = fs::metadata(path)
        .map_err(|error| CommandError::io("Could not inspect the file", error))?;

    let capacity =
        usize::try_from(metadata.len().min(MAX_FILE_BYTES)).unwrap_or(MAX_FILE_BYTES as usize);
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)
        .map_err(|error| CommandError::io("Could not open the file", error))?
        .take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| CommandError::io("Could not read the file", error))?;

    let final_metadata = fs::metadata(path)
        .map_err(|error| CommandError::io("Could not inspect the loaded file", error))?;
    let file_truncated = final_metadata.len() > bytes.len() as u64;
    let view = decode_file_view(bytes, file_truncated);

    Ok(FileDocument {
        path: document_path,
        content: view.content,
        modified_at_ms: modified_at_ms(&final_metadata)?,
        size: final_metadata.len(),
        read_only: view.read_only,
        truncated: view.truncated,
        view_mode: view.view_mode,
    })
}

#[tauri::command]
async fn open_standalone_file(
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<StandaloneFileDocument> {
    let path = canonicalize_standalone_file(&path)?;
    let display_path = path_to_display_string(&path);
    let document_path = standalone_file_name(&path);
    let load_path = path.clone();
    let document =
        tauri::async_runtime::spawn_blocking(move || load_file_document(&load_path, document_path))
            .await
            .map_err(|error| {
                CommandError::new(
                    "file_task_error",
                    format!("The standalone file task failed: {error}"),
                )
            })??;
    let file_id = register_standalone_file(&state, path)?;
    Ok(StandaloneFileDocument {
        file_id,
        display_path,
        document,
    })
}

#[tauri::command]
async fn read_standalone_file(
    file_id: String,
    state: State<'_, AppState>,
) -> CommandResult<StandaloneFileDocument> {
    let path = standalone_file_by_id(&state, &file_id)?;
    let display_path = path_to_display_string(&path);
    let document_path = standalone_file_name(&path);
    let document =
        tauri::async_runtime::spawn_blocking(move || load_file_document(&path, document_path))
            .await
            .map_err(|error| {
                CommandError::new(
                    "file_task_error",
                    format!("The standalone file task failed: {error}"),
                )
            })??;
    Ok(StandaloneFileDocument {
        file_id,
        display_path,
        document,
    })
}

#[tauri::command]
fn close_standalone_file(file_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    let mut files = state
        .standalone_files
        .write()
        .map_err(|_| CommandError::new("state_error", "Standalone file state is unavailable."))?;
    files.remove(&file_id);
    Ok(())
}

#[tauri::command]
fn write_project_file(
    root_id: String,
    relative_path: String,
    content: String,
    expected_modified_at_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<SaveResult> {
    let root = workspace_root_by_id(&state, &root_id)?.path;
    let normalized = normalize_relative(&relative_path)?;
    let path = resolve_existing_file(&root, &normalized)?;
    write_text_file(&path, &content, expected_modified_at_ms)
}

#[tauri::command]
fn write_standalone_file(
    file_id: String,
    content: String,
    expected_modified_at_ms: Option<u64>,
    state: State<'_, AppState>,
) -> CommandResult<SaveResult> {
    let path = standalone_file_by_id(&state, &file_id)?;
    write_text_file(&path, &content, expected_modified_at_ms)
}

fn write_text_file(
    path: &Path,
    content: &str,
    expected_modified_at_ms: Option<u64>,
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

    let metadata = fs::metadata(path)
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
    if metadata.len() > MAX_FILE_BYTES {
        return Err(CommandError::new(
            "read_only_file",
            "Large file previews are read-only.",
        ));
    }
    let mut existing_bytes =
        Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(MAX_FILE_BYTES as usize));
    File::open(path)
        .map_err(|error| CommandError::io("Could not verify the file encoding", error))?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut existing_bytes)
        .map_err(|error| CommandError::io("Could not verify the file encoding", error))?;
    if existing_bytes.len() as u64 > MAX_FILE_BYTES
        || looks_binary(&existing_bytes)
        || std::str::from_utf8(&existing_bytes).is_err()
    {
        return Err(CommandError::new(
            "read_only_file",
            "Binary and non-UTF-8 file previews are read-only.",
        ));
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
        .persist(path)
        .map_err(|error| CommandError::io("Could not replace the original file", error.error))?;

    let saved_metadata = fs::metadata(path)
        .map_err(|error| CommandError::io("Could not inspect the saved file", error))?;
    Ok(SaveResult {
        modified_at_ms: modified_at_ms(&saved_metadata)?,
        size: saved_metadata.len(),
    })
}

#[tauri::command]
fn create_project_entry(
    root_id: String,
    relative_path: String,
    kind: CreateKind,
    state: State<'_, AppState>,
) -> CommandResult<WorkspaceSnapshot> {
    let root = workspace_root_by_id(&state, &root_id)?.path;
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

    build_workspace_snapshot(&workspace_roots(&state)?)
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
    let roots = workspace_roots(&state)?;
    run_git_task(move || git_workspace_for_roots(&roots)).await
}

#[tauri::command]
async fn git_stage_file(
    repository: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let roots = workspace_roots(&state)?;
    run_git_task(move || {
        let (root, repository) = git_repository_target(&roots, &repository)?;
        git::stage_file(&root.path, &repository, &path)?;
        git_workspace_for_roots(&roots)
    })
    .await
}

#[tauri::command]
async fn git_unstage_file(
    repository: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let roots = workspace_roots(&state)?;
    run_git_task(move || {
        let (root, repository) = git_repository_target(&roots, &repository)?;
        git::unstage_file(&root.path, &repository, &path)?;
        git_workspace_for_roots(&roots)
    })
    .await
}

#[tauri::command]
async fn git_stage_all(
    repository: String,
    state: State<'_, AppState>,
) -> CommandResult<git::GitWorkspace> {
    let roots = workspace_roots(&state)?;
    run_git_task(move || {
        let (root, repository) = git_repository_target(&roots, &repository)?;
        git::stage_all(&root.path, &repository)?;
        git_workspace_for_roots(&roots)
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
    let roots = workspace_roots(&state)?;
    run_git_task(move || {
        let (root, repository_path) = git_repository_target(&roots, &repository)?;
        let warning = match action {
            GitCommitAction::Commit => {
                git::commit(&root.path, &repository_path, &message)?;
                None
            }
            GitCommitAction::CommitAmend => {
                git::amend(&root.path, &repository_path, &message)?;
                None
            }
            GitCommitAction::CommitPush => {
                git::commit(&root.path, &repository_path, &message)?;
                git::push(&root.path, &repository_path)
                    .err()
                    .map(|error| format!("Commit created, but push failed: {error}"))
            }
            GitCommitAction::CommitSync => {
                git::commit(&root.path, &repository_path, &message)?;
                git::sync(&root.path, &repository_path)
                    .err()
                    .map(|error| format!("Commit created, but sync failed: {error}"))
            }
        };
        Ok(GitCommitResult {
            workspace: git_workspace_for_roots(&roots)?,
            warning,
        })
    })
    .await
}

fn git_workspace_for_roots(roots: &[WorkspaceRoot]) -> Result<git::GitWorkspace, String> {
    let mut repositories = Vec::new();
    let mut total_changes = 0_usize;
    let multiple_roots = roots.len() > 1;

    for root in roots {
        let workspace = git::workspace(&root.path)?;
        total_changes = total_changes.saturating_add(workspace.total_changes);
        for mut repository in workspace.repositories {
            let path_within_root = repository.relative_path.clone();
            repository.workspace_root_id = root.id.clone();
            repository.workspace_root_name = workspace_root_name(&root.path);
            repository.path_within_root = path_within_root.clone();
            repository.relative_path = format!("{}/{}", root.id, path_within_root);
            if multiple_roots {
                repository.name =
                    format!("{} · {}", repository.workspace_root_name, repository.name);
            }
            repositories.push(repository);
        }
    }

    repositories.sort_by(|left, right| {
        left.workspace_root_name
            .to_lowercase()
            .cmp(&right.workspace_root_name.to_lowercase())
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(git::GitWorkspace {
        repositories,
        total_changes,
    })
}

fn git_repository_target(
    roots: &[WorkspaceRoot],
    repository_key: &str,
) -> Result<(WorkspaceRoot, String), String> {
    let (root_id, repository) = repository_key
        .split_once('/')
        .ok_or_else(|| "The selected repository identifier is invalid.".to_owned())?;
    let root = roots
        .iter()
        .find(|root| root.id == root_id)
        .cloned()
        .ok_or_else(|| "The workspace folder for this repository is unavailable.".to_owned())?;
    Ok((root, repository.to_owned()))
}

fn workspace_root_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
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

fn app_release_from_github(release: GitHubRelease, portable: bool) -> Option<AppRelease> {
    let version = release_version(&release.tag_name)?;
    let required_manifest = if portable {
        PORTABLE_UPDATE_MANIFEST_NAME
    } else {
        UPDATE_MANIFEST_NAME
    };
    let update_available = release
        .assets
        .iter()
        .any(|asset| asset.name.eq_ignore_ascii_case(required_manifest));
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

fn portable_update_manifest_url(version: &semver::Version) -> CommandResult<Url> {
    Url::parse(&format!(
        "https://github.com/mkkima/NullPointerIDE/releases/download/app-v{version}/{PORTABLE_UPDATE_MANIFEST_NAME}"
    ))
    .map_err(|error| {
        CommandError::new(
            "update_configuration_error",
            format!("Could not build the selected portable update URL: {error}"),
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

fn workspace_roots(state: &State<'_, AppState>) -> CommandResult<Vec<WorkspaceRoot>> {
    state
        .workspace_roots
        .read()
        .map_err(|_| CommandError::new("state_error", "Workspace state is unavailable."))
        .map(|roots| roots.clone())
}

fn canonicalize_standalone_file(path: &str) -> CommandResult<PathBuf> {
    let file = fs::canonicalize(Path::new(path))
        .map_err(|error| CommandError::io("Could not open the selected file", error))?;
    if !file.is_file() {
        return Err(CommandError::new(
            "not_a_file",
            "The selected path is not a regular file.",
        ));
    }
    Ok(file)
}

fn register_standalone_file(state: &State<'_, AppState>, path: PathBuf) -> CommandResult<String> {
    let mut files = state
        .standalone_files
        .write()
        .map_err(|_| CommandError::new("state_error", "Standalone file state is unavailable."))?;
    if let Some((file_id, _)) = files
        .iter()
        .find(|(_, candidate)| candidate.as_path() == path.as_path())
    {
        return Ok(file_id.clone());
    }
    if files.len() >= MAX_STANDALONE_FILES {
        return Err(CommandError::new(
            "standalone_file_limit",
            "Close an existing standalone file before opening another one.",
        ));
    }
    let sequence = state
        .next_standalone_file_id
        .fetch_add(1, AtomicOrdering::Relaxed)
        .saturating_add(1);
    let file_id = format!("standalone-{sequence}");
    files.insert(file_id.clone(), path);
    Ok(file_id)
}

fn standalone_file_by_id(state: &State<'_, AppState>, file_id: &str) -> CommandResult<PathBuf> {
    state
        .standalone_files
        .read()
        .map_err(|_| CommandError::new("state_error", "Standalone file state is unavailable."))?
        .get(file_id)
        .cloned()
        .ok_or_else(|| {
            CommandError::new(
                "standalone_file_not_found",
                "The standalone file is no longer open.",
            )
        })
}

fn standalone_file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_to_display_string(path))
}

fn workspace_root_by_id(
    state: &State<'_, AppState>,
    root_id: &str,
) -> CommandResult<WorkspaceRoot> {
    workspace_roots(state)?
        .into_iter()
        .find(|root| root.id == root_id)
        .ok_or_else(|| {
            CommandError::new(
                "workspace_root_not_found",
                "The workspace folder is no longer available.",
            )
        })
}

fn canonicalize_workspace_root(path: &str) -> CommandResult<PathBuf> {
    let root = fs::canonicalize(Path::new(path))
        .map_err(|error| CommandError::io("Could not open the selected folder", error))?;
    if !root.is_dir() {
        return Err(CommandError::new(
            "not_a_directory",
            "The selected path is not a directory.",
        ));
    }
    Ok(root)
}

fn next_workspace_root_id(state: &State<'_, AppState>) -> String {
    let sequence = state
        .next_workspace_root_id
        .fetch_add(1, AtomicOrdering::Relaxed)
        .saturating_add(1);
    format!("root-{sequence}")
}

fn build_workspace_snapshot(roots: &[WorkspaceRoot]) -> CommandResult<WorkspaceSnapshot> {
    let mut snapshots = Vec::with_capacity(roots.len());
    for root in roots {
        snapshots.push(build_project_snapshot(&root.id, &root.path)?);
    }
    Ok(WorkspaceSnapshot { roots: snapshots })
}

fn build_project_snapshot(id: &str, root: &Path) -> CommandResult<ProjectSnapshot> {
    let mut context = TreeContext::new();
    let entries = walk_directory(root, root, 0, &mut context)?;
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());

    Ok(ProjectSnapshot {
        id: id.to_owned(),
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

fn decode_file_view(bytes: Vec<u8>, file_truncated: bool) -> DecodedFileView {
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_utf16_view(&bytes[2..], true, file_truncated);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_utf16_view(&bytes[2..], false, file_truncated);
    }

    if !looks_binary(&bytes) {
        match String::from_utf8(bytes) {
            Ok(content) => {
                return DecodedFileView {
                    content,
                    read_only: file_truncated,
                    truncated: file_truncated,
                    view_mode: FileViewMode::Text,
                };
            }
            Err(error)
                if file_truncated
                    && error.utf8_error().error_len().is_none()
                    && error.utf8_error().valid_up_to() > 0 =>
            {
                let valid = error.utf8_error().valid_up_to();
                let mut bytes = error.into_bytes();
                bytes.truncate(valid);
                let content =
                    String::from_utf8(bytes).expect("the UTF-8 validator reported a valid prefix");
                return DecodedFileView {
                    content,
                    read_only: true,
                    truncated: true,
                    view_mode: FileViewMode::Text,
                };
            }
            Err(error) => return binary_file_view(&error.into_bytes(), file_truncated),
        }
    }

    binary_file_view(&bytes, file_truncated)
}

fn decode_utf16_view(bytes: &[u8], little_endian: bool, file_truncated: bool) -> DecodedFileView {
    let complete_length = bytes.len() - (bytes.len() % 2);
    let units = bytes[..complete_length].chunks_exact(2).map(|chunk| {
        let pair = [chunk[0], chunk[1]];
        if little_endian {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        }
    });
    let content = char::decode_utf16(units)
        .map(|result| result.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    DecodedFileView {
        content,
        read_only: true,
        truncated: file_truncated || complete_length != bytes.len(),
        view_mode: FileViewMode::Utf16,
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(32 * 1024)];
    if sample.is_empty() {
        return false;
    }
    let controls = sample
        .iter()
        .filter(|byte| **byte < 0x20 && !matches!(**byte, b'\n' | b'\r' | b'\t' | 0x0c))
        .count();
    sample.contains(&0) || controls.saturating_mul(10) > sample.len()
}

fn binary_file_view(bytes: &[u8], file_truncated: bool) -> DecodedFileView {
    let visible = &bytes[..bytes.len().min(MAX_HEX_VIEW_BYTES)];
    DecodedFileView {
        content: hexadecimal_text_view(visible),
        read_only: true,
        truncated: file_truncated || visible.len() != bytes.len(),
        view_mode: FileViewMode::Hex,
    }
}

fn hexadecimal_text_view(bytes: &[u8]) -> String {
    let line_count = bytes.len().div_ceil(HEX_VIEW_BYTES_PER_LINE);
    let mut output = String::with_capacity(line_count.saturating_mul(78));
    for (line_index, chunk) in bytes.chunks(HEX_VIEW_BYTES_PER_LINE).enumerate() {
        let offset = line_index.saturating_mul(HEX_VIEW_BYTES_PER_LINE);
        let _ = write!(output, "{offset:08x}  ");
        for index in 0..HEX_VIEW_BYTES_PER_LINE {
            if let Some(byte) = chunk.get(index) {
                let _ = write!(output, "{byte:02x} ");
            } else {
                output.push_str("   ");
            }
            if index == 7 {
                output.push(' ');
            }
        }
        output.push_str(" |");
        for byte in chunk {
            output.push(if byte.is_ascii_graphic() || *byte == b' ' {
                char::from(*byte)
            } else {
                '.'
            });
        }
        output.push_str("|\n");
    }
    output
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
    #[cfg(windows)]
    if portable_update::run_helper_if_requested() {
        return;
    }

    let runtime_mode = RuntimeMode::detect();
    #[cfg(windows)]
    let portable_health_file = portable_update::health_file_argument();
    #[cfg(windows)]
    let setup_runtime_mode = runtime_mode.clone();
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
            #[cfg(windows)]
            if let Some(portable_root) = setup_runtime_mode.portable_root() {
                portable_update::acknowledge_healthy_launch(portable_root, portable_health_file);
            }
            Ok(())
        })
        .manage(AppState::default())
        .manage(emulator::EmulatorManager::default())
        .manage(terminal::TerminalManager::default())
        .manage(UpdateState::default())
        .manage(runtime_mode)
        .invoke_handler(tauri::generate_handler![
            is_production_build,
            is_portable_build,
            list_app_releases,
            check_portable_update,
            install_app_version,
            open_project,
            add_workspace_folder,
            remove_workspace_folder,
            refresh_project,
            read_project_file,
            write_project_file,
            open_standalone_file,
            read_standalone_file,
            write_standalone_file,
            close_standalone_file,
            create_project_entry,
            load_research_state,
            save_research_state,
            save_research_files,
            get_git_workspace,
            git_stage_file,
            git_unstage_file,
            git_stage_all,
            git_commit_repository,
            emulator::get_android_emulators,
            emulator::launch_android_emulator,
            emulator::stop_android_emulator,
            emulator::reboot_android_emulator,
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
        let portable_url =
            portable_update_manifest_url(&version).expect("portable URL should be valid");
        assert_eq!(
            url.as_str(),
            "https://github.com/mkkima/NullPointerIDE/releases/download/app-v1.2.3/latest.json"
        );
        assert_eq!(
            portable_url.as_str(),
            "https://github.com/mkkima/NullPointerIDE/releases/download/app-v1.2.3/portable-latest.json"
        );
    }

    #[test]
    fn converts_paths_to_slash_separated_strings() {
        let path = PathBuf::from("src").join("editor").join("mod.rs");
        assert_eq!(path_to_relative_string(&path), "src/editor/mod.rs");
    }

    #[test]
    fn keeps_valid_utf8_files_editable() {
        let view = decode_file_view("Hello, мир\n".as_bytes().to_vec(), false);

        assert_eq!(view.view_mode, FileViewMode::Text);
        assert_eq!(
            serde_json::to_string(&view.view_mode).expect("view mode should serialize"),
            "\"text\""
        );
        assert_eq!(view.content, "Hello, мир\n");
        assert!(!view.read_only);
        assert!(!view.truncated);
    }

    #[test]
    fn decodes_utf16_files_without_allowing_destructive_saves() {
        let mut bytes = vec![0xff, 0xfe];
        for unit in "Hello, мир".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let view = decode_file_view(bytes, false);

        assert_eq!(view.view_mode, FileViewMode::Utf16);
        assert_eq!(
            serde_json::to_string(&view.view_mode).expect("view mode should serialize"),
            "\"utf16\""
        );
        assert_eq!(view.content, "Hello, мир");
        assert!(view.read_only);
        assert!(!view.truncated);
    }

    #[test]
    fn represents_binary_files_as_read_only_hex_text() {
        let view = decode_file_view(
            vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00],
            false,
        );

        assert_eq!(view.view_mode, FileViewMode::Hex);
        assert!(view.content.starts_with("00000000  89 50 4e 47"));
        assert!(view.content.contains("|.PNG.....|"));
        assert!(view.read_only);
        assert!(!view.truncated);
    }

    #[test]
    fn caps_binary_text_views_to_a_bounded_size() {
        let bytes = vec![0; MAX_HEX_VIEW_BYTES + 1];
        let view = decode_file_view(bytes, false);

        assert_eq!(view.view_mode, FileViewMode::Hex);
        assert!(view.truncated);
        assert_eq!(
            view.content.lines().count(),
            MAX_HEX_VIEW_BYTES / HEX_VIEW_BYTES_PER_LINE
        );
    }

    #[test]
    fn preserves_the_valid_prefix_of_a_truncated_utf8_file() {
        let view = decode_file_view(vec![b'H', b'i', b' ', 0xe2, 0x82], true);

        assert_eq!(view.view_mode, FileViewMode::Text);
        assert_eq!(view.content, "Hi ");
        assert!(view.read_only);
        assert!(view.truncated);
    }

    #[test]
    fn loads_an_individual_file_without_a_workspace_root() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("notes.txt");
        fs::write(&path, "standalone text").expect("fixture should be written");

        let document = load_file_document(&path, "notes.txt".to_owned()).expect("file should load");

        assert_eq!(document.path, "notes.txt");
        assert_eq!(document.content, "standalone text");
        assert!(!document.read_only);
        assert_eq!(document.view_mode, FileViewMode::Text);
    }

    #[test]
    fn standalone_text_saves_use_the_same_conflict_safe_writer() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("notes.txt");
        fs::write(&path, "before").expect("fixture should be written");
        let metadata = fs::metadata(&path).expect("fixture should be inspectable");
        let modified = modified_at_ms(&metadata).expect("timestamp should be valid");

        write_text_file(&path, "after", Some(modified)).expect("text file should save");

        assert_eq!(
            fs::read_to_string(&path).expect("saved file should be readable"),
            "after"
        );
    }

    #[test]
    fn standalone_binary_views_cannot_be_overwritten_as_text() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("image.bin");
        fs::write(&path, [0x00, 0x01, 0x02, 0xff]).expect("fixture should be written");

        let error =
            write_text_file(&path, "replacement", None).expect_err("binary save should fail");

        assert_eq!(error.code, "read_only_file");
        assert_eq!(
            fs::read(&path).expect("binary fixture should remain readable"),
            [0x00, 0x01, 0x02, 0xff]
        );
    }

    #[test]
    fn routes_git_repository_keys_to_their_workspace_folder() {
        let roots = vec![
            WorkspaceRoot {
                id: "root-1".to_owned(),
                path: PathBuf::from("first"),
            },
            WorkspaceRoot {
                id: "root-2".to_owned(),
                path: PathBuf::from("second"),
            },
        ];

        let (root, repository) =
            git_repository_target(&roots, "root-2/packages/app").expect("key should be valid");
        assert_eq!(root.id, "root-2");
        assert_eq!(repository, "packages/app");
        assert!(git_repository_target(&roots, "root-3/packages/app").is_err());
        assert!(git_repository_target(&roots, "packages/app").is_err());
    }

    #[test]
    fn preserves_workspace_root_identity_in_snapshots() {
        let first = tempfile::tempdir().expect("temporary directory should be created");
        let second = tempfile::tempdir().expect("temporary directory should be created");
        fs::write(first.path().join("first.txt"), "first").expect("fixture should be written");
        fs::write(second.path().join("second.txt"), "second").expect("fixture should be written");
        let roots = vec![
            WorkspaceRoot {
                id: "root-7".to_owned(),
                path: fs::canonicalize(first.path()).expect("path should be canonical"),
            },
            WorkspaceRoot {
                id: "root-8".to_owned(),
                path: fs::canonicalize(second.path()).expect("path should be canonical"),
            },
        ];

        let snapshot = build_workspace_snapshot(&roots).expect("snapshot should be created");
        assert_eq!(snapshot.roots.len(), 2);
        assert_eq!(snapshot.roots[0].id, "root-7");
        assert_eq!(snapshot.roots[0].entries[0].path, "first.txt");
        assert_eq!(snapshot.roots[1].id, "root-8");
        assert_eq!(snapshot.roots[1].entries[0].path, "second.txt");
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
