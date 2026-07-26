import { getVersion } from "@tauri-apps/api/app";
import {
  installAppVersion,
  isProductionBuild,
  listAppReleases,
  toAppError,
} from "../services/native";
import type { AppRelease, AppUpdateEvent } from "../types";

const AUTOMATIC_UPDATES_KEY = "nullpointer:automatic-updates";
const RELEASE_CACHE_MS = 5 * 60 * 1000;
const ROLLBACK_CONFIRM_MS = 6_000;

type ToastTone = "success" | "warning" | "error" | "neutral";

interface UpdatesCallbacks {
  readonly canInstall: () => boolean;
  readonly onAutoChange: (enabled: boolean) => void;
  readonly onBusy: (busy: boolean, message?: string) => void;
  readonly onToast: (message: string, tone: ToastTone, timeout?: number) => void;
}

interface ParsedVersion {
  readonly core: readonly [bigint, bigint, bigint];
  readonly prerelease: readonly string[];
}

function required<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Required updates element not found: ${selector}`);
  return value;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number {
  if (left === right) return 0;
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right, undefined, { numeric: true });
  }
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const leftPart = parsedLeft.core[index]!;
    const rightPart = parsedRight.core[index]!;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export class UpdatesController {
  private readonly currentVersionLabel: HTMLElement;
  private readonly summaryStatus: HTMLElement;
  private readonly automaticToggle: HTMLInputElement;
  private readonly automaticCaption: HTMLElement;
  private readonly lastCheckedLabel: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly progressValue: HTMLElement;
  private readonly releaseList: HTMLElement;

  private automatic = this.readAutomaticPreference();
  private currentVersion: string | null = null;
  private productionBuild = false;
  private releases: readonly AppRelease[] = [];
  private releasesLoaded = false;
  private releasesLoading = false;
  private releasesError: string | null = null;
  private lastCheckedAt = 0;
  private installingVersion: string | null = null;
  private installMessage: string | null = null;
  private downloadedBytes = 0;
  private totalBytes: number | null = null;
  private pendingRollback: string | null = null;
  private rollbackTimer: number | null = null;
  private initialization: Promise<void> | null = null;
  private progressFrame: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: UpdatesCallbacks,
  ) {
    this.currentVersionLabel = required(root, "#update-current-version");
    this.summaryStatus = required(root, "#update-summary-status");
    this.automaticToggle = required(root, "#update-auto-toggle");
    this.automaticCaption = required(root, "#update-auto-caption");
    this.lastCheckedLabel = required(root, "#update-last-checked");
    this.progress = required(root, "#update-progress");
    this.progressLabel = required(root, "#update-progress-label");
    this.progressValue = required(root, "#update-progress-value");
    this.releaseList = required(root, "#update-release-list");
    this.bindEvents();
    this.render();
  }

  start(): Promise<void> {
    return this.ensureInitialized();
  }

  async activate(): Promise<void> {
    await this.ensureInitialized();
    if (
      !this.releasesLoaded ||
      (this.lastCheckedAt > 0 && Date.now() - this.lastCheckedAt >= RELEASE_CACHE_MS)
    ) {
      await this.refresh();
    }
  }

  automaticUpdatesEnabled(): boolean {
    return this.automatic;
  }

  async refresh(): Promise<void> {
    if (this.releasesLoading || this.installingVersion) return;
    await this.ensureInitialized();
    this.releasesLoading = true;
    this.releasesError = null;
    this.render();
    try {
      this.releases = [...(await listAppReleases())].sort((left, right) =>
        compareVersions(right.version, left.version),
      );
      this.releasesLoaded = true;
      this.lastCheckedAt = Date.now();
    } catch (error) {
      this.releasesError = toAppError(error).message;
    } finally {
      this.releasesLoading = false;
      this.render();
    }
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = Promise.all([getVersion(), isProductionBuild()])
      .then(([version, production]) => {
        this.currentVersion = version;
        this.productionBuild = production;
      })
      .catch((error: unknown) => {
        this.releasesError = toAppError(error).message;
      })
      .finally(() => this.render());
    return this.initialization;
  }

  private bindEvents(): void {
    this.automaticToggle.addEventListener("change", () => {
      this.automatic = this.automaticToggle.checked;
      this.writeAutomaticPreference();
      this.renderAutomaticPreference();
      this.callbacks.onAutoChange(this.automatic);
      this.callbacks.onToast(
        this.automatic ? "Automatic updates enabled." : "Automatic updates disabled.",
        "neutral",
        2200,
      );
    });
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest<HTMLElement>("[data-update-action]");
      if (!action) return;
      if (action.dataset.updateAction === "refresh") {
        void this.refresh();
        return;
      }
      if (action.dataset.updateAction === "install" && action.dataset.version) {
        void this.install(action.dataset.version);
      }
    });
  }

  private async install(version: string): Promise<void> {
    if (this.installingVersion || !this.currentVersion || !this.productionBuild) return;
    const release = this.releases.find((candidate) => candidate.version === version);
    if (!release?.updateAvailable || version === this.currentVersion) return;

    const rollingBack = compareVersions(version, this.currentVersion) < 0;
    if (rollingBack && this.pendingRollback !== version) {
      this.pendingRollback = version;
      if (this.rollbackTimer !== null) window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = window.setTimeout(() => {
        this.pendingRollback = null;
        this.rollbackTimer = null;
        this.renderReleases();
      }, ROLLBACK_CONFIRM_MS);
      this.renderReleases();
      return;
    }
    if (!this.callbacks.canInstall()) {
      this.callbacks.onToast(
        "Save unsaved files and wait for current tasks before changing the app version.",
        "warning",
        4500,
      );
      return;
    }

    if (rollingBack && this.automatic) {
      this.automatic = false;
      this.writeAutomaticPreference();
      this.renderAutomaticPreference();
      this.callbacks.onAutoChange(false);
      this.callbacks.onToast(
        "Automatic updates were disabled so the rollback stays installed.",
        "neutral",
        4000,
      );
    }
    this.clearRollbackConfirmation();
    this.installingVersion = version;
    this.installMessage = rollingBack
      ? `Rolling back to ${version}…`
      : `Installing ${version}…`;
    this.downloadedBytes = 0;
    this.totalBytes = null;
    this.callbacks.onBusy(true, this.installMessage);
    this.render();

    try {
      await installAppVersion(version, (event) => this.handleInstallEvent(event));
    } catch (error) {
      const message = toAppError(error).message;
      this.installMessage = message;
      this.callbacks.onToast(`Version change failed: ${message}`, "error", 6000);
      this.installingVersion = null;
      this.callbacks.onBusy(false);
      this.render();
    }
  }

  private handleInstallEvent(event: AppUpdateEvent): void {
    if (event.event === "started") {
      this.downloadedBytes = 0;
      this.totalBytes = event.data.content_length;
    } else if (event.event === "progress") {
      this.downloadedBytes += event.data.chunk_length;
    } else {
      this.downloadedBytes = this.totalBytes ?? this.downloadedBytes;
      this.installMessage = "Verified. Restarting NullPointer…";
    }
    this.queueProgressRender();
  }

  private queueProgressRender(): void {
    if (this.progressFrame !== null) return;
    this.progressFrame = window.requestAnimationFrame(() => {
      this.progressFrame = null;
      this.renderProgress();
    });
  }

  private render(): void {
    this.renderAutomaticPreference();
    this.renderOverview();
    this.renderProgress();
    this.renderReleases();
  }

  private renderAutomaticPreference(): void {
    this.automaticToggle.checked = this.automatic;
    this.automaticCaption.textContent = this.automatic
      ? "Checks quietly every 30 minutes"
      : "Manual checks only";
  }

  private renderOverview(): void {
    this.currentVersionLabel.textContent = this.currentVersion
      ? `v${this.currentVersion}`
      : "Loading…";
    const latest = this.currentVersion
      ? this.releases.find(
          (release) =>
            release.updateAvailable &&
            compareVersions(release.version, this.currentVersion ?? release.version) > 0,
        )
      : null;
    if (!this.productionBuild && this.currentVersion) {
      this.summaryStatus.textContent = "Development build";
      this.summaryStatus.dataset.tone = "neutral";
    } else if (latest) {
      this.summaryStatus.textContent = `v${latest.version} available`;
      this.summaryStatus.dataset.tone = "available";
    } else if (this.releasesError) {
      this.summaryStatus.textContent = "Check unavailable";
      this.summaryStatus.dataset.tone = "warning";
    } else if (this.releasesLoaded) {
      this.summaryStatus.textContent = "Up to date";
      this.summaryStatus.dataset.tone = "current";
    } else {
      this.summaryStatus.textContent = "Not checked yet";
      this.summaryStatus.dataset.tone = "neutral";
    }

    this.lastCheckedLabel.textContent = this.lastCheckedAt
      ? `Checked ${new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(this.lastCheckedAt)}`
      : "Release history from GitHub";
  }

  private renderProgress(): void {
    const visible = this.installingVersion !== null || this.installMessage !== null;
    this.progress.classList.toggle("hidden", !visible);
    if (!visible) return;
    const percent =
      this.totalBytes && this.totalBytes > 0
        ? Math.min(100, Math.round((this.downloadedBytes / this.totalBytes) * 100))
        : null;
    this.progressLabel.textContent =
      percent === null
        ? (this.installMessage ?? "Preparing update…")
        : `${this.installMessage ?? "Installing…"} ${percent}%`;
    this.progressValue.style.width = percent === null ? "18%" : `${percent}%`;
    this.progressValue.classList.toggle("indeterminate", percent === null);
  }

  private renderReleases(): void {
    const fragment = document.createDocumentFragment();
    if (this.releasesLoading && this.releases.length === 0) {
      fragment.append(this.createState("Loading release history…", "neutral"));
    } else if (this.releasesError && this.releases.length === 0) {
      fragment.append(this.createState(this.releasesError, "error", true));
    } else if (this.releases.length === 0) {
      fragment.append(
        this.createState(
          this.releasesLoaded ? "No stable releases are available yet." : "Check for releases.",
          "neutral",
          !this.releasesLoaded,
        ),
      );
    } else {
      this.releases.forEach((release, index) => {
        fragment.append(this.createReleaseCard(release, index === 0));
      });
    }
    this.releaseList.replaceChildren(fragment);
  }

  private createState(message: string, tone: "neutral" | "error", retry = false): HTMLElement {
    const state = document.createElement("div");
    state.className = `update-state ${tone}`;
    const text = document.createElement("p");
    text.textContent = message;
    state.append(text);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.updateAction = "refresh";
      button.textContent = "Try again";
      state.append(button);
    }
    return state;
  }

  private createReleaseCard(release: AppRelease, latest: boolean): HTMLElement {
    const card = document.createElement("article");
    card.className = "update-release";
    if (release.version === this.currentVersion) card.classList.add("current");

    const header = document.createElement("header");
    const title = document.createElement("div");
    const version = document.createElement("strong");
    version.textContent = `v${release.version}`;
    title.append(version);
    if (latest) {
      const badge = document.createElement("span");
      badge.textContent = "Latest";
      title.append(badge);
    }
    const date = document.createElement("time");
    date.textContent = this.formatReleaseDate(release.publishedAt);
    if (release.publishedAt) date.dateTime = release.publishedAt;
    header.append(title, date);

    const name = document.createElement("p");
    name.className = "update-release-name";
    name.textContent = release.name;

    const notes = document.createElement("details");
    notes.className = "update-release-notes";
    const summary = document.createElement("summary");
    summary.textContent = "Release notes";
    const body = document.createElement("p");
    body.textContent = release.notes.trim() || "No release notes were provided.";
    notes.append(summary, body);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "update-release-action";
    const comparison = this.currentVersion
      ? compareVersions(release.version, this.currentVersion)
      : 0;
    if (!this.productionBuild) {
      action.textContent = "Packaged builds only";
      action.disabled = true;
    } else if (release.version === this.currentVersion) {
      action.textContent = "Installed";
      action.disabled = true;
    } else if (!release.updateAvailable) {
      action.textContent = "Installer unavailable";
      action.disabled = true;
    } else if (this.installingVersion) {
      action.textContent =
        this.installingVersion === release.version ? "Installing…" : "Please wait";
      action.disabled = true;
    } else {
      action.dataset.updateAction = "install";
      action.dataset.version = release.version;
      if (comparison > 0) {
        action.textContent = "Update";
      } else if (this.pendingRollback === release.version) {
        action.textContent = "Confirm rollback";
        action.classList.add("danger");
      } else {
        action.textContent = "Roll back";
      }
    }

    card.append(header, name, notes, action);
    return card;
  }

  private formatReleaseDate(value: string | null): string {
    if (!value) return "Unknown date";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  }

  private clearRollbackConfirmation(): void {
    this.pendingRollback = null;
    if (this.rollbackTimer !== null) {
      window.clearTimeout(this.rollbackTimer);
      this.rollbackTimer = null;
    }
  }

  private readAutomaticPreference(): boolean {
    try {
      return localStorage.getItem(AUTOMATIC_UPDATES_KEY) !== "false";
    } catch {
      return true;
    }
  }

  private writeAutomaticPreference(): void {
    try {
      localStorage.setItem(AUTOMATIC_UPDATES_KEY, String(this.automatic));
    } catch {
      // The session setting still works when persistent storage is unavailable.
    }
  }
}
