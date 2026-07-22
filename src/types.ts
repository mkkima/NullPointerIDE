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

