import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { findOptionalTemplateEventHandlerNearMarker, templateEventHandlerAfterMarker, templateEventHandlerAfterValue, templateEventHandlerNearMarker, templateText } from "../templateInspection.testSupport";
import { clickOutsideActionMenu } from "./actionMenu.testSupport";
import { SessionList, sessionRowActivityKind, sessionRowsForCurrentTree, sessionRowsForSessionList, unreadSessionCount } from "./SessionList";

describe("sessionRowActivityKind", () => {
  const idle = sessionStatus("s");

  it("reports 'sending' for an uploading session, taking precedence over server activity", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, true)).toBe("sending");
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, true)).toBe("sending");
  });

  it("reports 'session' for server activity when not sending", () => {
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, false)).toBe("session");
  });

  it("reports unread only while the session is idle", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, false, true)).toBe("unread");
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, false, true)).toBe("session");
    expect(sessionRowActivityKind(session("s"), idle, undefined, true, true)).toBe("sending");
  });

  it("reports undefined when idle, read, and not sending", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, false)).toBeUndefined();
  });

  it("never shows an indicator for archived or cached-new sessions, even while sending or unread", () => {
    expect(sessionRowActivityKind({ ...session("s"), archived: true }, idle, undefined, true, true)).toBeUndefined();
    expect(sessionRowActivityKind(markCachedNewSessionInfo(session("s")), idle, undefined, true, true)).toBeUndefined();
  });
});

describe("session tree activity presentation", () => {
  it("renders a distinct descendant-work badge on an idle parent", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const list = new SessionList();
    list.sessions = [parent, child];
    list.statuses = { [child.id]: sessionStatus(child.id, { isStreaming: true }) };

    const rendered = templateText(list.render());

    expect(rendered).toContain("1 subsession working");
    expect(rendered).toContain("activity-indicator descendant");
  });
});

