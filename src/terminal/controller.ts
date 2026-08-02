import type { SearchAddon } from "@xterm/addon-search";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal, IDisposable, ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  killTerminal,
  resizeTerminal,
  startTerminal,
  toAppError,
  writeTerminal,
  type TerminalEvent,
  type TerminalShell,
} from "../services/native";
import { icon } from "../ui/icons";
import { shouldCopyTerminalSelection } from "./keyboard";

const SETTINGS_KEY = "nullpointer:terminal-settings";
const HEIGHT_KEY = "nullpointer:terminal-height";
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;
const MAX_SESSIONS = 8;
const INPUT_CHUNK_LENGTH = 12_000;
const PANEL_ANIMATION_MS = 180;
const SESSION_ANIMATION_MS = 190;

interface TerminalLibraries {
  readonly Terminal: typeof import("@xterm/xterm").Terminal;
  readonly FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  readonly SearchAddon: typeof import("@xterm/addon-search").SearchAddon;
}

let terminalLibrariesPromise: Promise<TerminalLibraries> | null = null;

function loadTerminalLibraries(): Promise<TerminalLibraries> {
  if (!terminalLibrariesPromise) {
    const loading = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([xterm, fit, search]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      SearchAddon: search.SearchAddon,
    }));
    terminalLibrariesPromise = loading;
    void loading.catch(() => {
      if (terminalLibrariesPromise === loading) terminalLibrariesPromise = null;
    });
  }
  return terminalLibrariesPromise;
}

type CursorStyle = "block" | "bar" | "underline";

interface TerminalSettings {
  shell: TerminalShell;
  fontSize: number;
  cursorStyle: CursorStyle;
  scrollback: number;
}

interface TerminalSession {
  readonly clientId: number;
  readonly terminal: Terminal;
  readonly fit: FitAddon;
  readonly search: SearchAddon;
  readonly view: HTMLElement;
  readonly disposables: IDisposable[];
  shell: TerminalShell;
  label: string;
  backendId: number | null;
  generation: number;
  exited: boolean;
  pendingInput: string[];
  writingInput: boolean;
  resizeTimer: number | null;
  cwd: string | null;
}

