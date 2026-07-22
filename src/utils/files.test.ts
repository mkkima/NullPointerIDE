import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { basename, findQuickOpenMatches, fuzzyScore, validateNewPath } from "./files";

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
      { name: "app.ts", path: "src/app.ts", kind: "file", isSymlink: false, children: [] },
      { name: "api.ts", path: "src/api.ts", kind: "file", isSymlink: false, children: [] },
      { name: "readme.md", path: "readme.md", kind: "file", isSymlink: false, children: [] },
    ];
    expect(findQuickOpenMatches(entries, "ap", 1)).toHaveLength(1);
    expect(findQuickOpenMatches(entries, "readme")[0]?.path).toBe("readme.md");
  });

  it("rejects absolute and traversing new paths", () => {
    expect(validateNewPath("src/new.ts")).toBe("src/new.ts");
    expect(validateNewPath("../secret")).toBeNull();
    expect(validateNewPath("C:\\secret")).toBeNull();
    expect(validateNewPath("src//main.ts")).toBeNull();
  });
});

