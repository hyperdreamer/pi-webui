import { describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel onInput reporting", () => {
  it("invokes onInput exactly once after each successful input send and never for resize", () => {
    const panel = new TerminalPanel();
    const onInput = vi.fn();
    const socketSend = vi.fn();
    panel.onInput = onInput;
    Reflect.set(panel, "socket", { readyState: WebSocket.OPEN, send: socketSend });
    const send: unknown = Reflect.get(panel, "send");
    if (typeof send !== "function") throw new Error("Expected send");

    send.call(panel, { type: "input", data: "h" });
    send.call(panel, { type: "input", data: "i" });
    send.call(panel, { type: "resize", cols: 120, rows: 30 });

    expect(onInput).toHaveBeenCalledTimes(2);
    expect(socketSend).toHaveBeenCalledTimes(3);
  });

  it("does not report input for a disconnected socket", () => {
    const panel = new TerminalPanel();
    const onInput = vi.fn();
    const socketSend = vi.fn();
    panel.onInput = onInput;
    Reflect.set(panel, "socket", { readyState: WebSocket.CONNECTING, send: socketSend });
    const send: unknown = Reflect.get(panel, "send");
    if (typeof send !== "function") throw new Error("Expected send");

    send.call(panel, { type: "input", data: "ignored" });

    expect(socketSend).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });

  it("does not report input when the socket send throws", () => {
    const panel = new TerminalPanel();
    const onInput = vi.fn();
    const failure = new Error("socket closed during send");
    panel.onInput = onInput;
    Reflect.set(panel, "socket", { readyState: WebSocket.OPEN, send: () => { throw failure; } });
    const send: unknown = Reflect.get(panel, "send");
    if (typeof send !== "function") throw new Error("Expected send");

    expect(() => { send.call(panel, { type: "input", data: "lost" }); }).toThrow(failure);
    expect(onInput).not.toHaveBeenCalled();
  });
});
