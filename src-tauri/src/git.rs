use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Output},
};

const MAX_REPOSITORIES: usize = 32;
const MAX_SCAN_DIRECTORIES: usize = 5_000;
const MAX_SCAN_DEPTH: usize = 5;
const MAX_GRAPH_COMMITS: usize = 40;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorkspace {
    pub(crate) repositories: Vec<GitRepository>,
    pub(crate) total_changes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRepository {
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) branch: String,
    pub(crate) detached: bool,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) changes: Vec<GitFileChange>,
    pub(crate) commits: Vec<GitCommit>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileChange {
    pub(crate) path: String,
    pub(crate) index_status: Option<String>,
    pub(crate) worktree_status: Option<String>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommit {
    pub(crate) hash: String,
    pub(crate) short_hash: String,
    pub(crate) parents: Vec<String>,
    pub(crate) author: String,
    pub(crate) relative_time: String,
    pub(crate) summary: String,
}

pub(crate) fn workspace(root: &Path) -> Result<GitWorkspace, String> {
    ensure_git_available()?;
    let repository_paths = discover_repositories(root)?;
    let mut repositories = Vec::with_capacity(repository_paths.len());

    for path in repository_paths {
        if let Ok(repository) = repository_snapshot(root, &path) {
            repositories.push(repository);
        }
    }

    repositories.sort_by(|left, right| {
        let left_root = left.relative_path == ".";
        let right_root = right.relative_path == ".";
        right_root.cmp(&left_root).then_with(|| {
            left.relative_path
                .to_lowercase()
                .cmp(&right.relative_path.to_lowercase())
        })
    });
    let total_changes = repositories
        .iter()
        .map(|repository| repository.changes.len())
        .sum();

    Ok(GitWorkspace {
        repositories,
        total_changes,
    })
}

pub(crate) fn stage_file(root: &Path, repository: &str, path: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    let path = validate_git_path(path)?;
    run_mutating_git(&repository, ["add", "--", path.as_str()]).map(|_| ())
}

pub(crate) fn unstage_file(root: &Path, repository: &str, path: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    let path = validate_git_path(path)?;

    if run_mutating_git(&repository, ["restore", "--staged", "--", path.as_str()]).is_ok() {
        return Ok(());
    }
    if run_mutating_git(&repository, ["reset", "HEAD", "--", path.as_str()]).is_ok() {
        return Ok(());
    }

    run_mutating_git(&repository, ["rm", "--cached", "--", path.as_str()]).map(|_| ())
}

pub(crate) fn stage_all(root: &Path, repository: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    run_mutating_git(&repository, ["add", "--all"]).map(|_| ())
}

pub(crate) fn commit(root: &Path, repository: &str, message: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    let message = validate_commit_message(message)?;
    run_mutating_git(&repository, ["commit", "--message", message]).map(|_| ())
}

pub(crate) fn amend(root: &Path, repository: &str, message: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    let message = validate_commit_message(message)?;
    run_mutating_git(&repository, ["commit", "--amend", "--message", message]).map(|_| ())
}

pub(crate) fn push(root: &Path, repository: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    push_repository(&repository)
}

pub(crate) fn sync(root: &Path, repository: &str) -> Result<(), String> {
    let repository = resolve_repository(root, repository)?;
    if has_upstream(&repository) {
        run_mutating_git(&repository, ["pull", "--rebase", "--autostash"])?;
    }
    push_repository(&repository)
}

fn validate_commit_message(message: &str) -> Result<&str, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Enter a commit message first.".to_owned());
    }
    if message.len() > 500 {
        return Err("Commit messages are limited to 500 bytes.".to_owned());
    }
    if message
        .chars()
        .any(|character| character == '\0' || character.is_control())
    {
        return Err("The commit message contains unsupported control characters.".to_owned());
    }
    Ok(message)
}

