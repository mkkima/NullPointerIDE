import { describe, expect, it } from "vitest";
import {
  changeInterfaceScale,
  DEFAULT_INTERFACE_SCALE,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  normalizeInterfaceScale,
  parseStoredInterfaceScale,
} from "./model";

describe("interface scale model", () => {
  it("uses the default for missing or invalid persisted values", () => {
    expect(parseStoredInterfaceScale(null)).toBe(DEFAULT_INTERFACE_SCALE);
    expect(parseStoredInterfaceScale("")).toBe(DEFAULT_INTERFACE_SCALE);
    expect(parseStoredInterfaceScale("not-a-number")).toBe(DEFAULT_INTERFACE_SCALE);
  });

  it("rounds persisted values to a supported step and clamps the range", () => {
    expect(parseStoredInterfaceScale("123")).toBe(125);
    expect(parseStoredInterfaceScale("25")).toBe(MIN_INTERFACE_SCALE);
    expect(parseStoredInterfaceScale("300")).toBe(MAX_INTERFACE_SCALE);
  });

  it("does not move past either scale boundary", () => {
    expect(changeInterfaceScale(MIN_INTERFACE_SCALE, -1)).toBe(MIN_INTERFACE_SCALE);
    expect(changeInterfaceScale(MAX_INTERFACE_SCALE, 1)).toBe(MAX_INTERFACE_SCALE);
    expect(normalizeInterfaceScale(Number.NaN)).toBe(DEFAULT_INTERFACE_SCALE);
  });
});
