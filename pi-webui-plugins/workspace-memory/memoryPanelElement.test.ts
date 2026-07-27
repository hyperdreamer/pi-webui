import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  categoryBadgeLabel,
  categoryBadgeClass,
  truncateContent,
  renderEntryHtml,
  renderPanelState,
  type MemoryPanelState,
} from "./memoryPanelElement.js";
import type { MemoryEntry } from "./memoryData.js";
import type { WorkspacePanelContext } from "@hyperdreamer/pi-webui/plugin-api";

describe("memory panel element", () => {
  describe("category badge", () => {
    it("returns uncategorized for undefined category", () => {
      expect(categoryBadgeLabel(undefined)).toBe("uncategorized");
    });

    it("returns the category string when defined", () => {
      expect(categoryBadgeLabel("insight")).toBe("insight");
    });

    it("maps known categories to color classes", () => {
      expect(categoryBadgeClass("tool-quirk")).toBe("cat-amber");
      expect(categoryBadgeClass("insight")).toBe("cat-blue");
      expect(categoryBadgeClass("correction")).toBe("cat-green");
      expect(categoryBadgeClass("failure")).toBe("cat-red");
      expect(categoryBadgeClass("preference")).toBe("cat-purple");
      expect(categoryBadgeClass("convention")).toBe("cat-teal");
    });

    it("returns gray for unknown or missing category", () => {
      expect(categoryBadgeClass(undefined)).toBe("cat-gray");
      expect(categoryBadgeClass("unknown-type")).toBe("cat-gray");
    });
  });

  describe("truncateContent", () => {
    it("returns short content unchanged", () => {
      expect(truncateContent("Hello")).toBe("Hello");
    });

    it("truncates long content with ellipsis at ~120 chars", () => {
      const long = "A".repeat(300);
      const result = truncateContent(long);
      expect(result).toHaveLength(121); // 120 chars + …
      expect(result.endsWith("…")).toBe(true);
    });

    it("returns exactly-120-char content unchanged", () => {
      const exactly = "B".repeat(120);
      const result = truncateContent(exactly);
      expect(result).toBe(exactly);
      expect(result.endsWith("…")).toBe(false);
    });
  });

  describe("renderEntryHtml", () => {
    it("includes category badge in summary", () => {
      const entry: MemoryEntry = { id: "1", content: "Test.", category: "insight" };
      const html = renderEntryHtml(entry);
      expect(html).toContain("cat-badge");
      expect(html).toContain("cat-blue");
      expect(html).toContain("insight");
    });

    it("includes truncated content in summary", () => {
      const long = "X".repeat(200);
      const entry: MemoryEntry = { id: "2", content: long };
      const html = renderEntryHtml(entry);
      expect(html).toContain("X".repeat(120) + "…");
      expect(html).toContain("entry-summary");
    });

    it("includes full content in body pre", () => {
      const entry: MemoryEntry = { id: "3", content: "Full body text & <tags>" };
      const html = renderEntryHtml(entry);
      expect(html).toContain("&lt;tags&gt;");
      expect(html).toContain("<pre>");
    });

    it("renders created date when present", () => {
      const entry: MemoryEntry = { id: "4", content: "x", created: "2025-01-15" };
      const html = renderEntryHtml(entry);
      expect(html).toContain("2025-01-15");
      expect(html).toContain("Created:");
    });

    it("renders last-modified date when present", () => {
      const entry: MemoryEntry = { id: "5", content: "x", last: "2025-03-01" };
      const html = renderEntryHtml(entry);
      expect(html).toContain("2025-03-01");
      expect(html).toContain("Last modified:");
    });

    it("renders both dates when present", () => {
      const entry: MemoryEntry = { id: "6", content: "x", created: "2025-01-10", last: "2025-02-20" };
      const html = renderEntryHtml(entry);
      expect(html).toContain("2025-01-10");
      expect(html).toContain("2025-02-20");
    });

    it("renders no dates section when neither is present", () => {
      const entry: MemoryEntry = { id: "7", content: "x" };
      const html = renderEntryHtml(entry);
      expect(html).not.toContain("entry-dates");
    });

    it("escapes HTML in content", () => {
      const entry: MemoryEntry = { id: "8", content: "<script>alert('xss')</script>" };
      const html = renderEntryHtml(entry);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("renderPanelState", () => {
    it("renders exactly two initially open scope groups with separated entries and counts", () => {
      const html = renderPanelState({
        kind: "data",
        globalEntries: [{ id: "global", content: "Global-only memory" }],
        projectEntries: [
          { id: "project-one", content: "Project-only memory one" },
          { id: "project-two", content: "Project-only memory two" },
        ],
      });

      const groups = memoryGroups(html);
      expect(groups).toHaveLength(2);

      const globalGroup = groupWithTitle(groups, "Global memory");
      expect(globalGroup).toContain("1 entry");
      expect(globalGroup).toContain("Global-only memory");
      expect(globalGroup).not.toContain("Project-only memory one");

      const projectGroup = groupWithTitle(groups, "Project-specific memory");
      expect(projectGroup).toContain("2 entries");
      expect(projectGroup).toContain("Project-only memory one");
      expect(projectGroup).toContain("Project-only memory two");
      expect(projectGroup).not.toContain("Global-only memory");
    });

    it("renders scoped empty states and zero counts when both successful groups are empty", () => {
      const html = renderPanelState({ kind: "data", globalEntries: [], projectEntries: [] });

      const groups = memoryGroups(html);
      expect(groups).toHaveLength(2);
      expect(groupWithTitle(groups, "Global memory")).toContain("0 entries");
      expect(groupWithTitle(groups, "Global memory")).toContain("No global memories found.");
      expect(groupWithTitle(groups, "Project-specific memory")).toContain("0 entries");
      expect(groupWithTitle(groups, "Project-specific memory")).toContain("No project-specific memories found.");
    });

    it("keeps a populated group visible when the other successful group is empty", () => {
      const html = renderPanelState({
        kind: "data",
        globalEntries: [{ id: "global", content: "Global memory remains visible" }],
        projectEntries: [],
      });

      expect(groupWithTitle(memoryGroups(html), "Global memory")).toContain("Global memory remains visible");
      expect(groupWithTitle(memoryGroups(html), "Project-specific memory")).toContain("No project-specific memories found.");
    });

    it("shows project unavailability without hiding global entries or claiming zero project entries", () => {
      const html = renderPanelState({
        kind: "data",
        globalEntries: [{ id: "global", content: "Global memory remains visible" }],
        projectEntries: [],
        projectUnavailableMessage: "Project-specific memory could not be loaded.",
      });

      expect(groupWithTitle(memoryGroups(html), "Global memory")).toContain("Global memory remains visible");
      const projectGroup = groupWithTitle(memoryGroups(html), "Project-specific memory");
      expect(projectGroup).toContain("Unavailable");
      expect(projectGroup).not.toContain("0 entries");
      expect(projectGroup).toContain("Project-specific memory could not be loaded.");
    });

    it("keeps nested entry details, category badges, escaped content, and dates inside their scope", () => {
      const html = renderPanelState({
        kind: "data",
        globalEntries: [{
          id: "global",
          content: "Global <memory>",
          category: "insight",
          created: "2025-01-15",
          last: "2025-03-01",
        }],
        projectEntries: [],
      });

      const globalGroup = groupWithTitle(memoryGroups(html), "Global memory");
      expect(globalGroup).toContain('<details class="memory-entry">');
      expect(globalGroup).toContain("cat-badge");
      expect(globalGroup).toContain("cat-blue");
      expect(globalGroup).toContain("&lt;memory&gt;");
      expect(globalGroup).toContain("Created:");
      expect(globalGroup).toContain("Last modified:");
    });
  });

  describe("MemoryPanelState type", () => {
    it("accepts no-workspace state", () => {
      const s: MemoryPanelState = { kind: "no-workspace" };
      expect(s.kind).toBe("no-workspace");
    });

    it("accepts loading state", () => {
      const s: MemoryPanelState = { kind: "loading" };
      expect(s.kind).toBe("loading");
    });

    it("accepts scoped data state", () => {
      const s: MemoryPanelState = {
        kind: "data",
        globalEntries: [{ id: "global", content: "global" }],
        projectEntries: [{ id: "project", content: "project" }],
      };
      expect(s.kind).toBe("data");
      expect(s.globalEntries).toHaveLength(1);
      expect(s.projectEntries).toHaveLength(1);
    });

    it("accepts scoped project unavailability", () => {
      const s: MemoryPanelState = {
        kind: "data",
        globalEntries: [],
        projectEntries: [],
        projectUnavailableMessage: "Project-specific memory could not be loaded.",
      };
      expect(s.projectUnavailableMessage).toBe("Project-specific memory could not be loaded.");
    });

    it("accepts error state with message", () => {
      const s: MemoryPanelState = { kind: "error", message: "fail" };
      expect(s.kind).toBe("error");
      expect(s.message).toBe("fail");
    });
  });
});

function memoryGroups(html: string): string[] {
  return html.split('<details class="memory-group" open>').slice(1);
}

function groupWithTitle(groups: string[], title: string): string {
  const group = groups.find((candidate) => candidate.includes(title));
  if (group === undefined) throw new Error(`Memory group not found: ${title}`);
  return group;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
  };
}

class FakeShadowRoot {
  innerHTML = "";

  querySelector(): null {
    return null;
  }
}

class FakeHTMLElement {
  readonly isConnected = true;

  attachShadow(): FakeShadowRoot {
    return new FakeShadowRoot();
  }
}

class FakeCustomElementRegistry {
  private readonly definitions = new Map<string, CustomElementConstructor>();

  define(name: string, constructor: CustomElementConstructor): void {
    this.definitions.set(name, constructor);
  }

  get(name: string): CustomElementConstructor | undefined {
    return this.definitions.get(name);
  }
}

interface MemoryPanelElementInstance extends HTMLElement {
  context: WorkspacePanelContext | undefined;
  disconnectedCallback(): void;
}

const lifecycleFetchers = {
  fetchGlobalMemories: vi.fn<() => Promise<MemoryEntry[]>>(),
  fetchProjectMemories: vi.fn<(projectPath: string) => Promise<MemoryEntry[]>>(),
};
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const originalCustomElements = Object.getOwnPropertyDescriptor(globalThis, "customElements");

function installFakeCustomElements(): void {
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    value: new FakeCustomElementRegistry(),
  });
}

function restoreGlobalProperty(name: "HTMLElement" | "customElements", descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, descriptor);
}

