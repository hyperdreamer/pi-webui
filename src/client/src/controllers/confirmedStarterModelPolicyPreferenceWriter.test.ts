import { describe, expect, it, vi } from "vitest";
import { deferred, oldSession, type SessionInfo } from "./sessionController.testSupport";
import {
  ConfirmedStarterModelPolicyPreferenceWriter,
  type ConfirmedStarterModelPolicyPreferenceWriterDependencies,
  type StarterModelPolicyPreferenceWriteScope,
  type StarterModelPolicyPreferenceWriteSnapshot,
} from "./confirmedStarterModelPolicyPreferenceWriter";

describe("ConfirmedStarterModelPolicyPreferenceWriter", () => {
  it("serializes one scope, clones session references, and coalesces pending targets", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const changes: StarterModelPolicyPreferenceWriteSnapshot[] = [];
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({
      remember,
      onStateChange: (_scope, snapshot) => { changes.push(snapshot); },
    });
    const scope = { machineId: "remote-a", cwd: "/repo" };
    const initial: SessionInfo = { ...oldSession, id: "session-a" };
    const superseded: SessionInfo = { ...oldSession, id: "session-b" };
    const latest: SessionInfo = { ...oldSession, id: "session-c" };

    const initialWrite = writer.write(scope, initial);
    initial.id = "mutated-after-enqueue";
    const supersededWrite = writer.write(scope, superseded);
    const latestWrite = writer.write(scope, latest);
    latest.id = "also-mutated-after-enqueue";

    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember.mock.calls[0]?.[0]).toEqual(scope);
    expect(remember.mock.calls[0]?.[0]).not.toBe(scope);
    expect(remember.mock.calls[0]?.[1]).toMatchObject({ id: "session-a", cwd: "/repo" });
    expect(remember.mock.calls[0]?.[1]).not.toBe(initial);

    first.resolve(undefined);
    await vi.waitFor(() => { expect(remember).toHaveBeenCalledTimes(2); });
    expect(remember).toHaveBeenNthCalledWith(
      2,
      scope,
      expect.objectContaining({ id: "session-c", cwd: "/repo" }),
    );

    second.resolve(undefined);
    await Promise.all([initialWrite, supersededWrite, latestWrite]);
    expect(writer.snapshot(scope)).toEqual({ saving: false });
    expect(changes.at(-1)).toEqual({ saving: false });
  });

  it("keeps machine and path scopes independent", async () => {
    const machineARepo = { machineId: "remote-a", cwd: "/repo" };
    const machineAOther = { machineId: "remote-a", cwd: "/other" };
    const machineBRepo = { machineId: "remote-b", cwd: "/repo" };
    const requests = new Map<string, ReturnType<typeof deferred<unknown>>>([
      [scopeKey(machineARepo), deferred<unknown>()],
      [scopeKey(machineAOther), deferred<unknown>()],
      [scopeKey(machineBRepo), deferred<unknown>()],
    ]);
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>((scope) => {
      const request = requests.get(scopeKey(scope));
      if (request === undefined) throw new Error("Unexpected confirmed preference write scope");
      return request.promise;
    });
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({ remember });

    const first = writer.write(machineARepo, { ...oldSession, id: "session-a" });
    const second = writer.write(machineAOther, { ...oldSession, id: "session-b", cwd: "/other" });
    const third = writer.write(machineBRepo, { ...oldSession, id: "session-c" });

    expect(remember).toHaveBeenCalledTimes(3);
    expect(writer.snapshot(machineARepo)).toEqual({ saving: true });
    expect(writer.snapshot(machineAOther)).toEqual({ saving: true });
    expect(writer.snapshot(machineBRepo)).toEqual({ saving: true });
    expect(writer.snapshot({ machineId: "unused", cwd: "/repo" })).toEqual({ saving: false });

    requests.get(scopeKey(machineARepo))?.resolve(undefined);
    await first;
    await vi.waitFor(() => { expect(writer.snapshot(machineARepo)).toEqual({ saving: false }); });
    expect(writer.snapshot(machineAOther)).toEqual({ saving: true });
    expect(writer.snapshot(machineBRepo)).toEqual({ saving: true });

    requests.get(scopeKey(machineAOther))?.resolve(undefined);
    requests.get(scopeKey(machineBRepo))?.resolve(undefined);
    await Promise.all([second, third]);
  });

  it("keeps an older failure until the queued success settles, then clears it", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({ remember });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    const failed = writer.write(scope, { ...oldSession, id: "session-a" });
    const succeeding = writer.write(scope, { ...oldSession, id: "session-b" });

    first.reject(new Error("first failed"));
    await expect(failed).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(remember).toHaveBeenCalledTimes(2); });
    expect(writer.snapshot(scope)).toEqual({ saving: true, error: "Error: first failed" });

    second.resolve(undefined);
    await expect(succeeding).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(writer.snapshot(scope)).toEqual({ saving: false }); });
  });

  it("contains observer exceptions so they cannot poison remember requests", async () => {
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>()
      .mockResolvedValue(undefined);
    const onStateChange = vi.fn(() => { throw new Error("observer failed"); });
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({ remember, onStateChange });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    await expect(writer.write(scope, { ...oldSession, id: "session-a" })).resolves.toBeUndefined();
    await expect(writer.write(scope, { ...oldSession, id: "session-b" })).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(writer.snapshot(scope)).toEqual({ saving: false }); });

    expect(remember).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenCalled();
  });

  it("prunes successful idle scopes while retaining failed state", async () => {
    const failing = { machineId: "remote-a", cwd: "/failing" };
    const inFlight = deferred<unknown>();
    const remember = vi.fn<ConfirmedStarterModelPolicyPreferenceWriterDependencies["remember"]>((scope) => {
      if (scope.cwd === "/failing") return Promise.reject(new Error("disk full"));
      if (scope.cwd === "/in-flight") return inFlight.promise;
      return Promise.resolve();
    });
    const writer = new ConfirmedStarterModelPolicyPreferenceWriter({ remember });

    for (const suffix of ["a", "b", "c", "d", "e"]) {
      await writer.write(
        { machineId: "remote-a", cwd: `/settled-${suffix}` },
        { ...oldSession, id: `session-${suffix}`, cwd: `/settled-${suffix}` },
      );
    }
    await writer.write(failing, { ...oldSession, id: "failed-session", cwd: "/failing" });
    const pending = writer.write(
      { machineId: "remote-a", cwd: "/in-flight" },
      { ...oldSession, id: "pending-session", cwd: "/in-flight" },
    );

    await vi.waitFor(() => { expect(trackedScopeCount(writer)).toBe(2); });
    expect(writer.snapshot({ machineId: "remote-a", cwd: "/settled-a" })).toEqual({ saving: false });
    expect(writer.snapshot(failing)).toEqual({ saving: false, error: "Error: disk full" });

    inFlight.resolve(undefined);
    await pending;
    await vi.waitFor(() => { expect(trackedScopeCount(writer)).toBe(1); });
    expect(writer.snapshot(failing)).toEqual({ saving: false, error: "Error: disk full" });
  });
});

function trackedScopeCount(writer: ConfirmedStarterModelPolicyPreferenceWriter): number {
  const states: unknown = Reflect.get(writer, "states");
  if (!(states instanceof Map)) throw new Error("Confirmed preference write states are unavailable");
  return states.size;
}

function scopeKey(scope: StarterModelPolicyPreferenceWriteScope): string {
  return JSON.stringify([scope.machineId, scope.cwd]);
}