export interface TerminalWorkspaceFolder {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

interface TerminalCallbacks {
  readonly getCwd: () => string | null;
  readonly getWorkspaceFolders: () => readonly TerminalWorkspaceFolder[];
  readonly getActiveWorkspaceFolderId: () => string | null;
  readonly onWorkspaceFolderSelected: (id: string) => void;
  readonly onToast: (
    message: string,
    tone: "success" | "warning" | "error" | "neutral",
    timeout?: number,
  ) => void;
}

const TERMINAL_THEME: ITheme = {
  background: "#000000",
  foreground: "#d8d8d8",
  cursor: "#f2f2f2",
  cursorAccent: "#000000",
  selectionBackground: "#ffffff2e",
  selectionInactiveBackground: "#ffffff18",
  black: "#111111",
  red: "#db8290",
  green: "#8fc5ad",
  yellow: "#d7b77c",
  blue: "#83aee7",
  magenta: "#b99add",
  cyan: "#79b9c6",
  white: "#dedede",
  brightBlack: "#747474",
  brightRed: "#ee9ca8",
  brightGreen: "#a8d8bf",
  brightYellow: "#e8ca91",
  brightBlue: "#9cc2ef",
  brightMagenta: "#ceb2e8",
  brightCyan: "#96ced8",
  brightWhite: "#ffffff",
};

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Required terminal element not found: ${selector}`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function shellLabel(shell: TerminalShell): string {
  switch (shell) {
    case "powershell-core":
      return "PowerShell";
    case "windows-powershell":
      return "Windows PowerShell";
    case "command-prompt":
      return "Command Prompt";
    case "bash":
      return "Bash";
    case "zsh":
      return "Zsh";
    default:
      return "Default shell";
  }
}

function decodeTerminalOutput(data: string): Uint8Array {
  const binary = atob(data);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

export class TerminalController {
  private readonly shell: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly views: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly statusButton: HTMLButtonElement;
  private readonly shellPicker: HTMLElement;
  private readonly shellTrigger: HTMLButtonElement;
  private readonly shellMenu: HTMLElement;
  private readonly shellLabelElement: HTMLElement;
  private readonly cwdPicker: HTMLElement;
  private readonly cwdTrigger: HTMLButtonElement;
  private readonly cwdMenu: HTMLElement;
  private readonly cwdLabel: HTMLElement;
  private readonly searchWrap: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly settingsPopover: HTMLElement;
  private readonly fontSizeValue: HTMLElement;
  private readonly cursorSelect: HTMLSelectElement;
  private readonly scrollbackSelect: HTMLSelectElement;
  private readonly callbacks: TerminalCallbacks;
  private readonly sessions: TerminalSession[] = [];
  private readonly resizeObserver: ResizeObserver;

  private settings: TerminalSettings;
  private activeClientId: number | null = null;
  private nextClientId = 1;
  private pendingSessions = 0;
  private open = false;
  private maximized = false;
  private previousHeight = DEFAULT_HEIGHT;
  private height = DEFAULT_HEIGHT;
  private fitFrame: number | null = null;
  private panelCloseTimer: number | null = null;
  private readonly enteringClientIds = new Set<number>();

  constructor(shell: HTMLElement, panel: HTMLElement, callbacks: TerminalCallbacks) {
    this.shell = shell;
    this.panel = panel;
    this.callbacks = callbacks;
    this.views = required(panel, "#terminal-views");
    this.tabs = required(panel, "#terminal-tabs");
    this.statusButton = required(shell, "#terminal-status-button");
    this.shellPicker = required(panel, "#terminal-shell-picker");
    this.shellTrigger = required(panel, "#terminal-shell-trigger");
    this.shellMenu = required(panel, "#terminal-shell-menu");
    this.shellLabelElement = required(panel, "#terminal-shell-label");
    this.cwdPicker = required(panel, "#terminal-cwd-picker");
    this.cwdTrigger = required(panel, "#terminal-cwd-trigger");
    this.cwdMenu = required(panel, "#terminal-cwd-menu");
    this.cwdLabel = required(panel, "#terminal-cwd-label");
    this.searchWrap = required(panel, "#terminal-search");
    this.searchInput = required(panel, "#terminal-search-input");
    this.settingsPopover = required(panel, "#terminal-settings");
    this.fontSizeValue = required(panel, "#terminal-font-size-value");
    this.cursorSelect = required(panel, "#terminal-cursor-style");
    this.scrollbackSelect = required(panel, "#terminal-scrollback");
    this.settings = this.loadSettings();
    this.restoreHeight();
    this.applySettingsToControls();
    this.bindEvents();

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.views);
    this.sync();
    this.syncWorkspaceFolders();
  }

  syncWorkspaceFolders(): void {
    const folders = this.callbacks.getWorkspaceFolders();
    const activeId = this.callbacks.getActiveWorkspaceFolderId();
    this.cwdPicker.classList.toggle("hidden", folders.length <= 1);
    const active = folders.find((folder) => folder.id === activeId) ?? folders[0];
    this.cwdLabel.textContent = active?.name ?? "Workspace folder";
    this.cwdTrigger.title = active
      ? `New terminals start in ${active.path}`
      : "Working folder for new terminals";

    const fragment = document.createDocumentFragment();
    for (const folder of folders) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.terminalRoot = folder.id;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(folder.id === active?.id));
      option.classList.toggle("selected", folder.id === active?.id);
      option.title = folder.path;
      const label = document.createElement("span");
      label.textContent = folder.name;
      option.append(label);
      if (folder.id === active?.id) {
        const selected = document.createElement("span");
        selected.innerHTML = icon("check", 13);
        option.append(selected);
      }
      fragment.append(option);
    }
    this.cwdMenu.replaceChildren(fragment);
    if (folders.length <= 1) this.hideCwdMenu();
  }

  handleGlobalKeydown(event: KeyboardEvent): boolean {
    const command = event.ctrlKey || event.metaKey;
    if (!command) return false;

    if (event.code === "Backquote") {
      event.preventDefault();
      if (event.shiftKey) {
        void this.createSession();
      } else {
        void this.toggle();
      }
      return true;
    }

    if (
      event.key.toLowerCase() === "f" &&
      this.open &&
      this.panel.contains(document.activeElement)
    ) {
      event.preventDefault();
      this.showSearch();
      return true;
    }
    return false;
  }

  async toggle(): Promise<void> {
    if (this.open) {
      this.closePanel();
      return;
    }
    this.openPanel();
    if (this.sessions.length === 0) await this.createSession(false);
    else this.focusActive();
  }

  async createSession(openPanel = true): Promise<void> {
    if (this.sessions.length + this.pendingSessions >= MAX_SESSIONS) {
      this.callbacks.onToast(
        `At most ${MAX_SESSIONS} terminals can run at once.`,
        "warning",
      );
      return;
    }
    if (openPanel) this.openPanel();

    this.pendingSessions += 1;
    let libraries: TerminalLibraries;
    try {
      libraries = await loadTerminalLibraries();
    } catch (error) {
      this.callbacks.onToast(
        `Could not load terminal: ${toAppError(error).message}`,
        "error",
        5000,
      );
      return;
    } finally {
      this.pendingSessions -= 1;
    }
    const { Terminal, FitAddon, SearchAddon } = libraries;
    const clientId = this.nextClientId++;
    const view = document.createElement("div");
    view.className = "terminal-instance entering";
    const fit = new FitAddon();
    const search = new SearchAddon();
    const terminal = new Terminal({
      allowProposedApi: false,
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: this.settings.cursorStyle,
      drawBoldTextInBrightColors: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: this.settings.fontSize,
      fontWeight: "400",
      fontWeightBold: "600",
      letterSpacing: 0,
      lineHeight: 1.15,
      macOptionIsMeta: true,
      minimumContrastRatio: 1,
      rightClickSelectsWord: true,
      scrollback: this.settings.scrollback,
      smoothScrollDuration: 0,
      theme: TERMINAL_THEME,
    });
    terminal.loadAddon(fit);
    terminal.loadAddon(search);

    const session: TerminalSession = {
      clientId,
      terminal,
      fit,
      search,
      view,
      disposables: [],
      shell: this.settings.shell,
      label: shellLabel(this.settings.shell),
      backendId: null,
      generation: 0,
      exited: false,
      pendingInput: [],
      writingInput: false,
      resizeTimer: null,
      cwd: null,
    };
    terminal.attachCustomKeyEventHandler((event) =>
      this.handleTerminalKeyEvent(session, event),
    );
    this.enteringClientIds.add(clientId);
    this.sessions.push(session);
    this.views.append(view);
    window.setTimeout(() => {
      view.classList.remove("entering");
      this.enteringClientIds.delete(clientId);
      this.tabs
        .querySelector<HTMLElement>(`[data-terminal-tab="${clientId}"]`)
        ?.classList.remove("entering");
    }, this.animationDuration(SESSION_ANIMATION_MS));
    terminal.open(view);
    session.disposables.push(
      terminal.onData((data) => {
        for (let offset = 0; offset < data.length; offset += INPUT_CHUNK_LENGTH) {
          session.pendingInput.push(data.slice(offset, offset + INPUT_CHUNK_LENGTH));
        }
        void this.flushInput(session);
      }),
      terminal.onTitleChange((title) => {
        const cleaned = title.replace(/[\u0000-\u001f\u007f]/g, "").trim();
        if (cleaned) {
          session.label = cleaned.slice(0, 80);
          this.renderTabs();
        }
      }),
    );

    this.activate(session.clientId);
    await this.startSession(session);
  }

  private handleTerminalKeyEvent(session: TerminalSession, event: KeyboardEvent): boolean {
    if (!shouldCopyTerminalSelection(event, session.terminal.hasSelection())) return true;

    const selection = session.terminal.getSelection();
    if (selection.length === 0) return true;
    event.preventDefault();
    event.stopPropagation();
    void this.copyTerminalSelection(selection);
    return false;
  }

  private async copyTerminalSelection(selection: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(selection);
      return;
    } catch {
      // WebView clipboard access can be unavailable, so keep a synchronous fallback.
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = document.createElement("textarea");
    input.value = selection;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);

    let copied = false;
    try {
      input.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      input.remove();
      previouslyFocused?.focus({ preventScroll: true });
    }

    if (!copied) {
      this.callbacks.onToast("Could not copy the terminal selection.", "error", 4000);
    }
  }

  private async startSession(session: TerminalSession): Promise<void> {
    session.generation += 1;
    const generation = session.generation;
    session.exited = false;
    session.backendId = null;
    session.label = shellLabel(session.shell);
    this.renderTabs();
    this.fitSession(session, false);

    try {
      const info = await startTerminal(
        session.shell,
        this.callbacks.getCwd(),
        clamp(session.terminal.rows || 24, 2, 500),
        clamp(session.terminal.cols || 80, 2, 1_000),
        (event) => this.handleEvent(session, generation, event),
      );
      if (generation !== session.generation || session.exited) {
        await killTerminal(info.id).catch(() => undefined);
        return;
      }
      session.backendId = info.id;
      session.cwd = info.cwd;
      session.label = info.label;
      this.renderTabs();
      void this.flushInput(session);
      this.scheduleBackendResize(session);
    } catch (error) {
      if (generation !== session.generation) return;
      session.exited = true;
      const message = toAppError(error).message;
      session.terminal.writeln(`\r\n\x1b[31mCould not start terminal: ${message}\x1b[0m`);
      this.callbacks.onToast(message, "error", 5000);
      this.renderTabs();
    }
  }

  private handleEvent(
    session: TerminalSession,
    generation: number,
    event: TerminalEvent,
  ): void {
    if (generation !== session.generation) return;
    if (event.event === "output") {
      try {
        session.terminal.write(decodeTerminalOutput(event.data));
      } catch {
        session.terminal.writeln("\r\n\x1b[31mReceived invalid terminal output.\x1b[0m");
      }
      return;
    }
    if (event.event === "error") {
      session.terminal.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
      return;
    }

    session.exited = true;
    session.backendId = null;
    session.cwd = null;
    const detail = event.signal ? ` (${event.signal})` : "";
    session.terminal.writeln(
      `\r\n\x1b[90mProcess exited with code ${event.code}${detail}. Use Restart to run it again.\x1b[0m`,
    );
    this.renderTabs();
  }

  private async flushInput(session: TerminalSession): Promise<void> {
    if (session.writingInput || session.exited || session.backendId === null) return;
    session.writingInput = true;
    try {
      while (
        session.pendingInput.length > 0 &&
        !session.exited &&
        session.backendId !== null
      ) {
        const data = session.pendingInput.shift();
        if (!data) continue;
        try {
          await writeTerminal(session.backendId, data);
        } catch (error) {
          if (toAppError(error).code !== "terminal_not_found") {
            session.terminal.writeln(
              `\r\n\x1b[31mTerminal input failed: ${toAppError(error).message}\x1b[0m`,
            );
          }
          break;
        }
      }
    } finally {
      session.writingInput = false;
    }
  }

  private activate(clientId: number): void {
    const session = this.sessions.find((candidate) => candidate.clientId === clientId);
    if (!session) return;
    this.activeClientId = clientId;
    for (const candidate of this.sessions) {
      candidate.view.classList.toggle("active", candidate === session);
    }
    this.renderTabs();
    requestAnimationFrame(() => {
      this.fitSession(session);
      session.terminal.focus();
    });
  }

  private activeSession(): TerminalSession | undefined {
    return this.sessions.find((session) => session.clientId === this.activeClientId);
  }

  private async closeSession(clientId: number): Promise<void> {
    const index = this.sessions.findIndex((session) => session.clientId === clientId);
    if (index < 0) return;
    const session = this.sessions[index];
    if (!session) return;
    session.generation += 1;
    if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
    if (session.backendId !== null) {
      await killTerminal(session.backendId).catch(() => undefined);
    }
    session.disposables.forEach((disposable) => disposable.dispose());
    session.terminal.dispose();
    session.view.remove();
    this.sessions.splice(index, 1);

    if (this.activeClientId === clientId) {
      const next = this.sessions[Math.min(index, this.sessions.length - 1)];
      this.activeClientId = next?.clientId ?? null;
      if (next) this.activate(next.clientId);
    }
    if (this.sessions.length === 0) this.closePanel();
    this.sync();
  }

  private async restartActive(): Promise<void> {
    const session = this.activeSession();
    if (!session) {
      await this.createSession();
      return;
    }
    session.generation += 1;
    const backendId = session.backendId;
    session.backendId = null;
    session.exited = false;
    session.pendingInput.length = 0;
    if (backendId !== null) await killTerminal(backendId).catch(() => undefined);
    session.terminal.reset();
    session.terminal.clear();
    await this.startSession(session);
    session.terminal.focus();
  }

  private openPanel(): void {
    if (this.open) {
      this.focusActive();
      return;
    }
    this.cancelPendingPanelClose();
    this.open = true;
    this.panel.classList.add("opening");
    this.shell.classList.add("terminal-open");
    this.panel.setAttribute("aria-hidden", "false");
    this.setHeight(this.height);
    requestAnimationFrame(() => {
      this.panel.classList.add("visible");
    });
    this.panelCloseTimer = window.setTimeout(() => {
      this.panelCloseTimer = null;
      this.panel.classList.remove("opening");
      if (this.open) this.scheduleFit();
    }, this.animationDuration(PANEL_ANIMATION_MS));
    this.sync();
  }

  private closePanel(): void {
    if (!this.open) return;
    this.cancelPendingPanelClose();
    this.open = false;
    this.maximized = false;
    this.panel.classList.add("closing");
    this.panel.classList.remove("visible");
    this.shell.classList.remove("terminal-open");
    this.panel.setAttribute("aria-hidden", "true");
    this.hideSearch();
    this.hideSettings();
    this.hideShellMenu();
    this.hideCwdMenu();
    this.panelCloseTimer = window.setTimeout(() => {
      this.panelCloseTimer = null;
      this.panel.classList.remove("closing");
    }, this.animationDuration(PANEL_ANIMATION_MS));
    this.sync();
  }

  private cancelPendingPanelClose(): void {
    if (this.panelCloseTimer === null) return;
    window.clearTimeout(this.panelCloseTimer);
    this.panelCloseTimer = null;
    this.panel.classList.remove("opening", "closing");
  }

  private animationDuration(duration: number): number {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
  }

  private focusActive(): void {
    requestAnimationFrame(() => {
      const active = this.activeSession();
      if (active) {
        this.fitSession(active);
        active.terminal.focus();
      }
    });
  }

  private fitSession(session: TerminalSession, notifyBackend = true): void {
    if (!this.open || this.activeClientId !== session.clientId) return;
    try {
      session.fit.fit();
    } catch {
      return;
    }
    if (notifyBackend) this.scheduleBackendResize(session);
  }

  private scheduleFit(): void {
    if (
      !this.open ||
      this.fitFrame !== null ||
      this.panel.classList.contains("opening") ||
      this.panel.classList.contains("closing")
    ) {
      return;
    }
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      const active = this.activeSession();
      if (active) this.fitSession(active);
    });
  }

  private scheduleBackendResize(session: TerminalSession): void {
    if (session.backendId === null || session.exited) return;
    if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
    session.resizeTimer = window.setTimeout(() => {
      session.resizeTimer = null;
      if (session.backendId === null || session.exited) return;
      void resizeTerminal(
        session.backendId,
        clamp(session.terminal.rows, 2, 500),
        clamp(session.terminal.cols, 2, 1_000),
      ).catch((error) => {
        if (toAppError(error).code !== "terminal_not_found") {
          this.callbacks.onToast(toAppError(error).message, "error");
        }
      });
    }, 45);
  }

  private showSearch(): void {
    if (!this.activeSession()) return;
    this.searchWrap.classList.remove("hidden");
    this.searchInput.focus();
    this.searchInput.select();
  }

  private hideSearch(): void {
    this.searchWrap.classList.add("hidden");
    this.searchInput.value = "";
    this.activeSession()?.search.clearDecorations();
  }

  private find(forward: boolean): void {
    const session = this.activeSession();
    const value = this.searchInput.value;
    if (!session || !value) return;
    const options = { caseSensitive: false, incremental: true, wholeWord: false };
    if (forward) session.search.findNext(value, options);
    else session.search.findPrevious(value, options);
  }

  private clearActive(): void {
    const session = this.activeSession();
    if (!session) return;
    session.terminal.clear();
    session.terminal.focus();
  }

  private toggleMaximize(): void {
    if (!this.open) this.openPanel();
    if (!this.maximized) {
      this.previousHeight = this.height;
      this.maximized = true;
      this.setHeight(this.maximumHeight());
    } else {
      this.maximized = false;
      this.setHeight(this.previousHeight);
    }
    this.persistHeight();
    this.sync();
    this.scheduleFit();
  }

  private setHeight(height: number): void {
    this.height = clamp(Math.round(height), MIN_HEIGHT, this.maximumHeight());
    this.shell.style.setProperty("--terminal-height", `${this.height}px`);
  }

  private maximumHeight(): number {
    return Math.max(MIN_HEIGHT, window.innerHeight - 44 - 28 - 48);
  }

  private bindResize(): void {
    const resizer = required<HTMLElement>(this.panel, "#terminal-resizer");
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const wasOpen = this.open;
      let draggedHeight = wasOpen ? this.height : 0;
      this.previousHeight = this.height;
      if (!this.open) {
        this.cancelPendingPanelClose();
        this.open = true;
        this.shell.classList.add("terminal-open");
        this.panel.classList.add("visible");
        this.panel.setAttribute("aria-hidden", "false");
        this.shell.style.setProperty("--terminal-height", "0px");
      }
      this.maximized = false;
      resizer.setPointerCapture(event.pointerId);
      this.shell.classList.add("terminal-resizing");

      const onMove = (moveEvent: PointerEvent): void => {
        draggedHeight = clamp(
          Math.round(window.innerHeight - 28 - moveEvent.clientY),
          0,
          this.maximumHeight(),
        );
        this.shell.style.setProperty("--terminal-height", `${draggedHeight}px`);
        this.scheduleFit();
      };
      const onEnd = (): void => {
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onEnd);
        resizer.removeEventListener("pointercancel", onEnd);
        this.shell.classList.remove("terminal-resizing");
        if (draggedHeight < 72) {
          this.closePanel();
          this.setHeight(this.previousHeight);
          return;
        }
        this.setHeight(draggedHeight);
        this.persistHeight();
        this.sync();
        if (this.open && this.sessions.length === 0) void this.createSession(false);
        else this.focusActive();
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onEnd);
      resizer.addEventListener("pointercancel", onEnd);
    });
    resizer.addEventListener("dblclick", () => this.toggleMaximize());
  }

  private bindEvents(): void {
    this.bindResize();
    this.statusButton.addEventListener("click", () => void this.toggle());
    this.tabs.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const close = target.closest<HTMLElement>("[data-terminal-close]");
      if (close?.dataset.terminalClose) {
        event.stopPropagation();
        void this.closeSession(Number(close.dataset.terminalClose));
        return;
      }
      const tab = target.closest<HTMLElement>("[data-terminal-tab]");
      if (tab?.dataset.terminalTab) this.activate(Number(tab.dataset.terminalTab));
    });
    this.panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const shellOption = target.closest<HTMLButtonElement>("[data-terminal-shell]");
      if (shellOption?.dataset.terminalShell) {
        this.settings.shell = shellOption.dataset.terminalShell as TerminalShell;
        this.applySettingsToControls();
        this.saveSettings();
        this.hideShellMenu();
        this.shellTrigger.focus();
        return;
      }
      const rootOption = target.closest<HTMLButtonElement>("[data-terminal-root]");
      if (rootOption?.dataset.terminalRoot) {
        this.callbacks.onWorkspaceFolderSelected(rootOption.dataset.terminalRoot);
        this.syncWorkspaceFolders();
        this.hideCwdMenu();
        this.cwdTrigger.focus();
        return;
      }
      const action = target.closest<HTMLElement>("[data-terminal-action]")?.dataset
        .terminalAction;
      switch (action) {
        case "new":
          void this.createSession();
          break;
        case "search":
          this.searchWrap.classList.contains("hidden") ? this.showSearch() : this.hideSearch();
          break;
        case "clear":
          this.clearActive();
          break;
        case "restart":
          void this.restartActive();
          break;
        case "close":
          if (this.activeClientId !== null) void this.closeSession(this.activeClientId);
          break;
        case "maximize":
          this.toggleMaximize();
          break;
        case "collapse":
          this.closePanel();
          break;
        case "settings":
          this.toggleSettings();
          break;
        case "shell-menu":
          this.toggleShellMenu();
          break;
        case "cwd-menu":
          this.toggleCwdMenu();
          break;
        case "font-smaller":
          this.updateFontSize(this.settings.fontSize - 1);
          break;
        case "font-larger":
          this.updateFontSize(this.settings.fontSize + 1);
          break;
      }
    });
    this.shellTrigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.shellMenu.classList.contains("open")) {
        event.preventDefault();
        this.hideShellMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.showShellMenu();
        this.focusShellOption(event.key === "ArrowDown" ? 0 : -1);
      }
    });
    this.shellPicker.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (!this.shellPicker.contains(document.activeElement)) this.hideShellMenu();
      });
    });
    this.cwdPicker.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (!this.cwdPicker.contains(document.activeElement)) this.hideCwdMenu();
      });
    });
    this.cwdTrigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.cwdMenu.classList.contains("open")) {
        event.preventDefault();
        this.hideCwdMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.showCwdMenu();
        this.focusMenuOption(this.cwdMenu, event.key === "ArrowDown" ? 0 : -1);
      }
    });
    this.cwdMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideCwdMenu();
        this.cwdTrigger.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.focusMenuOption(this.cwdMenu, event.key === "ArrowDown" ? 1 : -1);
      }
    });
    this.shellMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hideShellMenu();
        this.shellTrigger.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.focusShellOption(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        this.focusShellOption(event.key === "Home" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
      }
    });
    this.cursorSelect.addEventListener("change", () => {
      this.settings.cursorStyle = this.cursorSelect.value as CursorStyle;
      this.applySettingsToSessions();
      this.saveSettings();
    });
    this.scrollbackSelect.addEventListener("change", () => {
      this.settings.scrollback = Number(this.scrollbackSelect.value);
      this.applySettingsToSessions();
      this.saveSettings();
    });
    this.searchInput.addEventListener("input", () => this.find(true));
    this.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.find(!event.shiftKey);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.hideSearch();
        this.focusActive();
      }
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (
          this.settingsPopover.matches(":popover-open") &&
          !this.settingsPopover.contains(target) &&
          !required(this.panel, "#terminal-settings-button").contains(target)
        ) {
          this.hideSettings();
        }
        if (!this.shellPicker.contains(target)) this.hideShellMenu();
        if (!this.cwdPicker.contains(target)) this.hideCwdMenu();
        if (
          !this.searchWrap.classList.contains("hidden") &&
          !this.searchWrap.contains(target) &&
          !required(this.panel, "#terminal-search-button").contains(target)
        ) {
          this.hideSearch();
        }
      },
      { capture: true },
    );
    window.addEventListener("resize", () => {
      this.setHeight(this.maximized ? this.maximumHeight() : this.height);
      this.scheduleFit();
    });
  }

  private renderTabs(): void {
    const fragment = document.createDocumentFragment();
    for (const session of this.sessions) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "terminal-tab";
      tab.dataset.terminalTab = String(session.clientId);
      tab.title = session.label;
      if (session.cwd) tab.title = `${session.label}\n${session.cwd}`;
      tab.classList.toggle("active", session.clientId === this.activeClientId);
      tab.classList.toggle("exited", session.exited);
      tab.classList.toggle("entering", this.enteringClientIds.has(session.clientId));
      tab.innerHTML = `
        <span class="terminal-tab-icon">&gt;_</span>
        <span class="terminal-tab-label"></span>
        <span class="terminal-tab-close" data-terminal-close="${session.clientId}" role="button" aria-label="Close terminal">${icon("x", 12)}</span>
      `;
      required<HTMLElement>(tab, ".terminal-tab-label").textContent = session.label;
      fragment.append(tab);
    }
    this.tabs.replaceChildren(fragment);
    this.sync();
  }

  private sync(): void {
    this.statusButton.classList.toggle("active", this.open);
    this.statusButton.setAttribute("aria-expanded", String(this.open));
    const count = this.sessions.length;
    required<HTMLElement>(this.statusButton, "#terminal-status-count").textContent =
      count > 0 ? String(count) : "";
    this.statusButton.title = this.open
      ? "Hide terminal (Ctrl+`)"
      : "Show terminal (Ctrl+`)";
    this.panel.classList.toggle("terminal-maximized", this.maximized);
    const maximizeButton = this.panel.querySelector<HTMLButtonElement>(
      '[data-terminal-action="maximize"]',
    );
    if (maximizeButton) {
      maximizeButton.title = this.maximized ? "Restore panel size" : "Maximize panel";
      maximizeButton.setAttribute(
        "aria-label",
        this.maximized ? "Restore panel size" : "Maximize panel",
      );
    }
  }

  private toggleSettings(): void {
    if (this.settingsPopover.matches(":popover-open")) {
      this.hideSettings();
    } else {
      this.applySettingsToControls();
      this.settingsPopover.showPopover();
    }
  }

  private toggleShellMenu(): void {
    if (this.shellMenu.classList.contains("open")) this.hideShellMenu();
    else this.showShellMenu();
  }

  private toggleCwdMenu(): void {
    if (this.cwdMenu.classList.contains("open")) this.hideCwdMenu();
    else this.showCwdMenu();
  }

  private showShellMenu(): void {
    this.hideSettings();
    this.hideCwdMenu();
    this.shellMenu.classList.add("open");
    this.shellMenu.setAttribute("aria-hidden", "false");
    this.shellTrigger.setAttribute("aria-expanded", "true");
  }

  private hideShellMenu(): void {
    this.shellMenu.classList.remove("open");
    this.shellMenu.setAttribute("aria-hidden", "true");
    this.shellTrigger.setAttribute("aria-expanded", "false");
  }

  private showCwdMenu(): void {
    if (this.callbacks.getWorkspaceFolders().length === 0) return;
    this.hideSettings();
    this.hideShellMenu();
    this.cwdMenu.classList.add("open");
    this.cwdMenu.setAttribute("aria-hidden", "false");
    this.cwdTrigger.setAttribute("aria-expanded", "true");
  }

  private hideCwdMenu(): void {
    this.cwdMenu.classList.remove("open");
    this.cwdMenu.setAttribute("aria-hidden", "true");
    this.cwdTrigger.setAttribute("aria-expanded", "false");
  }

  private focusMenuOption(menu: HTMLElement, offset: number): void {
    const options = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    if (options.length === 0) return;
    const focused =
      document.activeElement instanceof HTMLButtonElement
        ? options.indexOf(document.activeElement)
        : -1;
    const selected = options.findIndex((option) => option.classList.contains("selected"));
    const index =
      focused < 0
        ? selected >= 0
          ? selected
          : offset < 0
            ? options.length - 1
            : 0
        : (focused + offset + options.length) % options.length;
    options[index]?.focus();
  }

  private focusShellOption(offset: number): void {
    const options = [
      ...this.shellMenu.querySelectorAll<HTMLButtonElement>("[data-terminal-shell]"),
    ];
    if (options.length === 0) return;
    const focused = document.activeElement;
    const focusedIndex = focused instanceof HTMLButtonElement ? options.indexOf(focused) : -1;
    const selectedIndex = options.findIndex(
      (option) => option.dataset.terminalShell === this.settings.shell,
    );
    let index: number;
    if (offset === Number.NEGATIVE_INFINITY) index = 0;
    else if (offset === Number.POSITIVE_INFINITY) index = options.length - 1;
    else if (focusedIndex < 0) index = selectedIndex >= 0 ? selectedIndex : 0;
    else index = (focusedIndex + offset + options.length) % options.length;
    options[index]?.focus();
  }

  private hideSettings(): void {
    if (this.settingsPopover.matches(":popover-open")) {
      this.settingsPopover.hidePopover();
    }
  }

  private updateFontSize(fontSize: number): void {
    this.settings.fontSize = clamp(fontSize, 10, 22);
    this.applySettingsToControls();
    this.applySettingsToSessions();
    this.saveSettings();
    this.scheduleFit();
  }

  private applySettingsToSessions(): void {
    for (const session of this.sessions) {
      session.terminal.options.fontSize = this.settings.fontSize;
      session.terminal.options.cursorStyle = this.settings.cursorStyle;
      session.terminal.options.scrollback = this.settings.scrollback;
    }
    this.scheduleFit();
  }

  private applySettingsToControls(): void {
    this.shellLabelElement.textContent = shellLabel(this.settings.shell);
    this.shellMenu.querySelectorAll<HTMLButtonElement>("[data-terminal-shell]").forEach((option) => {
      const selected = option.dataset.terminalShell === this.settings.shell;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    this.fontSizeValue.textContent = `${this.settings.fontSize}px`;
    this.cursorSelect.value = this.settings.cursorStyle;
    this.scrollbackSelect.value = String(this.settings.scrollback);
  }

  private loadSettings(): TerminalSettings {
    const defaults: TerminalSettings = {
      shell: navigator.userAgent.includes("Windows") ? "powershell-core" : "default",
      fontSize: 13,
      cursorStyle: "block",
      scrollback: 5_000,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw) as Partial<TerminalSettings>;
      const shells: readonly TerminalShell[] = [
        "default",
        "powershell-core",
        "windows-powershell",
        "command-prompt",
        "bash",
        "zsh",
      ];
      const cursors: readonly CursorStyle[] = ["block", "bar", "underline"];
      return {
        shell: shells.includes(parsed.shell as TerminalShell)
          ? (parsed.shell as TerminalShell)
          : defaults.shell,
        fontSize:
          Number.isInteger(parsed.fontSize) && parsed.fontSize
            ? clamp(parsed.fontSize, 10, 22)
            : defaults.fontSize,
        cursorStyle: cursors.includes(parsed.cursorStyle as CursorStyle)
          ? (parsed.cursorStyle as CursorStyle)
          : defaults.cursorStyle,
        scrollback: [1_000, 5_000, 10_000, 50_000].includes(parsed.scrollback ?? 0)
          ? (parsed.scrollback as number)
          : defaults.scrollback,
      };
    } catch {
      return defaults;
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Terminal settings remain available for the current session.
    }
  }

  private restoreHeight(): void {
    try {
      const value = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(value) && value >= MIN_HEIGHT) this.height = value;
    } catch {
      // Use the default height when storage is unavailable.
    }
    this.setHeight(this.height);
    this.previousHeight = this.height;
  }

  private persistHeight(): void {
    if (!this.maximized) this.previousHeight = this.height;
    try {
      localStorage.setItem(HEIGHT_KEY, String(this.height));
    } catch {
      // Resizing still works when storage is unavailable.
    }
  }
}