describe("unreadSessionCount", () => {
  it("counts only current persisted sessions", () => {
    const current = session("current");
    const archived = { ...session("archived"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const cached = markCachedNewSessionInfo(session("cached"));

    const unreadIds = new Set([current.id, archived.id, cached.id]);
    expect(unreadSessionCount([current, archived, cached], unreadIds)).toBe(1);
    expect(unreadSessionCount([current, archived, cached], unreadIds, {
      statuses: { [current.id]: sessionStatus(current.id, { isStreaming: true }) },
    })).toBe(0);
  });
});

describe("expanded session browser interaction", () => {
  // The Node test environment has no DOM harness, so inspect the stable
  // accessible button marker to narrowly exercise Lit's click wiring.
  it("forwards the project-scoped browser action from the Sessions heading", () => {
    const list = new SessionList();
    const onOpenExpanded = vi.fn();
    list.onOpenExpanded = onOpenExpanded;

    templateEventHandlerNearMarker(list.render(), 'aria-label="Open expanded session browser"')(new Event("click"));

    expect(onOpenExpanded).toHaveBeenCalledOnce();
  });
});

describe("session action menu dismissal", () => {
  it("closes an open menu when another part of the session list is clicked", () => {
    const list = new SessionList();
    Reflect.set(list, "openMenuSessionId", "open-menu");

    clickOutsideActionMenu(list);

    expect(Reflect.get(list, "openMenuSessionId")).toBeUndefined();
  });
});

describe("session rename interaction", () => {
  // This narrowly checks Lit event wiring. The Node-based test environment has
  // no DOM harness, while the observable callback proves the user interaction.
  it("opens a name editor on double-click and sends the trimmed name on Enter", () => {
    const list = new SessionList();
    const target = session("rename", { name: "Existing session" });
    list.sessions = [target];
    const onRename = vi.fn();
    const onRenameStart = vi.fn();
    Reflect.set(list, "onRename", onRename);
    Reflect.set(list, "onRenameStart", onRenameStart);

    templateEventHandlerAfterMarker(list.render(), 'class="action-row')(rowDoubleClickEvent());
    expect(onRenameStart).toHaveBeenCalledWith(target);
    templateEventHandlerAfterMarker(list.render(), 'aria-label="Rename session"')(renameKeydownEvent("  Renamed session  "));

    expect(onRename).toHaveBeenCalledWith(target, "Renamed session");
  });

  // This narrowly checks Lit event wiring. The Node-based test environment has
  // no DOM harness, while the observable callback proves the user interaction.
  it("opens a name editor from session actions", () => {
    const list = new SessionList();
    const target = session("rename", { name: "Existing session" });
    list.sessions = [target];
    const onRenameStart = vi.fn();
    Reflect.set(list, "onRenameStart", onRenameStart);
    Reflect.set(list, "openMenuSessionId", target.id);

    templateEventHandlerAfterMarker(list.render(), 'title="Rename session"')(actionMenuButtonClickEvent());

    expect(onRenameStart).toHaveBeenCalledWith(target);
    expect(Reflect.get(list, "renamingSessionId")).toBe(target.id);
    expect(Reflect.get(list, "openMenuSessionId")).toBeUndefined();
  });
});

describe("pinned session interaction", () => {
  it("enlarges the pinned star and gives it a button surface on hover", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.pinned-star:hover\s*\{[^}]*background:\s*var\(--pi-surface\);/);
    expect(styles).toMatch(/\.pinned-star:hover\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--pi-border\);/);
    expect(styles).toMatch(/\.pinned-star:hover\s*\{[^}]*transform:\s*scale\(1\.25\);/);
  });

  // This narrowly checks Lit event wiring. The Node-based test environment has
  // no DOM harness, while the observable callback proves the user interaction.
  it("shows an unpin hint and unpins a session when its pinned star is clicked", () => {
    const list = new SessionList();
    const target = session("pinned", { pinned: true });
    list.sessions = [target];
    const onUnpin = vi.fn();
    list.onUnpin = onUnpin;
    const event = new Event("click");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    templateEventHandlerAfterMarker(list.render(), 'title="Click to unpin session"')(event);

    expect(onUnpin).toHaveBeenCalledWith(target);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});

describe("session action eligibility", () => {
  it("requires a persisted server signal before archiving when persistence is authoritative", () => {
    const authoritative = { authoritative: true };
    expect(isArchivableSessionInfo(session("persisted", { persisted: true }), undefined, authoritative)).toBe(true);
    expect(isArchivableSessionInfo(session("unknown"), undefined, authoritative)).toBe(false);
    expect(isArchivableSessionInfo(session("transient", { persisted: false }), undefined, authoritative)).toBe(false);
    expect(isArchivableSessionInfo({ ...session("archived", { persisted: true }), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" }, undefined, authoritative)).toBe(false);
  });

  it("preserves legacy archiving when persistence support is not advertised", () => {
    expect(isArchivableSessionInfo(session("legacy"))).toBe(true);
    expect(isTransientNewSessionInfo(session("legacy"))).toBe(false);
  });

  it("allows deleting transient non-archived sessions from server or browser-cached signals", () => {
    expect(isTransientNewSessionInfo(session("transient", { persisted: false }))).toBe(true);
    expect(isTransientNewSessionInfo(markCachedNewSessionInfo(session("cached")))).toBe(true);
    expect(isTransientNewSessionInfo(session("persisted", { persisted: true }))).toBe(false);
    expect(isTransientNewSessionInfo({ ...session("archived", { persisted: false }), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" })).toBe(false);
  });

  it("uses matching status as the freshest persistence signal", () => {
    const staleTransient = session("s", { persisted: false });
    expect(isArchivableSessionInfo(staleTransient, sessionStatus("s", { persisted: true }))).toBe(true);
    expect(isTransientNewSessionInfo(staleTransient, sessionStatus("s", { persisted: true }))).toBe(false);

    const stalePersisted = session("s", { persisted: true });
    expect(isArchivableSessionInfo(stalePersisted, sessionStatus("s", { persisted: false }))).toBe(false);
    expect(isTransientNewSessionInfo(stalePersisted, sessionStatus("s", { persisted: false }))).toBe(true);

    expect(isArchivableSessionInfo(staleTransient, sessionStatus("other", { persisted: true }))).toBe(false);
  });
});

describe("linked session group disclosure", () => {
  it("folds each linked parent family by default", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", { parentSessionPath: child.path });

    expect(rowSummaries(sessionRowsForSessionList([parent, child, grandchild]))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
    ]);
  });

  it("returns locally expanded families to their default folded state after a workspace change", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const list = new SessionList();
    list.sessions = [parent, child];
    list.currentWorkspacePath = "/workspace";
    Reflect.set(list, "expandedSessionPaths", new Set([parent.path]));

    list.currentWorkspacePath = "/workspace-feature";
    workspaceChanged(list, "/workspace");

    expect(expandedSessionPaths(list)).toEqual(new Set());
    expect(rowSummaries(sessionRowsForSessionList(list.sessions, { expandedSessionPaths: expandedSessionPaths(list) }))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
    ]);
  });

  // This narrowly checks Lit disclosure wiring. The Node-based test environment
  // has no DOM harness; row output from the shared tree helper is the observable result.
  it("expands a complete descendant tree and folds it again from its chevron", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", { parentSessionPath: child.path });
    const list = new SessionList();
    list.sessions = [parent, child, grandchild];

    templateEventHandlerAfterValue(list.render(), "Expand parent", "@click")(new Event("click"));
    expect(rowSummaries(sessionRowsForSessionList(list.sessions, { expandedSessionPaths: expandedSessionPaths(list) }))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
      { id: "child", depth: 1, hasMissingParent: false },
      { id: "grandchild", depth: 2, hasMissingParent: false },
    ]);

    templateEventHandlerAfterValue(list.render(), "Collapse parent", "@click")(new Event("click"));
    expect(rowSummaries(sessionRowsForSessionList(list.sessions, { expandedSessionPaths: expandedSessionPaths(list) }))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
    ]);
  });

  it("folds linked cross-workspace families by default", () => {
    const parent = session("parent", { cwd: "/workspace" });
    const child = session("child", { cwd: "/workspace-feature", parentSessionPath: parent.path });

    expect(rowSummaries(sessionRowsForSessionList([parent, child], {
      currentWorkspacePath: "/workspace",
      knownWorkspacePaths: new Set(["/workspace", "/workspace-feature"]),
    }))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
    ]);
  });

  it("automatically expands every ancestor of the selected descendant", () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const grandchild = session("grandchild", { parentSessionPath: child.path });

    expect(rowSummaries(sessionRowsForSessionList([parent, child, grandchild], { selectedSessionPath: grandchild.path }))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
      { id: "child", depth: 1, hasMissingParent: false },
      { id: "grandchild", depth: 2, hasMissingParent: false },
    ]);
  });
});

