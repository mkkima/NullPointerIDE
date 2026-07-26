import "@fontsource-variable/inter";
import "./styles/main.css";
import { EditorController } from "./editor/controller";
import { ResearchController } from "./research/controller";
import { TerminalController } from "./terminal/controller";
import { checkAndInstallUpdate } from "./services/updater";
import { UpdatesController } from "./updates/controller";
import {
  chooseProjectFolder,
  createProjectEntry,
  getGitWorkspace,
  gitCommitRepository,
  gitStageAll,
  gitStageFile,
  gitUnstageFile,
  openProject,
  readProjectFile,
  refreshProject,
  toAppError,
  writeProjectFile,
} from "./services/native";
import type {
  CreateKind,
  FileEntry,
  GitCommitAction,
  GitFileChange,
  GitRepository,
  GitWorkspace,
  ProjectSnapshot,
} from "./types";
import {
  basename,
  extension,
  findQuickOpenMatches,
  languageName,
  validateNewPath,
} from "./utils/files";
import { icon, type IconName } from "./ui/icons";

const LEGACY_LAST_PROJECT_KEY = "nullpointer:last-project";
const SIDEBAR_WIDTH_KEY = "nullpointer:sidebar-width";
const DEFAULT_COMMIT_ACTION: GitCommitAction = "commit-push";
const GIT_COMMIT_OPTIONS: readonly {
  readonly action: GitCommitAction;
  readonly label: string;
  readonly divider?: boolean;
}[] = [
  { action: "commit", label: "Commit" },
  { action: "commit-amend", label: "Commit (Amend)" },
  { action: "commit-push", label: "Commit & Push", divider: true },
  { action: "commit-sync", label: "Commit & Sync" },
];
const ACTIVITYBAR_WIDTH = 56;
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
type SidebarView = "explorer" | "source-control" | "updates";
type WorkspaceView = "editor" | "research";
const SIDEBAR_VIEW_ORDER: readonly SidebarView[] = ["explorer", "source-control", "updates"];

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
  private readonly workspace = element<HTMLElement>("#workspace");
  private readonly projectName = element<HTMLElement>("#project-name");
  private readonly projectPath = element<HTMLElement>("#project-path");
  private readonly sidebarTitle = element<HTMLElement>("#sidebar-title");
  private readonly explorerView = element<HTMLElement>("#explorer-view");
  private readonly researchView = element<HTMLElement>("#research-view");
  private readonly explorerActions = element<HTMLElement>("#explorer-actions");
  private readonly scmActions = element<HTMLElement>("#scm-actions");
  private readonly updatesActions = element<HTMLElement>("#updates-actions");
  private readonly scmView = element<HTMLElement>("#scm-view");
  private readonly updatesView = element<HTMLElement>("#updates-view");
  private readonly scmRepositories = element<HTMLElement>("#scm-repositories");
  private readonly scmGraph = element<HTMLElement>("#scm-graph");
  private readonly scmGraphBody = element<HTMLElement>("#scm-graph-body");
  private readonly scmGraphRepositoryTrigger = element<HTMLButtonElement>(
    "#scm-graph-repository-trigger",
  );
  private readonly scmGraphRepositoryLabel = element<HTMLElement>(
    "#scm-graph-repository-label",
  );
  private readonly scmGraphRepositoryMenu = element<HTMLElement>(
    "#scm-graph-repository-menu",
  );
  private readonly scmGraphToggle = element<HTMLButtonElement>("#scm-graph-toggle");
  private readonly scmRefreshButton = element<HTMLButtonElement>("#scm-refresh-button");
  private readonly scmBadge = element<HTMLElement>("#scm-badge");
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
  private readonly research: ResearchController;
  private readonly terminal: TerminalController;
  private readonly updates: UpdatesController;

  private project: ProjectSnapshot | null = null;
  private gitWorkspace: GitWorkspace | null = null;
  private gitError: string | null = null;
  private readonly expanded = new Set<string>();
  private readonly collapsedRepositories = new Set<string>();
  private readonly collapsedGitGroups = new Set<string>();
  private readonly commitMessages = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly loadingFiles = new Set<string>();
  private readonly disclosureAnimations = new WeakMap<HTMLElement, Animation>();
  private readonly disclosureCleanupTimers = new WeakMap<HTMLElement, number>();
  private readonly viewAnimations = new WeakMap<HTMLElement, Animation>();
  private sidebarView: SidebarView = "explorer";
  private workspaceView: WorkspaceView = "editor";
  private graphRepository: string | null = null;
  private gitMenuSequence = 0;
  private graphCollapsed = false;
  private sidebarCollapsed = false;
  private gitLoading = false;
  private quickMatches: FileEntry[] = [];
  private quickSelection = 0;
  private createKind: CreateKind = "file";
  private busyCount = 0;
  private projectGeneration = 0;
  private updateCheckInFlight = false;
  private deferredUpdateVersion: string | null = null;
  private readonly treeAnimationGenerations = new Map<string, number>();

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
    this.research = new ResearchController(this.researchView, {
      onBusy: (busy, message) => this.setBusy(busy, message),
      onToast: (message, tone, timeout) => this.toast(message, tone, timeout),
    });
    this.terminal = new TerminalController(
      this.shell,
      element<HTMLElement>("#terminal-panel"),
      {
        getCwd: () => this.project?.rootPath ?? null,
        onToast: (message, tone, timeout) => this.toast(message, tone, timeout),
      },
    );
    this.updates = new UpdatesController(this.updatesView, {
      canInstall: () =>
        this.dirty.size === 0 &&
        this.busyCount === 0 &&
        !this.quickDialog.open &&
        !this.entryDialog.open,
      onAutoChange: (enabled) => {
        if (enabled) void this.checkForUpdates();
      },
      onBusy: (busy, message) => this.setBusy(busy, message),
      onToast: (message, tone, timeout) => this.toast(message, tone, timeout),
    });
    this.restoreSidebarWidth();
    this.bindEvents();
    this.syncChrome();
  }

  start(): void {
    this.removeStorage(LEGACY_LAST_PROJECT_KEY);
    void this.research.restore();
    void this.updates.start().then(() => {
      window.setTimeout(() => void this.checkForUpdates(), 1_200);
    });
    window.setInterval(
      () => void this.checkForUpdates(),
      UPDATE_CHECK_INTERVAL_MS,
    );
  }

  private async checkForUpdates(): Promise<void> {
    if (this.updateCheckInFlight || !this.updates.automaticUpdatesEnabled()) return;
    this.updateCheckInFlight = true;
    let installing = false;
    try {
      const outcome = await checkAndInstallUpdate({
        canInstall: () =>
          this.dirty.size === 0 &&
          this.busyCount === 0 &&
          !this.quickDialog.open &&
          !this.entryDialog.open,
        onAvailable: (version) => {
          installing = true;
          this.setBusy(true, `Installing update ${version}…`);
          this.toast(`Installing NullPointer ${version}…`, "neutral", 5000);
        },
        onProgress: (downloaded, total) => {
          if (total && total > 0) {
            const percent = Math.min(100, Math.round((downloaded / total) * 100));
            this.generalStatus.textContent = `Updating NullPointer… ${percent}%`;
          } else {
            this.generalStatus.textContent = "Updating NullPointer…";
          }
        },
      });
      if (
        outcome.status === "deferred" &&
        this.deferredUpdateVersion !== outcome.version
      ) {
        this.deferredUpdateVersion = outcome.version;
        this.toast(
          `Update ${outcome.version} will install on the next clean launch.`,
          "neutral",
          5000,
        );
      }
    } catch (error) {
      if (installing) {
        this.toast(
          `Update failed: ${toAppError(error).message}`,
          "error",
          5000,
        );
      }
    } finally {
      if (installing) this.setBusy(false);
      this.updateCheckInFlight = false;
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
      this.showSidebarView("explorer");
    });
    element<HTMLButtonElement>("#activity-source-control").addEventListener("click", () => {
      this.showSidebarView("source-control");
      if (!this.gitWorkspace && !this.gitLoading) {
        void this.refreshGit();
      }
    });
    element<HTMLButtonElement>("#activity-updates").addEventListener("click", () => {
      this.showSidebarView("updates");
      void this.updates.activate();
    });
    element<HTMLButtonElement>("#activity-research").addEventListener("click", () => {
      this.showResearchWorkspace();
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
    this.scmRefreshButton.addEventListener("click", () => void this.refreshGit());
    element<HTMLButtonElement>("#updates-refresh-button").addEventListener("click", () => {
      void this.updates.refresh();
    });
    this.scmGraphToggle.addEventListener("click", () => {
      this.graphCollapsed = !this.graphCollapsed;
      this.syncGraphCollapsed();
    });
    this.scmGraphRepositoryTrigger.addEventListener("click", () => {
      this.toggleGraphRepositoryMenu();
    });
    this.scmGraphRepositoryMenu.addEventListener("click", (event) => {
      this.handleGraphRepositoryClick(event);
    });
    this.scmGraphRepositoryMenu.addEventListener("toggle", () => {
      this.scmGraphRepositoryTrigger.setAttribute(
        "aria-expanded",
        String(this.scmGraphRepositoryMenu.matches(":popover-open")),
      );
    });
    this.scmGraphRepositoryMenu.addEventListener("keydown", (event) => {
      this.handleGraphRepositoryKeydown(event);
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.scmGraphRepositoryMenu.matches(":popover-open")) return;
        const target = event.target;
        if (
          target instanceof Node &&
          !this.scmGraphRepositoryMenu.contains(target) &&
          !this.scmGraphRepositoryTrigger.contains(target)
        ) {
          this.scmGraphRepositoryMenu.hidePopover();
        }
      },
      { capture: true },
    );
    this.scmRepositories.addEventListener("click", (event) => {
      void this.handleGitClick(event);
    });
    this.scmRepositories.addEventListener("input", (event) => this.handleGitMessageInput(event));
    this.scmRepositories.addEventListener("keydown", (event) => {
      void this.handleGitKeydown(event);
    });
    this.tree.addEventListener("click", (event) => this.handleTreeClick(event));
    this.tabs.addEventListener("click", (event) => this.handleTabClick(event));
    this.tabs.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (
        event.button === 1 &&
        target instanceof Element &&
        target.closest(".tab")
      ) {
        event.preventDefault();
      }
    });
    this.tabs.addEventListener("auxclick", (event) => this.handleTabAuxClick(event));
    this.quickInput.addEventListener("input", () => this.renderQuickResults());
    this.quickInput.addEventListener("keydown", (event) => this.handleQuickKeydown(event));
    this.quickResults.addEventListener("click", (event) => this.handleQuickClick(event));
    this.quickDialog.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && event.target === this.quickDialog) {
        this.closeDialogAnimated(this.quickDialog);
      }
    });
    this.quickDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeDialogAnimated(this.quickDialog);
    });
    this.entryDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.closeDialogAnimated(this.entryDialog);
    });
    this.entryForm.addEventListener("submit", (event) => void this.handleEntrySubmit(event));
    element<HTMLButtonElement>("#entry-cancel").addEventListener("click", () => {
      this.closeDialogAnimated(this.entryDialog);
    });
    element<HTMLButtonElement>("#entry-cancel-secondary").addEventListener("click", () => {
      this.closeDialogAnimated(this.entryDialog);
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
      this.gitWorkspace = null;
      this.gitError = null;
      this.commitMessages.clear();
      this.collapsedRepositories.clear();
      this.collapsedGitGroups.clear();
      this.graphRepository = null;
      this.projectGeneration += 1;
      this.editor.reset();
      this.dirty.clear();
      this.expanded.clear();
      this.treeAnimationGenerations.clear();
      this.projectName.textContent = snapshot.name;
      this.projectPath.textContent = snapshot.rootPath;
      this.projectPath.title = snapshot.rootPath;
      document.title = `${snapshot.name} — NullPointer`;
      this.renderTree();
      this.renderTabs();
      this.renderGit();
      this.syncChrome();
      if (this.sidebarView === "source-control") void this.refreshGit(true);
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

  private async refreshGit(silent = false): Promise<void> {
    if (!this.project || this.gitLoading) {
      this.renderGit();
      return;
    }

    this.gitLoading = true;
    this.gitError = null;
    this.scmView.classList.add("loading");
    this.syncChrome();
    if (!silent) this.setBusy(true, "Refreshing source control…");
    try {
      this.gitWorkspace = await getGitWorkspace();
      this.renderGit();
    } catch (error) {
      const appError = toAppError(error);
      this.gitWorkspace = null;
      this.gitError = appError.message;
      this.renderGit();
      if (!silent) this.showError(appError);
    } finally {
      this.gitLoading = false;
      this.scmView.classList.remove("loading");
      this.syncChrome();
      if (!silent) this.setBusy(false);
    }
  }

  private renderGit(): void {
    this.scmRepositories.replaceChildren();
    this.renderGitGraph();
    if (!this.project) {
      this.scmRepositories.append(
        this.gitEmptyState("Open a project folder to inspect source control."),
      );
      return;
    }
    if (this.gitError) {
      this.scmRepositories.append(this.gitEmptyState(this.gitError, true));
      return;
    }
    if (!this.gitWorkspace) {
      this.scmRepositories.append(
        this.gitEmptyState(this.gitLoading ? "Scanning repositories…" : "Refresh to scan Git repositories."),
      );
      return;
    }
    if (this.gitWorkspace.repositories.length === 0) {
      this.scmRepositories.append(
        this.gitEmptyState("No Git repositories found in this workspace."),
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const repository of this.gitWorkspace.repositories) {
      fragment.append(this.renderGitRepository(repository));
    }
    this.scmRepositories.append(fragment);
  }

  private renderGitGraph(): void {
    const repositories = this.gitWorkspace?.repositories ?? [];
    this.scmView.classList.toggle("graph-hidden", repositories.length === 0);
    this.scmGraph.classList.toggle("hidden", repositories.length === 0);
    this.syncGraphCollapsed();
    this.scmGraphBody.replaceChildren();
    this.scmGraphRepositoryMenu.replaceChildren();
    if (repositories.length === 0) return;

    const selected =
      repositories.find((repository) => repository.relativePath === this.graphRepository) ??
      repositories[0];
    if (!selected) return;
    this.graphRepository = selected.relativePath;
    this.scmGraphRepositoryLabel.textContent = selected.name;
    this.scmGraphRepositoryLabel.title = selected.relativePath;
    this.scmGraphRepositoryTrigger.setAttribute(
      "aria-label",
      `Graph repository: ${selected.name}`,
    );

    for (const repository of repositories) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "scm-graph-repository-option";
      option.classList.toggle("active", repository.relativePath === selected.relativePath);
      option.dataset.graphRepository = repository.relativePath;
      option.title = repository.relativePath;
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        String(repository.relativePath === selected.relativePath),
      );
      const repositoryIcon = document.createElement("span");
      repositoryIcon.className = "scm-graph-repository-option-icon";
      repositoryIcon.innerHTML = icon("git-branch", 14);
      const name = document.createElement("span");
      name.textContent = repository.name;
      const selectedMarker = document.createElement("span");
      selectedMarker.className = "scm-graph-repository-option-check";
      if (repository.relativePath === selected.relativePath) {
        selectedMarker.innerHTML = icon("check", 14);
      }
      option.append(repositoryIcon, name, selectedMarker);
      this.scmGraphRepositoryMenu.append(option);
    }

    if (selected.commits.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scm-graph-empty";
      empty.textContent = "No commits yet";
      this.scmGraphBody.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    let lanes: string[] = [];
    selected.commits.forEach((commit, index) => {
      if (!lanes.includes(commit.hash)) lanes.push(commit.hash);
      const currentLanes = [...lanes];
      const commitLane = currentLanes.indexOf(commit.hash);
      const nextLanes = [...currentLanes];
      nextLanes.splice(commitLane, 1, ...commit.parents);
      lanes = nextLanes.filter(
        (hash, laneIndex) => hash && nextLanes.indexOf(hash) === laneIndex,
      );

      const row = document.createElement("div");
      row.className = "scm-graph-row";
      row.title = commit.hash;
      const laneCount = Math.max(currentLanes.length, lanes.length, 1);
      row.style.setProperty("--graph-width", `${Math.max(28, laneCount * 13 + 9)}px`);
      row.append(
        this.renderCommitLanes(currentLanes, lanes, commitLane, commit.parents, index === 0),
      );

      const details = document.createElement("div");
      details.className = "scm-graph-details";
      const headline = document.createElement("div");
      headline.className = "scm-graph-headline";
      const summary = document.createElement("span");
      summary.className = "scm-graph-summary";
      summary.textContent = commit.summary || "(no commit message)";
      headline.append(summary);

      const meta = document.createElement("div");
      meta.className = "scm-graph-meta";
      const hash = document.createElement("span");
      hash.className = "scm-graph-hash";
      hash.textContent = commit.shortHash;
      const author = document.createElement("span");
      author.textContent = commit.author;
      const time = document.createElement("span");
      time.textContent = commit.relativeTime;
      meta.append(hash, author, time);
      details.append(headline, meta);
      row.append(details);
      fragment.append(row);
    });
    this.scmGraphBody.append(fragment);
  }

  private syncGraphCollapsed(): void {
    const hasGraph = (this.gitWorkspace?.repositories.length ?? 0) > 0;
    this.scmView.classList.toggle("graph-collapsed", hasGraph && this.graphCollapsed);
    this.scmGraph.classList.toggle("collapsed", this.graphCollapsed);
    this.scmGraphToggle.setAttribute("aria-expanded", String(!this.graphCollapsed));
  }

  private toggleGraphRepositoryMenu(): void {
    if (this.scmGraphRepositoryMenu.matches(":popover-open")) {
      this.scmGraphRepositoryMenu.hidePopover();
      return;
    }
    this.openAnchoredPopover(
      this.scmGraphRepositoryMenu,
      this.scmGraphRepositoryTrigger,
      "start",
      true,
    );
    this.scmGraphRepositoryMenu
      .querySelector<HTMLButtonElement>(".scm-graph-repository-option.active")
      ?.focus({ preventScroll: true });
  }

  private handleGraphRepositoryClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLButtonElement>("[data-graph-repository]");
    if (!option?.dataset.graphRepository) return;
    this.scmGraphRepositoryMenu.hidePopover();
    if (this.graphRepository === option.dataset.graphRepository) return;
    this.graphRepository = option.dataset.graphRepository;
    this.renderGitGraph();
  }

  private handleGraphRepositoryKeydown(event: KeyboardEvent): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [
      ...this.scmGraphRepositoryMenu.querySelectorAll<HTMLButtonElement>(
        ".scm-graph-repository-option",
      ),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = options.length - 1;
    else if (event.key === "ArrowUp") next = current <= 0 ? options.length - 1 : current - 1;
    else if (event.key === "ArrowDown") next = current >= options.length - 1 ? 0 : current + 1;
    options[next]?.focus({ preventScroll: true });
  }

  private selectGraphRepositoryFromInteraction(repositoryPath: string): void {
    if (
      this.graphRepository === repositoryPath ||
      !this.gitWorkspace?.repositories.some(
        (repository) => repository.relativePath === repositoryPath,
      )
    ) {
      return;
    }
    this.graphRepository = repositoryPath;
    this.renderGitGraph();
  }

  private openAnchoredPopover(
    menu: HTMLElement,
    anchor: HTMLElement,
    alignment: "start" | "end",
    matchAnchorWidth = false,
  ): void {
    const anchorRect = anchor.getBoundingClientRect();
    menu.style.visibility = "hidden";
    menu.style.left = "0";
    menu.style.top = "0";
    menu.style.maxHeight = `${Math.max(80, window.innerHeight - 16)}px`;
    if (matchAnchorWidth) menu.style.width = `${Math.round(anchorRect.width)}px`;
    else menu.style.removeProperty("width");
    if (!menu.matches(":popover-open")) menu.showPopover();
    const menuRect = menu.getBoundingClientRect();
    const preferredLeft =
      alignment === "start" ? anchorRect.left : anchorRect.right - menuRect.width;
    const left = Math.max(
      8,
      Math.min(preferredLeft, window.innerWidth - menuRect.width - 8),
    );
    const below = anchorRect.bottom + 5;
    const top =
      below + menuRect.height <= window.innerHeight - 8
        ? below
        : Math.max(8, anchorRect.top - menuRect.height - 5);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.removeProperty("visibility");
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private cancelDisclosureCleanup(element: HTMLElement): void {
    const timer = this.disclosureCleanupTimers.get(element);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.disclosureCleanupTimers.delete(element);
  }

  private scheduleDisclosureCleanup(
    element: HTMLElement,
    shouldClear: () => boolean,
  ): void {
    this.cancelDisclosureCleanup(element);
    const timer = window.setTimeout(() => {
      this.disclosureCleanupTimers.delete(element);
      if (!element.hidden || !shouldClear()) return;
      element.replaceChildren();
      element.dataset.populated = "false";
    }, 1_200);
    this.disclosureCleanupTimers.set(element, timer);
  }

  private animateDisclosure(
    element: HTMLElement,
    expanding: boolean,
    onSettled?: () => void,
  ): void {
    const previous = this.disclosureAnimations.get(element);
    const interruptedHeight = previous ? element.getBoundingClientRect().height : null;
    const interruptedStyle = previous ? getComputedStyle(element) : null;
    const interruptedOpacity = interruptedStyle
      ? Number.parseFloat(interruptedStyle.opacity)
      : null;
    if (previous) {
      this.disclosureAnimations.delete(element);
      previous.cancel();
    }

    element.hidden = false;
    const contentHeight = element.scrollHeight;
    // Animating the full height of a large repository forces WebView to
    // relayout thousands of pixels on every frame. Animate only the visible
    // portion; the remaining off-screen content is restored after settling.
    const animatedHeight = Math.min(
      contentHeight,
      Math.max(240, Math.min(window.innerHeight * 0.55, 520)),
    );
    const startHeight =
      interruptedHeight === null
        ? expanding
          ? 0
          : animatedHeight
        : Math.min(interruptedHeight, animatedHeight);
    const endHeight = expanding ? animatedHeight : 0;
    const skipAnimation =
      this.prefersReducedMotion() ||
      !element.isConnected ||
      Math.abs(endHeight - startHeight) < 1;

    if (skipAnimation) {
      element.style.removeProperty("overflow");
      element.style.removeProperty("will-change");
      element.hidden = !expanding;
      onSettled?.();
      return;
    }

    const startOpacity =
      interruptedOpacity !== null && Number.isFinite(interruptedOpacity)
        ? interruptedOpacity
        : expanding
          ? 0
          : 1;
    const distanceRatio = Math.min(
      1,
      Math.abs(endHeight - startHeight) / Math.max(animatedHeight, 1),
    );
    const duration = Math.round(
      Math.max(70, (expanding ? 155 : 125) * distanceRatio),
    );
    element.style.overflow = "hidden";
    element.style.willChange = "height, opacity";
    const animation = element.animate(
      [
        {
          height: `${startHeight}px`,
          opacity: startOpacity,
        },
        {
          height: `${endHeight}px`,
          opacity: expanding ? 1 : 0,
        },
      ],
      {
        duration,
        easing: "cubic-bezier(.2,.8,.2,1)",
        fill: "both",
      },
    );
    this.disclosureAnimations.set(element, animation);
    const finish = (): void => {
      if (this.disclosureAnimations.get(element) !== animation) return;
      this.disclosureAnimations.delete(element);
      element.hidden = !expanding;
      animation.cancel();
      element.style.removeProperty("overflow");
      element.style.removeProperty("will-change");
      onSettled?.();
    };
    animation.onfinish = finish;
    animation.oncancel = () => {
      if (this.disclosureAnimations.get(element) !== animation) return;
      this.disclosureAnimations.delete(element);
      element.style.removeProperty("overflow");
      element.style.removeProperty("will-change");
      element.hidden = !expanding;
    };
  }

  private animateViewEntrance(element: HTMLElement, direction: -1 | 1): void {
    if (this.prefersReducedMotion()) return;
    const previous = this.viewAnimations.get(element);
    if (previous) {
      this.viewAnimations.delete(element);
      previous.cancel();
    }
    const animation = element.animate(
      [
        { opacity: 0, transform: `translateX(${direction * 8}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        duration: 165,
        easing: "cubic-bezier(.2,.8,.2,1)",
      },
    );
    this.viewAnimations.set(element, animation);
    const release = (): void => {
      if (this.viewAnimations.get(element) === animation) {
        this.viewAnimations.delete(element);
      }
    };
    animation.onfinish = release;
    animation.oncancel = release;
  }

  private closeDialogAnimated(dialog: HTMLDialogElement): void {
    if (!dialog.open || dialog.classList.contains("closing")) return;
    if (this.prefersReducedMotion()) {
      dialog.close();
      return;
    }

    dialog.classList.add("closing");
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      if (dialog.open) dialog.close();
      dialog.classList.remove("closing");
    };
    dialog.addEventListener("animationend", finish, { once: true });
    window.setTimeout(finish, 180);
  }

  private renderCommitLanes(
    currentLanes: readonly string[],
    nextLanes: readonly string[],
    commitLane: number,
    parents: readonly string[],
    firstRow: boolean,
  ): SVGSVGElement {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.classList.add("scm-graph-lines");
    svg.setAttribute("aria-hidden", "true");
    const laneCount = Math.max(currentLanes.length, nextLanes.length, 1);
    svg.setAttribute("viewBox", `0 0 ${laneCount * 13 + 9} 48`);
    const laneX = (lane: number): number => 9 + lane * 13;
    const addPath = (fromLane: number, fromY: number, toLane: number, toY: number): void => {
      const path = document.createElementNS(namespace, "path");
      const fromX = laneX(fromLane);
      const toX = laneX(toLane);
      const middle = (fromY + toY) / 2;
      path.setAttribute("d", `M ${fromX} ${fromY} C ${fromX} ${middle}, ${toX} ${middle}, ${toX} ${toY}`);
      svg.append(path);
    };

    currentLanes.forEach((hash, lane) => {
      if (lane === commitLane) return;
      const nextLane = nextLanes.indexOf(hash);
      if (nextLane >= 0) addPath(lane, 0, nextLane, 48);
    });
    if (!firstRow) addPath(commitLane, 0, commitLane, 14);
    parents.forEach((parent) => {
      const nextLane = nextLanes.indexOf(parent);
      if (nextLane >= 0) addPath(commitLane, 14, nextLane, 48);
    });

    const node = document.createElementNS(namespace, "circle");
    node.setAttribute("cx", String(laneX(commitLane)));
    node.setAttribute("cy", "14");
    node.setAttribute("r", parents.length > 1 ? "4.5" : "3.5");
    if (parents.length > 1) node.classList.add("merge");
    svg.append(node);
    return svg;
  }

  private gitEmptyState(message: string, error = false): HTMLElement {
    const empty = document.createElement("div");
    empty.className = `scm-empty${error ? " error" : ""}`;
    empty.innerHTML = icon(error ? "x" : "git-branch", 24);
    const text = document.createElement("p");
    text.textContent = message;
    empty.append(text);
    return empty;
  }

  private renderGitRepository(repository: GitRepository): HTMLElement {
    const section = document.createElement("section");
    section.className = "scm-repository";
    section.dataset.repository = repository.relativePath;

    const collapsed = this.collapsedRepositories.has(repository.relativePath);
    section.classList.toggle("collapsed", collapsed);
    const header = document.createElement("button");
    header.type = "button";
    header.className = "scm-repo-header";
    header.dataset.repositoryToggle = repository.relativePath;
    header.setAttribute("aria-expanded", String(!collapsed));
    header.title = repository.relativePath === "." ? repository.name : repository.relativePath;

    const marker = document.createElement("span");
    marker.className = "scm-repo-marker";
    marker.innerHTML = icon("chevron-down", 15);
    const repositoryIcon = document.createElement("span");
    repositoryIcon.className = "scm-repo-icon";
    repositoryIcon.innerHTML = icon("git-branch", 17);
    const name = document.createElement("strong");
    name.className = "scm-repo-name";
    name.textContent = repository.name;
    const branch = document.createElement("span");
    branch.className = "scm-branch";
    branch.innerHTML = icon("git-branch", 14);
    const branchName = document.createElement("span");
    branchName.textContent = repository.detached ? `detached@${repository.branch}` : repository.branch;
    branch.append(branchName);
    if (repository.ahead > 0 || repository.behind > 0) {
      const distance = document.createElement("span");
      distance.className = "scm-distance";
      distance.textContent = `↑${repository.ahead} ↓${repository.behind}`;
      branch.append(distance);
    }
    header.append(marker, repositoryIcon, name, branch);
    section.append(header);

    const body = document.createElement("div");
    body.className = "scm-repo-body";
    body.hidden = collapsed;
    body.dataset.populated = String(!collapsed);
    if (!collapsed) this.populateGitRepositoryBody(body, repository);
    section.append(body);
    return section;
  }

  private populateGitRepositoryBody(body: HTMLElement, repository: GitRepository): void {
    body.replaceChildren();
    const stagedChanges = repository.changes.filter((change) => change.indexStatus !== null);
    const workingChanges = repository.changes.filter((change) => change.worktreeStatus !== null);
    const message = this.commitMessages.get(repository.relativePath) ?? "";
    const hasMessage = message.trim().length > 0;
    const canCommit = stagedChanges.length > 0 && hasMessage;
    const canAmend = repository.commits.length > 0 && hasMessage;

    const commitRow = document.createElement("div");
    commitRow.className = "scm-commit";
    const input = document.createElement("input");
    input.className = "scm-commit-input";
    input.dataset.commitRepository = repository.relativePath;
    input.value = message;
    input.maxLength = 500;
    input.placeholder = `Message (Ctrl+Enter to commit on "${repository.branch}")`;
    input.setAttribute("aria-label", `Commit message for ${repository.name}`);
    const commitButton = document.createElement("button");
    commitButton.type = "button";
    commitButton.className = "scm-commit-button scm-commit-primary";
    commitButton.dataset.gitAction = DEFAULT_COMMIT_ACTION;
    commitButton.dataset.commitAction = DEFAULT_COMMIT_ACTION;
    commitButton.dataset.repository = repository.relativePath;
    commitButton.disabled = !canCommit;
    commitButton.textContent = "Commit & Push";

    const commitControl = document.createElement("div");
    commitControl.className = "scm-commit-control";
    const menuId = `scm-commit-menu-${++this.gitMenuSequence}`;
    const menuToggle = document.createElement("button");
    menuToggle.type = "button";
    menuToggle.className = "scm-commit-menu-toggle";
    menuToggle.dataset.commitMenuTarget = menuId;
    menuToggle.disabled = !canCommit && !canAmend;
    menuToggle.title = "Select commit action";
    menuToggle.setAttribute("aria-label", `Select commit action for ${repository.name}`);
    menuToggle.setAttribute("aria-haspopup", "menu");
    menuToggle.setAttribute("aria-controls", menuId);
    menuToggle.innerHTML = icon("chevron-down", 15);

    const menu = document.createElement("div");
    menu.id = menuId;
    menu.className = "scm-commit-menu";
    menu.popover = "auto";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Commit actions for ${repository.name}`);
    for (const option of GIT_COMMIT_OPTIONS) {
      if (option.divider) {
        const divider = document.createElement("div");
        divider.className = "scm-commit-menu-divider";
        divider.setAttribute("role", "separator");
        menu.append(divider);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "scm-commit-menu-item";
      item.classList.toggle("default", option.action === DEFAULT_COMMIT_ACTION);
      item.dataset.gitAction = option.action;
      item.dataset.commitAction = option.action;
      item.dataset.repository = repository.relativePath;
      item.disabled = option.action === "commit-amend" ? !canAmend : !canCommit;
      item.setAttribute("role", "menuitem");
      item.textContent = option.label;
      menu.append(item);
    }

    commitControl.append(commitButton, menuToggle, menu);
    commitRow.append(input, commitControl);
    body.append(commitRow);

    if (stagedChanges.length > 0) {
      body.append(this.renderGitGroup(repository, "Staged Changes", stagedChanges, "staged"));
    }
    if (workingChanges.length > 0) {
      body.append(this.renderGitGroup(repository, "Changes", workingChanges, "working"));
    }
    if (repository.changes.length === 0) {
      const clean = document.createElement("div");
      clean.className = "scm-clean";
      clean.innerHTML = icon("check", 15);
      const text = document.createElement("span");
      text.textContent = "Working tree clean";
      clean.append(text);
      body.append(clean);
    }
    body.dataset.populated = "true";
  }

  private ensureGitRepositoryBody(body: HTMLElement, repositoryPath: string): boolean {
    if (body.dataset.populated === "true") return true;
    const repository = this.gitWorkspace?.repositories.find(
      (candidate) => candidate.relativePath === repositoryPath,
    );
    if (!repository) return false;
    this.populateGitRepositoryBody(body, repository);
    return true;
  }

  private gitGroupKey(repository: string, scope: "staged" | "working"): string {
    return `${repository}\u0000${scope}`;
  }

  private renderGitGroup(
    repository: GitRepository,
    title: string,
    changes: readonly GitFileChange[],
    scope: "staged" | "working",
  ): HTMLElement {
    const collapsed = this.collapsedGitGroups.has(
      this.gitGroupKey(repository.relativePath, scope),
    );
    const group = document.createElement("section");
    group.className = "scm-group";
    group.classList.toggle("collapsed", collapsed);
    group.dataset.repository = repository.relativePath;
    group.dataset.gitScope = scope;
    const header = document.createElement("div");
    header.className = "scm-group-header";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "scm-group-toggle";
    toggle.dataset.gitGroupToggle = scope;
    toggle.dataset.repository = repository.relativePath;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} ${title}`);
    const marker = document.createElement("span");
    marker.className = "scm-group-marker";
    marker.innerHTML = icon("chevron-down", 14);
    const text = document.createElement("strong");
    text.textContent = title;
    toggle.append(marker, text);
    const actions = document.createElement("span");
    actions.className = "scm-group-actions";
    const count = document.createElement("span");
    count.className = "scm-count";
    count.textContent = String(changes.length);
    actions.append(count);
    if (scope === "working") {
      const stageAll = document.createElement("button");
      stageAll.type = "button";
      stageAll.className = "scm-inline-action";
      stageAll.dataset.gitAction = "stage-all";
      stageAll.dataset.repository = repository.relativePath;
      stageAll.title = `Stage all changes in ${repository.name}`;
      stageAll.setAttribute("aria-label", `Stage all changes in ${repository.name}`);
      stageAll.innerHTML = icon("plus", 15);
      actions.append(stageAll);
    }
    header.append(toggle, actions);
    group.append(header);

    const body = document.createElement("div");
    body.className = "scm-group-body";
    body.hidden = collapsed;
    body.dataset.populated = String(!collapsed);
    if (!collapsed) this.populateGitGroupBody(body, repository, changes, scope);
    group.append(body);
    return group;
  }

  private populateGitGroupBody(
    body: HTMLElement,
    repository: GitRepository,
    changes: readonly GitFileChange[],
    scope: "staged" | "working",
  ): void {
    body.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const change of changes) {
      const row = document.createElement("div");
      row.className = "scm-file-row";
      const status = scope === "staged" ? change.indexStatus : change.worktreeStatus;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "scm-file-main";
      open.dataset.gitOpen = change.path;
      open.dataset.repository = repository.relativePath;
      open.title = change.path;
      open.disabled = status === "D";
      const fileIcon = document.createElement("span");
      fileIcon.className = `scm-file-icon ext-${escapeSelector(extension(change.path) || "plain")}`;
      fileIcon.innerHTML = icon(
        ["js", "jsx", "ts", "tsx", "rs", "html", "css", "json"].includes(extension(change.path))
          ? "code"
          : "file",
        16,
      );
      const fileText = document.createElement("span");
      fileText.className = "scm-file-text";
      const fileName = document.createElement("span");
      fileName.className = "scm-file-name";
      fileName.textContent = basename(change.path);
      const directory = document.createElement("span");
      directory.className = "scm-file-directory";
      const separator = change.path.lastIndexOf("/");
      directory.textContent = separator > -1 ? change.path.slice(0, separator) : "";
      fileText.append(fileName, directory);
      open.append(fileIcon, fileText);

      const code = document.createElement("span");
      code.className = `scm-status status-${this.gitStatusLabel(status)}`;
      code.textContent = this.gitStatusLabel(status);
      code.title = this.gitStatusDescription(status);
      const action = document.createElement("button");
      action.type = "button";
      action.className = "scm-file-action";
      action.dataset.gitAction = scope === "staged" ? "unstage" : "stage";
      action.dataset.repository = repository.relativePath;
      action.dataset.path = change.path;
      action.title = scope === "staged" ? "Unstage changes" : "Stage changes";
      action.setAttribute("aria-label", `${action.title}: ${change.path}`);
      action.innerHTML = icon(scope === "staged" ? "minus" : "plus", 15);
      row.append(open, code, action);
      fragment.append(row);
    }
    body.append(fragment);
    body.dataset.populated = "true";
  }

  private ensureGitGroupBody(
    body: HTMLElement,
    repositoryPath: string,
    scope: "staged" | "working",
  ): boolean {
    if (body.dataset.populated === "true") return true;
    const repository = this.gitWorkspace?.repositories.find(
      (candidate) => candidate.relativePath === repositoryPath,
    );
    if (!repository) return false;
    const changes = repository.changes.filter((change) =>
      scope === "staged" ? change.indexStatus !== null : change.worktreeStatus !== null,
    );
    this.populateGitGroupBody(body, repository, changes, scope);
    return true;
  }

  private gitStatusLabel(status: string | null): string {
    return status === "?" ? "U" : (status ?? "M").toUpperCase();
  }

  private gitStatusDescription(status: string | null): string {
    const descriptions: Readonly<Record<string, string>> = {
      "?": "Untracked",
      A: "Added",
      C: "Copied",
      D: "Deleted",
      M: "Modified",
      R: "Renamed",
      T: "Type changed",
      U: "Unmerged",
    };
    return descriptions[status ?? "M"] ?? "Changed";
  }

  private async handleGitClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const interactedRepository = target.closest<HTMLElement>(".scm-repository")?.dataset.repository;
    if (interactedRepository) {
      this.selectGraphRepositoryFromInteraction(interactedRepository);
    }
    const commitMenuToggle = target.closest<HTMLButtonElement>("[data-commit-menu-target]");
    if (commitMenuToggle?.dataset.commitMenuTarget) {
      const menu = document.getElementById(commitMenuToggle.dataset.commitMenuTarget);
      if (!(menu instanceof HTMLElement)) return;
      if (menu.matches(":popover-open")) {
        menu.hidePopover();
        return;
      }
      this.openAnchoredPopover(menu, commitMenuToggle, "end");
      return;
    }

    const groupToggle = target.closest<HTMLButtonElement>("[data-git-group-toggle]");
    if (
      groupToggle?.dataset.repository &&
      (groupToggle.dataset.gitGroupToggle === "staged" ||
        groupToggle.dataset.gitGroupToggle === "working")
    ) {
      const repository = groupToggle.dataset.repository;
      const scope = groupToggle.dataset.gitGroupToggle;
      const key = this.gitGroupKey(repository, scope);
      const group = groupToggle.closest<HTMLElement>(".scm-group");
      const body = group?.querySelector<HTMLElement>(".scm-group-body");
      if (!group || !body) return;
      const expanding = this.collapsedGitGroups.has(key);
      if (expanding) {
        this.cancelDisclosureCleanup(body);
        if (!this.ensureGitGroupBody(body, repository, scope)) return;
        this.collapsedGitGroups.delete(key);
      } else {
        this.collapsedGitGroups.add(key);
      }
      group.classList.toggle("collapsed", !expanding);
      groupToggle.setAttribute("aria-expanded", String(expanding));
      groupToggle.setAttribute(
        "aria-label",
        `${expanding ? "Hide" : "Show"} ${scope === "staged" ? "Staged Changes" : "Changes"}`,
      );
      this.animateDisclosure(body, expanding, () => {
        if (!expanding) {
          this.scheduleDisclosureCleanup(body, () => this.collapsedGitGroups.has(key));
        }
      });
      return;
    }

    const toggle = target.closest<HTMLButtonElement>("[data-repository-toggle]");
    if (toggle?.dataset.repositoryToggle) {
      const repository = toggle.dataset.repositoryToggle;
      const section = toggle.closest<HTMLElement>(".scm-repository");
      const body = section?.querySelector<HTMLElement>(".scm-repo-body");
      if (!section || !body) return;
      const expanding = this.collapsedRepositories.has(repository);
      if (expanding) {
        this.cancelDisclosureCleanup(body);
        if (!this.ensureGitRepositoryBody(body, repository)) return;
        this.collapsedRepositories.delete(repository);
      } else {
        this.collapsedRepositories.add(repository);
      }
      section.classList.toggle("collapsed", !expanding);
      toggle.setAttribute("aria-expanded", String(expanding));
      this.animateDisclosure(body, expanding, () => {
        if (!expanding) {
          this.scheduleDisclosureCleanup(body, () =>
            this.collapsedRepositories.has(repository),
          );
        }
      });
      return;
    }

    const action = target.closest<HTMLButtonElement>("[data-git-action]");
    if (action?.dataset.gitAction && action.dataset.repository) {
      const menu = action.closest<HTMLElement>(".scm-commit-menu");
      if (menu?.matches(":popover-open")) menu.hidePopover();
      await this.performGitAction(
        action.dataset.gitAction,
        action.dataset.repository,
        action.dataset.path,
      );
      return;
    }

    const open = target.closest<HTMLButtonElement>("[data-git-open]");
    if (open?.dataset.gitOpen && open.dataset.repository) {
      const path =
        open.dataset.repository === "."
          ? open.dataset.gitOpen
          : `${open.dataset.repository}/${open.dataset.gitOpen}`;
      await this.openFile(path);
    }
  }

  private handleGitMessageInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.commitRepository) return;
    const repository = input.dataset.commitRepository;
    this.commitMessages.set(repository, input.value);
    const section = input.closest<HTMLElement>(".scm-repository");
    const snapshot = this.gitWorkspace?.repositories.find(
      (candidate) => candidate.relativePath === repository,
    );
    const hasStaged = snapshot?.changes.some((change) => change.indexStatus !== null) ?? false;
    const hasCommit = (snapshot?.commits.length ?? 0) > 0;
    const hasMessage = input.value.trim().length > 0;
    const actionButtons =
      section?.querySelectorAll<HTMLButtonElement>("[data-commit-action]") ?? [];
    for (const button of actionButtons) {
      button.disabled =
        !hasMessage ||
        (button.dataset.commitAction === "commit-amend" ? !hasCommit : !hasStaged);
    }
    const menuToggle = section?.querySelector<HTMLButtonElement>("[data-commit-menu-target]");
    if (menuToggle) menuToggle.disabled = !hasMessage || (!hasStaged && !hasCommit);
  }

  private async handleGitKeydown(event: KeyboardEvent): Promise<void> {
    const input = event.target;
    if (
      !(input instanceof HTMLInputElement) ||
      !input.dataset.commitRepository ||
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey)
    ) {
      return;
    }
    event.preventDefault();
    const section = input.closest<HTMLElement>(".scm-repository");
    const primary = section?.querySelector<HTMLButtonElement>(
      `[data-commit-action="${DEFAULT_COMMIT_ACTION}"]`,
    );
    if (primary?.disabled) return;
    await this.performGitAction(DEFAULT_COMMIT_ACTION, input.dataset.commitRepository);
  }

  private async performGitAction(
    action: string,
    repository: string,
    path?: string,
  ): Promise<void> {
    if (this.gitLoading) return;
    this.gitLoading = true;
    this.scmView.classList.add("loading");
    this.syncChrome();
    this.setBusy(true, "Updating source control…");
    try {
      if (action === "stage" && path) {
        this.gitWorkspace = await gitStageFile(repository, path);
        this.toast(`Staged ${basename(path)}`, "success", 1600);
      } else if (action === "unstage" && path) {
        this.gitWorkspace = await gitUnstageFile(repository, path);
        this.toast(`Unstaged ${basename(path)}`, "success", 1600);
      } else if (action === "stage-all") {
        this.gitWorkspace = await gitStageAll(repository);
        this.toast("Staged all changes", "success", 1600);
      } else if (this.isGitCommitAction(action)) {
        const message = this.commitMessages.get(repository)?.trim() ?? "";
        if (!message) return;
        const result = await gitCommitRepository(repository, message, action);
        this.gitWorkspace = result.workspace;
        this.commitMessages.delete(repository);
        if (result.warning) {
          this.toast(result.warning, "warning", 6000);
        } else {
          const successMessages: Readonly<Record<GitCommitAction, string>> = {
            commit: "Commit created",
            "commit-amend": "Commit amended",
            "commit-push": "Commit pushed",
            "commit-sync": "Commit synchronized",
          };
          this.toast(successMessages[action], "success", 1800);
        }
      }
      this.gitError = null;
      this.renderGit();
    } catch (error) {
      this.showError(error);
    } finally {
      this.gitLoading = false;
      this.scmView.classList.remove("loading");
      this.syncChrome();
      this.setBusy(false);
    }
  }

  private isGitCommitAction(action: string): action is GitCommitAction {
    return GIT_COMMIT_OPTIONS.some((option) => option.action === action);
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
    const appendEntries = (
      entries: readonly FileEntry[],
      depth: number,
      container: ParentNode,
    ): void => {
      for (const entry of entries) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row";
        row.dataset.path = entry.path;
        row.dataset.kind = entry.kind;
        row.dataset.depth = String(depth);
        row.style.setProperty("--tree-depth", String(depth));
        row.title = entry.path;
        if (entry.path === this.editor.active) row.classList.add("active");
        if (this.loadingFiles.has(entry.path)) row.classList.add("loading");
        if (entry.kind === "directory" && this.expanded.has(entry.path)) {
          row.classList.add("expanded");
        }

        const marker = document.createElement("span");
        marker.className = "tree-marker";
        if (entry.kind === "directory") {
          marker.innerHTML = icon("chevron-down", 15);
        }

        const glyph = document.createElement("span");
        glyph.className = `tree-icon ext-${escapeSelector(extension(entry.path) || "plain")}`;
        glyph.innerHTML = icon(this.entryIcon(entry), 18);

        const label = document.createElement("span");
        label.className = "tree-label";
        label.textContent = entry.name;
        if (entry.isSymlink) label.classList.add("symlink");

        row.append(marker, glyph, label);
        container.append(row);
        if (entry.kind === "directory" && this.expanded.has(entry.path)) {
          const children = document.createElement("div");
          children.className = "tree-directory-children";
          children.dataset.treeParent = entry.path;
          appendEntries(entry.children, depth + 1, children);
          container.append(children);
        }
      }
    };
    appendEntries(this.project.entries, 0, fragment);
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
      this.toggleDirectory(row, path);
      return;
    }
    void this.openFile(path);
  }

  private toggleDirectory(row: HTMLButtonElement, path: string): void {
    const generation = (this.treeAnimationGenerations.get(path) ?? 0) + 1;
    this.treeAnimationGenerations.set(path, generation);
    const expanding = !this.expanded.has(path);
    if (!expanding) {
      // Update the logical state before waiting so a rapid second click reverses
      // the transition instead of queueing another collapse.
      this.expanded.delete(path);
      const children = row.nextElementSibling;
      if (
        !(children instanceof HTMLElement) ||
        children.dataset.treeParent !== path
      ) {
        this.treeAnimationGenerations.delete(path);
        this.renderTree();
        this.focusTreeRow(path);
        return;
      }

      this.animateTreeMarker(row, false);
      this.animateDisclosure(children, false, () => {
        if (generation !== this.treeAnimationGenerations.get(path)) return;
        this.treeAnimationGenerations.delete(path);
        this.renderTree();
        this.focusTreeRow(path);
      });
      return;
    }

    this.expanded.add(path);
    this.renderTree();
    const expandedRow = this.tree.querySelector<HTMLButtonElement>(
      `.tree-row[data-path="${escapeSelector(path)}"]`,
    );
    const children = expandedRow?.nextElementSibling;
    if (
      !expandedRow ||
      !(children instanceof HTMLElement) ||
      children.dataset.treeParent !== path
    ) {
      this.treeAnimationGenerations.delete(path);
      return;
    }

    expandedRow.focus({ preventScroll: true });
    this.animateTreeMarker(expandedRow, true);
    this.animateDisclosure(children, true, () => {
      if (generation === this.treeAnimationGenerations.get(path)) {
        this.treeAnimationGenerations.delete(path);
      }
    });
  }

  private animateTreeMarker(row: HTMLButtonElement, expanding: boolean): void {
    if (this.prefersReducedMotion()) return;
    const marker = row.querySelector<HTMLElement>(".tree-marker");
    if (!marker) return;

    const animation = marker.animate(
      [
        { transform: expanding ? "rotate(-90deg)" : "rotate(0)" },
        { transform: expanding ? "rotate(0)" : "rotate(-90deg)" },
      ],
      {
        duration: expanding ? 150 : 125,
        easing: "cubic-bezier(.2,.8,.2,1)",
        fill: "both",
      },
    );
    animation.onfinish = () => animation.cancel();
  }

  private focusTreeRow(path: string): void {
    this.tree
      .querySelector<HTMLButtonElement>(
        `.tree-row[data-path="${escapeSelector(path)}"]`,
      )
      ?.focus({ preventScroll: true });
  }

  private async openFile(path: string): Promise<void> {
    this.showEditorWorkspace();
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

  private handleTabAuxClick(event: MouseEvent): void {
    if (event.button !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const path = target.closest<HTMLButtonElement>(".tab")?.dataset.path;
    if (!path) return;

    event.preventDefault();
    event.stopPropagation();
    this.closeTab(path);
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
    if (this.quickDialog.open) {
      this.quickInput.focus();
      this.quickInput.select();
      return;
    }
    this.quickInput.value = "";
    this.quickSelection = 0;
    this.renderQuickResults();
    this.quickDialog.classList.remove("closing");
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
        this.closeDialogAnimated(this.quickDialog);
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
      this.closeDialogAnimated(this.quickDialog);
      void this.openFile(path);
    }
  }

  private showEntryDialog(): void {
    if (!this.project) return;
    if (this.entryDialog.open) {
      this.entryInput.focus();
      return;
    }
    this.entryInput.value = "";
    this.entryError.textContent = "";
    this.createKind = "file";
    this.syncEntryKindButtons();
    this.entryDialog.classList.remove("closing");
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
      this.closeDialogAnimated(this.entryDialog);
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
    if (this.terminal.handleGlobalKeydown(event)) return;
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

  private showSidebarView(view: SidebarView): void {
    this.showEditorWorkspace();
    const previousView = this.sidebarView;
    const viewChanged = this.sidebarView !== view;
    this.sidebarView = view;
    if (this.sidebarCollapsed) {
      this.sidebarCollapsed = false;
      this.shell.classList.remove("sidebar-collapsed");
    }
    const title =
      view === "source-control" ? "Source Control" : view === "updates" ? "Updates" : "Explorer";
    const activeView =
      view === "source-control"
        ? this.scmView
        : view === "updates"
          ? this.updatesView
          : this.explorerView;
    this.sidebarTitle.textContent = title;
    this.explorerView.classList.toggle("hidden", view !== "explorer");
    this.explorerActions.classList.toggle("hidden", view !== "explorer");
    this.scmView.classList.toggle("hidden", view !== "source-control");
    this.scmActions.classList.toggle("hidden", view !== "source-control");
    this.updatesView.classList.toggle("hidden", view !== "updates");
    this.updatesActions.classList.toggle("hidden", view !== "updates");
    this.syncSidebarActivity();
    if (viewChanged) {
      const direction: -1 | 1 =
        SIDEBAR_VIEW_ORDER.indexOf(view) > SIDEBAR_VIEW_ORDER.indexOf(previousView) ? 1 : -1;
      this.animateViewEntrance(activeView, direction);
      const activeActions =
        view === "source-control"
          ? this.scmActions
          : view === "updates"
            ? this.updatesActions
            : this.explorerActions;
      this.animateViewEntrance(activeActions, direction);
      this.animateViewEntrance(this.sidebarTitle, direction);
    }
  }

  private showResearchWorkspace(): void {
    const viewChanged = this.workspaceView !== "research";
    this.workspaceView = "research";
    this.workspace.classList.add("research-active");
    this.researchView.classList.remove("hidden");
    if (!this.sidebarCollapsed) {
      this.sidebarCollapsed = true;
      this.shell.classList.add("sidebar-collapsed");
    }
    this.syncChrome();
    this.syncSidebarActivity();
    if (viewChanged) this.animateViewEntrance(this.researchView, 1);
  }

  private showEditorWorkspace(): void {
    if (this.workspaceView === "editor") return;
    this.workspaceView = "editor";
    this.workspace.classList.remove("research-active");
    this.researchView.classList.add("hidden");
    this.syncChrome();
    this.syncSidebarActivity();
  }

  private toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    this.shell.classList.toggle("sidebar-collapsed", this.sidebarCollapsed);
    this.syncSidebarActivity();
  }

  private syncSidebarActivity(): void {
    element<HTMLButtonElement>("#activity-explorer").classList.toggle(
      "active",
      this.workspaceView === "editor" &&
        !this.sidebarCollapsed &&
        this.sidebarView === "explorer",
    );
    element<HTMLButtonElement>("#activity-source-control").classList.toggle(
      "active",
      this.workspaceView === "editor" &&
        !this.sidebarCollapsed &&
        this.sidebarView === "source-control",
    );
    element<HTMLButtonElement>("#activity-updates").classList.toggle(
      "active",
      this.workspaceView === "editor" &&
        !this.sidebarCollapsed &&
        this.sidebarView === "updates",
    );
    element<HTMLButtonElement>("#activity-research").classList.toggle(
      "active",
      this.workspaceView === "research",
    );
  }

  private syncChrome(): void {
    const active = this.editor.active;
    const hasProject = this.project !== null;
    const researchActive = this.workspaceView === "research";
    this.welcome.classList.toggle("hidden", researchActive || active !== null);
    this.editorHost.classList.toggle("hidden", researchActive || active === null);
    this.tabs.classList.toggle("empty", this.editor.paths.length === 0);
    this.saveButton.disabled = researchActive || !active || !this.dirty.has(active);
    this.newEntryButton.disabled = !hasProject;
    this.refreshButton.disabled = !hasProject;
    this.scmRefreshButton.disabled = !hasProject || this.gitLoading;
    const sourceChanges = this.gitWorkspace?.totalChanges ?? 0;
    this.scmBadge.textContent = sourceChanges > 99 ? "99+" : String(sourceChanges);
    this.scmBadge.classList.toggle("hidden", !hasProject || sourceChanges === 0);
    this.cursorStatus.textContent =
      researchActive ? "Research" : active ? this.cursorStatus.textContent : "Ln —, Col —";
    this.languageStatus.textContent =
      researchActive ? "Markdown" : active ? languageName(active) : "Plain Text";
    this.generalStatus.textContent = researchActive
      ? "Research workspace"
      : active
        ? active
        : hasProject
          ? this.project?.rootPath ?? ""
          : "Ready";
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
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      this.shell.classList.add("resizing");
      const onMove = (moveEvent: PointerEvent): void => {
        const width = Math.max(
          0,
          Math.min(
            moveEvent.clientX - ACTIVITYBAR_WIDTH,
            window.innerWidth - ACTIVITYBAR_WIDTH,
          ),
        );
        this.shell.style.setProperty("--sidebar-width", `${width}px`);
        if (this.scmGraphRepositoryMenu.matches(":popover-open")) {
          this.openAnchoredPopover(
            this.scmGraphRepositoryMenu,
            this.scmGraphRepositoryTrigger,
            "start",
            true,
          );
        }
      };
      const onEnd = (): void => {
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onEnd);
        resizer.removeEventListener("pointercancel", onEnd);
        this.shell.classList.remove("resizing");
        const width = getComputedStyle(this.shell).getPropertyValue("--sidebar-width").trim();
        this.writeStorage(SIDEBAR_WIDTH_KEY, width);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onEnd);
      resizer.addEventListener("pointercancel", onEnd);
    });
  }

  private restoreSidebarWidth(): void {
    const stored = this.readStorage(SIDEBAR_WIDTH_KEY);
    const match = stored?.match(/^(\d+)px$/);
    if (!match) return;
    const width = Number(match[1]);
    if (!Number.isSafeInteger(width) || width < 0) return;
    const clamped = Math.min(width, Math.max(0, window.innerWidth - ACTIVITYBAR_WIDTH));
    this.shell.style.setProperty("--sidebar-width", `${clamped}px`);
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
        ${icon("files", 23)}
      </button>
      <button class="activity-button" id="activity-search" type="button" title="Quick open" aria-label="Quick open">
        ${icon("search", 23)}
      </button>
      <button class="activity-button" id="activity-research" type="button" title="Research" aria-label="Research">
        ${icon("flask", 23)}
      </button>
      <button class="activity-button" id="activity-source-control" type="button" title="Source Control" aria-label="Source Control">
        ${icon("git-branch", 23)}
        <span class="activity-badge hidden" id="scm-badge">0</span>
      </button>
      <button class="activity-button" id="activity-updates" type="button" title="Updates" aria-label="Updates">
        ${icon("history", 23)}
      </button>
      <span class="activity-spacer"></span>
      <button class="activity-button" id="toggle-sidebar-button" type="button" title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar">
        ${icon("panel-left", 22)}
      </button>
    </aside>

    <aside class="sidebar">
      <div class="sidebar-header">
        <span id="sidebar-title">Explorer</span>
        <div class="sidebar-actions" id="explorer-actions">
          <button class="mini-button" id="new-entry-button" type="button" title="New file or folder" aria-label="New file or folder">
            ${icon("file-plus", 18)}
          </button>
          <button class="mini-button" id="refresh-button" type="button" title="Refresh explorer" aria-label="Refresh explorer">
            ${icon("refresh", 17)}
          </button>
        </div>
        <div class="sidebar-actions hidden" id="scm-actions">
          <button class="mini-button" id="scm-refresh-button" type="button" title="Refresh source control" aria-label="Refresh source control">
            ${icon("refresh", 17)}
          </button>
        </div>
        <div class="sidebar-actions hidden" id="updates-actions">
          <button class="mini-button" id="updates-refresh-button" type="button" title="Check for releases" aria-label="Check for releases">
            ${icon("refresh", 17)}
          </button>
        </div>
      </div>
      <div class="explorer-view" id="explorer-view">
        <div class="project-path" id="project-path">No project selected</div>
        <nav class="file-tree" id="file-tree" aria-label="Project files">
          <div class="tree-empty">Open a folder to browse its files.</div>
        </nav>
      </div>
      <section class="scm-view hidden" id="scm-view" aria-label="Source control">
        <div class="scm-repositories" id="scm-repositories">
          <div class="scm-empty">${icon("git-branch", 24)}<p>Open a project folder to inspect source control.</p></div>
        </div>
        <section class="scm-graph hidden" id="scm-graph" aria-label="Commit graph">
          <header class="scm-graph-header">
            <button class="scm-graph-toggle" id="scm-graph-toggle" type="button" aria-expanded="true">
              ${icon("chevron-down", 14)}<strong>Graph</strong>
            </button>
            <div class="scm-graph-repository" id="scm-graph-repository">
              <button
                class="scm-graph-repository-trigger"
                id="scm-graph-repository-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-controls="scm-graph-repository-menu"
                aria-expanded="false"
                aria-label="Graph repository"
              >
                <span id="scm-graph-repository-label">Repository</span>
                ${icon("chevron-down", 14)}
              </button>
              <div
                class="scm-graph-repository-menu"
                id="scm-graph-repository-menu"
                popover="manual"
                role="listbox"
                aria-label="Graph repository"
              ></div>
            </div>
          </header>
          <div class="scm-graph-body" id="scm-graph-body"></div>
        </section>
      </section>
      <section class="updates-view hidden" id="updates-view" aria-label="Application updates">
        <div class="update-overview">
          <div class="update-version-mark">${icon("history", 22)}</div>
          <div class="update-version-copy">
            <small>Installed version</small>
            <strong id="update-current-version">Loading…</strong>
          </div>
          <span class="update-summary-status" id="update-summary-status" data-tone="neutral">Not checked yet</span>
        </div>

        <label class="update-auto-row" for="update-auto-toggle">
          <span>
            <strong>Automatic updates</strong>
            <small id="update-auto-caption">Checks quietly every 30 minutes</small>
          </span>
          <input id="update-auto-toggle" type="checkbox" />
          <span class="update-switch" aria-hidden="true"></span>
        </label>

        <div class="update-security-note">
          ${icon("check", 15)}
          <span id="update-security-copy">Every installer is verified with the app signing key before it can run.</span>
        </div>

        <div class="update-install-progress hidden" id="update-progress" role="status" aria-live="polite">
          <span id="update-progress-label">Preparing update…</span>
          <div><i id="update-progress-value"></i></div>
        </div>

        <div class="update-history-header">
          <div>
            <strong>Version history</strong>
            <small id="update-last-checked">Release history from GitHub</small>
          </div>
          <button type="button" data-update-action="refresh">Check now</button>
        </div>
        <div class="update-release-list" id="update-release-list"></div>
      </section>
      <div class="sidebar-resizer" id="sidebar-resizer"></div>
    </aside>

    <main class="workspace" id="workspace">
      <div class="tabs" id="tabs" role="tablist" aria-label="Open editors"></div>
      <section class="editor-surface">
        <section class="research-view hidden" id="research-view" aria-label="Research">
          <button
            class="research-folder-button"
            id="research-folder-button"
            type="button"
            data-research-action="choose-folder"
            aria-label="Choose research folder"
          >
            <span class="research-folder-icon">${icon("folder-open", 19)}</span>
            <span class="research-folder-details">
              <strong id="research-folder-name">Choose a folder</strong>
              <small id="research-folder-path">Markdown files will be saved here.</small>
            </span>
            ${icon("chevron-right", 15)}
          </button>

          <div class="research-intro" id="research-intro">
            <span class="research-intro-mark">${icon("flask", 25)}</span>
            <strong>Select a destination first</strong>
            <p>Your drafts, selected models and folder will be restored after restart.</p>
            <button class="primary-button" type="button" data-research-action="choose-folder">
              ${icon("folder-open", 17)} Choose folder
            </button>
          </div>

          <div class="research-workspace hidden" id="research-workspace">
            <div class="research-count-row">
              <div>
                <strong>Research drafts</strong>
                <small>Keep between 2 and 4 windows</small>
              </div>
              <div class="research-stepper" aria-label="Research window count">
                <button id="research-remove-draft" type="button" data-research-action="remove" aria-label="Remove last research window">
                  ${icon("minus", 14)}
                </button>
                <span id="research-draft-count">2 / 4</span>
                <button id="research-add-draft" type="button" data-research-action="add" aria-label="Add research window">
                  ${icon("plus", 14)}
                </button>
              </div>
            </div>

            <div class="research-drafts" id="research-drafts"></div>

            <div class="research-save-row">
              <button class="research-save-button" id="research-save" type="button" data-research-action="save">
                Save as Markdown
              </button>
              <p id="research-form-status">Add text to every research window.</p>
            </div>

            <section class="research-results hidden" id="research-results" aria-label="Saved research files">
              <header>
                <div>
                  <strong>Saved files</strong>
                  <small>Use the paths in your next workflow</small>
                </div>
              </header>
              <div class="research-results-list" id="research-results-list"></div>
              <button class="research-new-button" type="button" data-research-action="new">
                ${icon("plus", 15)} Start new research
              </button>
            </section>
          </div>
        </section>
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

    <section class="terminal-panel" id="terminal-panel" aria-label="Integrated terminal" aria-hidden="true">
      <div class="terminal-resizer" id="terminal-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize terminal"></div>
      <header class="terminal-toolbar">
        <div class="terminal-heading">
          <strong>Terminal</strong>
          <span class="terminal-shortcut">Ctrl &#96;</span>
        </div>
        <div class="terminal-tabs" id="terminal-tabs" role="tablist" aria-label="Terminal sessions"></div>
        <div class="terminal-actions">
          <div class="terminal-search hidden" id="terminal-search">
            ${icon("search", 14)}
            <input id="terminal-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="Find" aria-label="Find in terminal" />
            <span>Enter</span>
          </div>
          <div class="terminal-shell-picker" id="terminal-shell-picker">
            <button
              class="terminal-shell-trigger"
              id="terminal-shell-trigger"
              type="button"
              data-terminal-action="shell-menu"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="terminal-shell-menu"
              title="Shell for new terminals"
            >
              <span id="terminal-shell-label">PowerShell</span>
              ${icon("chevron-down", 13)}
            </button>
            <div class="terminal-shell-menu" id="terminal-shell-menu" role="listbox" aria-label="Shell for new terminals" aria-hidden="true">
              <button type="button" role="option" data-terminal-shell="powershell-core"><span>PowerShell</span>${icon("check", 13)}</button>
              <button type="button" role="option" data-terminal-shell="windows-powershell"><span>Windows PowerShell</span>${icon("check", 13)}</button>
              <button type="button" role="option" data-terminal-shell="command-prompt"><span>Command Prompt</span>${icon("check", 13)}</button>
              <button type="button" role="option" data-terminal-shell="default"><span>Default shell</span>${icon("check", 13)}</button>
              <button type="button" role="option" data-terminal-shell="bash"><span>Bash</span>${icon("check", 13)}</button>
              <button type="button" role="option" data-terminal-shell="zsh"><span>Zsh</span>${icon("check", 13)}</button>
            </div>
          </div>
          <button class="terminal-action" type="button" data-terminal-action="new" title="New terminal (Ctrl+Shift+&#96;)" aria-label="New terminal">
            ${icon("plus", 16)}
          </button>
          <button class="terminal-action" id="terminal-search-button" type="button" data-terminal-action="search" title="Find (Ctrl+F)" aria-label="Find in terminal">
            ${icon("search", 16)}
          </button>
          <button class="terminal-action" type="button" data-terminal-action="clear" title="Clear terminal" aria-label="Clear terminal">
            ${icon("eraser", 16)}
          </button>
          <button class="terminal-action" type="button" data-terminal-action="restart" title="Restart terminal" aria-label="Restart terminal">
            ${icon("refresh", 16)}
          </button>
          <button class="terminal-action" id="terminal-settings-button" type="button" data-terminal-action="settings" title="Terminal settings" aria-label="Terminal settings">
            ${icon("settings", 16)}
          </button>
          <button class="terminal-action" type="button" data-terminal-action="maximize" title="Maximize panel" aria-label="Maximize panel">
            ${icon("maximize", 15)}
          </button>
          <button class="terminal-action" type="button" data-terminal-action="close" title="Kill active terminal" aria-label="Kill active terminal">
            ${icon("trash", 15)}
          </button>
          <button class="terminal-action" type="button" data-terminal-action="collapse" title="Hide terminal" aria-label="Hide terminal">
            ${icon("chevron-down", 16)}
          </button>
        </div>
      </header>
      <div class="terminal-views" id="terminal-views"></div>
      <div class="terminal-settings" id="terminal-settings" popover="manual">
        <header><strong>Terminal settings</strong><small>Saved automatically</small></header>
        <div class="terminal-setting-row">
          <span><strong>Font size</strong><small>Terminal text only</small></span>
          <div class="terminal-font-stepper">
            <button type="button" data-terminal-action="font-smaller" aria-label="Decrease terminal font">${icon("minus", 13)}</button>
            <output id="terminal-font-size-value">13px</output>
            <button type="button" data-terminal-action="font-larger" aria-label="Increase terminal font">${icon("plus", 13)}</button>
          </div>
        </div>
        <label class="terminal-setting-row">
          <span><strong>Cursor</strong><small>Shape of the caret</small></span>
          <select id="terminal-cursor-style">
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label class="terminal-setting-row">
          <span><strong>Scrollback</strong><small>Lines kept in memory</small></span>
          <select id="terminal-scrollback">
            <option value="1000">1,000</option>
            <option value="5000">5,000</option>
            <option value="10000">10,000</option>
            <option value="50000">50,000</option>
          </select>
        </label>
      </div>
    </section>

    <footer class="statusbar">
      <span class="status-main" id="general-status">Ready</span>
      <button class="terminal-status-button" id="terminal-status-button" type="button" aria-expanded="false">
        ${icon("terminal", 14)}<span>Terminal</span><b id="terminal-status-count"></b>
      </button>
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
app.start();
