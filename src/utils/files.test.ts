import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import {
  basename,
  findQuickOpenMatches,
  fuzzyScore,
  splitWorkspaceFilePath,
  validateNewPath,
  workspaceFilePath,
} from "./files";

describe("file utilities", () => {
  it("extracts a basename from project-relative paths", () => {
    expect(basename("src/editor/main.ts")).toBe("main.ts");
  });

  it("ranks contiguous fuzzy matches above scattered matches", () => {
    expect(fuzzyScore("src/main.ts", "main")).toBeGreaterThan(
      fuzzyScore("src/models/admin-index.ts", "main") ?? -Infinity,
    );
  });

  it("filters and limits quick-open results", () => {
    const entries: FileEntry[] = [
      {
        name: "app.ts",
        path: "root-1/src/app.ts",
        relativePath: "src/app.ts",
        rootId: "root-1",
        rootName: "app",
        kind: "file",
        isSymlink: false,
        children: [],
      },
      {
        name: "api.ts",
        path: "root-1/src/api.ts",
        relativePath: "src/api.ts",
        rootId: "root-1",
        rootName: "app",
        kind: "file",
        isSymlink: false,
        children: [],
      },
      {
        name: "readme.md",
        path: "root-1/readme.md",
        relativePath: "readme.md",
        rootId: "root-1",
        rootName: "app",
        kind: "file",
        isSymlink: false,
        children: [],
      },
    ];
    expect(findQuickOpenMatches(entries, "ap", 1)).toHaveLength(1);
    expect(findQuickOpenMatches(entries, "readme")[0]?.path).toBe("root-1/readme.md");
  });

  it("keeps same-named files from different workspace folders distinct", () => {
    const fixture = (rootId: string, rootName: string): FileEntry => ({
      name: "index.ts",
      path: workspaceFilePath(rootId, "src/index.ts"),
      relativePath: "src/index.ts",
      rootId,
      rootName,
      kind: "file",
      isSymlink: false,
      children: [],
    });
    const matches = findQuickOpenMatches(
      [fixture("root-1", "frontend"), fixture("root-2", "backend")],
      "index",
    );

    expect(matches.map((entry) => entry.path).sort()).toEqual([
      "root-1/src/index.ts",
      "root-2/src/index.ts",
    ]);
  });

  it("round-trips virtual workspace file paths", () => {
    const path = workspaceFilePath("root-42", "src/main.ts");
    expect(splitWorkspaceFilePath(path)).toEqual({
      rootId: "root-42",
      relativePath: "src/main.ts",
    });
    expect(splitWorkspaceFilePath("../outside.ts")).toBeNull();
  });

  it("rejects absolute and traversing new paths", () => {
    expect(validateNewPath("src/new.ts")).toBe("src/new.ts");
    expect(validateNewPath("../secret")).toBeNull();
    expect(validateNewPath("C:\\secret")).toBeNull();
    expect(validateNewPath("src//main.ts")).toBeNull();
  });
});
