import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  categoryBadgeLabel,
  categoryBadgeClass,
  truncateContent,
  renderEntryHtml,
  renderPanelState,
  memoryBadge,
  isMemoryPanelVisible,
} from "./memoryPanelElement.js";
import type { MemoryEntry } from "./memoryData.js";

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
    it("renders two initially collapsed scope groups with decorative disclosure chevrons, separated entries, and counts", () => {
      const html = renderPanelState({
        kind: "data",
        globalEntries: [{ id: "global", content: "Global-only memory" }],
        projectEntries: [
          { id: "project-one", content: "Project-only memory one" },
          { id: "project-two", content: "Project-only memory two" },
        ],
      });

      const groups = memoryGroups(html);
      const chevron = '<svg class="memory-group-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"></path></svg>';
      expect(groups).toHaveLength(2);
      expect(html).not.toContain('<details class="memory-group" open>');
      for (const group of groups) {
        expect(groupSummary(group).split(chevron)).toHaveLength(2);
      }

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

    it("keeps project entries visible beside a partial provider warning", () => {
      const state = {
        kind: "data" as const,
        globalEntries: [{ id: "global", content: "Global memory" }],
        projectEntries: [
          { id: "project-one", content: "Available project memory one" },
          { id: "project-two", content: "Available project memory two" },
        ],
        projectUnavailableMessage: "One provider could not read project memory.",
      };

      const projectGroup = groupWithTitle(memoryGroups(renderPanelState(state)), "Project-specific memory");
      expect(memoryBadge(state)).toBe(3);
      expect(projectGroup).toContain("2 entries");
      expect(projectGroup).toContain("Available project memory one");
      expect(projectGroup).toContain("Available project memory two");
      expect(projectGroup).toContain("One provider could not read project memory.");
      expect(projectGroup).not.toContain("Unavailable");
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

  describe("MemoryWorkspaceState type", () => {
    it("accepts loading state", () => {
      const s = { kind: "loading" as const };
      expect(s.kind).toBe("loading");
    });

    it("accepts unavailable state", () => {
      const s = { kind: "unavailable" as const };
      expect(s.kind).toBe("unavailable");
    });

    it("accepts scoped data state", () => {
      const s = {
        kind: "data" as const,
        globalEntries: [{ id: "global", content: "global" }],
        projectEntries: [{ id: "project", content: "project" }],
      };
      expect(s.kind).toBe("data");
      expect(s.globalEntries).toHaveLength(1);
      expect(s.projectEntries).toHaveLength(1);
    });

    it("accepts scoped project unavailability", () => {
      const s = {
        kind: "data" as const,
        globalEntries: [],
        projectEntries: [],
        projectUnavailableMessage: "Project-specific memory could not be loaded.",
      };
      expect(s.projectUnavailableMessage).toBe("Project-specific memory could not be loaded.");
    });

    it("accepts error state with message", () => {
      const s = { kind: "error" as const, message: "fail" };
      expect(s.kind).toBe("error");
      expect(s.message).toBe("fail");
    });
  });
});

function memoryGroups(html: string): string[] {
  return html.split('<details class="memory-group">').slice(1);
}

function groupWithTitle(groups: string[], title: string): string {
  const group = groups.find((candidate) => candidate.includes(title));
  if (group === undefined) throw new Error(`Memory group not found: ${title}`);
  return group;
}

function groupSummary(group: string): string {
  const summaryStart = group.indexOf("<summary>");
  const summaryEnd = group.indexOf("</summary>");
  if (summaryStart === -1 || summaryEnd === -1) throw new Error("Memory group summary not found");
  return group.slice(summaryStart, summaryEnd + "</summary>".length);
}

class FakeButton {
  private clickHandler: EventListenerOrEventListenerObject | undefined;

  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void {
    if (event === "click") this.clickHandler = handler;
  }

  click(): void {
    if (this.clickHandler === undefined) throw new Error("No click handler registered");
    // MouseEvent is unavailable in the Vitest Node environment; the
    // panel callback does not inspect the event, so a plain object suffices.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const event = { type: "click" } as unknown as MouseEvent;
    if (typeof this.clickHandler === "function") this.clickHandler(event);
    else this.clickHandler.handleEvent(event);
  }
}

class FakeShadowRoot {
  innerHTML = "";
  private readonly elements = new Map<string, FakeButton>();

  querySelector(selector: string): FakeButton | null {
    // Support attribute-only selectors like button[data-retry] by checking
    // that the tag and attribute name both appear in the rendered HTML.
    const parts = selector.split("[");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
    const tagName = parts[0];
    const attrPart = parts[1].replace("]", "");
    const attrName = (attrPart.includes("=") ? attrPart.split("=")[0] : attrPart) ?? "";
    if (!this.innerHTML.includes(`<${tagName}`) || !this.innerHTML.includes(attrName)) {
      this.elements.delete(selector);
      return null;
    }
    const existing = this.elements.get(selector);
    if (existing !== undefined) return existing;
    const button = new FakeButton();
    this.elements.set(selector, button);
    return button;
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
  memoryState: { kind: string; globalEntries?: { id: string; content: string }[]; projectEntries?: { id: string; content: string }[]; refreshError?: string; message?: string } | undefined;
  onRetry: (() => void) | undefined;
  readonly root: { innerHTML: string; querySelector(selector: string): { click(): void } | null };
  disconnectedCallback(): void;
}

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
  return "memoryState" in value
    && "onRetry" in value
    && "root" in value
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

describe("memoryBadge", () => {
  it("returns no tab count for loading, unavailable, error, or empty data", () => {
    expect(memoryBadge({ kind: "loading" })).toBeUndefined();
    expect(memoryBadge({ kind: "unavailable" })).toBeUndefined();
    expect(memoryBadge({ kind: "error", message: "offline" })).toBeUndefined();
    expect(memoryBadge({ kind: "data", globalEntries: [], projectEntries: [] })).toBeUndefined();
  });

  it("sums global and project entries for a positive tab count", () => {
    expect(memoryBadge({
      kind: "data",
      globalEntries: [{ id: "g", content: "global" }],
      projectEntries: [{ id: "p1", content: "one" }, { id: "p2", content: "two" }],
    })).toBe(3);
  });
});

describe("isMemoryPanelVisible", () => {
  it("hides only a confirmed unavailable provider", () => {
    expect(isMemoryPanelVisible({ kind: "unavailable" })).toBe(false);
    expect(isMemoryPanelVisible({ kind: "loading" })).toBe(true);
    expect(isMemoryPanelVisible({ kind: "data", globalEntries: [], projectEntries: [] })).toBe(true);
    expect(isMemoryPanelVisible({ kind: "error", message: "offline" })).toBe(true);
  });
});

describe("memory panel lifecycle", () => {
  let panel: MemoryPanelElementInstance;
  let retryCallback: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    installFakeCustomElements();
    vi.resetModules();
    retryCallback = vi.fn();
    panel = await createMemoryPanel();
  });

  afterEach(() => {
    restoreGlobalProperty("HTMLElement", originalHTMLElement);
    restoreGlobalProperty("customElements", originalCustomElements);
  });

  it("renders data when memoryState is set without invoking network mocks", () => {
    panel.memoryState = {
      kind: "data",
      globalEntries: [{ id: "g", content: "global" }],
      projectEntries: [{ id: "p", content: "project" }],
    };

    const html = panel.root.innerHTML;
    expect(html).toContain("Global memory");
    expect(html).toContain("Project-specific memory");
    expect(html).toContain("global");
    expect(html).toContain("project");
  });

  it("calls the supplied retry callback once when Retry button is clicked", () => {
    panel.onRetry = retryCallback;
    panel.memoryState = { kind: "error", message: "offline" };

    const button = panel.root.querySelector("button[data-retry]");
    if (button === null) throw new Error("Expected retry button to be present");
    button.click();

    expect(retryCallback).toHaveBeenCalledOnce();
  });

  it("renders unavailable as a no-workspace-compatible empty state", () => {
    panel.memoryState = { kind: "unavailable" };

    const html = panel.root.innerHTML;
    expect(html).toContain("Select a workspace.");
  });

  it("renders data with refreshError retaining scope groups and showing Retry", () => {
    panel.onRetry = retryCallback;
    panel.memoryState = {
      kind: "data",
      globalEntries: [{ id: "g", content: "global" }],
      projectEntries: [],
      refreshError: "Polling failed",
    };

    const html = panel.root.innerHTML;
    expect(html).toContain("Global memory");
    expect(html).toContain("global");
    expect(html).toContain("Polling failed");

    const button = panel.root.querySelector("button[data-retry]");
    if (button === null) throw new Error("Expected retry button to be present");
    button.click();

    expect(retryCallback).toHaveBeenCalledOnce();
  });
});
