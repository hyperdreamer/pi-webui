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

function setScrollAwareRect(element: Element, body: HTMLElement, contentTop: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const top = contentTop - body.scrollTop;
      const bottom = top + height;
      return { x: 0, y: top, left: 0, top, right: 340, bottom, width: 340, height, toJSON: () => ({}) };
    },
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

function expectReorderEffectsCleared(input: { selectedSubject: HTMLElement; peerSubject: HTMLElement }): void {
  expect(input.selectedSubject.classList.contains("session-reorder-dragging")).toBe(false);
  expect(input.selectedSubject.classList.contains("session-drop-before")).toBe(false);
  expect(input.selectedSubject.classList.contains("session-drop-after")).toBe(false);
  expect(input.peerSubject.classList.contains("session-drop-before")).toBe(false);
  expect(input.peerSubject.classList.contains("session-drop-after")).toBe(false);
  expect(frames.size).toBe(0);
}

function beginEdgeReorder(input: Awaited<ReturnType<typeof pointerFixture>>, pointerId: number, clientY = 1): void {
  input.grip.dispatchEvent(pointer("pointerdown", { pointerId, clientX: 10, clientY: 20 }));
  document.dispatchEvent(pointer("pointermove", { pointerId, clientX: 10, clientY }));
  expect(input.selectedSubject.classList.contains("session-reorder-dragging")).toBe(true);
  expect(input.peerSubject.classList.contains("session-drop-before") || input.peerSubject.classList.contains("session-drop-after")).toBe(true);
  expect(frames.size).toBe(1);
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
    expect(list.renderRoot.querySelector(".session-reorder-slot")).toBeNull();
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

  it("places a child peer's after marker on its deepest rendered descendant", async () => {
    const parent = sessionFixture("parent");
    const selected = sessionFixture("selected", "/repo", { parentSessionPath: parent.path });
    const peer = sessionFixture("peer", "/repo", { parentSessionPath: parent.path });
    const grandchild = sessionFixture("grandchild", "/repo", { parentSessionPath: peer.path });
    const list = await mountList({ sessions: [parent, selected, peer, grandchild], selected });
    Reflect.set(list, "expandedSessionPaths", new Set([peer.path]));
    await list.updateComplete;

    const body = list.renderRoot.querySelector<HTMLElement>(".list-body");
    const grip = gripFor(list, selected.path);
    if (body === null || grip === null) throw new Error("Missing reorder DOM");
    const selectedSubject = elementByData(list.renderRoot, "data-session-reorder-path", selected.path);
    const peerSubject = elementByData(list.renderRoot, "data-session-reorder-path", peer.path);
    const grandchildRow = elementByData(list.renderRoot, "data-session-row-path", grandchild.path);
    setRect(body, 0, 0, 340, 200);
    setRect(selectedSubject, 0, 0, 340, 40);
    setRect(peerSubject, 0, 60, 340, 100);
    setRect(grandchildRow, 0, 100, 340, 140);

    grip.dispatchEvent(pointer("pointerdown", { pointerId: 3, clientX: 10, clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 3, clientX: 10, clientY: 150 }));

    expect(peerSubject.classList.contains("session-drop-after")).toBe(false);
    expect(grandchildRow.classList.contains("session-drop-after")).toBe(true);

    document.dispatchEvent(pointer("pointercancel", { pointerId: 3, clientX: 10, clientY: 150 }));
  });

  it("renders a non-focusable grip inside only the eligible selected local session", async () => {
    const selected = sessionFixture("selected");
    const peer = sessionFixture("peer");
    const list = await mountList({ sessions: [selected, peer], selected });
    const grip = gripFor(list, selected.path);
    expect(grip).not.toBeNull();
    expect(grip?.getAttribute("title")).toBe("Drag to reorder selected session");
    expect(grip?.tagName).toBe("SPAN");
    expect(grip?.getAttribute("role")).toBeNull();
    expect(grip?.getAttribute("tabindex")).toBeNull();
    expect(grip?.closest(".action-main")).not.toBeNull();
    expect(grip?.closest(".session-row-controls")).toBeNull();
    expect(list.renderRoot.querySelector(".session-reorder-slot")).toBeNull();

    list.selected = peer;
    await list.updateComplete;
    expect(gripFor(list, selected.path)).toBeNull();
    expect(gripFor(list, peer.path)?.closest(".action-main")).not.toBeNull();
    expect(list.renderRoot.querySelector(".session-reorder-slot")).toBeNull();
  });

  it("suppresses grips for sessions that cannot be reordered", async () => {
    const selected = sessionFixture("selected");
    const peer = sessionFixture("peer");
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

    const orphan = sessionFixture("orphan", "/repo", { parentSessionPath: "/sessions/missing.jsonl" });
    const orphanList = await mountList({ sessions: [orphan, peer], selected: orphan });
    expect(gripFor(orphanList, orphan.path)).toBeNull();
  });

  it("suppresses grips beyond the session reorder protocol limits", async () => {
    const oversized = Array.from({ length: 1_001 }, (_, index) => sessionFixture(`oversized-${String(index)}`));
    const oversizedSelected = oversized[0];
    if (oversizedSelected === undefined) throw new Error("Missing oversized selected session");
    const oversizedList = await mountList({ sessions: oversized, selected: oversizedSelected });
    expect(gripFor(oversizedList, oversizedSelected.path)).toBeNull();

    const selected = sessionFixture("selected");
    const peer = sessionFixture("peer");
    const catalogList = await mountList({
      sessions: [selected, peer],
      selected,
      workspaces: Array.from({ length: 1_001 }, (_, index) => workspace(`/catalog-${String(index)}`, `catalog-${String(index)}`)),
    });
    expect(gripFor(catalogList, selected.path)).toBeNull();
  });

  it("rejects pen, non-primary, and right-button drags through pointerup", async () => {
    const rejectedGestures = [
      { pointerType: "pen", button: 0, isPrimary: true },
      { pointerType: "touch", button: 0, isPrimary: false },
      { pointerType: "mouse", button: 0, isPrimary: false },
      { pointerType: "mouse", button: 2, isPrimary: true },
    ] as const;

    for (const [index, gesture] of rejectedGestures.entries()) {
      const fixture = await pointerFixture();
      const selected = vi.fn();
      fixture.list.onSelect = selected;
      setPointerCapture.mockClear();
      releasePointerCapture.mockClear();
      const pointerId = 20 + index;
      const input = { pointerId, clientX: 10, clientY: 20, ...gesture };
      fixture.grip.dispatchEvent(pointer("pointerdown", input));
      document.dispatchEvent(pointer("pointermove", { ...input, clientY: 90 }));
      document.dispatchEvent(pointer("pointerup", { ...input, clientY: 90 }));

      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(releasePointerCapture).not.toHaveBeenCalled();
      expect(fixture.submitted).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
      expect(fixture.list.selected).toBe(fixture.selected);
      expectReorderEffectsCleared(fixture);
    }
  });

  it("cleans up every pointer outcome that cannot submit a changed reorder", async () => {
    const belowThreshold = await pointerFixture();
    belowThreshold.grip.dispatchEvent(pointer("pointerdown", { pointerId: 30, clientX: 10, clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 30, clientX: 15, clientY: 20 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 30, clientX: 15, clientY: 20 }));
    expect(belowThreshold.submitted).not.toHaveBeenCalled();
    expectReorderEffectsCleared(belowThreshold);

    const sameSlot = await pointerFixture();
    beginEdgeReorder(sameSlot, 31);
    document.dispatchEvent(pointer("pointerup", { pointerId: 31, clientX: 10, clientY: 1 }));
    expect(sameSlot.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(31);
    expectReorderEffectsCleared(sameSlot);

    const cancelled = await pointerFixture();
    beginEdgeReorder(cancelled, 32);
    document.dispatchEvent(pointer("pointercancel", { pointerId: 32, clientX: 10, clientY: 1 }));
    expect(cancelled.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(32);
    expectReorderEffectsCleared(cancelled);

    const escaped = await pointerFixture();
    beginEdgeReorder(escaped, 33);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(escaped.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(33);
    expectReorderEffectsCleared(escaped);

    const changed = await pointerFixture();
    beginEdgeReorder(changed, 34);
    changed.list.selected = changed.peer;
    await changed.list.updateComplete;
    expect(changed.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(34);
    expectReorderEffectsCleared(changed);

    const outside = await pointerFixture();
    beginEdgeReorder(outside, 35);
    document.dispatchEvent(pointer("pointerup", { pointerId: 35, clientX: 10, clientY: 220 }));
    expect(outside.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(35);
    expectReorderEffectsCleared(outside);

    const missingCallback = await pointerFixture();
    Reflect.set(missingCallback.list, "onReorder", undefined);
    expect(Reflect.get(missingCallback.list, "onReorder")).toBeUndefined();
    beginEdgeReorder(missingCallback, 36, 190);
    document.dispatchEvent(pointer("pointerup", { pointerId: 36, clientX: 10, clientY: 190 }));
    expect(missingCallback.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(36);
    expectReorderEffectsCleared(missingCallback);

    const disconnected = await pointerFixture();
    beginEdgeReorder(disconnected, 37);
    disconnected.list.remove();
    expect(disconnected.submitted).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledWith(37);
    expectReorderEffectsCleared(disconnected);
  });

  it("removes one document listener set and resets detached drag effects before reattachment", async () => {
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const fixture = await pointerFixture();
    beginEdgeReorder(fixture, 40);
    fixture.list.remove();

    expectReorderEffectsCleared(fixture);
    for (const type of ["pointermove", "pointerup", "pointercancel", "keydown"]) {
      const added = addEventListener.mock.calls.find((call) => call[0] === type);
      if (added === undefined) throw new Error(`Missing ${type} listener`);
      expect(removeEventListener).toHaveBeenCalledWith(type, added[1]);
    }

    document.body.append(fixture.list);
    await fixture.list.updateComplete;
    const body = fixture.list.renderRoot.querySelector<HTMLElement>(".list-body");
    const grip = gripFor(fixture.list, fixture.selected.path);
    if (body === null || grip === null) throw new Error("Missing reattached reorder DOM");
    const selectedSubject = elementByData(fixture.list.renderRoot, "data-session-reorder-path", fixture.selected.path);
    const peerSubject = elementByData(fixture.list.renderRoot, "data-session-reorder-path", fixture.peer.path);
    setRect(body, 0, 0, 340, 200);
    setRect(selectedSubject, 0, 0, 340, 40);
    setRect(peerSubject, 0, 60, 340, 100);
    grip.dispatchEvent(pointer("pointerdown", { pointerId: 41, clientX: 10, clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 41, clientX: 10, clientY: 90 }));
    document.dispatchEvent(pointer("pointerup", { pointerId: 41, clientX: 10, clientY: 90 }));

    await vi.waitFor(() => { expect(fixture.submitted).toHaveBeenCalledTimes(1); });
  });

  it("omits archived family subjects while retaining active linked child drop peers", async () => {
    const archivedParent = sessionFixture("archived-parent", "/repo", { archived: true });
    const selected = sessionFixture("selected", "/repo", { parentSessionPath: archivedParent.path });
    const externalPeer = sessionFixture("external-peer", "/feature", { parentSessionPath: archivedParent.path });
    const list = await mountList({
      sessions: [archivedParent, selected],
      projectSessions: [archivedParent, selected, externalPeer],
      selected,
      workspaces: [workspace("/repo", "main"), workspace("/feature", "feature")],
    });

    const archivedSubjects = [...list.renderRoot.querySelectorAll<HTMLElement>("[data-session-reorder-path]")]
      .filter((element) => element.getAttribute("data-session-reorder-path") === archivedParent.path);
    expect(gripFor(list, archivedParent.path)).toBeNull();
    expect(archivedSubjects).toEqual([]);
    expect(gripFor(list, selected.path)).not.toBeNull();
    expect(elementByData(list.renderRoot, "data-session-reorder-path", externalPeer.path)).toBeInstanceOf(HTMLElement);
  });

  it("recomputes a coalesced edge-scroll marker and stops at a clamped boundary", async () => {
    const { body, grip, peerSubject } = await pointerFixture();
    let minimumScrollTop = 0;
    let scrollTop = 20;
    Object.defineProperty(body, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(minimumScrollTop, value); },
    });
    setScrollAwareRect(peerSubject, body, 20, 12);

    grip.dispatchEvent(pointer("pointerdown", { pointerId: 50, clientX: 10, clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 50, clientX: 10, clientY: 8 }));
    expect(peerSubject.classList.contains("session-drop-after")).toBe(true);
    document.dispatchEvent(pointer("pointermove", { pointerId: 50, clientX: 10, clientY: 8 }));
    document.dispatchEvent(pointer("pointermove", { pointerId: 50, clientX: 10, clientY: 8 }));
    expect(frames.size).toBe(1);

    runNextFrame();
    expect(body.scrollTop).toBe(11);
    expect(peerSubject.classList.contains("session-drop-before")).toBe(true);
    expect(peerSubject.classList.contains("session-drop-after")).toBe(false);
    expect(frames.size).toBe(1);

    minimumScrollTop = body.scrollTop;
    runNextFrame();
    expect(body.scrollTop).toBe(11);
    expect(frames.size).toBe(0);
    document.dispatchEvent(pointer("pointercancel", { pointerId: 50, clientX: 10, clientY: 8 }));
  });

  it("keeps grip and insertion geometry stable in component styles", () => {
    const styles = sessionListStyles();

    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*position:\s*absolute;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*right:\s*0;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*top:\s*50%;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*transform:\s*translateY\(-50%\);/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*width:\s*24px;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*height:\s*24px;/);
    expect(styles).toMatch(/\.session-reorder-grip\s*\{[^}]*touch-action:\s*none;/);
    expect(styles).toMatch(/\.session-drop-before::before,\s*\.session-drop-after::after\s*\{[^}]*height:\s*2px;/);
  });
});
