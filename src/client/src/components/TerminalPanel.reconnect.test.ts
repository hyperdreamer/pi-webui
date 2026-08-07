import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalSocket, type TerminalInfo } from "../api";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, terminalSocket: vi.fn() };
});

const terminalSocketMock = vi.mocked(terminalSocket);

describe("TerminalPanel terminal socket reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    vi.stubGlobal("window", {
      setTimeout: vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs)),
      clearTimeout: vi.fn((handle: number | undefined) => {
        clearTimeout(handle);
      }),
    });
    terminalSocketMock.mockReset();
  });

  afterEach(() => {
    terminalSocketMock.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects after an unexpected close with a 500 ms initial delay, ×1.6 backoff, capped at 5 s", () => {
    // One socket per factory call: the initial connect plus one per reconnect.
    const sockets = Array.from({ length: 7 }, () => new FakeTerminalSocket());
    for (const socket of sockets) terminalSocketMock.mockReturnValueOnce(asWebSocket(socket));
    const panel = new TerminalPanel();

    connectSocket(panel, fakeTerminal());
    // 500 × 1.6 → 800 → 1280 → 2048 → 3276.8 → capped at 5000.
    const expectedDelays = [500, 800, 1280, 2048, 3276.8, 5000];
    const reconnectSteps = sockets.slice(0, expectedDelays.length).map((socket, index) => {
      const delay = expectedDelays[index];
      if (delay === undefined) throw new Error("Missing expected reconnect delay fixture");
      return { socket, delay };
    });
    for (const [stepIndex, step] of reconnectSteps.entries()) {
      step.socket.emit("close");
      expect(terminalSocketMock).toHaveBeenCalledTimes(stepIndex + 1);
      vi.advanceTimersByTime(Math.floor(step.delay) - 1);
      expect(terminalSocketMock).toHaveBeenCalledTimes(stepIndex + 1);
      vi.advanceTimersByTime(1);
      expect(terminalSocketMock).toHaveBeenCalledTimes(stepIndex + 2);
    }
    expect(terminalSocketMock).toHaveBeenLastCalledWith("project-1", "workspace-1", "terminal-1", undefined, "local");
  });

  it("resets the reconnect delay to 500 ms after a successful open", () => {
    const firstSocket = new FakeTerminalSocket();
    const secondSocket = new FakeTerminalSocket();
    const thirdSocket = new FakeTerminalSocket();
    terminalSocketMock
      .mockReturnValueOnce(asWebSocket(firstSocket))
      .mockReturnValueOnce(asWebSocket(secondSocket))
      .mockReturnValueOnce(asWebSocket(thirdSocket));
    const panel = new TerminalPanel();

    connectSocket(panel, fakeTerminal());
    firstSocket.emit("close");
    vi.advanceTimersByTime(500);
    expect(terminalSocketMock).toHaveBeenCalledTimes(2);

    secondSocket.emit("open");
    secondSocket.emit("close");
    // Without the reset the delay would have backed off to 800 ms.
    vi.advanceTimersByTime(499);
    expect(terminalSocketMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(terminalSocketMock).toHaveBeenCalledTimes(3);
  });

  it("does not reconnect after the terminal view is disposed", () => {
    const socket = new FakeTerminalSocket();
    terminalSocketMock.mockReturnValueOnce(asWebSocket(socket));
    const panel = new TerminalPanel();

    connectSocket(panel, fakeTerminal());
    socket.emit("close");
    disposeTerminalView(panel);
    socket.emit("close");
    vi.advanceTimersByTime(5000);

    expect(terminalSocketMock).toHaveBeenCalledOnce();
  });

  it("does not reconnect when disposal closes the live socket", () => {
    const socket = new FakeTerminalSocket();
    terminalSocketMock.mockReturnValueOnce(asWebSocket(socket));
    const panel = new TerminalPanel();

    connectSocket(panel, fakeTerminal());
    // The fake close() dispatches "close" synchronously. Deliberate disposal must
    // clear the socket reference before invoking close(), or the close handler's
    // identity guard would pass and schedule a reconnect for the disposed view.
    disposeTerminalView(panel);
    vi.advanceTimersByTime(5000);

    expect(terminalSocketMock).toHaveBeenCalledOnce();
  });

  it("does not reconnect after the terminal sends an exit message", async () => {
    const socket = new FakeTerminalSocket();
    terminalSocketMock.mockReturnValueOnce(asWebSocket(socket));
    const panel = new TerminalPanel();
    const terminal = fakeTerminal();
    Reflect.set(panel, "terminals", [terminalInfo("terminal-1")]);

    connectSocket(panel, terminal);
    socket.emit("message", { data: JSON.stringify({ type: "exit", exitCode: 0 }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(terminal.writeln).toHaveBeenCalledWith("\r\n[process exited with code 0]");
    socket.emit("close");
    vi.advanceTimersByTime(5000);

    expect(terminalSocketMock).toHaveBeenCalledOnce();
  });

  it("resets the terminal before applying replay after a reconnect", async () => {
    const firstSocket = new FakeTerminalSocket();
    const secondSocket = new FakeTerminalSocket();
    terminalSocketMock
      .mockReturnValueOnce(asWebSocket(firstSocket))
      .mockReturnValueOnce(asWebSocket(secondSocket));
    const panel = new TerminalPanel();
    const events: string[] = [];
    const terminal = fakeTerminal(events);

    connectSocket(panel, terminal);
    firstSocket.emit("message", {
      data: JSON.stringify({ type: "output", data: "live", replay: false }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["write:live"]);

    firstSocket.emit("close");
    vi.advanceTimersByTime(500);
    expect(terminalSocketMock).toHaveBeenCalledTimes(2);

    secondSocket.emit("message", {
      data: JSON.stringify({ type: "output", data: "snapshot", replay: true }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(["write:live", "reset", "write:snapshot"]);
    expect(Reflect.get(panel, "suppressTerminalInput")).toBe(false);
  });
});

class FakeTerminalSocket {
  readyState = 1;
  binaryType = "";
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.emit("close");
  });
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function connectSocket(panel: TerminalPanel, terminal: FakeTerminal): void {
  const method: unknown = Reflect.get(panel, "connectSocket");
  if (typeof method !== "function") throw new Error("TerminalPanel.connectSocket is not callable");
  Reflect.apply(method, panel, ["project-1", "workspace-1", "terminal-1", terminal, undefined]);
}

function disposeTerminalView(panel: TerminalPanel): void {
  const method: unknown = Reflect.get(panel, "disposeTerminalView");
  if (typeof method !== "function") throw new Error("TerminalPanel.disposeTerminalView is not callable");
  Reflect.apply(method, panel, []);
}

type FakeTerminal = Pick<Terminal, "reset" | "write" | "writeln">;

function fakeTerminal(events: string[] = []): FakeTerminal {
  return {
    reset: vi.fn(() => { events.push("reset"); }),
    write: vi.fn((data: string | Uint8Array, callback?: () => void) => {
      events.push(`write:${typeof data === "string" ? data : "<bytes>"}`);
      callback?.();
    }),
    writeln: vi.fn(),
  };
}

function asWebSocket(socket: FakeTerminalSocket): WebSocket {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the harness intentionally implements only the WebSocket surface TerminalPanel consumes.
  return socket as unknown as WebSocket;
}

function terminalInfo(id: string): TerminalInfo {
  return { id, name: "Shell", cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", exited: false };
}