describe("sessionRowsForCurrentTree", () => {
  it("keeps archived ancestors visible while they have unarchived descendants", () => {
    const parent = { ...session("parent"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const child = session("child", { parentSessionPath: parent.path });

    expect(rowSummaries(sessionRowsForCurrentTree([parent, child]))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
      { id: "child", depth: 1, hasMissingParent: false },
    ]);
  });

  it("hides archived parents from the current tree once children are detached", () => {
    const parent = { ...session("parent"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const detachedChild = session("child");

    expect(rowSummaries(sessionRowsForCurrentTree([parent, detachedChild]))).toEqual([
      { id: "child", depth: 0, hasMissingParent: false },
    ]);
  });

  it("still marks unavailable parents when the parent record is missing", () => {
    const child = session("child", { parentSessionPath: "/sessions/missing.jsonl" });

    expect(rowSummaries(sessionRowsForCurrentTree([child]))).toEqual([
      { id: "child", depth: 0, hasMissingParent: true },
    ]);
  });
});

describe("session sidebar search and cleanup controls", () => {
  it("opens and closes the inline search control, clearing its query on close", () => {
    const list = new SessionList();
    const openSearch = findOptionalTemplateEventHandlerNearMarker(list.render(), 'aria-controls="session-search"');
    expect(openSearch).toBeTypeOf("function");
    if (openSearch === undefined) throw new Error("Expected session search control");

    openSearch(new Event("click"));
    expect(templateText(list.render())).toContain('id="session-search"');
    Reflect.set(list, "searchQuery", "release");

    const closeSearch = findOptionalTemplateEventHandlerNearMarker(list.render(), 'aria-controls="session-search"');
    expect(closeSearch).toBeTypeOf("function");
    if (closeSearch === undefined) throw new Error("Expected session search close control");
    closeSearch(new Event("click"));

    expect(Reflect.get(list, "searchQuery")).toBe("");
    expect(templateText(list.render())).not.toContain('id="session-search"');
  });

  // The Node test environment has no DOM harness, so inspect the stable
  // archive button text to narrowly exercise Lit's bulk-action wiring.
  it("archives only selected current sessions visible to an active query", () => {
    const hidden = session("hidden", { firstMessage: "Unrelated current session" });
    const visible = session("visible", { firstMessage: "Deploy release" });
    const list = new SessionList();
    const onArchiveMany = vi.fn();
    list.sessions = [hidden, visible];
    list.onArchiveMany = onArchiveMany;
    Reflect.set(list, "selectionScopes", new Set(["current"]));
    Reflect.set(list, "selectedSessionIds", new Set([hidden.id, visible.id]));
    Reflect.set(list, "searchOpen", true);

    templateEventHandlerAfterMarker(list.render(), 'id="session-search"')(searchInputEvent("deploy"));
    const rendered = list.render();
    expect(templateText(rendered)).toContain("Deploy release");
    expect(templateText(rendered)).not.toContain("Unrelated current session");

    templateEventHandlerNearMarker(rendered, "Archive selected")(new Event("click"));

    expect(onArchiveMany).toHaveBeenCalledWith([visible]);
    expect(Reflect.get(list, "selectedSessionIds")).toEqual(new Set([hidden.id]));
  });

  it("shows matching folded descendants and archived results while searching", () => {
    const parent = session("parent", { firstMessage: "Coordinate release" });
    const child = session("child", { firstMessage: "Deploy documentation", parentSessionPath: parent.path });
    const archived = session("archived", {
      archived: true,
      archivedAt: "2026-07-29T00:00:00.000Z",
      firstMessage: "Deploy archived notes",
    });
    const list = new SessionList();
    list.sessions = [parent, child, archived];
    Reflect.set(list, "searchQuery", "deploy");

    const renderedText = templateText(list.render());
    expect(renderedText).toContain("Coordinate release");
    expect(renderedText).toContain("Deploy documentation");
    expect(renderedText).toContain("Deploy archived notes");
    expect(renderedText).toContain("▾ Archived");
  });

  it("reports an empty result and clears an obsolete action menu when input changes", () => {
    const list = new SessionList();
    list.sessions = [session("existing")];
    Reflect.set(list, "searchOpen", true);
    Reflect.set(list, "openMenuSessionId", "existing");

    templateEventHandlerAfterMarker(list.render(), 'id="session-search"')(searchInputEvent("missing"));

    expect(Reflect.get(list, "openMenuSessionId")).toBeUndefined();
    expect(templateText(list.render())).toContain("No matching sessions.");
  });

  it("keeps cleanup callable through a labelled icon-only broom button", () => {
    const list = new SessionList();
    list.canCleanup = true;
    const onCleanup = vi.fn();
    list.onCleanup = onCleanup;

    templateEventHandlerAfterValue(list.render(), "Preview session cleanup", "@click")(new Event("click"));

    expect(onCleanup).toHaveBeenCalledOnce();
    expect(templateText(list.render())).toContain("cleanup-icon");
    expect(templateText(list.render())).not.toContain(">Clean up</button>");

    list.canCleanup = false;
    expect(templateText(list.render())).toContain(list.cleanupUnavailableMessage);
  });
});

function searchInputEvent(value: string): Event {
  const event = new Event("input");
  Object.defineProperty(event, "target", { value: { value } });
  return event;
}

function workspaceChanged(list: SessionList, previousWorkspacePath: string): void {
  const updated: unknown = Reflect.get(SessionList.prototype, "updated");
  if (!isSessionListUpdatedHook(updated)) throw new Error("Expected SessionList updated lifecycle hook");
  Reflect.apply(updated, list, [new Map<string, unknown>([["currentWorkspacePath", previousWorkspacePath]])]);
}

function expandedSessionPaths(list: SessionList): ReadonlySet<string> {
  const paths: unknown = Reflect.get(list, "expandedSessionPaths");
  if (!isStringSet(paths)) throw new Error("Expected expanded session paths");
  return paths;
}

function isSessionListUpdatedHook(value: unknown): value is (changed: Map<string, unknown>) => void {
  return typeof value === "function";
}

function isStringSet(value: unknown): value is Set<string> {
  return value instanceof Set && [...value].every((entry) => typeof entry === "string");
}

function rowSummaries(rows: ReturnType<typeof sessionRowsForCurrentTree>) {
  return rows.map((row) => ({ id: row.session.id, depth: row.depth, hasMissingParent: row.hasMissingParent }));
}

function rowDoubleClickEvent(): Event {
  const event = new Event("dblclick", { cancelable: true });
  Object.defineProperty(event, "composedPath", { value: () => [] });
  return event;
}

function actionMenuButtonClickEvent(): Event {
  const event = new Event("click", { cancelable: true });
  Object.defineProperty(event, "composedPath", { value: () => [{ matches: () => true }] });
  return event;
}

function renameKeydownEvent(value: string): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Enter" });
  Object.defineProperty(event, "currentTarget", { value: { value } });
  return event;
}

function sessionListStyles(): string {
  const styles = SessionList.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}

function sessionStatus(sessionId: string, overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
