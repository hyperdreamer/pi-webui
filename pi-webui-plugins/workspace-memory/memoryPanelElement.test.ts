import { describe, expect, it } from "vitest";
import {
  categoryBadgeLabel,
  categoryBadgeClass,
  truncateContent,
  renderEntryHtml,
  renderPanelState,
  type MemoryPanelState,
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
