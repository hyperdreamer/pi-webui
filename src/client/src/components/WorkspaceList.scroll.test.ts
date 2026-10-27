// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { WorkspaceList } from "./WorkspaceList";

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

beforeEach(() => {
  // jsdom has no layout; observe the browser boundaries instead.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true, value: () => (rowHasLayout ? laidOutRects : []) });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  rowHasLayout = true;
  resizeObservers.length = 0;
  scrollIntoView.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(HTMLElement.prototype, "getClientRects");
  vi.unstubAllGlobals();
});

function workspace(id: string): Workspace {
  return { id, projectId: "project", path: `/work/${id}`, label: id, isMain: false, isGitRepo: true, isGitWorktree: true };
}

async function mount(workspaces: Workspace[], selected?: Workspace, collapsed = false): Promise<WorkspaceList> {
  const list = new WorkspaceList();
  list.workspaces = workspaces;
  if (selected !== undefined) list.selected = selected;
  list.collapsed = collapsed;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function expectSelectedScroll(list: WorkspaceList): void {
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
  expect(scrollIntoView.mock.instances[0]).toBe(list.shadowRoot?.querySelector(".action-row.selected"));
}

describe("workspace selection scrolling", () => {
  it("reveals the initial selection but does not scroll on background refresh or same-ID selection replacement", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const list = await mount([first, second], first);
    expectSelectedScroll(list);
    scrollIntoView.mockClear();

    list.workspaces = [{ ...first }, { ...second }];
    await list.updateComplete;
    list.selected = { ...first };
    await list.updateComplete;
    list.workspaces = [second, first, workspace("third")];
    list.selected = { ...first };
    await list.updateComplete;
    list.activities = {};
    await list.updateComplete;
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a different selected ID", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const list = await mount([first, second], first);
    scrollIntoView.mockClear();
    list.selected = second;
    await list.updateComplete;
    expectSelectedScroll(list);
  });

  it("does not scroll while collapsed and reveals the selection on expansion", async () => {
    const first = workspace("first");
    const second = workspace("second");
    const list = await mount([first, second], first);
    scrollIntoView.mockClear();
    list.collapsed = true;
    await list.updateComplete;
    list.selected = second;
    list.workspaces = [{ ...first }, { ...second }];
    await list.updateComplete;
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.collapsed = false;
    await list.updateComplete;
    expectSelectedScroll(list);
    scrollIntoView.mockClear();
    list.collapsed = true;
    await list.updateComplete;
    list.collapsed = false;
    await list.updateComplete;
    expectSelectedScroll(list);
  });

  it("reveals an initially collapsed selection when expanded", async () => {
    const first = workspace("first");
    const list = await mount([first], first, true);
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.collapsed = false;
    await list.updateComplete;
    expectSelectedScroll(list);
  });

  it("reveals the selected row when it first loads or reappears", async () => {
    const first = workspace("first");
    const list = await mount([], first);
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.workspaces = [first];
    await list.updateComplete;
    expectSelectedScroll(list);
    scrollIntoView.mockClear();
    list.workspaces = [];
    await list.updateComplete;
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.workspaces = [{ ...first }];
    await list.updateComplete;
    expectSelectedScroll(list);
  });

  it("does not scroll without a selection and reveals a selection after clearing it", async () => {
    const first = workspace("first");
    const list = await mount([first]);
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.selected = first;
    await list.updateComplete;
    expectSelectedScroll(list);
    scrollIntoView.mockClear();
    Reflect.set(list, "selected", undefined);
    await list.updateComplete;
    expect(scrollIntoView).not.toHaveBeenCalled();
    list.selected = { ...first };
    await list.updateComplete;
    expectSelectedScroll(list);
  });

  it("waits for layout instead of losing the reveal while an enclosing panel is hidden", async () => {
    const first = workspace("first");
    rowHasLayout = false;
    const list = await mount([first], first);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rowHasLayout = true;
    notifyLayout();

    expectSelectedScroll(list);
  });

  it("keeps the reveal pending for the next refresh without ResizeObserver support", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const first = workspace("first");
    rowHasLayout = false;
    const list = await mount([first], first);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rowHasLayout = true;
    list.workspaces = [{ ...first }];
    await list.updateComplete;

    expectSelectedScroll(list);
  });
});
