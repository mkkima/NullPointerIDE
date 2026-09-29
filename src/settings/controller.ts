import { isTauri } from "@tauri-apps/api/core";
import {
  changeInterfaceScale,
  DEFAULT_INTERFACE_SCALE,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  normalizeInterfaceScale,
  parseStoredInterfaceScale,
} from "./model";

const STORAGE_KEY = "nullpointer:interface-scale";

interface AppSettingsControllerOptions {
  readonly onToast: (
    message: string,
    tone: "success" | "warning" | "error" | "neutral",
    timeout?: number,
  ) => void;
}

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Required settings element not found: ${selector}`);
  return value;
}

export class AppSettingsController {
  private readonly trigger: HTMLButtonElement;
  private readonly popover: HTMLElement;
  private readonly value: HTMLOutputElement;
  private readonly decreaseButton: HTMLButtonElement;
  private readonly increaseButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;

  private requestedScale: number;
  private appliedScale = DEFAULT_INTERFACE_SCALE;
  private applying = false;

  constructor(
    root: HTMLElement,
    private readonly options: AppSettingsControllerOptions,
  ) {
    this.trigger = required(root, "#app-settings-button");
    this.popover = required(root, "#app-settings-popover");
    this.value = required(root, "#app-scale-value");
    this.decreaseButton = required(root, "#app-scale-decrease");
    this.increaseButton = required(root, "#app-scale-increase");
    this.resetButton = required(root, "#app-scale-reset");
    this.requestedScale = this.loadScale();
    this.bindEvents();
    this.render();
  }

  start(): void {
    void this.flushScale(false);
  }

  private bindEvents(): void {
    this.trigger.addEventListener("click", () => this.togglePopover());
    this.decreaseButton.addEventListener("click", () => this.step(-1));
    this.increaseButton.addEventListener("click", () => this.step(1));
    this.resetButton.addEventListener("click", () => this.setScale(DEFAULT_INTERFACE_SCALE));
    this.popover.addEventListener("toggle", () => this.syncPopoverState());

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!this.popover.matches(":popover-open")) return;
        const target = event.target;
        if (
          target instanceof Node &&
          !this.popover.contains(target) &&
          !this.trigger.contains(target)
        ) {
          this.popover.hidePopover();
        }
      },
      { capture: true },
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        if (event.key === "0") {
          event.preventDefault();
          this.setScale(DEFAULT_INTERFACE_SCALE);
        } else if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          this.step(1);
        } else if (event.key === "-") {
          event.preventDefault();
          this.step(-1);
        }
      },
      { capture: true },
    );
  }

  private togglePopover(): void {
    if (this.popover.matches(":popover-open")) this.popover.hidePopover();
    else this.popover.showPopover();
  }

  private syncPopoverState(): void {
    const open = this.popover.matches(":popover-open");
    this.trigger.classList.toggle("active", open);
    this.trigger.setAttribute("aria-expanded", String(open));
  }

  private step(direction: -1 | 1): void {
    this.setScale(changeInterfaceScale(this.requestedScale, direction));
  }

  private setScale(scale: number): void {
    const normalized = normalizeInterfaceScale(scale);
    if (normalized === this.requestedScale) return;
    this.requestedScale = normalized;
    this.render();
    void this.flushScale(true);
  }

  private async flushScale(reportErrors: boolean): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.appliedScale !== this.requestedScale) {
        const target = this.requestedScale;
        await this.applyScale(target);
        this.appliedScale = target;
        this.saveScale(target);
        window.dispatchEvent(new Event("resize"));
      }
    } catch (error) {
      this.requestedScale = this.appliedScale;
      if (reportErrors) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.onToast(`Could not change interface scale: ${message}`, "error", 5000);
      }
    } finally {
      this.applying = false;
      this.render();
    }
  }

  private async applyScale(scale: number): Promise<void> {
    const factor = scale / 100;
    if (isTauri()) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(factor);
      return;
    }
    document.documentElement.style.zoom = String(factor);
  }

  private render(): void {
    this.value.textContent = `${this.requestedScale}%`;
    this.decreaseButton.disabled = this.requestedScale <= MIN_INTERFACE_SCALE;
    this.increaseButton.disabled = this.requestedScale >= MAX_INTERFACE_SCALE;
    this.resetButton.disabled = this.requestedScale === DEFAULT_INTERFACE_SCALE;
  }

  private loadScale(): number {
    try {
      return parseStoredInterfaceScale(localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_INTERFACE_SCALE;
    }
  }

  private saveScale(scale: number): void {
    try {
      localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      // Scale remains available for the current application session.
    }
  }
}
