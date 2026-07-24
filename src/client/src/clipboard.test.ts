import { describe, expect, it, vi } from "vitest";
import { writeClipboardText } from "./clipboard";

describe("writeClipboardText", () => {
  it("uses the synchronous fallback directly in insecure contexts", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const fallbackWriteText = vi.fn(() => true);

    const copied = await writeClipboardText("hello", { isSecureContext: false, writeText, fallbackWriteText });

    expect(copied).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(fallbackWriteText).toHaveBeenCalledWith("hello");
  });

  it("uses the async Clipboard API in secure contexts", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const fallbackWriteText = vi.fn(() => true);

    const copied = await writeClipboardText("hello", { isSecureContext: true, writeText, fallbackWriteText });

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(fallbackWriteText).not.toHaveBeenCalled();
  });

  it("falls back when the async Clipboard API is unavailable", async () => {
    const fallbackWriteText = vi.fn(() => true);

    const copied = await writeClipboardText("hello", { isSecureContext: true, fallbackWriteText });

    expect(copied).toBe(true);
    expect(fallbackWriteText).toHaveBeenCalledWith("hello");
  });

  it("falls back when the async Clipboard API rejects", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    const fallbackWriteText = vi.fn(() => true);

    const copied = await writeClipboardText("hello", { isSecureContext: true, writeText, fallbackWriteText });

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(fallbackWriteText).toHaveBeenCalledWith("hello");
  });
});
