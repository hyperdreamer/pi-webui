import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import { fetchGlobalMemories, fetchProjectMemories } from "./memoryClient.js";
import type { MemoryEntry } from "./memoryData.js";

export const memoryPanelTagName = "pi-webui-memory-panel";

export type MemoryPanelState =
  | { kind: "no-workspace" }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "data"; entries: MemoryEntry[] }
  | { kind: "error"; message: string };

const CATEGORY_CLASS: Record<string, string> = {
  "tool-quirk": "cat-amber",
  insight: "cat-blue",
  correction: "cat-green",
  failure: "cat-red",
  preference: "cat-purple",
  convention: "cat-teal",
};

const TRUNCATE_LENGTH = 120;

export function categoryBadgeLabel(category: string | undefined): string {
  return category ?? "uncategorized";
}

export function categoryBadgeClass(category: string | undefined): string {
  const key = categoryBadgeLabel(category);
  return CATEGORY_CLASS[key] ?? "cat-gray";
}

export function truncateContent(content: string): string {
  if (content.length <= TRUNCATE_LENGTH) return content;
  return content.slice(0, TRUNCATE_LENGTH) + "\u2026";
}

function renderCategoryBadge(category: string | undefined): string {
  const label = categoryBadgeLabel(category);
  const cls = categoryBadgeClass(category);
  return `<span class="cat-badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderDates(entry: MemoryEntry): string {
  const parts: string[] = [];
  if (entry.created !== undefined) {
    parts.push(`<span class="date-label">Created:</span> ${escapeHtml(entry.created)}`);
  }
  if (entry.last !== undefined) {
    parts.push(`<span class="date-label">Last modified:</span> ${escapeHtml(entry.last)}`);
  }
  if (parts.length === 0) return "";
  return `<div class="entry-dates">${parts.join(" &middot; ")}</div>`;
}

export function renderEntryHtml(entry: MemoryEntry): string {
  const badge = renderCategoryBadge(entry.category);
  const summaryText = truncateContent(entry.content);
  const dates = renderDates(entry);
  return `
    <details class="memory-entry">
      <summary>${badge}<span class="entry-summary">${escapeHtml(summaryText)}</span></summary>
      <div class="entry-body">
        <pre>${escapeHtml(entry.content)}</pre>
        ${dates}
      </div>
    </details>
  `;
}

export function defineMemoryPanelElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get(memoryPanelTagName)) {
    customElements.define(memoryPanelTagName, PiWebUiMemoryPanel);
  }
}

// Non-browser test environment fallback — keep the assertion off the ternary line.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class _NoopBase {}
function _noopElementConstructor(): typeof HTMLElement {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return _NoopBase as unknown as typeof HTMLElement;
}
const _BaseElement: typeof HTMLElement = typeof HTMLElement !== "undefined"
  ? HTMLElement
  : _noopElementConstructor();

class PiWebUiMemoryPanel extends _BaseElement {
  private contextValue: WorkspacePanelContext | undefined;
  private state: MemoryPanelState = { kind: "no-workspace" };
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /** Public setter for the workspace panel context. */
  set context(value: WorkspacePanelContext | undefined) {
    const previousPath = this.contextValue?.workspace.path;
    const nextPath = value?.workspace.path;
    this.contextValue = value;
    if (previousPath !== nextPath) {
      void this.loadMemories();
    }
  }

  /** Exposed for tests to inject state directly without network calls. */
  setState(next: MemoryPanelState): void {
    this.state = next;
    this.render();
  }

  connectedCallback(): void {
    this.render();
    if (this.contextValue !== undefined) {
      void this.loadMemories();
    }
  }

  private async loadMemories(): Promise<void> {
    const ctx = this.contextValue;
    if (ctx === undefined) {
      this.state = { kind: "no-workspace" };
      this.render();
      return;
    }

    this.state = { kind: "loading" };
    this.render();

    try {
      const [globalEntries, projectEntries] = await Promise.all([
        fetchGlobalMemories(),
        fetchProjectMemories(ctx.workspace.path).catch((): MemoryEntry[] => []),
      ]);

      const entries = [...globalEntries, ...projectEntries];

      if (entries.length === 0) {
        this.state = { kind: "empty" };
      } else {
        this.state = { kind: "data", entries };
      }
    } catch (error) {
      this.state = {
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to load memories.",
      };
    }
    this.render();
    ctx.host.requestRender();
  }

  private render(): void {
    this.root.innerHTML = `${panelStyles()}${renderPanelState(this.state)}`;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.root.querySelector("button[data-retry]")?.addEventListener("click", () => {
      void this.loadMemories();
    });
  }
}

function renderPanelState(state: MemoryPanelState): string {
  switch (state.kind) {
    case "no-workspace":
      return `<section class="empty">Select a workspace.</section>`;
    case "loading":
      return `<section class="viewer"><div class="spinner">Loading memories\u2026</div></section>`;
    case "empty":
      return `<section class="viewer"><p class="muted">No memories found.</p></section>`;
    case "error":
      return `<section class="viewer">
        <div class="status error">${escapeHtml(state.message)}</div>
        <button class="secondary" data-retry style="margin-top:10px">Retry</button>
      </section>`;
    case "data":
      return `<section class="toolbar"><strong>Memory</strong><span class="muted">${String(state.entries.length)} ${state.entries.length === 1 ? "entry" : "entries"}</span></section>
      <section class="viewer">${state.entries.map((entry) => renderEntryHtml(entry)).join("")}</section>`;
  }
}

function panelStyles(): string {
  return `
    <style>
      :host { display: contents; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
      .viewer { box-sizing: border-box; min-height: 0; overflow: auto; padding: 12px; }
      .empty { padding: 16px; color: var(--pi-muted); }
      .muted { color: var(--pi-muted); }
      .spinner { display: flex; align-items: center; gap: 8px; color: var(--pi-muted); }
      .spinner::before { content: ""; display: inline-block; width: 16px; height: 16px; border: 2px solid var(--pi-border); border-top-color: var(--pi-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 10px; font: inherit; }
      button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
      .memory-entry { border: 1px solid var(--pi-border); border-radius: 8px; margin-bottom: 8px; }
      .memory-entry[open] { background: var(--pi-surface); }
      .memory-entry summary { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; cursor: pointer; }
      .cat-badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase; border-radius: 4px; padding: 2px 6px; white-space: nowrap; flex-shrink: 0; }
      .cat-amber { background: #f59e0b20; color: #b45309; }
      .cat-blue { background: #3b82f620; color: #1d4ed8; }
      .cat-green { background: #10b98120; color: #047857; }
      .cat-red { background: #ef444420; color: #b91c1c; }
      .cat-purple { background: #8b5cf620; color: #6d28d9; }
      .cat-teal { background: #14b8a620; color: #0f766e; }
      .cat-gray { background: #6b728020; color: #4b5563; }
      .entry-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
      .entry-body { padding: 0 12px 12px; }
      .entry-body pre { margin: 0 0 8px; padding: 8px; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
      .entry-dates { font-size: 12px; color: var(--pi-muted); }
      .date-label { font-weight: 600; }
    </style>
  `;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
