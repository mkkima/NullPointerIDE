import {
  getAndroidEmulators,
  launchAndroidEmulator,
  rebootAndroidEmulator,
  stopAndroidEmulator,
  toAppError,
} from "../services/native";
import type { AndroidAvd, AndroidDevice, AndroidEmulatorSnapshot } from "../types";
import { icon } from "../ui/icons";
import {
  emulatorSnapshotsEqual,
  emulatorStatusLabel,
  secondaryAndroidDevices,
  summarizeEmulators,
} from "./model";

const POLL_INTERVAL_MS = 3_000;

interface EmulatorControllerOptions {
  readonly onOpenAdbShell: (serial: string) => void;
  readonly onToast: (
    message: string,
    tone: "success" | "warning" | "error" | "neutral",
    timeout?: number,
  ) => void;
}

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Required emulator element not found: ${selector}`);
  return value;
}

export class EmulatorController {
  private readonly sdkPath: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly warnings: HTMLElement;
  private readonly avdList: HTMLElement;
  private readonly deviceSection: HTMLElement;
  private readonly deviceList: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly actionKeys = new Set<string>();

  private snapshot: AndroidEmulatorSnapshot | null = null;
  private active = false;
  private loading = false;
  private refreshInFlight = false;
  private generation = 0;
  private pollTimer: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly options: EmulatorControllerOptions,
  ) {
    this.sdkPath = required(root, "#emulator-sdk-path");
    this.summary = required(root, "#emulator-summary");
    this.warnings = required(root, "#emulator-warnings");
    this.avdList = required(root, "#emulator-avd-list");
    this.deviceSection = required(root, "#emulator-device-section");
    this.deviceList = required(root, "#emulator-device-list");
    this.refreshButton = required(root, "#emulator-refresh");
    this.bindEvents();
    this.render();
  }

  activate(): void {
    if (this.active) {
      void this.refresh(true);
      return;
    }
    this.active = true;
    void this.refresh(true);
    this.pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void this.refresh(true);
    }, POLL_INTERVAL_MS);
  }

  deactivate(): void {
    this.active = false;
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private bindEvents(): void {
    this.root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("[data-emulator-action]");
      const action = button?.dataset.emulatorAction;
      if (!button || !action || button.disabled) return;
      if (action === "refresh") {
        void this.refresh(false);
        return;
      }
      const avdName = button.dataset.avdName;
      const serial = button.dataset.emulatorSerial;
      if ((action === "start" || action === "cold-boot") && avdName) {
        void this.launch(avdName, action === "cold-boot");
      } else if (action === "stop" && serial) {
        void this.stop(serial);
      } else if (action === "reboot" && serial) {
        void this.reboot(serial);
      } else if (action === "adb-shell" && serial && /^emulator-\d+$/.test(serial)) {
        this.options.onOpenAdbShell(serial);
      }
    });
  }

  private async refresh(silent = false): Promise<void> {
    if (this.refreshInFlight || this.actionKeys.size > 0) return;
    this.refreshInFlight = true;
    const showLoading = !silent || this.snapshot === null;
    if (showLoading) {
      this.loading = true;
      this.syncLoadingState();
      if (this.snapshot === null) {
        this.render();
      }
    }
    const generation = ++this.generation;
    let snapshotChanged = false;
    try {
      const snapshot = await getAndroidEmulators();
      if (generation !== this.generation) return;
      snapshotChanged = !emulatorSnapshotsEqual(this.snapshot, snapshot);
      this.snapshot = snapshot;
      if (!silent) this.options.onToast("Emulators refreshed", "success", 1400);
    } catch (error) {
      if (generation !== this.generation) return;
      this.options.onToast(toAppError(error).message, "error", 5000);
    } finally {
      this.refreshInFlight = false;
      if (generation === this.generation) {
        this.loading = false;
        if (snapshotChanged || this.snapshot === null) this.render();
        else this.syncLoadingState();
      }
    }
  }

  private async launch(name: string, coldBoot: boolean): Promise<void> {
    const key = `launch:${name}`;
    await this.runAction(key, async () => {
      this.snapshot = await launchAndroidEmulator(name, coldBoot);
      this.options.onToast(
        `${name} is starting${coldBoot ? " with a cold boot" : ""}`,
        "success",
        2600,
      );
    });
  }

  private async stop(serial: string): Promise<void> {
    await this.runAction(`stop:${serial}`, async () => {
      this.snapshot = await stopAndroidEmulator(serial);
      this.options.onToast(`Stopping ${serial}`, "neutral", 2200);
    });
  }

  private async reboot(serial: string): Promise<void> {
    await this.runAction(`reboot:${serial}`, async () => {
      this.snapshot = await rebootAndroidEmulator(serial);
      this.options.onToast(`Rebooting ${serial}`, "success", 2200);
    });
  }

  private async runAction(key: string, action: () => Promise<void>): Promise<void> {
    if (this.loading || this.actionKeys.has(key)) return;
    this.actionKeys.add(key);
    this.generation += 1;
    this.render();
    try {
      await action();
    } catch (error) {
      this.options.onToast(toAppError(error).message, "error", 5000);
    } finally {
      this.actionKeys.delete(key);
      this.render();
      if (this.active) {
        window.setTimeout(() => void this.refresh(true), 1_200);
      }
    }
  }

  private render(): void {
    this.syncLoadingState();

    if (!this.snapshot) {
      this.sdkPath.textContent = this.loading ? "Detecting Android SDK…" : "Not checked yet";
      this.summary.replaceChildren();
      this.warnings.replaceChildren();
      this.deviceSection.classList.add("hidden");
      this.renderInitialState();
      return;
    }

    this.sdkPath.textContent = this.snapshot.sdkRoot ?? "Android SDK root not found";
    this.sdkPath.title = this.snapshot.sdkRoot ?? "";
    this.renderSummary(this.snapshot);
    this.renderWarnings(this.snapshot.warnings);
    this.renderAvds(this.snapshot);
    this.renderDevices(secondaryAndroidDevices(this.snapshot));
  }

  private syncLoadingState(): void {
    this.root.classList.toggle("loading", this.loading);
    this.refreshButton.disabled = this.loading || this.actionKeys.size > 0;
    this.refreshButton.classList.toggle("spinning", this.loading);
  }

  private renderInitialState(): void {
    const state = document.createElement("div");
    state.className = "emulator-empty";
    state.innerHTML = `${icon("smartphone", 30)}<strong>${this.loading ? "Scanning system…" : "Open the section to detect emulators"}</strong>`;
    const copy = document.createElement("p");
    copy.textContent = "NullPointer checks Android SDK, AVD and ADB without changing their configuration.";
    state.append(copy);
    this.avdList.replaceChildren(state);
  }

  private renderSummary(snapshot: AndroidEmulatorSnapshot): void {
    const values = summarizeEmulators(snapshot);
    const fragment = document.createDocumentFragment();
    for (const [label, value] of [
      ["Installed", values.installed],
      ["Running", values.running],
      ["Connected", values.connected],
    ] as const) {
      const card = document.createElement("div");
      const output = document.createElement("strong");
      output.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      card.append(output, caption);
      fragment.append(card);
    }
    this.summary.replaceChildren(fragment);
  }

  private renderWarnings(warnings: readonly string[]): void {
    const fragment = document.createDocumentFragment();
    for (const warning of warnings) {
      const row = document.createElement("div");
      row.innerHTML = icon("settings", 15);
      const text = document.createElement("span");
      text.textContent = warning;
      row.append(text);
      fragment.append(row);
    }
    this.warnings.replaceChildren(fragment);
    this.warnings.classList.toggle("hidden", warnings.length === 0);
  }

  private renderAvds(snapshot: AndroidEmulatorSnapshot): void {
    if (snapshot.avds.length === 0) {
      const state = document.createElement("div");
      state.className = "emulator-empty";
      state.innerHTML = icon("smartphone", 30);
      const heading = document.createElement("strong");
      heading.textContent = snapshot.emulatorAvailable
        ? "No Android virtual devices installed"
        : "Android Emulator is unavailable";
      const copy = document.createElement("p");
      copy.textContent = snapshot.emulatorAvailable
        ? "Create an AVD in Android Studio Device Manager, then refresh this page."
        : "Install Android Emulator through Android Studio SDK Manager.";
      state.append(heading, copy);
      this.avdList.replaceChildren(state);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const avd of snapshot.avds) fragment.append(this.renderAvdCard(avd));
    this.avdList.replaceChildren(fragment);
  }

  private renderAvdCard(avd: AndroidAvd): HTMLElement {
    const card = document.createElement("article");
    card.className = `emulator-card status-${avd.status}`;

    const header = document.createElement("header");
    const mark = document.createElement("span");
    mark.className = "emulator-device-mark";
    mark.innerHTML = icon("smartphone", 21);
    const identity = document.createElement("div");
    identity.className = "emulator-identity";
    const title = document.createElement("strong");
    title.textContent = avd.displayName;
    const name = document.createElement("small");
    name.textContent = avd.name;
    identity.append(title, name);
    const status = document.createElement("span");
    status.className = `emulator-status ${avd.status}`;
    status.textContent = emulatorStatusLabel(avd.status);
    header.append(mark, identity, status);

    const metadata = document.createElement("div");
    metadata.className = "emulator-metadata";
    for (const value of [
      avd.target,
      avd.abi,
      avd.resolution,
      avd.playStore ? "Google Play" : null,
      avd.serial,
    ]) {
      if (!value) continue;
      const item = document.createElement("span");
      item.textContent = value;
      item.title = value;
      metadata.append(item);
    }

    const actions = document.createElement("footer");
    actions.className = "emulator-actions";
    const launching = this.actionKeys.has(`launch:${avd.name}`);
    const stopping = avd.serial ? this.actionKeys.has(`stop:${avd.serial}`) : false;
    const rebooting = avd.serial ? this.actionKeys.has(`reboot:${avd.serial}`) : false;
    if (avd.status === "stopped") {
      actions.append(
        this.actionButton("start", "Start", { avdName: avd.name }, launching, true),
        this.actionButton(
          "cold-boot",
          "Cold boot",
          { avdName: avd.name },
          launching,
        ),
      );
    } else {
      if (avd.serial && avd.status === "running") {
        actions.append(
          this.actionButton(
            "adb-shell",
            "ADB shell",
            { serial: avd.serial },
            rebooting || stopping,
          ),
          this.actionButton(
            "reboot",
            rebooting ? "Rebooting…" : "Reboot",
            { serial: avd.serial },
            rebooting || stopping,
          ),
        );
      }
      if (avd.serial) {
        actions.append(
          this.actionButton(
            "stop",
            stopping ? "Stopping…" : "Stop",
            { serial: avd.serial },
            stopping || rebooting,
            false,
            true,
          ),
        );
      } else {
        const waiting = document.createElement("span");
        waiting.className = "emulator-waiting";
        waiting.textContent = "Waiting for ADB…";
        actions.append(waiting);
      }
    }

    card.append(header, metadata, actions);
    return card;
  }

  private actionButton(
    action: string,
    label: string,
    data: { readonly avdName?: string; readonly serial?: string },
    disabled: boolean,
    primary = false,
    danger = false,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.emulatorAction = action;
    if (data.avdName) button.dataset.avdName = data.avdName;
    if (data.serial) button.dataset.emulatorSerial = data.serial;
    button.disabled = this.loading || disabled;
    button.className = primary ? "primary" : danger ? "danger" : "";
    button.textContent = label;
    return button;
  }

  private renderDevices(devices: readonly AndroidDevice[]): void {
    this.deviceSection.classList.toggle("hidden", devices.length === 0);
    const fragment = document.createDocumentFragment();
    for (const device of devices) {
      const row = document.createElement("div");
      const mark = document.createElement("span");
      mark.innerHTML = icon("smartphone", 17);
      const identity = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = device.model ?? device.device ?? device.serial;
      const detail = document.createElement("small");
      detail.textContent = `${device.serial} · ${device.state}`;
      identity.append(name, detail);
      row.append(mark, identity);
      fragment.append(row);
    }
    this.deviceList.replaceChildren(fragment);
  }
}
