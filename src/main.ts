import "./styles/main.css";
import { EditorController } from "./editor/controller";
import {
  chooseProjectFolder,
  createProjectEntry,
  openProject,
  readProjectFile,
  refreshProject,
  toAppError,
  writeProjectFile,
} from "./services/native";
import type { CreateKind, FileEntry, ProjectSnapshot } from "./types";
import {
  basename,
  extension,
  findQuickOpenMatches,
  languageName,
  validateNewPath,
} from "./utils/files";
import { icon, type IconName } from "./ui/icons";

const LAST_PROJECT_KEY = "nullpointer:last-project";
const SIDEBAR_WIDTH_KEY = "nullpointer:sidebar-width";

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Required UI element not found: ${selector}`);
  return value;
}

function escapeSelector(value: string): string {
  return CSS.escape(value);
}

class NullPointerApp {
  private readonly shell = element<HTMLElement>("#shell");
  private readonly projectName = element<HTMLElement>("#project-name");
  private readonly projectPath = element<HTMLElement>("#project-path");
  private readonly tree = element<HTMLElement>("#file-tree");
  private readonly tabs = element<HTMLElement>("#tabs");
  private readonly welcome = element<HTMLElement>("#welcome");
  private readonly editorHost = element<HTMLElement>("#editor-host");
  private readonly cursorStatus = element<HTMLElement>("#cursor-status");
  private readonly languageStatus = element<HTMLElement>("#language-status");
  private readonly generalStatus = element<HTMLElement>("#general-status");
  private readonly saveButton = element<HTMLButtonElement>("#save-button");
  private readonly newEntryButton = element<HTMLButtonElement>("#new-entry-button");
  private readonly refreshButton = element<HTMLButtonElement>("#refresh-button");
  private readonly quickDialog = element<HTMLDialogElement>("#quick-dialog");
  private readonly quickInput = element<HTMLInputElement>("#quick-input");
  private readonly quickResults = element<HTMLElement>("#quick-results");
  private readonly entryDialog = element<HTMLDialogElement>("#entry-dialog");
  private readonly entryForm = element<HTMLFormElement>("#entry-form");
  private readonly entryInput = element<HTMLInputElement>("#entry-path");
  private readonly entryError = element<HTMLElement>("#entry-error");
  private readonly editor: EditorController;

  private project: ProjectSnapshot | null = null;
  private readonly expanded = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly loadingFiles = new Set<string>();
  private sidebarCollapsed = false;
  private quickMatches: FileEntry[] = [];
  private quickSelection = 0;
  private createKind: CreateKind = "file";
  private busyCount = 0;
  private projectGeneration = 0;

  constructor() {
    this.editor = new EditorController(this.editorHost, {
      onDirtyChange: (path, isDirty) => {
        if (isDirty) this.dirty.add(path);
        else this.dirty.delete(path);
        this.renderTabs();
        this.syncChrome();
      },
      onCursorChange: (line, column) => {
        this.cursorStatus.textContent = `Ln ${line}, Col ${column}`;
      },
    });
    this.restoreSidebarWidth();
    this.bindEvents();
    this.syncChrome();
  }

  async start(): Promise<void> {
    const lastProject = this.readStorage(LAST_PROJECT_KEY);
    if (!lastProject) return;
    try {
      await this.loadProject(lastProject, false);
    } catch {
      this.removeStorage(LAST_PROJECT_KEY);
    }
  }

  private bindEvents(): void {
    element<HTMLButtonElement>("#open-folder-button").addEventListener("click", () => {
      void this.chooseAndOpenProject();
    });
    element<HTMLButtonElement>("#welcome-open-button").addEventListener("click", () => {
      void this.chooseAndOpenProject();
    });
    element<HTMLButtonElement>("#welcome-quick-button").addEventListener("click", () => {
      this.showQuickOpen();
    });
    element<HTMLButtonElement>("#quick-open-button").addEventListener("click", () => {
      this.showQuickOpen();
    });
    element<HTMLButtonElement>("#activity-explorer").addEventListener("click", () => {
      if (this.sidebarCollapsed) this.toggleSidebar();
    });
    element<HTMLButtonElement>("#activity-search").addEventListener("click", () => {
      this.showQuickOpen();
    });
    element<HTMLButtonElement>("#toggle-sidebar-button").addEventListener("click", () => {
      this.toggleSidebar();
    });
    this.saveButton.addEventListener("click", () => void this.saveActive());
    this.newEntryButton.addEventListener("click", () => this.showEntryDialog());
    this.refreshButton.addEventListener("click", () => void this.refreshTree());
    this.tree.addEventListener("click", (event) => this.handleTreeClick(event));
    this.tabs.addEventListener("click", (event) => this.handleTabClick(event));
    this.quickInput.addEventListener("input", () => this.renderQuickResults());
    this.quickInput.addEventListener("keydown", (event) => this.handleQuickKeydown(event));
    this.quickResults.addEventListener("click", (event) => this.handleQuickClick(event));
    this.entryForm.addEventListener("submit", (event) => void this.handleEntrySubmit(event));
    element<HTMLButtonElement>("#entry-cancel").addEventListener("click", () => {
      this.entryDialog.close();
    });
    element<HTMLButtonElement>("#entry-cancel-secondary").addEventListener("click", () => {
      this.entryDialog.close();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-entry-kind]").forEach((button) => {
      button.addEventListener("click", () => {
        this.createKind = button.dataset.entryKind === "directory" ? "directory" : "file";
        this.syncEntryKindButtons();
      });
    });
    document.addEventListener("keydown", (event) => this.handleGlobalKeydown(event));
    window.addEventListener("beforeunload", (event) => {
      if (this.dirty.size === 0) return;
      event.preventDefault();
    });
    this.bindSidebarResize();
  }

  private async chooseAndOpenProject(): Promise<void> {
    if (!this.canDiscardAll()) return;
    try {
      const path = await chooseProjectFolder();
      if (path) await this.loadProject(path, true);
    } catch (error) {
      this.showError(error);
    }
  }

  private async loadProject(path: string, announce: boolean): Promise<void> {
    this.setBusy(true, "Opening project…");
    try {
      const snapshot = await openProject(path);
      this.project = snapshot;
      this.projectGeneration += 1;
      this.editor.reset();
      this.dirty.clear();
      this.expanded.clear();
      this.projectName.textContent = snapshot.name;
      this.projectPath.textContent = snapshot.rootPath;
      this.projectPath.title = snapshot.rootPath;
      document.title = `${snapshot.name} — NullPointer`;
      this.writeStorage(LAST_PROJECT_KEY, snapshot.rootPath);
      this.renderTree();
      this.renderTabs();
      this.syncChrome();
      if (snapshot.truncated) {
        this.toast("Project tree was capped at 20,000 entries.", "warning", 5000);
      } else if (announce) {
        this.toast(`Opened ${snapshot.name}`, "success");
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async refreshTree(): Promise<void> {
    if (!this.project) return;
    this.setBusy(true, "Refreshing files…");
    try {
      this.project = await refreshProject();
      this.renderTree();
      this.toast("Explorer refreshed", "success", 1800);
    } catch (error) {
      this.showError(error);
    } finally {
      this.setBusy(false);
    }
  }

  private renderTree(): void {
    this.tree.replaceChildren();
    if (!this.project) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "Open a folder to browse its files.";
      this.tree.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    const appendEntries = (entries: readonly FileEntry[], depth: number): void => {
      for (const entry of entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row";
        row.dataset.path = entry.path;
        row.dataset.kind = entry.kind;
        row.style.setProperty("--tree-depth", String(depth));
        row.title = entry.path;
        if (entry.path === this.editor.active) row.classList.add("active");
        if (this.loadingFiles.has(entry.path)) row.classList.add("loading");

        const marker = document.createElement("span");
        marker.className = "tree-marker";
        if (entry.kind === "directory") {
          marker.innerHTML = icon(this.expanded.has(entry.path) ? "chevron-down" : "chevron-right", 15);
        }

        const glyph = document.createElement("span");
        glyph.className = `tree-icon ext-${escapeSelector(extension(entry.path) || "plain")}`;
        glyph.innerHTML = icon(this.entryIcon(entry), 18);

        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = entry.name;
        if (entry.isSymlink) label.classList.add("symlink");

        row.append(marker, glyph, label);
        fragment.append(row);
        if (entry.kind === "directory" && this.expanded.has(entry.path)) {
          appendEntries(entry.children, depth + 1);
        }
      }
    };
    appendEntries(this.project.entries, 0);
    this.tree.append(fragment);
  }

  private entryIcon(entry: FileEntry): IconName {
    if (entry.kind === "directory") {
      return this.expanded.has(entry.path) ? "folder-open" : "folder";
    }
    return ["js", "jsx", "ts", "tsx", "rs", "html", "css", "json"].includes(extension(entry.path))
      ? "code"
      : "file";
  }

  private handleTreeClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLButtonElement>(".tree-row");
    const path = row?.dataset.path;
    if (!row || !path) return;

    if (row.dataset.kind === "directory") {
      if (this.expanded.has(path)) this.expanded.delete(path);
      else this.expanded.add(path);
      this.renderTree();
      return;
    }
    void this.openFile(path);
  }

  private async openFile(path: string): Promise<void> {
    if (this.editor.has(path)) {
      this.editor.activate(path);
      this.renderTabs();
      this.renderTree();
      this.syncChrome();
      return;
    }
    if (this.loadingFiles.has(path)) return;

    this.loadingFiles.add(path);
    const generation = this.projectGeneration;
    this.renderTree();
    this.setBusy(true, `Opening ${basename(path)}…`);
    try {
      const document = await readProjectFile(path);
      if (generation !== this.projectGeneration) return;
      const added = await this.editor.add(document, () => generation === this.projectGeneration);
      if (!added) return;
      this.renderTabs();
      this.renderTree();
      this.syncChrome();
    } catch (error) {
      this.showError(error);
    } finally {
      this.loadingFiles.delete(path);
      this.setBusy(false);
      this.renderTree();
    }
  }

  private renderTabs(): void {
    const fragment = document.createDocumentFragment();
    for (const path of this.editor.paths) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.dataset.path = path;
      tab.title = path;
      if (path === this.editor.active) tab.classList.add("active");

      const fileGlyph = document.createElement("span");
      fileGlyph.className = `tab-file-icon ext-${escapeSelector(extension(path) || "plain")}`;
      fileGlyph.innerHTML = icon("code", 16);
      const label = document.createElement("span");
      label.textContent = basename(path);
      const close = document.createElement("span");
      close.className = "tab-close";
      close.dataset.closePath = path;
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", `Close ${basename(path)}`);
      close.innerHTML = this.dirty.has(path) ? '<span class="dirty-dot"></span>' : icon("x", 13);
      tab.append(fileGlyph, label, close);
      fragment.append(tab);
    }
    this.tabs.replaceChildren(fragment);
  }

  private handleTabClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const close = target.closest<HTMLElement>("[data-close-path]");
    if (close?.dataset.closePath) {
      event.stopPropagation();
      this.closeTab(close.dataset.closePath);
      return;
    }
    const tab = target.closest<HTMLButtonElement>(".tab");
    const path = tab?.dataset.path;
    if (path && this.editor.activate(path)) {
      this.renderTabs();
      this.renderTree();
      this.syncChrome();
    }
  }

  private closeTab(path: string): void {
    if (this.dirty.has(path) && !window.confirm(`Discard unsaved changes in ${basename(path)}?`)) {
      return;
    }
    const paths = [...this.editor.paths];
    const index = paths.indexOf(path);
    const wasActive = this.editor.active === path;
    this.editor.close(path);
    this.dirty.delete(path);
    if (wasActive) {
      const remaining = [...this.editor.paths];
      const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      if (next) this.editor.activate(next);
    }
    this.renderTabs();
    this.renderTree();
    this.syncChrome();
  }

  private async saveActive(): Promise<void> {
    const path = this.editor.active;
    if (!path) return;
    const content = this.editor.content(path);
    const modifiedAt = this.editor.modifiedAt(path);
    if (content === null || modifiedAt === null) return;
    if (!this.editor.isDirty(path)) {
      this.toast("No changes to save", "neutral", 1400);
      return;
    }

    this.setBusy(true, `Saving ${basename(path)}…`);
    try {
      const result = await writeProjectFile(path, content, modifiedAt);
      this.editor.markSaved(path, result.modifiedAtMs, result.size);
      this.renderTabs();
      this.syncChrome();
      this.toast(`Saved ${basename(path)}`, "success", 1600);
    } catch (error) {
      const appError = toAppError(error);
      if (
        appError.code === "file_changed" &&
        window.confirm(`${appError.message}\n\nReload from disk and discard your local changes?`)
      ) {
        await this.reloadFile(path);
      } else {
        this.showError(appError);
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async reloadFile(path: string): Promise<void> {
    try {
      const document = await readProjectFile(path);
      this.editor.close(path);
      this.dirty.delete(path);
      await this.editor.add(document);
      this.renderTabs();
      this.syncChrome();
      this.toast(`Reloaded ${basename(path)}`, "success");
    } catch (error) {
      this.showError(error);
    }
  }

  private showQuickOpen(): void {
    if (!this.project) {
      this.toast("Open a project folder first", "neutral");
      return;
    }
    this.quickInput.value = "";
    this.quickSelection = 0;
    this.renderQuickResults();
    this.quickDialog.showModal();
    requestAnimationFrame(() => this.quickInput.focus());
  }

  private renderQuickResults(): void {
    if (!this.project) return;
    this.quickMatches = findQuickOpenMatches(this.project.entries, this.quickInput.value);
    this.quickSelection = Math.min(this.quickSelection, Math.max(0, this.quickMatches.length - 1));
    const fragment = document.createDocumentFragment();

    if (this.quickMatches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "quick-empty";
      empty.textContent = "No matching files";
      fragment.append(empty);
    }

    this.quickMatches.forEach((entry, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "quick-result";
      row.dataset.quickPath = entry.path;
      if (index === this.quickSelection) row.classList.add("selected");
      const glyph = document.createElement("span");
      glyph.className = `quick-icon ext-${escapeSelector(extension(entry.path) || "plain")}`;
      glyph.innerHTML = icon("code", 18);
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = entry.name;
      const parent = document.createElement("small");
      const slash = entry.path.lastIndexOf("/");
      parent.textContent = slash > -1 ? entry.path.slice(0, slash) : this.project?.name ?? "";
      text.append(name, parent);
      row.append(glyph, text);
      fragment.append(row);
    });
    this.quickResults.replaceChildren(fragment);
    this.quickResults.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
  }

  private handleQuickKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const count = this.quickMatches.length;
      if (count > 0) this.quickSelection = (this.quickSelection + direction + count) % count;
      this.renderQuickResults();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const match = this.quickMatches[this.quickSelection];
      if (match) {
        this.quickDialog.close();
        void this.openFile(match.path);
      }
    }
  }

  private handleQuickClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLButtonElement>("[data-quick-path]");
    const path = row?.dataset.quickPath;
    if (path) {
      this.quickDialog.close();
      void this.openFile(path);
    }
  }

  private showEntryDialog(): void {
    if (!this.project) return;
    this.entryInput.value = "";
    this.entryError.textContent = "";
    this.createKind = "file";
    this.syncEntryKindButtons();
    this.entryDialog.showModal();
    requestAnimationFrame(() => this.entryInput.focus());
  }

  private syncEntryKindButtons(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-entry-kind]").forEach((button) => {
      button.classList.toggle("active", button.dataset.entryKind === this.createKind);
    });
    element<HTMLElement>("#entry-dialog-title").textContent =
      this.createKind === "file" ? "New file" : "New folder";
    this.entryInput.placeholder = this.createKind === "file" ? "src/new-file.ts" : "src/components";
  }

  private async handleEntrySubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const path = validateNewPath(this.entryInput.value);
    if (!path) {
      this.entryError.textContent = "Enter a valid project-relative path without .. segments.";
      return;
    }

    const submit = element<HTMLButtonElement>("#entry-submit");
    submit.disabled = true;
    try {
      this.project = await createProjectEntry(path, this.createKind);
      const parentEnd = path.lastIndexOf("/");
      if (parentEnd > 0) {
        const parts = path.slice(0, parentEnd).split("/");
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          this.expanded.add(current);
        }
      }
      this.entryDialog.close();
      this.renderTree();
      this.toast(`${this.createKind === "file" ? "Created" : "Created folder"} ${path}`, "success");
      if (this.createKind === "file") await this.openFile(path);
    } catch (error) {
      this.entryError.textContent = toAppError(error).message;
    } finally {
      submit.disabled = false;
    }
  }

  private handleGlobalKeydown(event: KeyboardEvent): void {
    const command = event.ctrlKey || event.metaKey;
    if (!command) return;
    const key = event.key.toLowerCase();
    if (key === "o") {
      event.preventDefault();
      void this.chooseAndOpenProject();
    } else if (key === "p") {
      event.preventDefault();
      this.showQuickOpen();
    } else if (key === "s") {
      event.preventDefault();
      void this.saveActive();
    } else if (key === "w") {
      event.preventDefault();
      if (this.editor.active) this.closeTab(this.editor.active);
    } else if (key === "n") {
      event.preventDefault();
      this.showEntryDialog();
    } else if (key === "b") {
      event.preventDefault();
      this.toggleSidebar();
    }
  }

  private toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.shell.classList.toggle("sidebar-collapsed", this.sidebarCollapsed);
    element<HTMLButtonElement>("#activity-explorer").classList.toggle("active", !this.sidebarCollapsed);
  }

  private syncChrome(): void {
    const active = this.editor.active;
    const hasProject = this.project !== null;
    this.welcome.classList.toggle("hidden", active !== null);
    this.editorHost.classList.toggle("hidden", active === null);
    this.tabs.classList.toggle("empty", this.editor.paths.length === 0);
    this.saveButton.disabled = !active || !this.dirty.has(active);
    this.newEntryButton.disabled = !hasProject;
    this.refreshButton.disabled = !hasProject;
    this.cursorStatus.textContent = active ? this.cursorStatus.textContent : "Ln —, Col —";
    this.languageStatus.textContent = active ? languageName(active) : "Plain Text";
    this.generalStatus.textContent = active ? active : hasProject ? this.project?.rootPath ?? "" : "Ready";
  }

  private setBusy(busy: boolean, message?: string): void {
    this.busyCount = Math.max(0, this.busyCount + (busy ? 1 : -1));
    this.shell.classList.toggle("busy", this.busyCount > 0);
    if (busy && message) this.generalStatus.textContent = message;
    if (!busy && this.busyCount === 0) this.syncChrome();
  }

  private showError(error: unknown): void {
    this.toast(toAppError(error).message, "error", 5000);
  }

  private toast(message: string, tone: "success" | "warning" | "error" | "neutral", timeout = 3000): void {
    const container = element<HTMLElement>("#toasts");
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    const dot = document.createElement("span");
    dot.className = "toast-dot";
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(dot, text);
    container.append(toast);
    requestAnimationFrame(() => toast.classList.add("visible"));
    window.setTimeout(() => {
      toast.classList.remove("visible");
      window.setTimeout(() => toast.remove(), 180);
    }, timeout);
  }

  private canDiscardAll(): boolean {
    return (
      this.dirty.size === 0 ||
      window.confirm(`Discard unsaved changes in ${this.dirty.size} file${this.dirty.size === 1 ? "" : "s"}?`)
    );
  }

  private bindSidebarResize(): void {
    const resizer = element<HTMLElement>("#sidebar-resizer");
    resizer.addEventListener("pointerdown", (event) => {
      if (this.sidebarCollapsed) return;
      resizer.setPointerCapture(event.pointerId);
      const onMove = (moveEvent: PointerEvent): void => {
        const width = Math.min(420, Math.max(190, moveEvent.clientX - 48));
        this.shell.style.setProperty("--sidebar-width", `${width}px`);
      };
      const onEnd = (): void => {
        resizer.removeEventListener("pointermove", onMove);
        const width = getComputedStyle(this.shell).getPropertyValue("--sidebar-width").trim();
        this.writeStorage(SIDEBAR_WIDTH_KEY, width);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onEnd, { once: true });
      resizer.addEventListener("pointercancel", onEnd, { once: true });
    });
  }

  private restoreSidebarWidth(): void {
    const stored = this.readStorage(SIDEBAR_WIDTH_KEY);
    if (stored && /^\d{3}px$/.test(stored)) this.shell.style.setProperty("--sidebar-width", stored);
  }

  private readStorage(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The editor remains fully usable when persistent web storage is unavailable.
    }
  }

  private removeStorage(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore unavailable persistent storage.
    }
  }
}

element<HTMLElement>("#app").innerHTML = `
  <div class="shell" id="shell">
    <div class="progress" aria-hidden="true"></div>
    <header class="topbar">
      <div class="brand" aria-label="NullPointer">
        <span class="brand-mark">N<span></span></span>
        <span class="brand-name">NullPointer</span>
      </div>
      <div class="topbar-center">
        <button class="project-switcher" id="open-folder-button" type="button" title="Open folder (Ctrl+O)">
          ${icon("folder-open", 18)}
          <span id="project-name">No folder open</span>
        </button>
      </div>
      <div class="topbar-actions">
        <button class="quick-trigger" id="quick-open-button" type="button" title="Quick open (Ctrl+P)">
          ${icon("search", 17)}<span>Go to file</span><kbd>Ctrl P</kbd>
        </button>
        <button class="icon-button" id="save-button" type="button" title="Save (Ctrl+S)" aria-label="Save">
          ${icon("save", 20)}
        </button>
      </div>
    </header>

    <aside class="activitybar" aria-label="Activity bar">
      <button class="activity-button active" id="activity-explorer" type="button" title="Explorer" aria-label="Explorer">
        ${icon("panel-left", 23)}
      </button>
      <button class="activity-button" id="activity-search" type="button" title="Quick open" aria-label="Quick open">
        ${icon("search", 23)}
      </button>
      <span class="activity-spacer"></span>
      <button class="activity-button" id="toggle-sidebar-button" type="button" title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar">
        ${icon("panel-left", 22)}
      </button>
    </aside>

    <aside class="sidebar">
      <div class="sidebar-header">
        <span>Explorer</span>
        <div class="sidebar-actions">
          <button class="mini-button" id="new-entry-button" type="button" title="New file or folder" aria-label="New file or folder">
            ${icon("file-plus", 18)}
          </button>
          <button class="mini-button" id="refresh-button" type="button" title="Refresh explorer" aria-label="Refresh explorer">
            ${icon("refresh", 17)}
          </button>
        </div>
      </div>
      <div class="project-path" id="project-path">No project selected</div>
      <nav class="file-tree" id="file-tree" aria-label="Project files">
        <div class="tree-empty">Open a folder to browse its files.</div>
      </nav>
      <div class="sidebar-resizer" id="sidebar-resizer"></div>
    </aside>

    <main class="workspace">
      <div class="tabs" id="tabs" role="tablist" aria-label="Open editors"></div>
      <section class="editor-surface">
        <div class="welcome" id="welcome">
          <div class="welcome-glow"></div>
          <div class="welcome-content">
            <div class="welcome-mark">N<span></span></div>
            <p class="eyebrow">FAST BY DEFAULT</p>
            <h1>Stay in the flow.</h1>
            <p class="welcome-copy">A quiet, native editor with everything essential and nothing in the way.</p>
            <div class="welcome-actions">
              <button class="primary-button" id="welcome-open-button" type="button">${icon("folder-open", 18)} Open folder</button>
              <button class="secondary-button" id="welcome-quick-button" type="button">${icon("search", 18)} Quick open <kbd>Ctrl P</kbd></button>
            </div>
            <div class="shortcut-grid">
              <span><kbd>Ctrl S</kbd> Save</span>
              <span><kbd>Ctrl N</kbd> New file</span>
              <span><kbd>Ctrl B</kbd> Sidebar</span>
            </div>
          </div>
        </div>
        <div class="editor-host hidden" id="editor-host"></div>
      </section>
    </main>

    <footer class="statusbar">
      <span class="status-main" id="general-status">Ready</span>
      <span id="cursor-status">Ln —, Col —</span>
      <span>UTF-8</span>
      <span id="language-status">Plain Text</span>
    </footer>

    <dialog class="command-dialog" id="quick-dialog">
      <div class="command-input-wrap">${icon("search", 20)}<input id="quick-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search files by name…" aria-label="Search files" /><kbd>Esc</kbd></div>
      <div class="quick-results" id="quick-results"></div>
      <div class="dialog-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span></div>
    </dialog>

    <dialog class="entry-dialog" id="entry-dialog">
      <form id="entry-form">
        <div class="dialog-title-row">
          <div><p class="eyebrow">CREATE</p><h2 id="entry-dialog-title">New file</h2></div>
          <button class="mini-button" id="entry-cancel" type="button" aria-label="Close">${icon("x", 16)}</button>
        </div>
        <div class="kind-switch" role="group" aria-label="Entry type">
          <button class="active" type="button" data-entry-kind="file">${icon("file", 15)} File</button>
          <button type="button" data-entry-kind="directory">${icon("folder", 15)} Folder</button>
        </div>
        <label for="entry-path">Project-relative path</label>
        <input id="entry-path" type="text" autocomplete="off" spellcheck="false" placeholder="src/new-file.ts" />
        <p class="entry-error" id="entry-error" role="alert"></p>
        <div class="dialog-actions"><button class="secondary-button" id="entry-cancel-secondary" type="button">Cancel</button><button class="primary-button" id="entry-submit" type="submit">Create</button></div>
      </form>
    </dialog>

    <div class="toasts" id="toasts" aria-live="polite"></div>
  </div>
`;

const app = new NullPointerApp();
void app.start();
