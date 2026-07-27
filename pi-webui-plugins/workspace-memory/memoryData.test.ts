import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "./memoryData.js";

describe("memory data types", () => {
  it("accepts a minimal MemoryEntry with only id and content", () => {
    const entry: MemoryEntry = { id: "abc123", content: "Hello world." };
    expect(entry.id).toBe("abc123");
    expect(entry.content).toBe("Hello world.");
  });

  it("accepts a MemoryEntry with all optional fields", () => {
    const entry: MemoryEntry = {
      id: "def456",
      content: "Remember X.",
      category: "insight",
      created: "2025-01-15",
      last: "2025-02-20",
      failureReason: "timeout",
    };
    expect(entry.category).toBe("insight");
    expect(entry.created).toBe("2025-01-15");
    expect(entry.last).toBe("2025-02-20");
    expect(entry.failureReason).toBe("timeout");
  });
});
