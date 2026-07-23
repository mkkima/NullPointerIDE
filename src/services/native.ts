import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppError,
  CreateKind,
  FileDocument,
  GitWorkspace,
  ProjectSnapshot,
  SaveResult,
} from "../types";

function requireDesktopRuntime(): void {
  if (!isTauri()) {
    throw {
      code: "desktop_only",
      message: "Folder access is available in the Tauri desktop app. Run `npm run tauri dev`.",
    } satisfies AppError;
  }
}

export async function chooseProjectFolder(): Promise<string | null> {
  requireDesktopRuntime();
  const selection = await open({
    directory: true,
    multiple: false,
    title: "Open project folder",
  });
  return typeof selection === "string" ? selection : null;
}

export async function openProject(path: string): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return invoke<ProjectSnapshot>("open_project", { path });
}

export async function refreshProject(): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return invoke<ProjectSnapshot>("refresh_project");
}

export async function readProjectFile(relativePath: string): Promise<FileDocument> {
  requireDesktopRuntime();
  return invoke<FileDocument>("read_project_file", { relativePath });
}

export async function writeProjectFile(
  relativePath: string,
  content: string,
  expectedModifiedAtMs: number,
): Promise<SaveResult> {
  requireDesktopRuntime();
  return invoke<SaveResult>("write_project_file", {
    relativePath,
    content,
    expectedModifiedAtMs,
  });
}

export async function createProjectEntry(
  relativePath: string,
  kind: CreateKind,
): Promise<ProjectSnapshot> {
  requireDesktopRuntime();
  return invoke<ProjectSnapshot>("create_project_entry", { relativePath, kind });
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
): Promise<GitWorkspace> {
  requireDesktopRuntime();
  return invoke<GitWorkspace>("git_commit_repository", { repository, message });
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
