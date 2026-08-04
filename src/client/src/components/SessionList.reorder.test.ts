// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionReorderRequest } from "../api";
import { SessionList } from "./SessionList";

let nextFrameId: number;
let frames: Map<number, FrameRequestCallback>;
let setPointerCapture: ReturnType<typeof vi.fn>;
let releasePointerCapture: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nextFrameId = 0;
  frames = new Map();
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runNextFrame(): void {
  const first = frames.entries().next().value;
  if (first === undefined) throw new Error("Expected a queued animation frame");
  frames.delete(first[0]);
  first[1](0);
}

function pointer(type: string, input: {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType?: string;
  button?: number;
  isPrimary?: boolean;
}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperties(event, {
    pointerId: { value: input.pointerId },
    clientX: { value: input.clientX },
    clientY: { value: input.clientY },
    pointerType: { value: input.pointerType ?? "mouse" },
    button: { value: input.button ?? 0 },
    isPrimary: { value: input.isPrimary ?? true },
  });
  return event;
}

function sessionFixture(id: string, cwd = "/repo", patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    cwd,
    path: `/sessions/${id}.jsonl`,
    persisted: true,
    created: "now",
    modified: "now",
    messageCount: 0,
    firstMessage: id,
    ...patch,
  };
}

function workspace(path: string, id = path): SessionList["workspaces"][number] {
  return {
    id,
    projectId: "project",
    path,
    label: path,
    isMain: path === "/repo",
    isGitRepo: true,
    isGitWorktree: path !== "/repo",
  };
}

async function mountList(input: {
  sessions: SessionInfo[];
  projectSessions?: SessionInfo[];
  selected: SessionInfo;
  workspaces?: SessionList["workspaces"];
}): Promise<SessionList> {
  const list = new SessionList();
  Object.assign(list, {
    sessions: input.sessions,
    projectSessions: input.projectSessions ?? input.sessions,
    selected: input.selected,
    currentWorkspacePath: "/repo",
    canReorder: true,
    authoritativeSessionPersistence: true,
    workspaces: input.workspaces ?? [workspace("/repo", "main")],
  });
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function elementByData(root: ParentNode, name: string, value: string): HTMLElement {
  const element = [...root.querySelectorAll<HTMLElement>(`[${name}]`)]
    .find((candidate) => candidate.getAttribute(name) === value);
  if (element === undefined) throw new Error(`Missing ${name}=${value}`);
  return element;
}

function gripFor(list: SessionList, sessionPath: string): HTMLElement | null {
  return [...list.renderRoot.querySelectorAll<HTMLElement>(".session-reorder-grip")]
    .find((candidate) => candidate.getAttribute("data-session-reorder-handle") === sessionPath) ?? null;
}

function setRect(element: Element, left: number, top: number, right: number, bottom: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) }),
  });
}

function sessionListStyles(): string {
  const styles = SessionList.styles;
  const styleResults = Array.isArray(styles) ? styles : [styles];
  return styleResults.map((style) => style.cssText).join("\n");
}

async function pointerFixture() {
  const selected = sessionFixture("selected");
  const peer = sessionFixture("peer");
  const list = await mountList({ sessions: [selected, peer], selected });
  const submitted = vi.fn<(session: SessionInfo, input: SessionReorderRequest) => void>();
  list.onReorder = (session, input) => { submitted(session, input); };
  const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
  const grip = gripFor(list, selected.path);
  if (body === null || grip === null) throw new Error("Missing reorder DOM");
  const selectedSubject = elementByData(list.renderRoot, "data-session-reorder-path", selected.path);
  const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
  setRect(body, 0, 0, 340, 200);
  setRect(selectedSubject, 0, 0, 340, 40);
  setRect(peerSubject, 0, 60, 340, 100);
  return { body, grip, list, peer, peerSubject, selected, selectedSubject, submitted };
}

