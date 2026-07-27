import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppError,
  AppRelease,
  AppUpdateEvent,
  CreateKind,
  FileDocument,
  FileEntry,
  GitCommitAction,
  GitCommitResult,
  GitWorkspace,
  ProjectSnapshot,
  ResearchFileInput,
  ResearchSavedFile,
  ResearchWorkspaceState,
  SaveResult,
  WorkspaceRootSnapshot,
} from "../types";
import { splitWorkspaceFilePath, workspaceFilePath } from "../utils/files";

export type TerminalShell =
  | "default"
  | "powershell-core"
  | "windows-powershell"
  | "command-prompt"
  | "bash"
  | "zsh";

export type TerminalEvent =
  | { readonly event: "output"; readonly data: string }
  | { readonly event: "exit"; readonly code: number; readonly signal: string | null }
  | { readonly event: "error"; readonly message: string };

export interface TerminalInfo {
  readonly id: number;
  readonly shell: TerminalShell;
  readonly label: string;
  readonly cwd: string;
  readonly processId: number | null;
}

interface NativeFileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly isSymlink: boolean;
  readonly children: readonly NativeFileEntry[];
}

interface NativeWorkspaceRoot {
  readonly id: string;
  readonly rootPath: string;
  readonly name: string;
  readonly entries: readonly NativeFileEntry[];
  readonly truncated: boolean;
}

interface NativeWorkspaceSnapshot {
  readonly roots: readonly NativeWorkspaceRoot[];
}

function hydrateWorkspace(snapshot: NativeWorkspaceSnapshot): ProjectSnapshot {
  const hydrateEntry = (
    root: NativeWorkspaceRoot,
    entry: NativeFileEntry,
  ): FileEntry => ({
    name: entry.name,
    path: workspaceFilePath(root.id, entry.path),
    relativePath: entry.path,
    rootId: root.id,
    rootName: root.name,
    kind: entry.kind,
    isSymlink: entry.isSymlink,
    children: entry.children.map((child) => hydrateEntry(root, child)),
  });
  const roots: WorkspaceRootSnapshot[] = snapshot.roots.map((root) => ({
    id: root.id,
    rootPath: root.rootPath,
    name: root.name,
    entries: root.entries.map((entry) => hydrateEntry(root, entry)),
    truncated: root.truncated,
  }));
  return {
    roots,
    rootPath: roots[0]?.rootPath ?? "",
    name: roots.length === 1 ? (roots[0]?.name ?? "") : `${roots.length} folders`,
    entries: roots.flatMap((root) => root.entries),
    truncated: roots.some((root) => root.truncated),
  };
}

function requireWorkspaceFilePath(path: string): {
  readonly rootId: string;
  readonly relativePath: string;
} {
  const parsed = splitWorkspaceFilePath(path);
  if (parsed) return parsed;
  throw {
    code: "invalid_workspace_path",
    message: "The selected file does not belong to an open workspace folder.",
  } satisfies AppError;
}

function requireDesktopRuntime(): void {
  if (!isTauri()) {
    throw {
      code: "desktop_only",
      message: "Folder access is available in the Tauri desktop app. Run `npm run tauri dev`.",
    } satisfies AppError;
  }
}

export async function chooseProjectFolder(
  title = "Open project folder",
): Promise<string | null> {
  requireDesktopRuntime();
  const selection = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selection === "string" ? selection : null;
}

export async function isProductionBuild(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("is_production_build");
}

export async function isPortableBuild(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("is_portable_build");
}

export async function listAppReleases(): Promise<readonly AppRelease[]> {
  requireDesktopRuntime();
  return invoke<readonly AppRelease[]>("list_app_releases");
}

export async function installAppVersion(
  version: string,
  onEvent: (event: AppUpdateEvent) => void,
): Promise<void> {
  requireDesktopRuntime();
  const channel = new Channel<AppUpdateEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("install_app_version", { version, onEvent: channel });
}

export async function chooseResearchFolder(): Promise<string | null> {
  requireDesktopRuntime();
  const selection = await open({
    directory: true,
    multiple: false,
    title: "Choose research folder",
  });
  return typeof selection === "string" ? selection : null;
}

export async function openProject(path: string): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return hydrateWorkspace(await invoke<NativeWorkspaceSnapshot>("open_project", { path }));
}

