import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import { fetchGlobalMemories, fetchProjectMemories } from "./memoryClient.js";
import { MemoryLoadController } from "./memoryLoadController.js";
import type { MemoryEntry } from "./memoryData.js";

export const memoryPanelTagName = "pi-webui-memory-panel";

export type MemoryPanelState =
  | { kind: "no-workspace" }
  | { kind: "loading" }
  | {
      kind: "data";
      globalEntries: MemoryEntry[];
      projectEntries: MemoryEntry[];
      projectUnavailableMessage?: string;
    }
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
  private readonly loadController = new MemoryLoadController({ fetchGlobalMemories, fetchProjectMemories });

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /** Public setter for the workspace panel context. */
  set context(value: WorkspacePanelContext | undefined) {
    const previousContext = this.contextValue;
    this.contextValue = value;
    if (isSameWorkspaceContext(previousContext, value)) return;

    this.loadController.invalidate();
    if (value === undefined) {
      this.state = { kind: "no-workspace" };
      this.render();
      return;
    }

    if (this.isConnected) void this.loadMemories();
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

  disconnectedCallback(): void {
    this.loadController.invalidate();
  }

  private async loadMemories(): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) {
      this.state = { kind: "no-workspace" };
      this.render();
      return;
    }

    const workspacePath = context.workspace.path;
    this.state = { kind: "loading" };
    this.render();

    const result = await this.loadController.load(workspacePath);
    if (result === undefined || !this.isCurrentContext(context, workspacePath)) return;

    this.state = result.kind === "global-error"
      ? { kind: "error", message: result.message }
      : {
          kind: "data",
          globalEntries: result.globalEntries,
          projectEntries: result.projectEntries,
          ...(result.projectUnavailableMessage === undefined
            ? {}
            : { projectUnavailableMessage: result.projectUnavailableMessage }),
        };
    this.render();
    context.host.requestRender();
  }

  private isCurrentContext(context: WorkspacePanelContext, workspacePath: string): boolean {
    const currentContext = this.contextValue;
    return currentContext !== undefined
      && hasSameWorkspaceIdentity(currentContext, context)
      && currentContext.workspace.path === workspacePath;
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

function isSameWorkspaceContext(
  left: WorkspacePanelContext | undefined,
  right: WorkspacePanelContext | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return hasSameWorkspaceIdentity(left, right) && left.workspace.path === right.workspace.path;
}

function hasSameWorkspaceIdentity(left: WorkspacePanelContext, right: WorkspacePanelContext): boolean {
  return left.machine.id === right.machine.id
    && left.workspace.projectId === right.workspace.projectId
    && left.workspace.id === right.workspace.id;
}

export function renderPanelState(state: MemoryPanelState): string {
  switch (state.kind) {
    case "no-workspace":
      return `<section class="empty">Select a workspace.</section>`;
    case "loading":
      return `<section class="viewer"><div class="spinner">Loading memories\u2026</div></section>`;
    case "error":
      return `<section class="viewer">
        <div class="status error">${escapeHtml(state.message)}</div>
        <button class="secondary" data-retry style="margin-top:10px">Retry</button>
      </section>`;
    case "data":
      return `<section class="viewer">
        ${renderMemoryGroupHtml({
          title: "Global memory",
          entries: state.globalEntries,
          emptyMessage: "No global memories found.",
        })}
        ${renderMemoryGroupHtml({
          title: "Project-specific memory",
          entries: state.projectEntries,
          emptyMessage: "No project-specific memories found.",
          ...(state.projectUnavailableMessage === undefined
            ? {}
            : { unavailableMessage: state.projectUnavailableMessage }),
        })}
      </section>`;
  }
}

interface MemoryGroupRenderOptions {
  readonly title: string;
  readonly entries: MemoryEntry[];
  readonly emptyMessage: string;
  readonly unavailableMessage?: string;
}

function renderMemoryGroupHtml(options: MemoryGroupRenderOptions): string {
  const unavailable = options.unavailableMessage !== undefined;
  const count = `${String(options.entries.length)} ${options.entries.length === 1 ? "entry" : "entries"}`;
  const body = unavailable
    ? `<p class="memory-group-message unavailable">${escapeHtml(options.unavailableMessage)}</p>`
    : options.entries.length === 0
      ? `<p class="memory-group-message">${escapeHtml(options.emptyMessage)}</p>`
      : options.entries.map((entry) => renderEntryHtml(entry)).join("");

  return `
    <details class="memory-group" open>
      <summary>
        <span class="memory-group-title">${escapeHtml(options.title)}</span>
        <span class="${unavailable ? "memory-group-status unavailable" : "memory-group-count"}">${unavailable ? "Unavailable" : count}</span>
      </summary>
      <div class="memory-group-body">${body}</div>
    </details>
  `;
}

function panelStyles(): string {
  return `
    <style>
      :host { display: contents; }
      .viewer { box-sizing: border-box; min-height: 0; overflow: auto; padding: 12px; }
      .empty { padding: 16px; color: var(--pi-muted); }
      .memory-group { border: 1px solid var(--pi-border); border-radius: 8px; margin-bottom: 10px; }
      .memory-group:last-child { margin-bottom: 0; }
      .memory-group[open] { background: var(--pi-surface); }
      .memory-group summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; cursor: pointer; }
      .memory-group-title { font-weight: 600; }
      .memory-group-count, .memory-group-status { color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
      .memory-group-status.unavailable { color: var(--pi-danger); }
      .memory-group-body { padding: 0 12px 12px; }
      .memory-group-message { margin: 0; color: var(--pi-muted); }
      .memory-group-message.unavailable { color: var(--pi-danger); }
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
