// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Project, RecentProjectEntry, Workspace } from "../../../shared/apiTypes";
import { RecentProjectsPanel, registeredProjectForEntry } from "./RecentProjectsPanel";

function entry(path: string, id = `entry-${path}`): RecentProjectEntry {
  return { id, name: path.split("/").at(-1) ?? path, path, lastUsedAt: "2026-01-01T00:00:00.000Z" };
}

function project(id: string, path: string): Project {
  return { id, name: path.split("/").at(-1) ?? path, path, createdAt: "2026-01-01T00:00:00.000Z" };
}

function workspace(projectId: string, path: string): Workspace {
  return { id: `w-${projectId}`, projectId, path, label: "main", isMain: true, isGitRepo: true, isGitWorktree: false };
}

describe("registeredProjectForEntry", () => {
  it("matches a registered project by path", () => {
    const alpha = project("p1", "/work/alpha");

    expect(registeredProjectForEntry(entry("/work/alpha"), [alpha])).toEqual(alpha);
  });

  it("returns undefined when no registered project has that path", () => {
    expect(registeredProjectForEntry(entry("/work/alpha"), [project("p1", "/work/beta")])).toBeUndefined();
  });
});

async function mount(overrides: Partial<RecentProjectsPanel>): Promise<{ panel: RecentProjectsPanel; teardown: () => void }> {
  await import("./RecentProjectsPanel");
  const panel = new RecentProjectsPanel();
  Object.assign(panel, overrides);
  document.body.append(panel);
  await panel.updateComplete;
  return { panel, teardown: () => { panel.remove(); } };
}

function rows(panel: RecentProjectsPanel): HTMLElement[] {
  return [...panel.renderRoot.querySelectorAll<HTMLElement>(".recent-project-row")];
}

function primary(panel: RecentProjectsPanel, rowIndex = 0): HTMLButtonElement | undefined {
  return rows(panel)[rowIndex]?.querySelector<HTMLButtonElement>("button.recent-project-open") ?? undefined;
}

function removeButton(panel: RecentProjectsPanel, rowIndex = 0): HTMLButtonElement | undefined {
  return rows(panel)[rowIndex]?.querySelector<HTMLButtonElement>("button.recent-project-remove") ?? undefined;
}

function panelStyles(): string {
  const styles = RecentProjectsPanel.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}

