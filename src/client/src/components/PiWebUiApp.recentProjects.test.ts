import { afterEach, describe, expect, it, vi } from "vitest";
import { PiWebUiApp } from "./PiWebUiApp";
import type { ResolvedWorkspacePanelTab } from "./WorkspacePanel";

afterEach(() => {
  vi.unstubAllGlobals();
});

function resolvedTabs(app: PiWebUiApp): ResolvedWorkspacePanelTab[] {
  const resolve: unknown = Reflect.get(app, "resolvedWorkspacePanelTabs");
  if (typeof resolve !== "function") throw new Error("Expected resolvedWorkspacePanelTabs");
  const tabs: unknown = resolve.call(app);
  if (!Array.isArray(tabs) || !tabs.every(isResolvedWorkspacePanelTab)) {
    throw new Error("Expected an array of resolved tabs");
  }
  return tabs;
}

function isResolvedWorkspacePanelTab(value: unknown): value is ResolvedWorkspacePanelTab {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "id") === "string"
    && typeof Reflect.get(value, "title") === "string"
    && typeof Reflect.get(value, "render") === "function";
}

describe("PiWebUiApp recent projects tab", () => {
  it("offers Recent Projects first when no workspace is selected", () => {
    const app = createApp();

    const tabs = resolvedTabs(app);

    expect(tabs[0]?.id).toBe("core:recent-projects");
    expect(tabs[0]?.title).toBe("Recent Projects");
    expect(tabs.every((tab) => tab.id === "core:recent-projects")).toBe(true);
  });

  it("renders the Recent Projects body without a workspace context", () => {
    const app = createApp();

    expect(() => resolvedTabs(app)[0]?.render()).not.toThrow();
  });
});

function createApp(): PiWebUiApp {
  vi.stubGlobal("localStorage", createStorage());
  vi.stubGlobal("window", { location: { search: "" }, localStorage: createStorage() });
  return new PiWebUiApp();
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}