export async function addWorkspaceFolder(path: string): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return hydrateWorkspace(
    await invoke<NativeWorkspaceSnapshot>("add_workspace_folder", { path }),
  );
}

export async function removeWorkspaceFolder(rootId: string): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return hydrateWorkspace(
    await invoke<NativeWorkspaceSnapshot>("remove_workspace_folder", { rootId }),
  );
}

export async function refreshProject(): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return hydrateWorkspace(await invoke<NativeWorkspaceSnapshot>("refresh_project"));
}

export async function readProjectFile(path: string): Promise<FileDocument> {
  requireDesktopRuntime();
  const { rootId, relativePath } = requireWorkspaceFilePath(path);
  const document = await invoke<FileDocument>("read_project_file", {
    rootId,
    relativePath,
  });
  return { ...document, path };
}

export async function writeProjectFile(
  path: string,
  content: string,
  expectedModifiedAtMs: number,
): Promise<SaveResult> {
  requireDesktopRuntime();
  const { rootId, relativePath } = requireWorkspaceFilePath(path);
  return invoke<SaveResult>("write_project_file", {
    rootId,
    relativePath,
    content,
    expectedModifiedAtMs,
  });
}

export async function createProjectEntry(
  rootId: string,
  relativePath: string,
  kind: CreateKind,
): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return hydrateWorkspace(
    await invoke<NativeWorkspaceSnapshot>("create_project_entry", {
      rootId,
      relativePath,
      kind,
    }),
  );
}

export async function getGitWorkspace(): Promise<GitWorkspace> {
  requireDesktopRuntime();
  return invoke<GitWorkspace>("get_git_workspace");
}

export async function gitStageFile(repository: string, path: string): Promise<GitWorkspace> {
  requireDesktopRuntime();
  return invoke<GitWorkspace>("git_stage_file", { repository, path });
}

export async function gitUnstageFile(repository: string, path: string): Promise<GitWorkspace> {
  requireDesktopRuntime();
  return invoke<GitWorkspace>("git_unstage_file", { repository, path });
}

export async function gitStageAll(repository: string): Promise<GitWorkspace> {
  requireDesktopRuntime();
  return invoke<GitWorkspace>("git_stage_all", { repository });
}

export async function gitCommitRepository(
  repository: string,
  message: string,
  action: GitCommitAction,
): Promise<GitCommitResult> {
  requireDesktopRuntime();
  return invoke<GitCommitResult>("git_commit_repository", { repository, message, action });
}

export async function loadResearchState(): Promise<ResearchWorkspaceState | null> {
  requireDesktopRuntime();
  return invoke<ResearchWorkspaceState | null>("load_research_state");
}

export async function saveResearchState(
  researchState: ResearchWorkspaceState,
): Promise<void> {
  requireDesktopRuntime();
  return invoke<void>("save_research_state", { researchState });
}

export async function saveResearchFiles(
  folderPath: string,
  entries: readonly ResearchFileInput[],
): Promise<readonly ResearchSavedFile[]> {
  requireDesktopRuntime();
  return invoke<readonly ResearchSavedFile[]>("save_research_files", {
    folderPath,
    entries,
  });
}

export async function startTerminal(
  shell: TerminalShell,
  cwd: string | null,
  rows: number,
  cols: number,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalInfo> {
  requireDesktopRuntime();
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = onEvent;
  return invoke<TerminalInfo>("terminal_start", {
    shell,
    cwd,
    rows,
    cols,
    onEvent: channel,
  });
}

export async function writeTerminal(id: number, data: string): Promise<void> {
  requireDesktopRuntime();
  return invoke<void>("terminal_write", { id, data });
}

export async function resizeTerminal(
  id: number,
  rows: number,
  cols: number,
): Promise<void> {
  requireDesktopRuntime();
  return invoke<void>("terminal_resize", { id, rows, cols });
}

export async function killTerminal(id: number): Promise<void> {
  requireDesktopRuntime();
  return invoke<void>("terminal_kill", { id });
}

export function toAppError(error: unknown): AppError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.message === "string") {
      return {
        code: typeof candidate.code === "string" ? candidate.code : "unknown",
        message: candidate.message,
      };
    }
  }
  if (typeof error === "string") {
    return { code: "unknown", message: error };
  }
  return { code: "unknown", message: "An unexpected error occurred." };
}
