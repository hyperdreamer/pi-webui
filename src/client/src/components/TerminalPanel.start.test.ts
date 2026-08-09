// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalsApi, type TerminalInfo, type Workspace } from "../api";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
const { TerminalPanel } = await import("./TerminalPanel");
type TerminalPanelElement = InstanceType<typeof TerminalPanel>;

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/work/alpha",
  label: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: false,
};

const terminal: TerminalInfo = {
  id: "terminal-1",
  name: "Shell",
  cwd: workspace.path,
  createdAt: "2026-01-01T00:00:00.000Z",
  exited: false,
};

class IdleIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds: readonly number[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setOnStarted(panel: TerminalPanelElement, callback: () => void): void {
  Reflect.set(panel, "onStarted", callback);
}

async function loadTerminals(panel: TerminalPanelElement): Promise<void> {
  const load: unknown = Reflect.get(panel, "loadTerminals");
  if (typeof load !== "function") throw new Error("Expected TerminalPanel.loadTerminals");
  await load.call(panel);
}

async function mountPanel(): Promise<TerminalPanelElement> {
  const panel = new TerminalPanel();
  panel.workspace = workspace;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function shellButton(panel: TerminalPanelElement): HTMLButtonElement {
  const button = panel.renderRoot.querySelector<HTMLButtonElement>("button.new");
  if (button === null) throw new Error("Expected + Shell button");
  return button;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IdleIntersectionObserver);
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
  vi.spyOn(terminalsApi, "listCommandRuns").mockResolvedValue([]);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TerminalPanel accepted starts", () => {
  it("reports successful auto-start exactly once to the callback captured at issue time", async () => {
    const start = deferred<TerminalInfo>();
    vi.spyOn(terminalsApi, "terminals").mockResolvedValue([]);
    vi.spyOn(terminalsApi, "startTerminal").mockReturnValue(start.promise);
    const panel = new TerminalPanel();
    panel.workspace = workspace;
    panel.autoStart = true;
    const onStarted = vi.fn();
    const replacement = vi.fn();
    setOnStarted(panel, onStarted);

    const loading = loadTerminals(panel);
    await vi.waitFor(() => { expect(terminalsApi.startTerminal).toHaveBeenCalledTimes(1); });
    expect(onStarted).not.toHaveBeenCalled();
    setOnStarted(panel, replacement);
    start.resolve(terminal);
    await loading;

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("reports a + Shell start exactly once after the API succeeds", async () => {
    const start = deferred<TerminalInfo>();
    vi.spyOn(terminalsApi, "startTerminal").mockReturnValue(start.promise);
    const panel = await mountPanel();
    const onStarted = vi.fn();
    setOnStarted(panel, onStarted);

    shellButton(panel).click();
    await vi.waitFor(() => { expect(terminalsApi.startTerminal).toHaveBeenCalledTimes(1); });
    expect(onStarted).not.toHaveBeenCalled();
    start.resolve(terminal);

    await vi.waitFor(() => { expect(onStarted).toHaveBeenCalledTimes(1); });
    expect(terminalsApi.startTerminal).toHaveBeenCalledWith("project-1", "workspace-1", { cols: 100, rows: 30 }, "local");
  });

  it("does not report a list failure or attempt a start", async () => {
    vi.spyOn(terminalsApi, "terminals").mockRejectedValue(new Error("list failed"));
    const startTerminal = vi.spyOn(terminalsApi, "startTerminal");
    const panel = new TerminalPanel();
    panel.workspace = workspace;
    panel.autoStart = true;
    const onStarted = vi.fn();
    setOnStarted(panel, onStarted);

    await loadTerminals(panel);

    expect(startTerminal).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not report a failed start", async () => {
    vi.spyOn(terminalsApi, "terminals").mockResolvedValue([]);
    vi.spyOn(terminalsApi, "startTerminal").mockRejectedValue(new Error("start failed"));
    const panel = new TerminalPanel();
    panel.workspace = workspace;
    panel.autoStart = true;
    const onStarted = vi.fn();
    setOnStarted(panel, onStarted);

    await loadTerminals(panel);

    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not report selecting an existing terminal", async () => {
    vi.spyOn(terminalsApi, "terminals").mockResolvedValue([terminal]);
    const startTerminal = vi.spyOn(terminalsApi, "startTerminal");
    const panel = new TerminalPanel();
    panel.workspace = workspace;
    panel.autoStart = true;
    const onStarted = vi.fn();
    setOnStarted(panel, onStarted);

    await loadTerminals(panel);

    expect(startTerminal).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
