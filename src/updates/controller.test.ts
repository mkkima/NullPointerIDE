import { describe, expect, it } from "vitest";
import { compareVersions } from "./controller";

describe("application version comparison", () => {
  it("compares numeric segments instead of lexicographic text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("orders stable releases after prereleases", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0);
  });
});
