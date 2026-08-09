import { describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel onInput reporting", () => {
  it("invokes onInput exactly once per input send and never for resize", () => {
    const panel = new TerminalPanel();
    const onInput = vi.fn();
    panel.onInput = onInput;
    const send: unknown = Reflect.get(panel, "send");
    if (typeof send !== "function") throw new Error("Expected send");

    send.call(panel, { type: "input", data: "h" });
    send.call(panel, { type: "input", data: "i" });
    send.call(panel, { type: "resize", cols: 120, rows: 30 });

    expect(onInput).toHaveBeenCalledTimes(2);
  });
});
