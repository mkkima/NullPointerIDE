import {
  chooseResearchFolder,
  loadResearchState,
  saveResearchFiles,
  saveResearchState,
  toAppError,
} from "../services/native";
import { icon } from "../ui/icons";
import type {
  ResearchDraft,
  ResearchModel,
  ResearchWorkspaceState,
} from "../types";

const MIN_DRAFTS = 2;
const MAX_DRAFTS = 4;
const MIN_DRAFT_HEIGHT = 180;
const MAX_DRAFT_HEIGHT = 1_000;
const PERSIST_DELAY_MS = 220;

const MODELS: readonly { readonly value: ResearchModel; readonly label: string }[] = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "gemini", label: "Gemini" },
  { value: "claude", label: "Claude" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "grok", label: "Grok" },
  { value: "qwen", label: "Qwen" },
  { value: "perplexity", label: "Perplexity" },
];

type ToastTone = "success" | "warning" | "error" | "neutral";

interface ResearchControllerOptions {
  readonly onBusy: (busy: boolean, message?: string) => void;
  readonly onToast: (message: string, tone: ToastTone, timeout?: number) => void;
}

function draftId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `research-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createDraft(index: number): ResearchDraft {
  return {
    id: draftId(),
    model: MODELS[index % MODELS.length]?.value ?? "chatgpt",
    content: "",
    heightPx: 0,
  };
}

function defaultState(): ResearchWorkspaceState {
  return {
    version: 1,
    folderPath: "",
    drafts: [createDraft(0), createDraft(1)],
    savedFiles: [],
  };
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export class ResearchController {
  private readonly folderButton: HTMLButtonElement;
  private readonly folderName: HTMLElement;
  private readonly folderPath: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly draftsHost: HTMLElement;
  private readonly draftCount: HTMLElement;
  private readonly removeButton: HTMLButtonElement;
  private readonly addButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly formStatus: HTMLElement;
  private readonly results: HTMLElement;
  private readonly resultsList: HTMLElement;
  private readonly options: ResearchControllerOptions;

  private state = defaultState();
  private saving = false;
  private persistTimer: number | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private persistenceErrorShown = false;

  constructor(
    private readonly root: HTMLElement,
    options: ResearchControllerOptions,
  ) {
    this.options = options;
    this.folderButton = this.element<HTMLButtonElement>("#research-folder-button");
    this.folderName = this.element<HTMLElement>("#research-folder-name");
    this.folderPath = this.element<HTMLElement>("#research-folder-path");
    this.intro = this.element<HTMLElement>("#research-intro");
    this.workspace = this.element<HTMLElement>("#research-workspace");
    this.draftsHost = this.element<HTMLElement>("#research-drafts");
    this.draftCount = this.element<HTMLElement>("#research-draft-count");
    this.removeButton = this.element<HTMLButtonElement>("#research-remove-draft");
    this.addButton = this.element<HTMLButtonElement>("#research-add-draft");
    this.saveButton = this.element<HTMLButtonElement>("#research-save");
    this.formStatus = this.element<HTMLElement>("#research-form-status");
    this.results = this.element<HTMLElement>("#research-results");
    this.resultsList = this.element<HTMLElement>("#research-results-list");

    this.root.addEventListener("click", (event) => {
      void this.handleClick(event);
    });
    this.root.addEventListener("input", (event) => this.handleInput(event));
    this.root.addEventListener("change", (event) => this.handleChange(event));
    this.root.addEventListener("pointerdown", (event) => this.handleResizeStart(event));
    this.root.addEventListener("dblclick", (event) => this.handleHeaderDoubleClick(event));
    this.root.addEventListener("keydown", (event) => this.handleResizeKeydown(event));
    window.addEventListener("beforeunload", () => this.flushPersistence());
    this.render();
  }

  async restore(): Promise<void> {
    try {
      const restored = await loadResearchState();
      if (restored) this.state = restored;
    } catch (error) {
      this.options.onToast(toAppError(error).message, "error", 5000);
    }
    this.render();
  }

  private element<T extends HTMLElement>(selector: string): T {
    const value = this.root.querySelector<T>(selector);
    if (!value) throw new Error(`Required Research element not found: ${selector}`);
    return value;
  }

  private async handleClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionTarget = target.closest<HTMLElement>("[data-research-action]");
    const action = actionTarget?.dataset.researchAction;
    if (!action) return;

    if (action === "choose-folder") {
      await this.chooseFolder();
    } else if (action === "add") {
      this.addDraft();
    } else if (action === "remove") {
      this.removeDraft();
    } else if (action === "save") {
      await this.save();
    } else if (action === "copy") {
      const index = Number(
        target.closest<HTMLElement>("[data-research-result-index]")?.dataset
          .researchResultIndex,
      );
      const result = Number.isSafeInteger(index) ? this.state.savedFiles[index] : undefined;
      if (result) await this.copyPath(result.path);
    } else if (action === "copy-content" && actionTarget?.dataset.researchDraftId) {
      await this.copyDraftContent(actionTarget.dataset.researchDraftId);
    } else if (action === "clear-content" && actionTarget?.dataset.researchDraftId) {
      this.clearDraftContent(actionTarget.dataset.researchDraftId);
    } else if (action === "new") {
      this.startNewResearch();
    }
  }

  private handleInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.dataset.researchDraft) return;
    const id = target.dataset.researchDraft;
    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((draft) =>
        draft.id === id ? { ...draft, content: target.value } : draft,
      ),
    };
    const count = target
      .closest<HTMLElement>(".research-draft")
      ?.querySelector<HTMLElement>(".research-character-count");
    if (count) count.textContent = this.characterCount(target.value);
    target
      .closest<HTMLElement>(".research-draft")
      ?.querySelectorAll<HTMLButtonElement>("[data-research-draft-id]")
      .forEach((button) => {
        button.disabled = target.value.length === 0;
      });
    this.syncControls();
    this.schedulePersistence();
  }

  private handleChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.dataset.researchModel) return;
    const model = MODELS.find((candidate) => candidate.value === target.value)?.value;
    if (!model) return;
    const id = target.dataset.researchModel;
    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((draft) =>
        draft.id === id ? { ...draft, model } : draft,
      ),
    };
    this.schedulePersistence(true);
  }

  private handleResizeStart(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest<HTMLElement>("[data-research-resize]");
    const id = handle?.dataset.researchResize;
    if (!handle || !id) return;
    const textarea = this.draftsHost.querySelector<HTMLTextAreaElement>(
      `textarea[data-research-draft="${CSS.escape(id)}"]`,
    );
    if (!textarea) return;

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    this.root.classList.add("research-resizing");
    const startY = event.clientY;
    const startHeight = textarea.getBoundingClientRect().height;
    let latestHeight = Math.round(startHeight);

    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      latestHeight = this.clampDraftHeight(startHeight + moveEvent.clientY - startY);
      textarea.style.height = `${latestHeight}px`;
      handle.setAttribute("aria-valuenow", String(latestHeight));
    };
    const onEnd = (endEvent: PointerEvent): void => {
      if (endEvent.pointerId !== event.pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      this.root.classList.remove("research-resizing");
      this.setDraftHeight(id, latestHeight);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  private handleHeaderDoubleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, select, option, input, a")) {
      return;
    }
    const header = target.closest<HTMLElement>(".research-draft > header");
    const card = header?.closest<HTMLElement>(".research-draft");
    const id = card?.dataset.researchDraftId;
    if (!header || !id) return;
    event.preventDefault();
    this.resetDraftHeight(id);
  }

  private handleResizeKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.dataset.researchResize) return;
    const id = target.dataset.researchResize;
    if (event.key === "Home") {
      event.preventDefault();
      this.resetDraftHeight(id);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const textarea = this.draftsHost.querySelector<HTMLTextAreaElement>(
      `textarea[data-research-draft="${CSS.escape(id)}"]`,
    );
    if (!textarea) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 12;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const height = this.clampDraftHeight(
      textarea.getBoundingClientRect().height + step * direction,
    );
    textarea.style.height = `${height}px`;
    target.setAttribute("aria-valuenow", String(height));
    this.setDraftHeight(id, height);
  }

  private clampDraftHeight(height: number): number {
    return Math.round(Math.min(MAX_DRAFT_HEIGHT, Math.max(MIN_DRAFT_HEIGHT, height)));
  }

  private setDraftHeight(id: string, heightPx: number): void {
    const height = this.clampDraftHeight(heightPx);
    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((draft) =>
        draft.id === id ? { ...draft, heightPx: height } : draft,
      ),
    };
    this.schedulePersistence(true);
  }

  private resetDraftHeight(id: string): void {
    const index = this.state.drafts.findIndex((draft) => draft.id === id);
    if (index < 0) return;
    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((draft) =>
        draft.id === id ? { ...draft, heightPx: 0 } : draft,
      ),
    };
    const textarea = this.draftsHost.querySelector<HTMLTextAreaElement>(
      `textarea[data-research-draft="${CSS.escape(id)}"]`,
    );
    const handle = this.draftsHost.querySelector<HTMLElement>(
      `[data-research-resize="${CSS.escape(id)}"]`,
    );
    if (textarea) {
      textarea.style.removeProperty("height");
      handle?.setAttribute(
        "aria-valuenow",
        String(Math.round(textarea.getBoundingClientRect().height)),
      );
    }
    this.schedulePersistence(true);
    this.options.onToast(`Research ${index + 1} size reset`, "neutral", 1600);
  }

  private async chooseFolder(): Promise<void> {
    try {
      const path = await chooseResearchFolder();
      if (!path) return;
      this.state = {
        ...this.state,
        folderPath: path,
        savedFiles: [],
      };
      this.render();
      this.schedulePersistence(true);
      this.options.onToast(`Research folder: ${folderName(path)}`, "success");
    } catch (error) {
      this.options.onToast(toAppError(error).message, "error", 5000);
    }
  }

  private addDraft(): void {
    if (this.state.drafts.length >= MAX_DRAFTS) return;
    const used = new Set(this.state.drafts.map((draft) => draft.model));
    const model =
      MODELS.find((candidate) => !used.has(candidate.value))?.value ??
      MODELS[this.state.drafts.length % MODELS.length]?.value ??
      "chatgpt";
    this.state = {
      ...this.state,
      drafts: [
        ...this.state.drafts,
        { id: draftId(), model, content: "", heightPx: 0 },
      ],
    };
    this.render();
    this.schedulePersistence(true);
    this.draftsHost
      .querySelector<HTMLTextAreaElement>(".research-draft:last-child textarea")
      ?.focus();
  }

  private removeDraft(): void {
    if (this.state.drafts.length <= MIN_DRAFTS) return;
    this.state = {
      ...this.state,
      drafts: this.state.drafts.slice(0, -1),
    };
    this.render();
    this.schedulePersistence(true);
  }

  private async save(): Promise<void> {
    if (!this.canSave() || this.saving) return;
    this.saving = true;
    this.syncControls();
    this.options.onBusy(true, "Saving research…");
    try {
      const savedFiles = await saveResearchFiles(
        this.state.folderPath,
        this.state.drafts.map(({ model, content }) => ({ model, content })),
      );
      this.state = {
        ...this.state,
        savedFiles: [...savedFiles],
      };
      this.render();
      this.schedulePersistence(true);
      this.options.onToast(
        `Saved ${savedFiles.length} research file${savedFiles.length === 1 ? "" : "s"}`,
        "success",
      );
    } catch (error) {
      this.options.onToast(toAppError(error).message, "error", 5000);
    } finally {
      this.saving = false;
      this.options.onBusy(false);
      this.syncControls();
    }
  }

  private startNewResearch(): void {
    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((draft) => ({ ...draft, content: "" })),
      savedFiles: [],
    };
    this.render();
    this.schedulePersistence(true);
    this.draftsHost.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  private canSave(): boolean {
    return (
      this.state.folderPath.length > 0 &&
      this.state.drafts.length >= MIN_DRAFTS &&
      this.state.drafts.every((draft) => draft.content.trim().length > 0)
    );
  }

  private render(): void {
    const hasFolder = this.state.folderPath.length > 0;
    this.folderName.textContent = hasFolder
      ? folderName(this.state.folderPath)
      : "Choose a folder";
    this.folderPath.textContent = hasFolder
      ? this.state.folderPath
      : "Markdown files will be saved here.";
    this.folderPath.title = this.state.folderPath;
    this.folderButton.setAttribute(
      "aria-label",
      hasFolder ? "Change research folder" : "Choose research folder",
    );
    this.intro.classList.toggle("hidden", hasFolder);
    this.workspace.classList.toggle("hidden", !hasFolder);
    this.renderDrafts();
    this.renderResults();
    this.syncControls();
  }

  private renderDrafts(): void {
    const fragment = document.createDocumentFragment();
    this.state.drafts.forEach((draft, index) => {
      const card = document.createElement("article");
      card.className = "research-draft";
      card.dataset.researchDraftId = draft.id;

      const header = document.createElement("header");
      header.title = "Double-click to reset height";
      const number = document.createElement("span");
      number.className = "research-draft-number";
      number.textContent = `Research ${index + 1}`;

      const select = document.createElement("select");
      select.dataset.researchModel = draft.id;
      select.setAttribute("aria-label", `Model for research ${index + 1}`);
      for (const model of MODELS) {
        const option = document.createElement("option");
        option.value = model.value;
        option.textContent = model.label;
        option.selected = model.value === draft.model;
        select.append(option);
      }

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "research-draft-action";
      copy.dataset.researchAction = "copy-content";
      copy.dataset.researchDraftId = draft.id;
      copy.disabled = draft.content.length === 0;
      copy.title = "Copy research text";
      copy.setAttribute("aria-label", `Copy research ${index + 1} text`);
      copy.innerHTML = icon("copy", 14);

      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "research-draft-action danger";
      clear.dataset.researchAction = "clear-content";
      clear.dataset.researchDraftId = draft.id;
      clear.disabled = draft.content.length === 0;
      clear.title = "Clear research text";
      clear.setAttribute("aria-label", `Clear research ${index + 1} text`);
      clear.innerHTML = icon("trash", 14);

      const controls = document.createElement("div");
      controls.className = "research-draft-controls";
      controls.append(copy, clear, select);
      header.append(number, controls);

      const textarea = document.createElement("textarea");
      textarea.dataset.researchDraft = draft.id;
      textarea.value = draft.content;
      textarea.placeholder = "Paste the research text here…";
      textarea.setAttribute("aria-label", `Research ${index + 1} text`);
      if (draft.heightPx > 0) textarea.style.height = `${draft.heightPx}px`;

      const footer = document.createElement("footer");
      const count = document.createElement("span");
      count.className = "research-character-count";
      count.textContent = this.characterCount(draft.content);
      footer.append(count);

      const resizeHandle = document.createElement("div");
      resizeHandle.className = "research-resize-handle";
      resizeHandle.dataset.researchResize = draft.id;
      resizeHandle.tabIndex = 0;
      resizeHandle.setAttribute("role", "separator");
      resizeHandle.setAttribute("aria-orientation", "horizontal");
      resizeHandle.setAttribute("aria-label", `Resize research ${index + 1}`);
      resizeHandle.setAttribute("aria-valuemin", String(MIN_DRAFT_HEIGHT));
      resizeHandle.setAttribute("aria-valuemax", String(MAX_DRAFT_HEIGHT));
      resizeHandle.setAttribute(
        "aria-valuenow",
        String(draft.heightPx || 300),
      );

      card.append(header, textarea, footer, resizeHandle);
      fragment.append(card);
    });
    this.draftsHost.replaceChildren(fragment);
  }

  private renderResults(): void {
    const hasResults = this.state.savedFiles.length > 0;
    this.results.classList.toggle("hidden", !hasResults);
    const fragment = document.createDocumentFragment();
    this.state.savedFiles.forEach((file, index) => {
      const row = document.createElement("div");
      row.className = "research-result";
      row.dataset.researchResultIndex = String(index);

      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = file.fileName;
      const path = document.createElement("span");
      path.textContent = file.path;
      path.title = file.path;
      details.append(name, path);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "research-copy-button";
      copy.dataset.researchAction = "copy";
      copy.textContent = "Copy path";
      copy.setAttribute("aria-label", `Copy path to ${file.fileName}`);
      row.append(details, copy);
      fragment.append(row);
    });
    this.resultsList.replaceChildren(fragment);
  }

  private syncControls(): void {
    this.draftCount.textContent = `${this.state.drafts.length} / ${MAX_DRAFTS}`;
    this.removeButton.disabled = this.saving || this.state.drafts.length <= MIN_DRAFTS;
    this.addButton.disabled = this.saving || this.state.drafts.length >= MAX_DRAFTS;
    this.saveButton.disabled = this.saving || !this.canSave();
    this.saveButton.textContent = this.saving ? "Saving…" : "Save as Markdown";
    this.formStatus.textContent = this.canSave()
      ? "Ready to save all drafts."
      : "Add text to every research window.";
  }

  private characterCount(content: string): string {
    return `${content.length.toLocaleString()} characters`;
  }

  private schedulePersistence(immediate = false): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (immediate) {
      this.flushPersistence();
      return;
    }
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistence();
    }, PERSIST_DELAY_MS);
  }

  private flushPersistence(): void {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const snapshot: ResearchWorkspaceState = {
      version: 1,
      folderPath: this.state.folderPath,
      drafts: this.state.drafts.map((draft) => ({ ...draft })),
      savedFiles: this.state.savedFiles.map((file) => ({ ...file })),
    };
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => saveResearchState(snapshot))
      .then(() => {
        this.persistenceErrorShown = false;
      })
      .catch((error: unknown) => {
        if (this.persistenceErrorShown) return;
        this.persistenceErrorShown = true;
        this.options.onToast(toAppError(error).message, "error", 5000);
      });
  }

  private async copyDraftContent(id: string): Promise<void> {
    const index = this.state.drafts.findIndex((draft) => draft.id === id);
    const draft = index >= 0 ? this.state.drafts[index] : undefined;
    if (!draft || draft.content.length === 0) return;
    await this.copyText(
      draft.content,
      `Research ${index + 1} text copied`,
      "Could not copy the research text.",
    );
  }

  private clearDraftContent(id: string): void {
    const index = this.state.drafts.findIndex((draft) => draft.id === id);
    const draft = index >= 0 ? this.state.drafts[index] : undefined;
    if (!draft || draft.content.length === 0) return;

    this.state = {
      ...this.state,
      drafts: this.state.drafts.map((candidate) =>
        candidate.id === id ? { ...candidate, content: "" } : candidate,
      ),
    };
    const textarea = this.draftsHost.querySelector<HTMLTextAreaElement>(
      `textarea[data-research-draft="${CSS.escape(id)}"]`,
    );
    if (textarea) {
      textarea.value = "";
      const card = textarea.closest<HTMLElement>(".research-draft");
      const count = card?.querySelector<HTMLElement>(".research-character-count");
      if (count) count.textContent = this.characterCount("");
      card
        ?.querySelectorAll<HTMLButtonElement>("[data-research-draft-id]")
        .forEach((button) => {
          button.disabled = true;
        });
      textarea.focus();
    }
    this.syncControls();
    this.schedulePersistence(true);
    this.options.onToast(`Research ${index + 1} cleared`, "neutral", 1800);
  }

  private async copyPath(path: string): Promise<void> {
    await this.copyText(
      path,
      "Research path copied",
      "Could not copy the research path.",
    );
  }

  private async copyText(
    value: string,
    successMessage: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.options.onToast(successMessage, "success", 1800);
      return;
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) {
        this.options.onToast(errorMessage, "error", 4000);
        return;
      }
      this.options.onToast(successMessage, "success", 1800);
    }
  }
}
