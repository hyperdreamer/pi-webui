// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, Workspace } from "../api";
import { SessionList } from "./SessionList";

const scrollIntoView = vi.fn();
const resizeObservers: FakeResizeObserver[] = [];
// jsdom reports no layout for any element. Model the browser here: a reveal can only run
// while the selected row has layout, which an enclosing hidden panel removes.
let rowHasLayout = true;

class FakeResizeObserver implements ResizeObserver {
  private observed = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(): void {
    this.observed = true;
  }

  unobserve(): void {
    this.observed = false;
  }

  disconnect(): void {
    this.observed = false;
  }

  notify(): void {
    if (this.observed) this.callback([], this);
  }
}

function notifyLayout(): void {
  for (const observer of resizeObservers) observer.notify();
}

const laidOutRects = [new DOMRect(0, 0, 200, 24)];
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const getClientRectsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getClientRects");

function restorePrototypeMethod(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
  else Object.defineProperty(HTMLElement.prototype, name, descriptor);
}

beforeEach(() => {
  // jsdom has no layout; observe the browser boundaries instead.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrollIntoView });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true, writable: true, value: () => (rowHasLayout ? laidOutRects : []) });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  rowHasLayout = true;
  resizeObservers.length = 0;
  scrollIntoView.mockClear();
});

afterEach(() => {
  // Remove hosts first so their disconnect cleanup runs against the real observer global.
  document.body.replaceChildren();
  restorePrototypeMethod("scrollIntoView", scrollIntoViewDescriptor);
  restorePrototypeMethod("getClientRects", getClientRectsDescriptor);
  vi.unstubAllGlobals();
});

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

function archivedSession(id: string): SessionInfo {
  return session(id, { archived: true, archivedAt: "2026-06-09T00:00:00.000Z" });
}

interface MountOptions {
  selected?: SessionInfo;
  collapsed?: boolean;
  projectSessions?: SessionInfo[];
  currentWorkspacePath?: string;
  workspaces?: Workspace[];
}

async function mount(sessions: SessionInfo[], options: MountOptions = {}): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  list.workspaces = options.workspaces ?? [];
  if (options.projectSessions !== undefined) list.projectSessions = options.projectSessions;
  if (options.currentWorkspacePath !== undefined) list.currentWorkspacePath = options.currentWorkspacePath;
  if (options.selected !== undefined) list.selected = options.selected;
  list.collapsed = options.collapsed ?? false;
  document.body.append(list);
  await settle(list);
  return list;
}

/** Awaits the render plus any follow-up cycle a `@state` write during `updated()` schedules. */
async function settle(list: SessionList): Promise<void> {
  await list.updateComplete;
  await list.updateComplete;
}

function selectedRow(list: SessionList): Element | null | undefined {
  return list.shadowRoot?.querySelector(".action-row.selected");
}

function expectRevealedOnce(list: SessionList): void {
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(scrollIntoView.mock.instances[0]).toBe(selectedRow(list));
}

function clickShadowButton(list: SessionList, label: string): void {
  const button = list.shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (button === null || button === undefined) throw new Error(`no button labelled ${label}`);
  button.click();
}

async function typeSearch(list: SessionList, query: string): Promise<void> {
  if (list.shadowRoot?.querySelector(".session-search-input") === null) {
    clickShadowButton(list, "Search sessions");
    await settle(list);
  }
  const input = list.shadowRoot?.querySelector<HTMLInputElement>(".session-search-input");
  if (input === null || input === undefined) throw new Error("no session search input");
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(list);
}

async function closeSearch(list: SessionList): Promise<void> {
  clickShadowButton(list, "Close session search");
  await settle(list);
}

function workspace(path: string): Workspace {
  return { id: path, projectId: "project", path, label: path, isMain: false, isGitRepo: true, isGitWorktree: true };
}