function isMemoryPanelElementInstance(value: HTMLElement): value is MemoryPanelElementInstance {
  return "context" in value
    && "disconnectedCallback" in value
    && typeof value.disconnectedCallback === "function";
}

async function createMemoryPanel(): Promise<MemoryPanelElementInstance> {
  const { defineMemoryPanelElement, memoryPanelTagName } = await import("./memoryPanelElement.js");
  defineMemoryPanelElement();
  const constructor = customElements.get(memoryPanelTagName);
  if (constructor === undefined) throw new Error("Memory panel element was not registered");
  const panel = new constructor();
  if (!isMemoryPanelElementInstance(panel)) throw new Error("Memory panel element has no lifecycle interface");
  return panel;
}

// The panel only consumes these fields; the complete plugin context is irrelevant to this lifecycle harness.
/* eslint-disable @typescript-eslint/consistent-type-assertions -- test-only partial WorkspacePanelContext */
function contextFor(
  host: WorkspacePanelContext["host"],
  identity: { machineId?: string; projectId?: string; workspaceId?: string; path?: string } = {},
): WorkspacePanelContext {
  return {
    machine: { id: identity.machineId ?? "machine-1" },
    workspace: {
      projectId: identity.projectId ?? "project-1",
      id: identity.workspaceId ?? "workspace-1",
      path: identity.path ?? "/projects/one",
    },
    host,
  } as unknown as WorkspacePanelContext;
}
/* eslint-enable @typescript-eslint/consistent-type-assertions */

