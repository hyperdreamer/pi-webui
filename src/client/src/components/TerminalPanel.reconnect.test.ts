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

  it("reconnects once after an unexpected close", () => {
    const firstSocket = new FakeTerminalSocket();
    const secondSocket = new FakeTerminalSocket();
    const thirdSocket = new FakeTerminalSocket();
    terminalSocketMock
      .mockReturnValueOnce(asWebSocket(firstSocket))
      .mockReturnValueOnce(asWebSocket(secondSocket))
      .mockReturnValueOnce(asWebSocket(thirdSocket));
    const panel = new TerminalPanel();
    const terminal = fakeTerminal();

    connectSocket(panel, terminal);
    firstSocket.emit("close");

    expect(terminalSocketMock).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(499);
    expect(terminalSocketMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);

    expect(terminalSocketMock).toHaveBeenCalledTimes(2);
    expect(terminalSocketMock).toHaveBeenLastCalledWith("project-1", "workspace-1", "terminal-1", undefined, "local");

    secondSocket.emit("open");
    secondSocket.emit("close");
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
});

class FakeTerminalSocket {
  readyState = 1;
  binaryType = "";
  readonly send = vi.fn();
  readonly close = vi.fn();
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

function connectSocket(panel: TerminalPanel, terminal: Pick<Terminal, "writeln">): void {
  const method: unknown = Reflect.get(panel, "connectSocket");
  if (typeof method !== "function") throw new Error("TerminalPanel.connectSocket is not callable");
  Reflect.apply(method, panel, ["project-1", "workspace-1", "terminal-1", terminal, undefined]);
}

function disposeTerminalView(panel: TerminalPanel): void {
  const method: unknown = Reflect.get(panel, "disposeTerminalView");
  if (typeof method !== "function") throw new Error("TerminalPanel.disposeTerminalView is not callable");
  Reflect.apply(method, panel, []);
}

function fakeTerminal(): Pick<Terminal, "writeln"> {
  return { writeln: vi.fn() };
}

function asWebSocket(socket: FakeTerminalSocket): WebSocket {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the harness intentionally implements only the WebSocket surface TerminalPanel consumes.
  return socket as unknown as WebSocket;
}

function terminalInfo(id: string): TerminalInfo {
  return { id, name: "Shell", cwd: "/repo", createdAt: "2026-01-01T00:00:00.000Z", exited: false };
}
