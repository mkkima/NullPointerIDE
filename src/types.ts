export type EntryKind = "file" | "directory";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: EntryKind;
  readonly isSymlink: boolean;
  readonly children: readonly FileEntry[];
}

export interface ProjectSnapshot {
  readonly rootPath: string;
  readonly name: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}

export interface FileDocument {
  readonly path: string;
  readonly content: string;
  readonly modifiedAtMs: number;
  readonly size: number;
}

export interface SaveResult {
  readonly modifiedAtMs: number;
  readonly size: number;
}

export interface AppRelease {
  readonly version: string;
  readonly name: string;
  readonly notes: string;
  readonly publishedAt: string | null;
  readonly releaseUrl: string;
  readonly updateAvailable: boolean;
}

export type AppUpdateEvent =
  | {
      readonly event: "started";
      readonly data: { readonly content_length: number | null };
    }
  | {
      readonly event: "progress";
      readonly data: { readonly chunk_length: number };
    }
  | { readonly event: "finished" };

export type ResearchModel =
  | "chatgpt"
  | "gemini"
  | "claude"
  | "deepseek"
  | "grok"
  | "qwen"
  | "perplexity";

export interface ResearchDraft {
  readonly id: string;
  readonly model: ResearchModel;
  readonly content: string;
  readonly heightPx: number;
}

export interface ResearchSavedFile {
  readonly model: ResearchModel;
  readonly fileName: string;
  readonly path: string;
}

export interface ResearchWorkspaceState {
  readonly version: 1;
  readonly folderPath: string;
  readonly drafts: readonly ResearchDraft[];
  readonly savedFiles: readonly ResearchSavedFile[];
}

export interface ResearchFileInput {
  readonly model: ResearchModel;
  readonly content: string;
}

export interface AppError {
  readonly code: string;
  readonly message: string;
}

export type CreateKind = "file" | "directory";

export interface GitWorkspace {
  readonly repositories: readonly GitRepository[];
  readonly totalChanges: number;
}

export type GitCommitAction = "commit" | "commit-amend" | "commit-push" | "commit-sync";

export interface GitCommitResult {
  readonly workspace: GitWorkspace;
  readonly warning: string | null;
}

export interface GitRepository {
  readonly relativePath: string;
  readonly name: string;
  readonly branch: string;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly changes: readonly GitFileChange[];
  readonly commits: readonly GitCommit[];
}

export interface GitFileChange {
  readonly path: string;
  readonly indexStatus: string | null;
  readonly worktreeStatus: string | null;
}

export interface GitCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly relativeTime: string;
  readonly summary: string;
}
