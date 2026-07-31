import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";
import type { MemoryEntry, MemoryWorkspaceState } from "./memoryData.js";

export const memoryPanelTagName = "pi-webui-memory-panel";

const CATEGORY_CLASS: Record<string, string> = {
  "tool-quirk": "cat-amber",
  insight: "cat-blue",
  correction: "cat-green",
  failure: "cat-red",
  preference: "cat-purple",
  convention: "cat-teal",
};

const TRUNCATE_LENGTH = 120;
const MEMORY_GROUP_SELECTOR = "details.memory-group";

type MemoryGroupScope = "global" | "project";

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

/**
 * Returns the total count of memories for a workspace-panel badge, or
 * undefined when no badge should be shown (loading, unavailable, error, or
 * zero entries).
 */
export function memoryBadge(state: MemoryWorkspaceState): number | undefined {
  if (state.kind !== "data") return undefined;
  const total = state.globalEntries.length + state.projectEntries.length;
  return total > 0 ? total : undefined;
}

/**
 * Returns true unless the provider has confirmed that memories are
 * unavailable (e.g. older agent runtime without the memory endpoint).
 */
export function isMemoryPanelVisible(state: MemoryWorkspaceState): boolean {
  return state.kind !== "unavailable";
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
  private state: MemoryWorkspaceState = { kind: "loading" };
  private retry: (() => void) | undefined;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  /** Public setter for the workspace panel context (reserved for WorkspacePanel wiring). */
  set context(_value: WorkspacePanelContext | undefined) {
    // Context is consumed by the plugin contribution (visible/badge/render),
    // not by the panel element itself in the new architecture.  Keep the
    // setter so WorkspacePanel can assign it without errors.
  }

  /** Accept the core-owned memory state and render synchronously. */
  set memoryState(value: MemoryWorkspaceState) {
    if (this.state === value) return;
    this.state = value;
    this.render();
  }

  /** Retry callback wired to the core MemoryController. */
  set onRetry(value: (() => void) | undefined) {
    this.retry = value;
  }

  connectedCallback(): void {
    this.render();
  }

  disconnectedCallback(): void {
    // No timers to clean up — the core controller owns that lifetime.
  }

  private render(): void {
    const expandedGroups = this.expandedMemoryGroups();
    this.root.innerHTML = `${panelStyles()}${renderPanelState(this.state, expandedGroups)}`;
    this.attachEventListeners();
  }

  private expandedMemoryGroups(): ReadonlySet<MemoryGroupScope> {
    const expanded = new Set<MemoryGroupScope>();
    for (const group of this.root.querySelectorAll<HTMLDetailsElement>(MEMORY_GROUP_SELECTOR)) {
      const scope = group.dataset["memoryGroup"];
      if (group.open && isMemoryGroupScope(scope)) expanded.add(scope);
    }
    return expanded;
  }

  private attachEventListeners(): void {
    const retry = this.retry;
    if (retry === undefined) return;
    this.root.querySelector("button[data-retry]")?.addEventListener("click", () => {
      retry();
    });
  }
}

export function renderPanelState(state: MemoryWorkspaceState, expandedGroups: ReadonlySet<MemoryGroupScope> = new Set()): string {
  switch (state.kind) {
    case "unavailable":
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
        ${state.refreshError === undefined ? "" : `<div class="status warning">${escapeHtml(state.refreshError)}</div>`}
        ${renderMemoryGroupHtml({
          scope: "global",
          title: "Global memory",
          entries: state.globalEntries,
          emptyMessage: "No global memories found.",
          open: expandedGroups.has("global"),
        })}
        ${renderMemoryGroupHtml({
          scope: "project",
          title: "Project-specific memory",
          entries: state.projectEntries,
          emptyMessage: "No project-specific memories found.",
          open: expandedGroups.has("project"),
          ...(state.projectUnavailableMessage === undefined
            ? {}
            : { unavailableMessage: state.projectUnavailableMessage }),
        })}
        ${state.refreshError === undefined ? "" : `<button class="secondary" data-retry style="margin-top:10px">Retry</button>`}
      </section>`;
  }
}

interface MemoryGroupRenderOptions {
  readonly scope: MemoryGroupScope;
  readonly title: string;
  readonly entries: MemoryEntry[];
  readonly emptyMessage: string;
  readonly open: boolean;
  readonly unavailableMessage?: string;
}

function renderMemoryGroupHtml(options: MemoryGroupRenderOptions): string {
  const unavailable = options.unavailableMessage !== undefined && options.entries.length === 0;
  const hasPartialWarning = options.unavailableMessage !== undefined && !unavailable;
  const count = `${String(options.entries.length)} ${options.entries.length === 1 ? "entry" : "entries"}`;
  const body = unavailable
    ? `<p class="memory-group-message unavailable">${escapeHtml(options.unavailableMessage)}</p>`
    : options.entries.length === 0
      ? `<p class="memory-group-message">${escapeHtml(options.emptyMessage)}</p>`
      : `${hasPartialWarning ? `<p class="memory-group-message warning">${escapeHtml(options.unavailableMessage)}</p>` : ""}${options.entries.map((entry) => renderEntryHtml(entry)).join("")}`;

  return `
    <details class="memory-group" data-memory-group="${options.scope}"${options.open ? " open" : ""}>
      <summary>
        <svg class="memory-group-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg>
        <span class="memory-group-title">${escapeHtml(options.title)}</span>
        <span class="${unavailable ? "memory-group-status unavailable" : "memory-group-count"}">${unavailable ? "Unavailable" : count}</span>
      </summary>
      <div class="memory-group-body">${body}</div>
    </details>
  `;
}

function isMemoryGroupScope(value: string | undefined): value is MemoryGroupScope {
  return value === "global" || value === "project";
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
      .memory-group summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; list-style: none; }
      .memory-group summary::-webkit-details-marker { display: none; }
      .memory-group summary::marker { content: ""; }
      .memory-group-chevron { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; color: var(--pi-muted); pointer-events: none; transition: transform 0.15s ease; }
      .memory-group[open] .memory-group-chevron { transform: rotate(90deg); }
      .memory-group-title { flex: 1 1 auto; min-width: 0; font-weight: 600; }
      .memory-group-count, .memory-group-status { flex: 0 0 auto; color: var(--pi-muted); font-size: 12px; white-space: nowrap; }
      .memory-group-status.unavailable { color: var(--pi-danger); }
      .memory-group-body { padding: 0 12px 12px; }
      .memory-group-message { margin: 0; color: var(--pi-muted); }
      .memory-group-message.unavailable { color: var(--pi-danger); }
      .memory-group-message.warning { color: var(--pi-warning, #d97706); margin-bottom: 8px; }
      .muted { color: var(--pi-muted); }
      .spinner { display: flex; align-items: center; gap: 8px; color: var(--pi-muted); }
      .spinner::before { content: ""; display: inline-block; width: 16px; height: 16px; border: 2px solid var(--pi-border); border-top-color: var(--pi-accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .status { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
      .status.error { border-color: var(--pi-danger); color: var(--pi-danger); }
      .status.warning { border-color: var(--pi-warning, #d97706); color: var(--pi-warning, #d97706); margin-bottom: 10px; }
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
