import "./styles/main.css";
import { EditorController } from "./editor/controller";
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
const ACTIVITYBAR_WIDTH = 56;
const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 640;

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
  private readonly sidebarTitle = element<HTMLElement>("#sidebar-title");
  private readonly explorerView = element<HTMLElement>("#explorer-view");
  private readonly explorerActions = element<HTMLElement>("#explorer-actions");
  private readonly scmActions = element<HTMLElement>("#scm-actions");
  private readonly scmView = element<HTMLElement>("#scm-view");
  private readonly scmRepositories = element<HTMLElement>("#scm-repositories");
  private readonly scmGraph = element<HTMLElement>("#scm-graph");
  private readonly scmGraphBody = element<HTMLElement>("#scm-graph-body");
  private readonly scmGraphRepository = element<HTMLSelectElement>("#scm-graph-repository");
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

  private project: ProjectSnapshot | null = null;
  private gitWorkspace: GitWorkspace | null = null;
  private gitError: string | null = null;
  private readonly expanded = new Set<string>();
  private readonly collapsedRepositories = new Set<string>();
  private readonly commitMessages = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly loadingFiles = new Set<string>();
  private sidebarView: "explorer" | "source-control" = "explorer";
  private graphRepository: string | null = null;
  private graphCollapsed = false;
  private sidebarCollapsed = false;
  private gitLoading = false;
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

  start(): void {
    this.removeStorage(LEGACY_LAST_PROJECT_KEY);
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
      void this.refreshGit();
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
    this.scmGraphToggle.addEventListener("click", () => {
      this.graphCollapsed = !this.graphCollapsed;
      this.renderGitGraph();
    });
    this.scmGraphRepository.addEventListener("change", () => {
      this.graphRepository = this.scmGraphRepository.value;
      this.renderGitGraph();
    });
    this.scmRepositories.addEventListener("click", (event) => {
      void this.handleGitClick(event);
    });
    this.scmRepositories.addEventListener("input", (event) => this.handleGitMessageInput(event));
    this.scmRepositories.addEventListener("keydown", (event) => {
      void this.handleGitKeydown(event);
    });
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
      this.gitWorkspace = null;
      this.gitError = null;
      this.commitMessages.clear();
      this.collapsedRepositories.clear();
      this.graphRepository = null;
      this.projectGeneration += 1;
      this.editor.reset();
      this.dirty.clear();
      this.expanded.clear();
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
    this.scmView.classList.toggle(
      "graph-collapsed",
      repositories.length > 0 && this.graphCollapsed,
    );
    this.scmGraph.classList.toggle("hidden", repositories.length === 0);
    this.scmGraph.classList.toggle("collapsed", this.graphCollapsed);
    this.scmGraphToggle.setAttribute("aria-expanded", String(!this.graphCollapsed));
    this.scmGraphToggle.innerHTML =
      `${icon(this.graphCollapsed ? "chevron-right" : "chevron-down", 14)}<strong>Graph</strong>`;
    this.scmGraphBody.replaceChildren();
    this.scmGraphRepository.replaceChildren();
    if (repositories.length === 0) return;

    const selected =
      repositories.find((repository) => repository.relativePath === this.graphRepository) ??
      repositories[0];
    if (!selected) return;
    this.graphRepository = selected.relativePath;

    for (const repository of repositories) {
      const option = document.createElement("option");
      option.value = repository.relativePath;
      option.textContent = repository.name;
      option.title = repository.relativePath;
      option.selected = repository.relativePath === selected.relativePath;
      this.scmGraphRepository.append(option);
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
      for (const reference of commit.refs) {
        const badge = document.createElement("span");
        badge.className = `scm-ref${reference.startsWith("HEAD -> ") ? " head" : ""}`;
        badge.textContent = reference.replace(/^HEAD -> /, "");
        badge.title = reference;
        headline.append(badge);
      }

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
    const header = document.createElement("button");
    header.type = "button";
    header.className = "scm-repo-header";
    header.dataset.repositoryToggle = repository.relativePath;
    header.title = repository.relativePath === "." ? repository.name : repository.relativePath;

    const marker = document.createElement("span");
    marker.className = "scm-repo-marker";
    marker.innerHTML = icon(collapsed ? "chevron-right" : "chevron-down", 15);
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
    const stagedChanges = repository.changes.filter((change) => change.indexStatus !== null);
    const workingChanges = repository.changes.filter((change) => change.worktreeStatus !== null);
    const message = this.commitMessages.get(repository.relativePath) ?? "";

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
    commitButton.className = "scm-commit-button";
    commitButton.dataset.gitAction = "commit";
    commitButton.dataset.repository = repository.relativePath;
    commitButton.disabled = stagedChanges.length === 0 || message.trim().length === 0;
    commitButton.innerHTML = `${icon("check", 17)}<span>Commit</span>`;
    commitRow.append(input, commitButton);
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

    section.append(body);
    return section;
  }

  private renderGitGroup(
    repository: GitRepository,
    title: string,
    changes: readonly GitFileChange[],
    scope: "staged" | "working",
  ): HTMLElement {
    const group = document.createElement("section");
    group.className = "scm-group";
    const header = document.createElement("div");
    header.className = "scm-group-header";
    const label = document.createElement("span");
    label.innerHTML = icon("chevron-down", 14);
    const text = document.createElement("strong");
    text.textContent = title;
    label.append(text);
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
    header.append(label, actions);
    group.append(header);

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
      group.append(row);
    }
    return group;
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
    const toggle = target.closest<HTMLButtonElement>("[data-repository-toggle]");
    if (toggle?.dataset.repositoryToggle) {
      const repository = toggle.dataset.repositoryToggle;
      if (this.collapsedRepositories.has(repository)) this.collapsedRepositories.delete(repository);
      else this.collapsedRepositories.add(repository);
      this.renderGit();
      return;
    }

    const action = target.closest<HTMLButtonElement>("[data-git-action]");
    if (action?.dataset.gitAction && action.dataset.repository) {
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
    const commitButton = section?.querySelector<HTMLButtonElement>('[data-git-action="commit"]');
    const hasStaged = this.gitWorkspace?.repositories
      .find((candidate) => candidate.relativePath === repository)
      ?.changes.some((change) => change.indexStatus !== null);
    if (commitButton) commitButton.disabled = !hasStaged || input.value.trim().length === 0;
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
    await this.performGitAction("commit", input.dataset.commitRepository);
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
      } else if (action === "commit") {
        const message = this.commitMessages.get(repository)?.trim() ?? "";
        if (!message) return;
        this.gitWorkspace = await gitCommitRepository(repository, message);
        this.commitMessages.delete(repository);
        this.toast("Commit created", "success", 1800);
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

  private showSidebarView(view: "explorer" | "source-control"): void {
    this.sidebarView = view;
    if (this.sidebarCollapsed) {
      this.sidebarCollapsed = false;
      this.shell.classList.remove("sidebar-collapsed");
    }
    const sourceControl = view === "source-control";
    this.sidebarTitle.textContent = sourceControl ? "Source Control" : "Explorer";
    this.explorerView.classList.toggle("hidden", sourceControl);
    this.explorerActions.classList.toggle("hidden", sourceControl);
    this.scmView.classList.toggle("hidden", !sourceControl);
    this.scmActions.classList.toggle("hidden", !sourceControl);
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
      !this.sidebarCollapsed && this.sidebarView === "explorer",
    );
    element<HTMLButtonElement>("#activity-source-control").classList.toggle(
      "active",
      !this.sidebarCollapsed && this.sidebarView === "source-control",
    );
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
    this.scmRefreshButton.disabled = !hasProject || this.gitLoading;
    const sourceChanges = this.gitWorkspace?.totalChanges ?? 0;
    this.scmBadge.textContent = sourceChanges > 99 ? "99+" : String(sourceChanges);
    this.scmBadge.classList.toggle("hidden", !hasProject || sourceChanges === 0);
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
        const width = Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, moveEvent.clientX - ACTIVITYBAR_WIDTH),
        );
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
    const match = stored?.match(/^(\d{3})px$/);
    if (!match) return;
    const width = Number(match[1]);
    const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
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
        ${icon("panel-left", 23)}
      </button>
      <button class="activity-button" id="activity-search" type="button" title="Quick open" aria-label="Quick open">
        ${icon("search", 23)}
      </button>
      <button class="activity-button" id="activity-source-control" type="button" title="Source Control" aria-label="Source Control">
        ${icon("git-branch", 23)}
        <span class="activity-badge hidden" id="scm-badge">0</span>
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
            <select class="scm-graph-repository" id="scm-graph-repository" aria-label="Graph repository"></select>
          </header>
          <div class="scm-graph-body" id="scm-graph-body"></div>
        </section>
      </section>
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
app.start();