fn has_upstream(repository: &Path) -> bool {
    run_readonly_git(
        repository,
        [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .is_ok()
}

fn push_repository(repository: &Path) -> Result<(), String> {
    if has_upstream(repository) {
        return run_mutating_git(repository, ["push"]).map(|_| ());
    }

    let (branch, detached) = current_branch(repository)?;
    if detached {
        return Err("Cannot push while HEAD is detached. Check out a branch first.".to_owned());
    }
    if run_readonly_git(repository, ["remote", "get-url", "origin"]).is_err() {
        return Err(
            "No upstream is configured and the repository has no \"origin\" remote.".to_owned(),
        );
    }
    run_mutating_git(
        repository,
        ["push", "--set-upstream", "origin", branch.as_str()],
    )
    .map(|_| ())
}

fn ensure_git_available() -> Result<(), String> {
    let output = Command::new("git")
        .arg("--version")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Git is not installed or is not available in PATH: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err("Git is not available in PATH.".to_owned())
    }
}

fn discover_repositories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut repositories = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut visited = HashSet::new();
    let mut scanned = 0_usize;

    while let Some((directory, depth)) = queue.pop_front() {
        if repositories.len() >= MAX_REPOSITORIES || scanned >= MAX_SCAN_DIRECTORIES {
            break;
        }
        scanned += 1;

        let canonical = match fs::canonicalize(&directory) {
            Ok(path) if path.starts_with(root) => path,
            _ => continue,
        };
        if !visited.insert(canonical.clone()) {
            continue;
        }
        if has_git_metadata(&canonical) {
            repositories.push(canonical.clone());
        }
        if depth >= MAX_SCAN_DEPTH {
            continue;
        }

        let entries = match fs::read_dir(&canonical) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(error) => {
                return Err(format!(
                    "Could not scan {} for Git repositories: {error}",
                    canonical.display()
                ));
            }
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            if should_skip_directory(&name) {
                continue;
            }
            queue.push_back((entry.path(), depth + 1));
        }
    }

    Ok(repositories)
}

fn repository_snapshot(workspace_root: &Path, repository: &Path) -> Result<GitRepository, String> {
    let (branch, detached) = current_branch(repository)?;
    let (ahead, behind) = upstream_distance(repository);
    let output = run_readonly_git(
        repository,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let changes = parse_porcelain_status(&output.stdout);
    let commits = recent_commits(repository);
    let relative = repository.strip_prefix(workspace_root).map_err(|_| {
        format!(
            "Repository {} is outside the open workspace.",
            repository.display()
        )
    })?;
    let relative_path = if relative.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        path_to_slash_string(relative)
    };
    let name = repository
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| repository.to_string_lossy().into_owned());

    Ok(GitRepository {
        relative_path,
        name,
        branch,
        detached,
        ahead,
        behind,
        changes,
        commits,
    })
}

fn recent_commits(repository: &Path) -> Vec<GitCommit> {
    let max_count = format!("--max-count={MAX_GRAPH_COMMITS}");
    let output = run_readonly_git(
        repository,
        [
            "log",
            max_count.as_str(),
            "--date=relative",
            "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ar%x1f%s%x1e",
        ],
    );
    output
        .map(|value| parse_commit_log(&value.stdout))
        .unwrap_or_default()
}

fn parse_commit_log(bytes: &[u8]) -> Vec<GitCommit> {
    bytes
        .split(|byte| *byte == 0x1e)
        .filter_map(|record| {
            let record = trim_ascii_bytes(record);
            if record.is_empty() {
                return None;
            }
            let fields = record
                .splitn(6, |byte| *byte == 0x1f)
                .map(|field| String::from_utf8_lossy(field).into_owned())
                .collect::<Vec<_>>();
            if fields.len() != 6 || fields[0].is_empty() {
                return None;
            }

            Some(GitCommit {
                hash: fields[0].clone(),
                short_hash: fields[1].clone(),
                parents: fields[2].split_whitespace().map(str::to_owned).collect(),
                author: fields[3].clone(),
                relative_time: fields[4].clone(),
                summary: fields[5].clone(),
            })
        })
        .collect()
}

fn trim_ascii_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)
        .unwrap_or(start);
    &bytes[start..end]
}

fn current_branch(repository: &Path) -> Result<(String, bool), String> {
    let symbolic = run_readonly_git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if let Ok(output) = symbolic {
        return Ok((trim_output(&output.stdout), false));
    }

    let output = run_readonly_git(repository, ["rev-parse", "--short", "HEAD"])?;
    Ok((trim_output(&output.stdout), true))
}

fn upstream_distance(repository: &Path) -> (u32, u32) {
    let output = match run_readonly_git(
        repository,
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    ) {
        Ok(output) => output,
        Err(_) => return (0, 0),
    };
    let value = trim_output(&output.stdout);
    let mut counts = value.split_whitespace();
    let behind = counts
        .next()
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    let ahead = counts
        .next()
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    (ahead, behind)
}

