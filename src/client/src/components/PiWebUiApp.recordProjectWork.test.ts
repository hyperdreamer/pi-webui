import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebUiApp } from "./PiWebUiApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installRecorder(app: PiWebUiApp): string[] {
  const recorded: string[] = [];
  const controller: unknown = Reflect.get(app, "recentProjects");
  if (typeof controller !== "object" || controller === null) throw new Error("Expected the recentProjects controller");
  Reflect.set(controller, "recordWork", (projectId: string) => { recorded.push(projectId); });
  return recorded;
}

function recordProjectWork(app: PiWebUiApp): void {
  const record: unknown = Reflect.get(app, "recordProjectWork");
  if (typeof record !== "function") throw new Error("Expected recordProjectWork");
  record.call(app);
}

describe("PiWebUiApp.recordProjectWork", () => {
  it("records the selected project", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedProject: { id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" } });

    recordProjectWork(app);

    expect(recorded).toEqual(["p1"]);
  });

  it("records nothing when no project is selected", () => {
    const app = createApp();
    const recorded = installRecorder(app);

    recordProjectWork(app);

    expect(recorded).toEqual([]);
  });

  it("does not record when only the selected project changes", () => {
    const app = createApp();
    const recorded = installRecorder(app);
    const project = { id: "p1", name: "alpha", path: "/work/alpha", createdAt: "2026-01-01T00:00:00.000Z" };

    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedProject: project });
    Reflect.set(app, "state", { ...Reflect.get(app, "state"), selectedWorkspace: { id: "w1", projectId: "p1", path: "/work/alpha", label: "main", isMain: true, isGitRepo: true, isGitWorktree: false } });

    expect(recorded).toEqual([]);
  });
});

function createApp(): PiWebUiApp {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("document", {
    title: "",
    head: { nodeType: 1, ownerDocument: null, parentNode: null },
  });
  vi.stubGlobal("MutationObserver", vi.fn(FakeMutationObserver));
  vi.stubGlobal("window", {
    location: { search: "", href: "http://localhost/", pathname: "/", hash: "" },
    localStorage: createStorage(),
    history: { pushState: vi.fn(), replaceState: vi.fn() },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  return new PiWebUiApp();
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number { return values.size; },
    clear: () => { values.clear(); },
    getItem: (key: string) => (values.has(key) ? values.get(key) ?? null : null),
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function FakeMutationObserver(this: { observe: ReturnType<typeof vi.fn>; disconnect: () => void }) {
  this.observe = vi.fn();
  this.disconnect = () => undefined;
}
