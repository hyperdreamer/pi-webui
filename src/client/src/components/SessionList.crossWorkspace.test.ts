import { describe, expect, it } from "vitest";
import type { SessionInfo, Workspace } from "../api";
import { eligibleSessionReorderGroup } from "../sessionReorder";
import { findOptionalTemplateEventHandlerAfterMarker, isTemplateResult, templateText } from "../templateInspection.testSupport";
import { SessionList, sessionRowsForCurrentTree } from "./SessionList";

describe("cross-workspace session rows", () => {
  it("colors linked session names with the blue accent", () => {
    expect(sessionListStyles()).toMatch(/\.action-row\.external-session \.action-name\s*\{[^}]*color:\s*var\(--pi-accent\);/);
  });

  it("styles parent families with a solid neutral rectangular frame", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border:\s*1px solid var\(--pi-hierarchy-border\);/);
    expect(styles).not.toContain(".session-family-frame::before");
    expect(styles).toMatch(/\.session-family-frame\s*\{[^}]*border-radius:\s*10px;/);
  });

  it("draws the nested guide rail on the row surface, not the row box", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.action-row\.nested \.action-main::before\s*\{[^}]*background:\s*var\(--pi-hierarchy-border\);/);
    expect(styles).not.toContain(".action-row.nested::before");
  });

  it("marks a row at the capped depth as nested", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", "/workspace", { parentSessionPath: child.path });
    const list = new SessionList();
    list.sessions = [parent, child, grandchild];
    const rows = sessionRowsForCurrentTree([parent, child, grandchild], { currentWorkspacePath: "/workspace" });
    const grandchildRow = rows.find((row) => row.session.id === "grandchild");
    if (grandchildRow === undefined) throw new Error("grandchild row missing");
    const parentRow = rows.find((row) => row.session.id === "parent");
    if (parentRow === undefined) throw new Error("parent row missing");

    expect(renderedRowClasses(list, grandchildRow)).toContain("nested");
    expect(renderedRowClasses(list, parentRow)).not.toContain("nested");
  });

  it("nests a related session from another workspace beneath its local parent", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace-feature", { parentSessionPath: parent.path });
    const unrelated = session("unrelated", "/workspace-feature");

    const rows = sessionRowsForCurrentTree([parent, child, unrelated], { currentWorkspacePath: "/workspace" });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, external: row.external }))).toEqual([
      { id: "parent", depth: 0, external: false },
      { id: "child", depth: 1, external: true },
    ]);
  });

  it("places a known external parent above its local child", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace-feature", { parentSessionPath: parent.path });

    const rows = sessionRowsForCurrentTree([parent, child], {
      currentWorkspacePath: "/workspace-feature",
      knownWorkspacePaths: new Set(["/workspace", "/workspace-feature"]),
    });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, external: row.external }))).toEqual([
      { id: "parent", depth: 0, external: true },
      { id: "child", depth: 1, external: false },
    ]);
  });

  it("keeps an archived local parent visible for an active linked child", () => {
    const parent = { ...session("parent", "/workspace"), archived: true, archivedAt: "2026-06-10T00:00:00.000Z" };
    const child = session("child", "/workspace-feature", { parentSessionPath: parent.path });

    const rows = sessionRowsForCurrentTree([parent, child], {
      currentWorkspacePath: "/workspace",
      knownWorkspacePaths: new Set(["/workspace", "/workspace-feature"]),
    });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, external: row.external }))).toEqual([
      { id: "parent", depth: 0, external: false },
      { id: "child", depth: 1, external: true },
    ]);
  });

  it("keeps a parent unavailable when its workspace is no longer known", () => {
    const parent = session("parent", "/removed-workspace");
    const child = session("child", "/workspace", { parentSessionPath: parent.path });

    const rows = sessionRowsForCurrentTree([parent, child], {
      currentWorkspacePath: "/workspace",
      knownWorkspacePaths: new Set(["/workspace"]),
    });

    expect(rows.map((row) => ({ id: row.session.id, depth: row.depth, missingParent: row.hasMissingParent }))).toEqual([
      { id: "child", depth: 0, missingParent: true },
    ]);
  });

  it("does not expose pin actions for a linked session", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace-feature", { parentSessionPath: parent.path, pinned: true });
    const list = new SessionList();
    list.sessions = [parent];
    list.projectSessions = [parent, child];
    list.currentWorkspacePath = parent.cwd;
    list.workspaces = [workspace("workspace", parent.cwd), workspace("workspace-feature", child.cwd)];

    // This narrowly checks that an external row cannot invoke the local
    // mutation control in the Node-only Lit test environment.
    expect(findOptionalTemplateEventHandlerAfterMarker(list.render(), 'title="Click to unpin session"')).toBeUndefined();
  });

  it("keeps external selections read-only while local children retain external drop peers", () => {
    const parent = session("parent", "/workspace", { persisted: true });
    const localChild = session("local-child", "/workspace", { persisted: true, parentSessionPath: parent.path });
    const externalChild = session("external-child", "/workspace-feature", { persisted: true, parentSessionPath: parent.path });
    const list = new SessionList();
    list.sessions = [parent, localChild];
    list.projectSessions = [parent, localChild, externalChild];
    list.currentWorkspacePath = parent.cwd;
    list.workspaces = [workspace("workspace", parent.cwd), workspace("workspace-feature", externalChild.cwd)];
    list.canReorder = true;
    list.selected = externalChild;

    expect(templateText(list.render())).not.toContain("session-reorder-grip");
    expect(eligibleSessionReorderGroup(
      sessionRowsForCurrentTree(list.projectSessions, {
        currentWorkspacePath: parent.cwd,
        knownWorkspacePaths: new Set([parent.cwd, externalChild.cwd]),
      }),
      localChild,
      parent.cwd,
    ).map(({ id }) => id)).toEqual([localChild.id, externalChild.id]);
  });

  it("hides an entire descendant group when its parent is folded", () => {
    const parent = session("parent", "/workspace");
    const child = session("child", "/workspace-feature", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", "/workspace-feature", { parentSessionPath: child.path });

    const rows = sessionRowsForCurrentTree([parent, child, grandchild], {
      currentWorkspacePath: "/workspace",
      foldedSessionPaths: new Set([parent.path]),
    });

    expect(rows.map((row) => ({ id: row.session.id, hasChildren: row.hasChildren }))).toEqual([
      { id: "parent", hasChildren: true },
    ]);
  });
});

function sessionListStyles(): string {
  const styles = SessionList.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}

/**
 * Session rows render inside a map over row groups, so templateText cannot reach
 * a single row through render(). This uses the component's own per-row seam,
 * matching the pattern already used by this component's other row tests.
 */
function renderedRowClasses(list: SessionList, row: unknown): string {
  const method: unknown = Reflect.get(list, "renderSession");
  if (typeof method !== "function") throw new Error("SessionList.renderSession is not callable");
  const rendered: unknown = Reflect.apply(method, list, [row, 0, "current", [], [], [], false, false]);
  if (!isTemplateResult(rendered)) throw new Error("SessionList.renderSession did not return a template");
  return templateText(rendered);
}

function workspace(id: string, path: string): Workspace {
  return {
    id,
    projectId: "project",
    path,
    label: id,
    isMain: false,
    isGitRepo: true,
    isGitWorktree: true,
  };
}

function session(id: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd,
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
