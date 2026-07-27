import type DOMPurify from "dompurify";

const PREVIEW_WIDTH_KEY = "nullpointer:markdown-preview-width";
const DEFAULT_PREVIEW_RATIO = 0.5;
const MIN_PREVIEW_RATIO = 0.15;
const MAX_PREVIEW_RATIO = 0.85;
const MAX_PREVIEW_CHARACTERS = 2_000_000;
const RENDER_DELAY_MS = 90;
const RENDER_TIMEOUT_MS = 8_000;

interface MarkdownRenderResponse {
  readonly id: number;
  readonly html?: string;
  readonly error?: string;
}

interface PendingRender {
  readonly resolve: (html: string) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: number;
}

let sanitizerPromise: Promise<typeof DOMPurify> | null = null;

function sanitizer(): Promise<typeof DOMPurify> {
  if (!sanitizerPromise) {
    const loading = import("dompurify").then((module) => module.default);
    sanitizerPromise = loading;
    void loading.catch(() => {
      if (sanitizerPromise === loading) sanitizerPromise = null;
    });
  }
  return sanitizerPromise;
}

export async function sanitizeMarkdownHtml(html: string): Promise<string> {
  const purify = await sanitizer();
  return String(
    purify.sanitize(html, {
      ALLOW_DATA_ATTR: false,
      FORBID_ATTR: ["id", "name", "style", "target"],
      FORBID_TAGS: [
        "audio",
        "base",
        "button",
        "embed",
        "form",
        "iframe",
        "input",
        "link",
        "meta",
        "object",
        "option",
        "select",
        "source",
        "style",
        "textarea",
        "video",
      ],
      RETURN_TRUSTED_TYPE: false,
      USE_PROFILES: { html: true },
    }),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function slugifyHeading(value: string, used: Map<string, number>): string {
  const base =
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/[\s-]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  const occurrence = used.get(base) ?? 0;
  used.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}-${occurrence + 1}`;
}

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Required Markdown preview element not found: ${selector}`);
  return value;
}

class MarkdownWorkerRenderer {
  private worker: Worker | null;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRender>();

  constructor() {
    this.worker = this.createWorker();
  }

