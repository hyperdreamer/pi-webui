import { describe, expect, it, vi } from "vitest";
import { SlowConsumerGuard, type GuardedSocket } from "./slowConsumerGuard";

function fakeSocket(): GuardedSocket & { terminate: ReturnType<typeof vi.fn<() => void>> } {
  return { bufferedAmount: 0, terminate: vi.fn<() => void>() };
}

describe("SlowConsumerGuard", () => {
  it("leaves a socket under the soft limit alone", () => {
    const socket = fakeSocket();
    let clock = 0;
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock });
    socket.bufferedAmount = 999;
    clock = 10_000;
    expect(guard.afterSend()).toBe(false);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("does not terminate a deep consumer that is still draining", () => {
    const socket = fakeSocket();
    let clock = 0;
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock });
    socket.bufferedAmount = 5000;
    guard.afterSend();
    for (let step = 0; step < 20; step += 1) {
      clock += 90;
      socket.bufferedAmount = 5000 - (step + 1) * 100;
      expect(guard.afterSend()).toBe(false);
    }
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("does not terminate on the first deep observation when the clock is epoch-based", () => {
    const socket = fakeSocket();
    let clock = 1_700_000_000_000;
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock });
    socket.bufferedAmount = 5000;
    expect(guard.afterSend()).toBe(false);
    expect(socket.terminate).not.toHaveBeenCalled();
    clock += 99;
    expect(guard.afterSend()).toBe(false);
    expect(socket.terminate).not.toHaveBeenCalled();
    clock += 2;
    expect(guard.afterSend()).toBe(true);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a consumer that stays above the soft limit without draining", () => {
    const socket = fakeSocket();
    let clock = 0;
    const onTerminate = vi.fn();
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 1000, stallWindowMs: 100, now: () => clock, onTerminate });
    socket.bufferedAmount = 5000;
    expect(guard.afterSend()).toBe(false);
    clock = 101;
    socket.bufferedAmount = 5001;
    expect(guard.afterSend()).toBe(true);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(onTerminate).toHaveBeenCalledWith({ bufferedAmount: 5001, stalledForMs: 101 });
  });

  it("terminates only once and reports terminated state", () => {
    const socket = fakeSocket();
    let clock = 0;
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 10, stallWindowMs: 0, now: () => clock });
    socket.bufferedAmount = 100;
    guard.afterSend();
    clock = 1;
    guard.afterSend();
    expect(guard.terminated).toBe(true);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("survives a terminate() that throws", () => {
    const socket = fakeSocket();
    socket.terminate.mockImplementation(() => { throw new Error("already gone"); });
    const clock = 0;
    const guard = new SlowConsumerGuard(socket, { softLimitBytes: 10, stallWindowMs: 0, now: () => clock });
    socket.bufferedAmount = 100;
    expect(() => guard.afterSend()).not.toThrow();
    expect(guard.terminated).toBe(true);
  });
});