fn parse_porcelain_status(bytes: &[u8]) -> Vec<GitFileChange> {
    let records: Vec<&[u8]> = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect();
    let mut changes = Vec::new();
    let mut index = 0_usize;

    while index < records.len() {
        let record = records[index];
        if record.len() < 3 {
            index += 1;
            continue;
        }

        let index_code = record[0] as char;
        let worktree_code = record[1] as char;
        if index_code == '!' && worktree_code == '!' {
            index += 1;
            continue;
        }

        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let (index_status, worktree_status) = if index_code == '?' && worktree_code == '?' {
            (None, Some("?".to_owned()))
        } else {
            (
                (index_code != ' ').then(|| index_code.to_string()),
                (worktree_code != ' ').then(|| worktree_code.to_string()),
            )
        };
        changes.push(GitFileChange {
            path,
            index_status,
            worktree_status,
        });

        index += 1;
        if matches!(index_code, 'R' | 'C') || matches!(worktree_code, 'R' | 'C') {
            index += 1;
        }
    }

    changes
}

fn resolve_repository(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = if relative == "." {
        root.to_path_buf()
    } else {
        root.join(validate_git_path(relative)?)
    };
    let canonical = fs::canonicalize(&candidate)
        .map_err(|error| format!("The selected repository no longer exists: {error}"))?;
    if !canonical.starts_with(root) || !has_git_metadata(&canonical) {
        return Err("The selected path is not a Git repository in this workspace.".to_owned());
    }
    Ok(canonical)
}

fn validate_git_path(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("Git paths cannot be empty.".to_owned());
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err("Only repository-relative Git paths are allowed.".to_owned());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("The Git path must stay inside its repository.".to_owned());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Git paths cannot be empty.".to_owned());
    }
    Ok(path_to_slash_string(&normalized))
}

fn run_readonly_git<const N: usize>(
    repository: &Path,
    arguments: [&str; N],
) -> Result<Output, String> {
    run_git(repository, arguments, true)
}

fn run_mutating_git<const N: usize>(
    repository: &Path,
    arguments: [&str; N],
) -> Result<Output, String> {
    run_git(repository, arguments, false)
}