describe("SessionList reorder interaction", () => {
  it("drags a complete root family after its root peer", async () => {
    const parent = sessionFixture("parent");
    const child = sessionFixture("child", "/repo", { parentSessionPath: parent.path });
    const peer = sessionFixture("peer");
    const list = await mountList({ sessions: [parent, child, peer], selected: parent });
    const submitted: { session: SessionInfo; input: SessionReorderRequest }[] = [];
    let settleSubmission = (): void => undefined;
    const submission = new Promise<void>((resolve) => { settleSubmission = resolve; });
    list.onReorder = (session, input) => {
      submitted.push({ session, input });
      return submission;
    };
    const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
    const grip = gripFor(list, parent.path);
    if (body === null || grip === null) throw new Error("Missing reorder DOM");
    const parentSubject = elementByData(list.renderRoot, "data-session-reorder-path", parent.path);
    const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
    setRect(body, 0, 0, 340, 200);
    setRect(parentSubject, 0, 0, 340, 50);
    setRect(peerSubject, 0, 60, 340, 100);

    grip.dispatchEvent(pointer("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 1, clientX: 10, clientY: 90 }));
    expect(parentSubject.classList.contains("session-reorder-dragging")).toBe(true);
    expect(peerSubject.classList.contains("session-drop-after")).toBe(true);
    document.dispatchEvent(pointer("pointerup", { pointerId: 1, clientX: 10, clientY: 90 }));
    await vi.waitFor(() => { expect(submitted).toHaveLength(1); });

    expect(submitted[0]?.session).toBe(parent);
    expect(submitted[0]?.input.orderedSessions).toEqual([
      { id: "peer", cwd: "/repo" },
      { id: "parent", cwd: "/repo" },
    ]);
    expect(submitted[0]?.input.orderedSessions.some(({ id }) => id === child.id)).toBe(false);
    expect(parentSubject.classList.contains("session-reorder-dragging")).toBe(false);
    expect(releasePointerCapture).toHaveBeenCalledWith(1);
    await list.updateComplete;
    expect(gripFor(list, parent.path)).toBeNull();
    settleSubmission();
    await vi.waitFor(() => {
      expect(gripFor(list, parent.path)).not.toBeNull();
    });
  });

  it("uses the same pointer flow for cross-workspace child peers on touch", async () => {
    const parent = sessionFixture("parent");
    const selected = sessionFixture("selected", "/repo", { parentSessionPath: parent.path });
    const peer = sessionFixture("peer", "/feature", { parentSessionPath: parent.path });
    const list = await mountList({
      sessions: [parent, selected],
      projectSessions: [parent, selected, peer],
      selected,
      workspaces: [workspace("/repo", "main"), workspace("/feature", "feature")],
    });
    const submitted: SessionReorderRequest[] = [];
    list.onReorder = (_session, input) => { submitted.push(input); };
    const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
    const grip = gripFor(list, selected.path);
    if (body === null || grip === null) throw new Error("Missing reorder DOM");
    const selectedSubject = elementByData(list.renderRoot, "data-session-reorder-path", selected.path);
    const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
    setRect(body, 0, 0, 340, 200);
    setRect(selectedSubject, 0, 0, 340, 40);
    setRect(peerSubject, 0, 50, 340, 90);

    grip.dispatchEvent(pointer("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 80 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 2, pointerType: "touch", clientX: 10, clientY: 80 }));
    await vi.waitFor(() => { expect(submitted).toHaveLength(1); });

    expect(submitted[0]).toMatchObject({
      scope: { kind: "children", parentSessionPath: parent.path },
      catalogCwds: ["/repo", "/feature"],
      orderedSessions: [
        { id: "peer", cwd: "/feature" },
        { id: "selected", cwd: "/repo" },
      ],
    });
  });

  it("renders a non-focusable grip only for an eligible selected local session", async () => {
    const selected = sessionFixture("selected");
    const peer = sessionFixture("peer");
    const list = await mountList({ sessions: [selected, peer], selected });
    const grip = gripFor(list, selected.path);
    expect(grip).not.toBeNull();
    expect(grip?.getAttribute("title")).toBe("Drag to reorder selected session");
    expect(grip?.tagName).toBe("SPAN");
    expect(grip?.getAttribute("role")).toBeNull();
    expect(grip?.getAttribute("tabindex")).toBeNull();

    grip?.dispatchEvent(pointer("pointerdown", { pointerId: 3, pointerType: "pen", clientX: 10, clientY: 10 }));
    grip?.dispatchEvent(pointer("pointerdown", { pointerId: 4, isPrimary: false, clientX: 10, clientY: 10 }));
    expect(setPointerCapture).not.toHaveBeenCalled();

    list.selected = peer;
    await list.updateComplete;
    expect(gripFor(list, selected.path)).toBeNull();

    const archived = sessionFixture("archived", "/repo", { archived: true });
    const archivedList = await mountList({ sessions: [archived, peer], selected: archived });
    expect(gripFor(archivedList, archived.path)).toBeNull();

    const transient = sessionFixture("transient", "/repo", { persisted: false });
    const transientList = await mountList({ sessions: [transient, peer], selected: transient });
    expect(gripFor(transientList, transient.path)).toBeNull();

    const parent = sessionFixture("parent");
    const localChild = sessionFixture("local-child", "/repo", { parentSessionPath: parent.path });
    const externalChild = sessionFixture("external-child", "/feature", { parentSessionPath: parent.path });
    const externalList = await mountList({
      sessions: [parent, localChild],
      projectSessions: [parent, localChild, externalChild],
      selected: externalChild,
      workspaces: [workspace("/repo", "main"), workspace("/feature", "feature")],
    });
    expect(gripFor(externalList, externalChild.path)).toBeNull();

    const searchList = await mountList({ sessions: [selected, peer], selected });
    Reflect.set(searchList, "searchOpen", true);
    Reflect.set(searchList, "searchQuery", "selected");
    await searchList.updateComplete;
    expect(gripFor(searchList, selected.path)).toBeNull();

    const bulkList = await mountList({ sessions: [selected, peer], selected });
    Reflect.set(bulkList, "selectionScopes", new Set(["current"]));
    await bulkList.updateComplete;
    expect(gripFor(bulkList, selected.path)).toBeNull();

    const renameList = await mountList({ sessions: [selected, peer], selected });
    Reflect.set(renameList, "renamingSessionId", selected.id);
    await renameList.updateComplete;
    expect(gripFor(renameList, selected.path)).toBeNull();

    const disabledList = await mountList({ sessions: [selected, peer], selected });
    disabledList.canReorder = false;
    await disabledList.updateComplete;
    expect(gripFor(disabledList, selected.path)).toBeNull();

    const oversized = Array.from({ length: 1_001 }, (_, index) => sessionFixture(`oversized-${String(index)}`));
    const oversizedSelected = oversized[0];
    if (oversizedSelected === undefined) throw new Error("Missing oversized selected session");
    const oversizedList = await mountList({ sessions: oversized, selected: oversizedSelected });
    expect(gripFor(oversizedList, oversizedSelected.path)).toBeNull();

    const catalogList = await mountList({
      sessions: [selected, peer],
      selected,
      workspaces: Array.from({ length: 1_001 }, (_, index) => workspace(`/catalog-${String(index)}`, `catalog-${String(index)}`)),
    });
    expect(gripFor(catalogList, selected.path)).toBeNull();

    const orphan = sessionFixture("orphan", "/repo", { parentSessionPath: "/sessions/missing.jsonl" });
    const orphanList = await mountList({ sessions: [orphan, peer], selected: orphan });
    expect(gripFor(orphanList, orphan.path)).toBeNull();
  });

  it("cleans up every pointer outcome that cannot submit a changed reorder", async () => {
    const belowThreshold = await pointerFixture();
    belowThreshold.grip.dispatchEvent(pointer("pointerdown", { pointerId: 10, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 10, clientX: 15, clientY: 10 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 10, clientX: 15, clientY: 10 }));
    expect(belowThreshold.submitted).not.toHaveBeenCalled();

    const sameSlot = await pointerFixture();
    sameSlot.grip.dispatchEvent(pointer("pointerdown", { pointerId: 11, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 11, clientX: 17, clientY: 10 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 11, clientX: 17, clientY: 10 }));
    expect(sameSlot.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(11);

    const cancelled = await pointerFixture();
    cancelled.grip.dispatchEvent(pointer("pointerdown", { pointerId: 12, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 12, clientX: 10, clientY: 90 }));
    document.dispatchEvent(pointer("pointercancel", { pointerId: 12, clientX: 10, clientY: 90 }));
    expect(cancelled.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(12);

    const escaped = await pointerFixture();
    escaped.grip.dispatchEvent(pointer("pointerdown", { pointerId: 13, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 13, clientX: 10, clientY: 90 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(escaped.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(13);

    const changed = await pointerFixture();
    changed.grip.dispatchEvent(pointer("pointerdown", { pointerId: 14, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 14, clientX: 10, clientY: 90 }));
    changed.list.selected = changed.peer;
    await changed.list.updateComplete;
    expect(changed.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(14);

    const outside = await pointerFixture();
    outside.grip.dispatchEvent(pointer("pointerdown", { pointerId: 15, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 15, clientX: 10, clientY: 90 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 15, clientX: 10, clientY: 220 }));
    expect(outside.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(15);

    const disconnected = await pointerFixture();
    disconnected.grip.dispatchEvent(pointer("pointerdown", { pointerId: 16, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 16, clientX: 10, clientY: 90 }));
    disconnected.list.remove();
    expect(disconnected.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(16);
  });

  it("scrolls at the edge with one bounded animation frame and cancels it", async () => {
    const { body, grip, peerSubject } = await pointerFixture();
    body.scrollTop = 20;
    grip.dispatchEvent(pointer("pointerdown", { pointerId: 17, clientX: 10, clientY: 10 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 17, clientX: 10, clientY: 1 }));
    expect(frames.size).toBe(1);

    const previousScrollTop = body.scrollTop;
    runNextFrame();
    expect(Math.abs(body.scrollTop - previousScrollTop)).toBeLessThanOrEqual(12);
    expect(peerSubject.classList.contains("session-drop-before")).toBe(true);

    document.dispatchEvent(pointer("pointercancel", { pointerId: 17, clientX: 10, clientY: 1 }));
    expect(frames.size).toBe(0);
  });

  it("keeps grip and insertion geometry stable in component styles", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.session-reorder-slot\s*\{[^}]*width:\s*24px;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*width:\s*24px;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*height:\s*24px;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*touch-action:\s*none;/);
    expect(styles).toMatch(/\.session-drop-before::before,\s*\.session-drop-after::after\s*\{[^}]*height:\s*2px;/);
    expect(styles).toMatch(/\.action-row\.selected \.session-reorder-slot\s*\{[^}]*background:\s*var\(--pi-selection-bg\);/);
  });
});