  render(source: string): Promise<string> {
    const id = ++this.sequence;
    return new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.failAll(new Error("Markdown preview timed out."));
        this.discardWorker();
      }, RENDER_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      if (!this.worker) this.worker = this.createWorker();
      this.worker.postMessage({ id, source });
    });
  }

  destroy(): void {
    this.failAll(new Error("Markdown preview was closed."));
    this.discardWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "markdown-preview",
    });
    worker.addEventListener("message", (event: MessageEvent<MarkdownRenderResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      window.clearTimeout(pending.timeout);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.html ?? "");
    });
    worker.addEventListener("error", () => {
      if (this.worker !== worker) return;
      this.failAll(new Error("Markdown preview worker failed."));
      this.discardWorker(worker);
    });
    return worker;
  }

  private discardWorker(worker = this.worker): void {
    worker?.terminate();
    if (this.worker === worker) this.worker = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class MarkdownPreviewController {
  private readonly output: HTMLElement;
  private readonly status: HTMLElement;
  private readonly resizer: HTMLElement;
  private readonly renderer = new MarkdownWorkerRenderer();
  private activePath: string | null = null;
  private pendingSource = "";
  private renderedSource = "";
  private renderTimer: number | null = null;
  private generation = 0;
  private previewRatio = DEFAULT_PREVIEW_RATIO;

  constructor(
    private readonly layout: HTMLElement,
    private readonly panel: HTMLElement,
  ) {
    this.output = required(panel, "#markdown-preview-content");
    this.status = required(panel, "#markdown-preview-status");
    this.resizer = required(layout, "#markdown-preview-resizer");
    this.restorePreviewWidth();
    this.bindResize();
    this.bindLinks();
  }

  show(path: string, source: string): void {
    const changedDocument = this.activePath !== path;
    this.activePath = path;
    this.layout.classList.add("markdown-preview-visible");
    this.panel.setAttribute("aria-hidden", "false");
    if (
      !changedDocument &&
      source === this.pendingSource &&
      (source === this.renderedSource || this.renderTimer !== null)
    ) {
      return;
    }
    this.pendingSource = source;
    this.generation += 1;
    this.scheduleRender(changedDocument ? 0 : RENDER_DELAY_MS);
  }

  hide(): void {
    if (!this.activePath && !this.layout.classList.contains("markdown-preview-visible")) return;
    this.activePath = null;
    this.pendingSource = "";
    this.renderedSource = "";
    this.generation += 1;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.layout.classList.remove("markdown-preview-visible", "markdown-preview-loading");
    this.panel.setAttribute("aria-hidden", "true");
    this.status.textContent = "Live";
  }

  destroy(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderer.destroy();
  }

  private scheduleRender(delay: number): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.render();
    }, delay);
  }

  private async render(): Promise<void> {
    const path = this.activePath;
    const source = this.pendingSource;
    if (!path) return;
    const generation = ++this.generation;

    if (source.length > MAX_PREVIEW_CHARACTERS) {
      this.showMessage(
        "Preview paused",
        "This Markdown file is too large for live preview. Editing and saving still work normally.",
      );
      this.renderedSource = source;
      return;
    }
    if (!source.trim()) {
      this.showMessage("Nothing to preview", "Start typing Markdown in the editor.");
      this.renderedSource = source;
      return;
    }

    this.layout.classList.add("markdown-preview-loading");
    this.status.textContent = "Rendering…";
    try {
      const html = await this.renderer.render(source);
      if (generation !== this.generation || path !== this.activePath) return;
      const sanitized = await sanitizeMarkdownHtml(html);
      if (generation !== this.generation || path !== this.activePath) return;
      const previousHeight = Math.max(1, this.output.scrollHeight - this.output.clientHeight);
      const scrollRatio = this.output.scrollTop / previousHeight;
      this.output.innerHTML = sanitized;
      this.decorateOutput();
      const nextHeight = Math.max(0, this.output.scrollHeight - this.output.clientHeight);
      this.output.scrollTop = Math.round(nextHeight * scrollRatio);
      this.renderedSource = source;
      this.status.textContent = "Live";
    } catch (error) {
      if (generation !== this.generation || path !== this.activePath) return;
      this.showMessage(
        "Preview unavailable",
        error instanceof Error ? error.message : "Markdown rendering failed.",
      );
    } finally {
      if (generation === this.generation) {
        this.layout.classList.remove("markdown-preview-loading");
      }
    }
  }

  private showMessage(title: string, message: string): void {
    const container = document.createElement("div");
    container.className = "markdown-preview-message";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = message;
    container.append(heading, copy);
    this.output.replaceChildren(container);
    this.status.textContent = title;
    this.layout.classList.remove("markdown-preview-loading");
  }

  private decorateOutput(): void {
    const usedHeadings = new Map<string, number>();
    this.output
      .querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      .forEach((heading) => {
        heading.id = slugifyHeading(heading.textContent ?? "", usedHeadings);
      });
    this.output.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
      link.rel = "noopener noreferrer";
      const href = link.getAttribute("href") ?? "";
      if (!href.startsWith("#")) {
        link.title = href ? `${href} — external navigation is disabled in preview` : "";
      }
    });
    this.output.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener(
        "error",
        () => {
          const placeholder = document.createElement("span");
          placeholder.className = "markdown-preview-image-unavailable";
          placeholder.textContent = image.alt
            ? `Image unavailable: ${image.alt}`
            : "Image unavailable";
          placeholder.title = image.getAttribute("src") ?? "";
          image.replaceWith(placeholder);
        },
        { once: true },
      );
    });
  }

  private bindLinks(): void {
    this.output.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (!href.startsWith("#") || href.length < 2) return;
      let fragment: string;
      try {
        fragment = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      this.output
        .querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  private bindResize(): void {
    this.resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.resizer.setPointerCapture(event.pointerId);
      this.layout.classList.add("markdown-preview-resizing");

      const update = (clientX: number): void => {
        const bounds = this.layout.getBoundingClientRect();
        if (bounds.width <= 0) return;
        this.setPreviewRatio((bounds.right - clientX) / bounds.width);
      };
      const onMove = (moveEvent: PointerEvent): void => update(moveEvent.clientX);
      const onEnd = (): void => {
        this.resizer.removeEventListener("pointermove", onMove);
        this.resizer.removeEventListener("pointerup", onEnd);
        this.resizer.removeEventListener("pointercancel", onEnd);
        this.layout.classList.remove("markdown-preview-resizing");
        this.persistPreviewWidth();
      };
      this.resizer.addEventListener("pointermove", onMove);
      this.resizer.addEventListener("pointerup", onEnd);
      this.resizer.addEventListener("pointercancel", onEnd);
    });
    this.resizer.addEventListener("dblclick", () => {
      this.setPreviewRatio(DEFAULT_PREVIEW_RATIO);
      this.persistPreviewWidth();
    });
    this.resizer.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 0.05 : 0.02;
      this.setPreviewRatio(
        this.previewRatio + (event.key === "ArrowLeft" ? step : -step),
      );
      this.persistPreviewWidth();
    });
  }

  private setPreviewRatio(value: number): void {
    this.previewRatio = clamp(value, MIN_PREVIEW_RATIO, MAX_PREVIEW_RATIO);
    this.layout.style.setProperty(
      "--markdown-preview-width",
      `${(this.previewRatio * 100).toFixed(2)}%`,
    );
    this.resizer.setAttribute("aria-valuenow", String(Math.round(this.previewRatio * 100)));
  }

  private restorePreviewWidth(): void {
    try {
      const value = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
      if (Number.isFinite(value)) this.previewRatio = value;
    } catch {
      // The default split remains available when storage is disabled.
    }
    this.setPreviewRatio(this.previewRatio);
  }

  private persistPreviewWidth(): void {
    try {
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(this.previewRatio));
    } catch {
      // Resizing remains available for the current session.
    }
  }
}
