type TerminalCopyKeyEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

export function shouldCopyTerminalSelection(
  event: TerminalCopyKeyEvent,
  hasSelection: boolean,
): boolean {
  return (
    hasSelection &&
    event.type === "keydown" &&
    event.key.toLowerCase() === "c" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey
  );
}