fn run_git<const N: usize>(
    repository: &Path,
    arguments: [&str; N],
    readonly: bool,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    if readonly {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }

    let output = command
        .output()
        .map_err(|error| format!("Could not execute Git: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        let stderr = trim_output(&output.stderr);
        let stdout = trim_output(&output.stdout);
        let message = if !stderr.is_empty() { stderr } else { stdout };
        Err(if message.is_empty() {
            format!("Git exited with status {}.", output.status)
        } else {
            message
        })
    }
}

fn has_git_metadata(directory: &Path) -> bool {
    fs::symlink_metadata(directory.join(".git")).is_ok()
}

fn should_skip_directory(name: &OsStr) -> bool {
    matches!(
        name.to_string_lossy().as_ref(),
        ".git"
            | ".next"
            | ".turbo"
            | ".cache"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
    )
}

fn trim_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

fn path_to_slash_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parses_staged_worktree_and_untracked_changes() {
        let status = b"M  staged.rs\0 M modified.rs\0?? new file.ts\0MM both.rs\0";
        let changes = parse_porcelain_status(status);

        assert_eq!(
            changes,
            vec![
                GitFileChange {
                    path: "staged.rs".to_owned(),
                    index_status: Some("M".to_owned()),
                    worktree_status: None,
                },
                GitFileChange {
                    path: "modified.rs".to_owned(),
                    index_status: None,
                    worktree_status: Some("M".to_owned()),
                },
                GitFileChange {
                    path: "new file.ts".to_owned(),
                    index_status: None,
                    worktree_status: Some("?".to_owned()),
                },
                GitFileChange {
                    path: "both.rs".to_owned(),
                    index_status: Some("M".to_owned()),
                    worktree_status: Some("M".to_owned()),
                },
            ]
        );
    }

    #[test]
    fn skips_rename_source_record() {
        let changes = parse_porcelain_status(b"R  renamed.rs\0old.rs\0 M next.rs\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "renamed.rs");
        assert_eq!(changes[1].path, "next.rs");
    }

    #[test]
    fn parses_graph_commits() {
        let log = b"0123456789abcdef\x1f0123456\x1fparent-a parent-b\x1fAda Lovelace\x1f2 hours ago\x1fShip graph\x1e\n";
        let commits = parse_commit_log(log);

        assert_eq!(
            commits,
            vec![GitCommit {
                hash: "0123456789abcdef".to_owned(),
                short_hash: "0123456".to_owned(),
                parents: vec!["parent-a".to_owned(), "parent-b".to_owned()],
                author: "Ada Lovelace".to_owned(),
                relative_time: "2 hours ago".to_owned(),
                summary: "Ship graph".to_owned(),
            }]
        );
    }

    #[test]
    fn rejects_git_path_traversal() {
        assert!(validate_git_path("../outside.txt").is_err());
        assert!(validate_git_path("/absolute.txt").is_err());
        assert_eq!(
            validate_git_path("src/./main.rs").expect("safe path"),
            "src/main.rs"
        );
    }

    #[test]
    fn discovers_valid_repositories_and_ignores_invalid_markers() {
        if ensure_git_available().is_err() {
            return;
        }

        let workspace_root = TempDir::new().expect("temporary workspace");
        fs::create_dir(workspace_root.path().join(".git")).expect("invalid marker");
        let repository = workspace_root.path().join("packages").join("app");
        fs::create_dir_all(&repository).expect("repository directory");
        let init = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .arg("init")
            .output()
            .expect("git init");
        assert!(init.status.success());
        fs::write(repository.join("new.txt"), "content").expect("untracked file");
        let canonical_workspace =
            fs::canonicalize(workspace_root.path()).expect("canonical workspace");
        let canonical_repository = fs::canonicalize(&repository).expect("canonical repository");
        let direct = repository_snapshot(&canonical_workspace, &canonical_repository);
        assert!(direct.is_ok(), "repository snapshot failed: {direct:?}");

        let result = workspace(&canonical_workspace).expect("workspace snapshot");
        assert_eq!(result.repositories.len(), 1);
        assert_eq!(result.repositories[0].relative_path, "packages/app");
        assert_eq!(result.repositories[0].changes.len(), 1);
    }

    #[test]
    fn stages_unstages_and_commits_in_a_repository() {
        if ensure_git_available().is_err() {
            return;
        }

        let temporary = TempDir::new().expect("temporary repository");
        let repository = fs::canonicalize(temporary.path()).expect("canonical repository");
        let init = Command::new("git")
            .arg("-C")
            .arg(&repository)
            .arg("init")
            .output()
            .expect("git init");
        assert!(init.status.success());
        run_mutating_git(&repository, ["config", "user.name", "NullPointer Test"])
            .expect("configure author");
        run_mutating_git(
            &repository,
            ["config", "user.email", "nullpointer@example.invalid"],
        )
        .expect("configure email");
        run_mutating_git(&repository, ["config", "commit.gpgSign", "false"])
            .expect("disable signing");

        fs::write(repository.join("tracked.txt"), "initial").expect("initial file");
        run_mutating_git(&repository, ["add", "--", "tracked.txt"]).expect("initial stage");
        run_mutating_git(&repository, ["commit", "--message", "initial"]).expect("initial commit");
        fs::write(repository.join("tracked.txt"), "changed").expect("changed file");

        stage_file(&repository, ".", "tracked.txt").expect("stage file");
        let staged = workspace(&repository).expect("staged snapshot");
        assert_eq!(
            staged.repositories[0].changes[0].index_status.as_deref(),
            Some("M")
        );

        unstage_file(&repository, ".", "tracked.txt").expect("unstage file");
        let unstaged = workspace(&repository).expect("unstaged snapshot");
        assert_eq!(
            unstaged.repositories[0].changes[0]
                .worktree_status
                .as_deref(),
            Some("M")
        );

        stage_all(&repository, ".").expect("stage all");
        commit(&repository, ".", "tested source control").expect("create commit");
        let clean = workspace(&repository).expect("clean snapshot");
        assert_eq!(clean.total_changes, 0);
        assert_eq!(
            clean.repositories[0].commits[0].summary,
            "tested source control"
        );

        amend(&repository, ".", "amended source control").expect("amend commit");
        let amended = workspace(&repository).expect("amended snapshot");
        assert_eq!(
            amended.repositories[0].commits[0].summary,
            "amended source control"
        );

        let remote = TempDir::new().expect("temporary remote");
        let init_remote = Command::new("git")
            .arg("-C")
            .arg(remote.path())
            .args(["init", "--bare"])
            .output()
            .expect("initialize remote");
        assert!(init_remote.status.success());
        let remote_path = remote.path().to_string_lossy();
        run_mutating_git(
            &repository,
            ["remote", "add", "origin", remote_path.as_ref()],
        )
        .expect("configure remote");
        push(&repository, ".").expect("push and configure upstream");
        assert!(has_upstream(&repository));
        sync(&repository, ".").expect("sync repository");
    }
}
