import { describe, expect, it } from "vitest";
import {
  categoryBadgeLabel,
  categoryBadgeClass,
  truncateContent,
  renderEntryHtml,
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

  describe("MemoryPanelState type", () => {
    it("accepts no-workspace state", () => {
      const s: MemoryPanelState = { kind: "no-workspace" };
      expect(s.kind).toBe("no-workspace");
    });

    it("accepts loading state", () => {
      const s: MemoryPanelState = { kind: "loading" };
      expect(s.kind).toBe("loading");
    });

    it("accepts empty state", () => {
      const s: MemoryPanelState = { kind: "empty" };
      expect(s.kind).toBe("empty");
    });

    it("accepts data state with entries", () => {
      const s: MemoryPanelState = { kind: "data", entries: [{ id: "x", content: "hi" }] };
      expect(s.kind).toBe("data");
      expect(s.entries).toHaveLength(1);
    });

    it("accepts error state with message", () => {
      const s: MemoryPanelState = { kind: "error", message: "fail" };
      expect(s.kind).toBe("error");
      expect(s.message).toBe("fail");
    });
  });
});
