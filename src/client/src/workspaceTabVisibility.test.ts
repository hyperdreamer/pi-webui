import { afterEach, describe, expect, it, vi } from "vitest";
import { INFO_TAB_HIDDEN_STORAGE_KEY, readWorkspaceTabVisibility, TERMINAL_TAB_HIDDEN_STORAGE_KEY, writeWorkspaceTabVisibility, type WorkspaceTabVisibilityStorage } from "./workspaceTabVisibility";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspaceTabVisibility", () => {
  it("defaults both tabs to visible when no preference is stored", () => {
    expect(readWorkspaceTabVisibility(createStorage())).toEqual({ terminalHidden: false, infoHidden: false });
  });

  it("reads and writes hidden tab preferences", () => {
    const storage = createStorage();

    writeWorkspaceTabVisibility({ terminalHidden: true, infoHidden: true }, storage);

    expect(storage.getItem(TERMINAL_TAB_HIDDEN_STORAGE_KEY)).toBe("true");
    expect(storage.getItem(INFO_TAB_HIDDEN_STORAGE_KEY)).toBe("true");
    expect(readWorkspaceTabVisibility(storage)).toEqual({ terminalHidden: true, infoHidden: true });
  });

  it("removes stored preferences when both tabs are visible", () => {
    const storage = createStorage();
    writeWorkspaceTabVisibility({ terminalHidden: true, infoHidden: true }, storage);

    writeWorkspaceTabVisibility({ terminalHidden: false, infoHidden: false }, storage);

    expect(storage.getItem(TERMINAL_TAB_HIDDEN_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(INFO_TAB_HIDDEN_STORAGE_KEY)).toBeNull();
    expect(readWorkspaceTabVisibility(storage)).toEqual({ terminalHidden: false, infoHidden: false });
  });

  it("falls back to visible tabs when storage is unavailable or fails", () => {
    expect(readWorkspaceTabVisibility(undefined)).toEqual({ terminalHidden: false, infoHidden: false });
    expect(() => {
      writeWorkspaceTabVisibility({ terminalHidden: true, infoHidden: true }, undefined);
    }).not.toThrow();

    const failingStorage: WorkspaceTabVisibilityStorage = {
      getItem: () => { throw new Error("read failed"); },
      setItem: () => { throw new Error("write failed"); },
      removeItem: () => { throw new Error("remove failed"); },
    };
    expect(readWorkspaceTabVisibility(failingStorage)).toEqual({ terminalHidden: false, infoHidden: false });
    expect(() => {
      writeWorkspaceTabVisibility({ terminalHidden: true, infoHidden: true }, failingStorage);
    }).not.toThrow();
  });
});

function createStorage(): WorkspaceTabVisibilityStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