describe("session selection reveal", () => {
  it("reveals the initial selection once", async () => {
    const first = session("first");
    const list = await mount([first, session("second")], { selected: first });
    expectRevealedOnce(list);
  });

  it("does not scroll on background refresh or same-id/same-section replacement", async () => {
    const first = session("first");
    const second = session("second");
    const list = await mount([first, second], { selected: first });
    scrollIntoView.mockClear();

    list.sessions = [{ ...first }, { ...second }];
    await settle(list);
    list.selected = { ...first };
    await settle(list);
    list.sessions = [second, first, session("third")];
    list.selected = { ...first };
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a different selected id", async () => {
    const first = session("first");
    const second = session("second");
    const list = await mount([first, second], { selected: first });
    scrollIntoView.mockClear();
    list.selected = second;
    await settle(list);
    expectRevealedOnce(list);
  });

  it("reveals the selected row when it first loads or reappears", async () => {
    const first = session("first");
    const list = await mount([], { selected: first });
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.sessions = [first];
    await settle(list);
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    list.sessions = [];
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.sessions = [{ ...first }];
    await settle(list);
    expectRevealedOnce(list);
  });

  it("reveals a selected row that appears through a projectSessions-only change", async () => {
    // A session from another workspace renders only as an external family member of a
    // current-workspace anchor, which is what makes projectSessions a real appearance path.
    const parent = session("parent");
    const child = session("child", { cwd: "/other", parentSessionPath: parent.path });
    const list = await mount([parent], {
      selected: child,
      currentWorkspacePath: "/workspace",
      workspaces: [workspace("/other")],
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.projectSessions = [child];
    await settle(list);
    expectRevealedOnce(list);
  });

  it("reveals on a workspace-path appearance and stays silent on disappearance", async () => {
    const project = session("project-only", { cwd: "/other" });
    const list = await mount([project], { selected: project, currentWorkspacePath: "/workspace" });
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.currentWorkspacePath = "/other";
    await settle(list);
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    list.currentWorkspacePath = "/workspace";
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.currentWorkspacePath = "/other";
    await settle(list);
    expectRevealedOnce(list);
  });

  it("does not scroll without a selection and reveals after clearing then reselecting", async () => {
    const first = session("first");
    const list = await mount([first]);
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.selected = first;
    await settle(list);
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    Reflect.set(list, "selected", undefined);
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.selected = { ...first };
    await settle(list);
    expectRevealedOnce(list);
  });

  it("does not scroll while collapsed and reveals on expansion", async () => {
    const first = session("first");
    const second = session("second");
    const list = await mount([first, second], { selected: first });
    scrollIntoView.mockClear();

    list.collapsed = true;
    await settle(list);
    list.selected = second;
    list.sessions = [{ ...first }, { ...second }];
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();

    list.collapsed = false;
    await settle(list);
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    list.collapsed = true;
    await settle(list);
    list.collapsed = false;
    await settle(list);
    expectRevealedOnce(list);
  });

  it("delivers a hidden reveal on resize and does not repeat it on refresh", async () => {
    const first = session("first");
    rowHasLayout = false;
    const list = await mount([first], { selected: first });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rowHasLayout = true;
    notifyLayout();
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    list.sessions = [{ ...first }];
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the owed reveal for the next update without ResizeObserver support", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const first = session("first");
    rowHasLayout = false;
    const list = await mount([first], { selected: first });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rowHasLayout = true;
    list.sessions = [{ ...first }];
    await settle(list);
    expectRevealedOnce(list);
  });

  it("expands the archived section for a selected archived session and reveals it once", async () => {
    const archived = archivedSession("old");
    const list = await mount([session("current"), archived], { selected: archived });
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    list.sessions = [session("current"), { ...archived }];
    await settle(list);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals the new row position when the selected session is archived or restored", async () => {
    const current = session("moving");
    const list = await mount([current], { selected: current });
    scrollIntoView.mockClear();

    // Archiving keeps the id and moves the row into the archived section.
    list.sessions = [{ ...current, archived: true, archivedAt: "2026-06-09T00:00:00.000Z" }];
    list.selected = { ...current, archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    await settle(list);
    expectRevealedOnce(list);
    scrollIntoView.mockClear();

    // Restoring keeps the id and moves the row back into the current section.
    list.sessions = [{ ...current }];
    list.selected = { ...current };
    await settle(list);
    expectRevealedOnce(list);
  });

  it("does not consume the reveal when search hides the selected row", async () => {
    const alpha = session("alpha");
    const list = await mount([alpha, session("beta")], { selected: alpha });
    scrollIntoView.mockClear();

    await typeSearch(list, "beta");
    expect(scrollIntoView).not.toHaveBeenCalled();

    await closeSearch(list);
    expectRevealedOnce(list);
  });
});
