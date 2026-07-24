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
