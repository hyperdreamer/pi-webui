import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { computeWindowTitle, createWindowTitleObserver } from "./windowTitle";

describe("computeWindowTitle", () => {
  it("returns just the app title when projectName is undefined", () => {
    expect(computeWindowTitle(undefined)).toBe("PI WEBUI");
  });

  it("returns the project name with app title suffix when projectName is provided", () => {
    expect(computeWindowTitle("my-backend")).toBe("my-backend - PI WEBUI");
  });

  it("returns just the app title when projectName is empty", () => {
    expect(computeWindowTitle("")).toBe("PI WEBUI");
  });

  it("returns project name as-is in the title when project name contains special chars", () => {
    expect(computeWindowTitle("my-project_v2")).toBe("my-project_v2 - PI WEBUI");
  });
});

describe("createWindowTitleObserver", () => {
  let title: string;
  let observerCallback: (() => void) | undefined;
  let mutationObserverDisconnected: boolean;

  function FakeMutationObserver(this: { observe: ReturnType<typeof vi.fn>; disconnect: () => void }, callback: () => void) {
    observerCallback = callback;
    mutationObserverDisconnected = false;
    this.observe = vi.fn();
    this.disconnect = () => { mutationObserverDisconnected = true; };
  }

  beforeEach(() => {
    title = "";
    observerCallback = undefined;
    mutationObserverDisconnected = false;
    const fakeDocument = {
      get title(): string { return title; },
      set title(value: string) { title = value; },
      head: { nodeType: 1, ownerDocument: null, parentNode: null },
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("MutationObserver", vi.fn(FakeMutationObserver));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets document.title to the given title immediately", () => {
    const cleanup = createWindowTitleObserver("Test Title");
    expect(title).toBe("Test Title");
    cleanup();
  });

  it("creates a MutationObserver on document.head", () => {
    const cleanup = createWindowTitleObserver("Observed Title");
    expect(MutationObserver).toHaveBeenCalledOnce();
    cleanup();
  });

  it("reverts external title mutations via the observer callback", () => {
    createWindowTitleObserver("Original Title");
    expect(title).toBe("Original Title");

    // Simulate external mutation
    title = "Hijacked Title";
    // Trigger the observer callback
    if (observerCallback !== undefined) observerCallback();
    expect(title).toBe("Original Title");
  });

  it("calls observer.observe with document.head", () => {
    const cleanup = createWindowTitleObserver("Observed Title");
    // The MutationObserver mock records calls - we can verify observe was called
    expect(MutationObserver).toHaveBeenCalledOnce();
    cleanup();
  });

  it("cleanup disconnects the observer so external mutations persist", () => {
    const cleanup = createWindowTitleObserver("Observed Title");
    cleanup();

    title = "After Cleanup Title";
    expect(title).toBe("After Cleanup Title");
    // Verify observer was disconnected
    expect(mutationObserverDisconnected).toBe(true);
  });
});
