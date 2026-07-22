import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { FileDocument } from "../types";
import { languageExtension } from "./languages";
import { editorTheme } from "./theme";

interface Session {
  state: EditorState;
  savedContent: string;
  modifiedAtMs: number;
  size: number;
}

interface EditorCallbacks {
  readonly onDirtyChange: (path: string, dirty: boolean) => void;
  readonly onCursorChange: (line: number, column: number) => void;
}

const commonExtensions: readonly Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter({ openText: "⌄", closedText: "›" }),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion({ activateOnTyping: true }),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    indentWithTab,
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...completionKeymap,
  ]),
  editorTheme,
];

export class EditorController {
  private readonly sessions = new Map<string, Session>();
  private readonly view: EditorView;
  private activePath: string | null = null;

  constructor(parent: HTMLElement, private readonly callbacks: EditorCallbacks) {
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: [EditorState.readOnly.of(true), editorTheme],
      }),
    });
  }

  get active(): string | null {
    return this.activePath;
  }

  get paths(): readonly string[] {
    return [...this.sessions.keys()];
  }

  has(path: string): boolean {
    return this.sessions.has(path);
  }

  async add(document: FileDocument, shouldCommit: () => boolean = () => true): Promise<boolean> {
    const existing = this.sessions.get(document.path);
    if (existing) {
      this.activate(document.path);
      return true;
    }

    const language = await languageExtension(document.path);
    if (!shouldCommit()) return false;
    let session: Session;
    const state = EditorState.create({
      doc: document.content,
      extensions: [
        ...commonExtensions,
        language,
        EditorView.updateListener.of((update) => {
          session.state = update.state;
          if (update.docChanged) {
            this.callbacks.onDirtyChange(
              document.path,
              update.state.doc.toString() !== session.savedContent,
            );
          }
          if ((update.selectionSet || update.docChanged) && this.activePath === document.path) {
            this.emitCursor(update.state);
          }
        }),
      ],
    });
    session = {
      state,
      savedContent: document.content,
      modifiedAtMs: document.modifiedAtMs,
      size: document.size,
    };
    this.sessions.set(document.path, session);
    this.activate(document.path);
    return true;
  }

  activate(path: string): boolean {
    const session = this.sessions.get(path);
    if (!session) return false;
    this.activePath = path;
    this.view.setState(session.state);
    this.view.focus();
    this.emitCursor(session.state);
    return true;
  }

  content(path: string): string | null {
    return this.sessions.get(path)?.state.doc.toString() ?? null;
  }

  modifiedAt(path: string): number | null {
    return this.sessions.get(path)?.modifiedAtMs ?? null;
  }

  isDirty(path: string): boolean {
    const session = this.sessions.get(path);
    return session ? session.state.doc.toString() !== session.savedContent : false;
  }

  markSaved(path: string, modifiedAtMs: number, size: number): void {
    const session = this.sessions.get(path);
    if (!session) return;
    session.savedContent = session.state.doc.toString();
    session.modifiedAtMs = modifiedAtMs;
    session.size = size;
    this.callbacks.onDirtyChange(path, false);
  }

  close(path: string): void {
    this.sessions.delete(path);
    if (this.activePath === path) this.activePath = null;
  }

  reset(): void {
    this.sessions.clear();
    this.activePath = null;
    this.view.setState(
      EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), editorTheme] }),
    );
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    this.view.destroy();
  }

  private emitCursor(state: EditorState): void {
    const position = state.selection.main.head;
    const line = state.doc.lineAt(position);
    this.callbacks.onCursorChange(line.number, position - line.from + 1);
  }
}