describe("recent-projects-panel rendering", () => {
  it("places active entries first without letting selection change stable history order", async () => {
    const beta = project("p-beta", "/work/beta");
    const alpha = project("p-alpha", "/work/alpha");
    const gamma = project("p-gamma", "/work/gamma");
    const delta = project("p-delta", "/work/delta");
    const { panel, teardown } = await mount({
      state: {
        kind: "ready",
        entries: [entry("/work/beta"), entry("/work/alpha"), entry("/work/gamma"), entry("/work/delta")],
      },
      projects: [beta, alpha, gamma, delta],
      selectedProjectId: beta.id,
      workspacesByProjectId: {
        "p-beta": [workspace("p-beta", "/work/beta")],
        "p-alpha": [workspace("p-alpha", "/work/alpha")],
        "p-gamma": [workspace("p-gamma", "/work/gamma")],
        "p-delta": [workspace("p-delta", "/work/delta")],
      },
      activities: {
        "/work/alpha": { cwd: "/work/alpha", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" },
        "/work/gamma": { cwd: "/work/gamma", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    });

    expect(rows(panel).map((row) => row.dataset["recentProjectId"])).toEqual([
      "entry-/work/alpha",
      "entry-/work/gamma",
      "entry-/work/beta",
      "entry-/work/delta",
    ]);
    expect(rows(panel)[2]?.classList.contains("selected")).toBe(true);

    teardown();
  });

  it("keeps focus and activation attached when activity moves an entry", async () => {
    const alpha = project("p-alpha", "/work/alpha");
    const beta = project("p-beta", "/work/beta");
    const onOpenRegistered = vi.fn();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] },
      projects: [alpha, beta],
      workspacesByProjectId: {
        "p-alpha": [workspace("p-alpha", "/work/alpha")],
        "p-beta": [workspace("p-beta", "/work/beta")],
      },
      onOpenRegistered,
    });

    primary(panel, 1)?.focus();
    expect(panel.shadowRoot?.activeElement?.getAttribute("aria-label")).toBe("beta, /work/beta");

    panel.activities = {
      "/work/beta": { cwd: "/work/beta", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" },
    };
    await panel.updateComplete;

    expect(rows(panel).map((row) => row.dataset["recentProjectId"])).toEqual([
      "entry-/work/beta",
      "entry-/work/alpha",
    ]);
    const focused = panel.shadowRoot?.activeElement;
    expect(focused?.getAttribute("aria-label")).toBe("beta, /work/beta");
    expect(focused).toBe(primary(panel, 0));
    if (!(focused instanceof HTMLButtonElement)) throw new Error("Expected the focused entry action to be a button");

    focused.click();
    expect(onOpenRegistered).toHaveBeenCalledWith(beta);

    teardown();
  });

  it("marks an entry with no registered project as Closed", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
    });

    expect(panel.renderRoot.textContent).toContain("Closed");

    teardown();
  });

  it("renders a refreshed matching project path as registered", async () => {
    const alphaEntry = entry("/work/alpha");
    const alphaProject = project("p1", "/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [alphaEntry] },
      projects: [],
    });
    expect(panel.renderRoot.textContent).toContain("Closed");

    panel.projects = [alphaProject];
    await panel.updateComplete;

    expect(panel.renderRoot.textContent).not.toContain("Closed");
    expect(primary(panel)?.getAttribute("aria-label")).toBe("alpha, /work/alpha");
    teardown();
  });

  it("shows an activity indicator for a registered project with active work", async () => {
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [project("p1", "/work/alpha")],
      workspacesByProjectId: { p1: [workspace("p1", "/work/alpha")] },
      activities: { "/work/alpha": { cwd: "/work/alpha", hasSessionActivity: true, hasTerminalActivity: false, updatedAt: "2026-01-01T00:00:00.000Z" } },
    });

    expect(panel.renderRoot.querySelector(".activity-indicator")).not.toBeNull();

    teardown();
  });

  it("renders loading, empty, and failed states", async () => {
    const loading = await mount({ state: { kind: "loading" } });
    expect(loading.panel.renderRoot.textContent).toContain("Loading");
    loading.teardown();

    const empty = await mount({ state: { kind: "ready", entries: [] } });
    expect(empty.panel.renderRoot.textContent).toContain("No recent projects");
    empty.teardown();

    const failed = await mount({ state: { kind: "failed", message: "offline" } });
    expect(failed.panel.renderRoot.textContent).toContain("offline");
    expect(failed.panel.renderRoot.querySelector("button.recent-projects-retry")).not.toBeNull();
    failed.teardown();
  });

  it("renders sibling primary and remove buttons inside a non-interactive row container", async () => {
    const onOpenRegistered = vi.fn();
    const onOpenClosed = vi.fn();
    const onRemoveRequested = vi.fn();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] },
      projects: [project("p1", "/work/alpha")],
      onOpenRegistered,
      onOpenClosed,
      onRemoveRequested,
    });

    const [row, closedRow] = rows(panel);
    expect(row?.getAttribute("role")).toBeNull();
    expect(row?.hasAttribute("tabindex")).toBe(false);
    expect(row?.getAttribute("data-recent-project-id")).toBe("entry-/work/alpha");

    // The primary action owns the path title, accessible label, and keyboard focus.
    const open = primary(panel);
    expect(open?.tagName).toBe("BUTTON");
    expect(open?.getAttribute("title")).toBe("/work/alpha");
    expect(open?.getAttribute("aria-label")).toBe("alpha, /work/alpha");
    expect(open?.tabIndex).toBe(0);
    expect(closedRow?.querySelector("button.recent-project-open")?.getAttribute("aria-label")).toBe("beta, closed, /work/beta");

    const removes = [...panel.renderRoot.querySelectorAll<HTMLButtonElement>("button.recent-project-remove")];
    expect(removes).toHaveLength(2);
    expect(removes[0]?.getAttribute("title")).toBe("Remove alpha from Recent Projects");
    expect(removes[0]?.getAttribute("aria-label")).toBe("Remove alpha from Recent Projects");
    expect(removes[0]?.tabIndex).toBe(0);
    expect(removes[1]?.getAttribute("aria-label")).toBe("Remove beta from Recent Projects");
    expect(panel.renderRoot.querySelector(".recent-project-remove svg path")?.getAttribute("d")).toBe("m6 6 12 12M18 6 6 18");

    // The row container itself is inert; pointer and keyboard activation live on the buttons.
    row?.click();
    expect(onOpenRegistered).not.toHaveBeenCalled();
    expect(onOpenClosed).not.toHaveBeenCalled();
    expect(onRemoveRequested).not.toHaveBeenCalled();

    teardown();
  });

  it("lays out inset cards with an overlaid remove target and collision-free activity", () => {
    const styles = panelStyles();

    expect(styles).toMatch(/\.recent-projects-list\s*\{[^}]*box-sizing:\s*border-box;[^}]*padding-inline:\s*8px;/);
    expect(styles).toMatch(/\.recent-project-row\s*\{[^}]*display:\s*block;/);
    expect(styles).not.toMatch(/\.recent-project-row\s*\{[^}]*grid-template-columns:/);
    expect(styles).toMatch(/\.recent-project-open\s*\{[^}]*width:\s*100%;[^}]*border-radius:\s*8px;[^}]*padding-right:\s*54px;[^}]*font:\s*inherit;/);
    expect(styles).toMatch(/\.recent-project-remove\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*z-index:\s*2;[^}]*width:\s*32px;[^}]*min-width:\s*32px;[^}]*height:\s*100%;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-radius:\s*0 8px 8px 0;[^}]*background:\s*transparent;/);
    expect(styles).toMatch(/\.action-activity\s*\{\s*right:\s*38px;\s*\}/);
    expect(styles).not.toContain("!important");
  });

  it("reveals the inline remove action without tinting its target", () => {
    const styles = panelStyles();

    expect(styles).toMatch(/\.recent-project-remove\s*\{[^}]*color:\s*var\(--pi-muted\);[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(styles).toMatch(/\.recent-project-row:hover \.recent-project-remove,\s*\.recent-project-row:focus-within \.recent-project-remove\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
    expect(styles).toMatch(/\.recent-project-remove:hover\s*\{\s*color:\s*var\(--pi-text\);\s*background:\s*transparent;\s*\}/);
    expect(styles).not.toMatch(/\.recent-project-row\.selected \.recent-project-remove\s*\{[^}]*background:/);

    const nonHover = styles.slice(styles.indexOf("@media (hover: none)"));
    expect(nonHover).toMatch(/\.recent-project-remove\s*\{\s*opacity:\s*1;\s*pointer-events:\s*auto;/);
  });
});

describe("recent-projects-panel activation", () => {
  it("opens a registered project through the supplied callback", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    primary(panel)?.click();

    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    teardown();
  });

  it("routes a closed entry to the closed handler instead", async () => {
    const onOpenRegistered = vi.fn();
    const onOpenClosed = vi.fn();
    const closed = entry("/work/alpha");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [closed] },
      projects: [],
      onOpenClosed,
      onOpenRegistered,
    });

    primary(panel)?.click();

    expect(onOpenClosed).toHaveBeenCalledWith(closed, expect.any(Function));
    expect(onOpenRegistered).not.toHaveBeenCalled();
    teardown();
  });

  it("activates the primary action from the keyboard and retries from the failed state", async () => {
    const onOpenRegistered = vi.fn();
    const alpha = project("p1", "/work/alpha");
    const opened = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [alpha],
      onOpenRegistered,
    });

    const primaryButton = primary(opened.panel);
    primaryButton?.focus();
    expect(opened.panel.shadowRoot?.activeElement).toBe(primaryButton);
    primaryButton?.click();
    expect(onOpenRegistered).toHaveBeenCalledWith(alpha);
    opened.teardown();

    const onRetry = vi.fn();
    const failed = await mount({ state: { kind: "failed", message: "offline" }, onRetry });

    failed.panel.renderRoot.querySelector<HTMLButtonElement>("button.recent-projects-retry")?.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.teardown();
  });

  it("requests removal from either row type without opening the entry", async () => {
    const onOpenRegistered = vi.fn<(project: Project) => void>();
    const onOpenClosed = vi.fn<(entry: RecentProjectEntry, restoreFocus: () => void) => void>();
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const alpha = project("p1", "/work/alpha");
    const beta = entry("/work/beta");
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), beta] },
      projects: [alpha],
      onOpenRegistered,
      onOpenClosed,
      onRemoveRequested,
    });

    removeButton(panel, 0)?.click();
    removeButton(panel, 1)?.click();

    expect(onRemoveRequested).toHaveBeenCalledTimes(2);
    expect(onOpenRegistered).not.toHaveBeenCalled();
    expect(onOpenClosed).not.toHaveBeenCalled();

    const firstCall = onRemoveRequested.mock.calls[0];
    expect(firstCall?.[0]).toEqual(entry("/work/alpha"));
    expect(firstCall?.[1]).toEqual(expect.any(Function));
    expect(firstCall?.[2]).toEqual(expect.any(Function));

    expect(onRemoveRequested.mock.calls[1]?.[0]).toEqual(beta);
    teardown();
  });

  it("activates removal from the keyboard-focus path", async () => {
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
      onRemoveRequested,
    });

    const remove = removeButton(panel);
    remove?.focus();
    expect(panel.shadowRoot?.activeElement).toBe(remove);
    remove?.click();

    expect(onRemoveRequested).toHaveBeenCalledTimes(1);
    expect(onRemoveRequested.mock.calls[0]?.[0]).toEqual(entry("/work/alpha"));
    teardown();
  });

  it("restores focus to the originating remove button when the direct-remove flow cancels", async () => {
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
      onRemoveRequested,
    });

    const remove = removeButton(panel);
    remove?.click();
    const cancelFocus = onRemoveRequested.mock.calls[0]?.[1];
    expect(cancelFocus).toEqual(expect.any(Function));

    cancelFocus?.();
    await panel.updateComplete;

    expect(panel.shadowRoot?.activeElement).toBe(remove);
    teardown();
  });

  it("restores focus to the primary action when the Closed flow is cancelled", async () => {
    const onOpenClosed = vi.fn<(entry: RecentProjectEntry, restoreFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
      onOpenClosed,
    });

    const primaryButton = primary(panel);
    primaryButton?.focus();
    expect(panel.shadowRoot?.activeElement).toBe(primaryButton);
    primaryButton?.click();
    const restoreFocus = onOpenClosed.mock.calls[0]?.[1];

    restoreFocus?.();
    await panel.updateComplete;

    expect(panel.shadowRoot?.activeElement).toBe(primary(panel));
    teardown();
  });

  it("falls back to the next primary action when the Closed row disappears before cancel", async () => {
    const onOpenClosed = vi.fn<(entry: RecentProjectEntry, restoreFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] },
      projects: [],
      onOpenClosed,
    });

    primary(panel, 0)?.click();
    const restoreFocus = onOpenClosed.mock.calls[0]?.[1];

    panel.state = { kind: "ready", entries: [entry("/work/beta")] };
    await panel.updateComplete;
    restoreFocus?.();
    await panel.updateComplete;

    expect(panel.shadowRoot?.activeElement).toBe(primary(panel, 0));
    teardown();
  });

  it("moves focus to the next entry's primary action after removal", async () => {
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] },
      projects: [],
      onRemoveRequested,
    });

    removeButton(panel, 0)?.click();
    const removalFocus = onRemoveRequested.mock.calls[0]?.[2];

    panel.state = { kind: "ready", entries: [entry("/work/beta")] };
    await panel.updateComplete;
    removalFocus?.();
    await panel.updateComplete;

    expect(panel.shadowRoot?.activeElement).toBe(primary(panel, 0));
    teardown();
  });

  it("moves focus to the previous entry's primary action when the last entry is removed", async () => {
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha"), entry("/work/beta")] },
      projects: [],
      onRemoveRequested,
    });

    removeButton(panel, 1)?.click();
    const removalFocus = onRemoveRequested.mock.calls[0]?.[2];

    panel.state = { kind: "ready", entries: [entry("/work/alpha")] };
    await panel.updateComplete;
    removalFocus?.();
    await panel.updateComplete;

    expect(panel.shadowRoot?.activeElement).toBe(primary(panel, 0));
    teardown();
  });

  it("moves focus to the focusable empty state when the sole entry is removed", async () => {
    const onRemoveRequested = vi.fn<(entry: RecentProjectEntry, cancelFocus: () => void, removalFocus: () => void) => void>();
    const { panel, teardown } = await mount({
      state: { kind: "ready", entries: [entry("/work/alpha")] },
      projects: [],
      onRemoveRequested,
    });

    removeButton(panel, 0)?.click();
    const removalFocus = onRemoveRequested.mock.calls[0]?.[2];

    panel.state = { kind: "ready", entries: [] };
    await panel.updateComplete;
    removalFocus?.();
    await panel.updateComplete;

    const empty = panel.renderRoot.querySelector<HTMLElement>(".recent-projects-empty");
    expect(panel.shadowRoot?.activeElement).toBe(empty);
    expect(empty?.getAttribute("tabindex")).toBe("-1");
    teardown();
  });
});
