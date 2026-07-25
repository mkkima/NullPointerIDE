import {
  chooseResearchFolder,
  loadResearchState,
  saveResearchFiles,
  saveResearchState,
  toAppError,
} from "../services/native";
import type {
  ResearchDraft,
  ResearchModel,
  ResearchWorkspaceState,
} from "../types";

const MIN_DRAFTS = 2;
const MAX_DRAFTS = 5;
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
    const action = target.closest<HTMLElement>("[data-research-action]")?.dataset
      .researchAction;
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
      drafts: [...this.state.drafts, { id: draftId(), model, content: "" }],
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

      const header = document.createElement("header");
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
      header.append(number, select);

      const textarea = document.createElement("textarea");
      textarea.dataset.researchDraft = draft.id;
      textarea.value = draft.content;
      textarea.placeholder = "Paste the research text here…";
      textarea.setAttribute("aria-label", `Research ${index + 1} text`);

      const footer = document.createElement("footer");
      const count = document.createElement("span");
      count.className = "research-character-count";
      count.textContent = this.characterCount(draft.content);
      footer.append(count);

      card.append(header, textarea, footer);
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

  private async copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.options.onToast("Research path copied", "success", 1800);
      return;
    } catch {
      const input = document.createElement("textarea");
      input.value = path;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      if (!copied) {
        this.options.onToast("Could not copy the research path.", "error", 4000);
        return;
      }
      this.options.onToast("Research path copied", "success", 1800);
    }
  }
}
