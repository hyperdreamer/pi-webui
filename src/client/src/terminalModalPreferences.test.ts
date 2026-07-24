import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_MODAL_PREFERENCES,
  TERMINAL_MODAL_PREFERENCES_STORAGE_KEY,
  readTerminalModalPreferences,
  writeTerminalModalPreferences,
} from "./terminalModalPreferences";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("terminal modal preferences", () => {
  it("restores a saved font size and opacity", () => {
    const storage = new MemoryStorage();
    storage.setItem(TERMINAL_MODAL_PREFERENCES_STORAGE_KEY, JSON.stringify({ fontSize: 19, opacity: 45 }));

    expect(readTerminalModalPreferences(storage)).toEqual({ fontSize: 19, opacity: 45 });
  });

  it("uses defaults for missing or malformed saved preferences", () => {
    const storage = new MemoryStorage();
    expect(readTerminalModalPreferences(storage)).toEqual(DEFAULT_TERMINAL_MODAL_PREFERENCES);

    storage.setItem(TERMINAL_MODAL_PREFERENCES_STORAGE_KEY, "not-json");
    expect(readTerminalModalPreferences(storage)).toEqual(DEFAULT_TERMINAL_MODAL_PREFERENCES);
  });

  it("writes restored values within the supported ranges", () => {
    const storage = new MemoryStorage();

    writeTerminalModalPreferences({ fontSize: 99, opacity: -10 }, storage);

    expect(readTerminalModalPreferences(storage)).toEqual({ fontSize: 28, opacity: 20 });
  });
});
