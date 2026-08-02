import { describe, expect, it } from "vitest";
import { shouldCopyTerminalSelection } from "./keyboard";

function keyEvent(
  overrides: Partial<Parameters<typeof shouldCopyTerminalSelection>[0]> = {},
): Parameters<typeof shouldCopyTerminalSelection>[0] {
  return {
    type: "keydown",
    key: "c",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("terminal copy shortcut", () => {
  it("copies Ctrl+C only while terminal text is selected", () => {
    expect(shouldCopyTerminalSelection(keyEvent(), true)).toBe(true);
    expect(shouldCopyTerminalSelection(keyEvent(), false)).toBe(false);
  });

  it("supports uppercase, Ctrl+Shift+C, and the macOS command key", () => {
    expect(shouldCopyTerminalSelection(keyEvent({ key: "C" }), true)).toBe(true);
    expect(shouldCopyTerminalSelection(keyEvent({ shiftKey: true }), true)).toBe(true);
    expect(
      shouldCopyTerminalSelection(
        keyEvent({ ctrlKey: false, metaKey: true }),
        true,
      ),
    ).toBe(true);
  });

  it("does not intercept keyup or Alt-modified shortcuts", () => {
    expect(shouldCopyTerminalSelection(keyEvent({ type: "keyup" }), true)).toBe(false);
    expect(shouldCopyTerminalSelection(keyEvent({ altKey: true }), true)).toBe(false);
  });
});