async function settleMemoryLoad(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe("memory panel lifecycle", () => {
  beforeEach(() => {
    lifecycleFetchers.fetchGlobalMemories.mockReset();
    lifecycleFetchers.fetchProjectMemories.mockReset();
    installFakeCustomElements();
    vi.resetModules();
    vi.doMock("./memoryClient.js", () => lifecycleFetchers);
  });

  afterEach(() => {
    vi.doUnmock("./memoryClient.js");
    restoreGlobalProperty("HTMLElement", originalHTMLElement);
    restoreGlobalProperty("customElements", originalCustomElements);
  });

  it("does not restart a successful load when requestRender supplies a fresh same-workspace context", async () => {
    lifecycleFetchers.fetchGlobalMemories.mockResolvedValue([{ id: "global", content: "Global memory" }]);
    lifecycleFetchers.fetchProjectMemories.mockResolvedValue([{ id: "project", content: "Project memory" }]);
    const panel = await createMemoryPanel();
    const replacementHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };
    const replacement = contextFor(replacementHost);
    const initialHost = {
      requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>(() => {
        panel.context = replacement;
      }),
    };

    panel.context = contextFor(initialHost);
    await settleMemoryLoad();

    expect(initialHost.requestRender).toHaveBeenCalledOnce();
    expect(lifecycleFetchers.fetchGlobalMemories).toHaveBeenCalledOnce();
    expect(lifecycleFetchers.fetchProjectMemories).toHaveBeenCalledOnce();
  });

  it("does not restart a global-error load when requestRender supplies a fresh same-workspace context", async () => {
    lifecycleFetchers.fetchGlobalMemories.mockRejectedValue(new Error("Global route unavailable"));
    lifecycleFetchers.fetchProjectMemories.mockResolvedValue([]);
    const panel = await createMemoryPanel();
    const replacementHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };
    const replacement = contextFor(replacementHost);
    const initialHost = {
      requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>(() => {
        panel.context = replacement;
      }),
    };

    panel.context = contextFor(initialHost);
    await settleMemoryLoad();

    expect(initialHost.requestRender).toHaveBeenCalledOnce();
    expect(lifecycleFetchers.fetchGlobalMemories).toHaveBeenCalledOnce();
    expect(lifecycleFetchers.fetchProjectMemories).toHaveBeenCalledOnce();
  });

  it("accepts an in-flight result after a fresh context wrapper preserves the workspace identity and path", async () => {
    const global = deferred<MemoryEntry[]>();
    const project = deferred<MemoryEntry[]>();
    lifecycleFetchers.fetchGlobalMemories.mockReturnValue(global.promise);
    lifecycleFetchers.fetchProjectMemories.mockReturnValue(project.promise);
    const panel = await createMemoryPanel();
    const initialHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };
    const replacementHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };
    const initial = contextFor(initialHost);
    const replacement = contextFor(replacementHost);

    panel.context = initial;
    panel.context = replacement;
    global.resolve([]);
    project.resolve([]);
    await settleMemoryLoad();

    expect(lifecycleFetchers.fetchGlobalMemories).toHaveBeenCalledOnce();
    expect(lifecycleFetchers.fetchProjectMemories).toHaveBeenCalledOnce();
    expect(initialHost.requestRender).toHaveBeenCalledOnce();
    expect(replacementHost.requestRender).not.toHaveBeenCalled();
  });

  it("suppresses a stale result when the semantic workspace changes", async () => {
    const globalA = deferred<MemoryEntry[]>();
    const projectA = deferred<MemoryEntry[]>();
    const globalB = deferred<MemoryEntry[]>();
    const projectB = deferred<MemoryEntry[]>();
    lifecycleFetchers.fetchGlobalMemories
      .mockReturnValueOnce(globalA.promise)
      .mockReturnValueOnce(globalB.promise);
    lifecycleFetchers.fetchProjectMemories
      .mockReturnValueOnce(projectA.promise)
      .mockReturnValueOnce(projectB.promise);
    const panel = await createMemoryPanel();
    const hostA = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };
    const hostB = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };

    panel.context = contextFor(hostA);
    panel.context = contextFor(hostB, { workspaceId: "workspace-2", path: "/projects/two" });
    globalA.resolve([]);
    projectA.resolve([]);
    await settleMemoryLoad();
    expect(hostA.requestRender).not.toHaveBeenCalled();

    globalB.resolve([]);
    projectB.resolve([]);
    await settleMemoryLoad();
    expect(hostB.requestRender).toHaveBeenCalledOnce();
  });

  it("suppresses a stale result after context removal or disconnect", async () => {
    const removedGlobal = deferred<MemoryEntry[]>();
    const removedProject = deferred<MemoryEntry[]>();
    lifecycleFetchers.fetchGlobalMemories.mockReturnValueOnce(removedGlobal.promise);
    lifecycleFetchers.fetchProjectMemories.mockReturnValueOnce(removedProject.promise);
    const removedPanel = await createMemoryPanel();
    const removedHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };

    removedPanel.context = contextFor(removedHost);
    removedPanel.context = undefined;
    removedGlobal.resolve([]);
    removedProject.resolve([]);
    await settleMemoryLoad();
    expect(removedHost.requestRender).not.toHaveBeenCalled();

    const disconnectedGlobal = deferred<MemoryEntry[]>();
    const disconnectedProject = deferred<MemoryEntry[]>();
    lifecycleFetchers.fetchGlobalMemories.mockReturnValueOnce(disconnectedGlobal.promise);
    lifecycleFetchers.fetchProjectMemories.mockReturnValueOnce(disconnectedProject.promise);
    const disconnectedPanel = await createMemoryPanel();
    const disconnectedHost = { requestRender: vi.fn<WorkspacePanelContext["host"]["requestRender"]>() };

    disconnectedPanel.context = contextFor(disconnectedHost);
    disconnectedPanel.disconnectedCallback();
    disconnectedGlobal.resolve([]);
    disconnectedProject.resolve([]);
    await settleMemoryLoad();
    expect(disconnectedHost.requestRender).not.toHaveBeenCalled();
  });
});
