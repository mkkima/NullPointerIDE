import type { FileEntry } from "../types";

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  cjs: "JavaScript",
  css: "CSS",
  htm: "HTML",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  jsx: "JavaScript JSX",
  markdown: "Markdown",
  md: "Markdown",
  mjs: "JavaScript",
  py: "Python",
  pyi: "Python",
  rs: "Rust",
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  txt: "Plain Text",
};

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function languageName(path: string): string {
  return LANGUAGE_NAMES[extension(path)] ?? "Plain Text";
}

export function flattenFiles(entries: readonly FileEntry[]): FileEntry[] {
  const files: FileEntry[] = [];
  const visit = (nodes: readonly FileEntry[]): void => {
    for (const node of nodes) {
      if (node.kind === "file") {
        files.push(node);
      } else {
        visit(node.children);
      }
    }
  };
  visit(entries);
  return files;
}

export function fuzzyScore(value: string, rawQuery: string): number | null {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return 0;

  const candidate = value.toLowerCase();
  let score = 0;
  let queryIndex = 0;
  let previousMatch = -2;

  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;

    score += index === previousMatch + 1 ? 8 : 2;
    if (index === 0 || "/_- .".includes(candidate[index - 1] ?? "")) score += 5;
    previousMatch = index;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return null;
  return score - candidate.length * 0.015;
}

export function findQuickOpenMatches(
  entries: readonly FileEntry[],
  query: string,
  limit = 80,
): FileEntry[] {
  return flattenFiles(entries)
    .map((entry) => ({ entry, score: fuzzyScore(entry.path, query) }))
    .filter((item): item is { entry: FileEntry; score: number } => item.score !== null)
    .sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
    .slice(0, limit)
    .map((item) => item.entry);
}

export function validateNewPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    return null;
  }
  return parts.join("/");
}
