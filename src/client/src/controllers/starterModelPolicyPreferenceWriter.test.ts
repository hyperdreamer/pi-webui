import { describe, expect, it, vi } from "vitest";
import {
  StarterModelPolicyPreferenceWriter,
  type StarterModelPolicyPreferenceWriteScope,
  type StarterModelPolicyPreferenceWriterDependencies,
  type StarterModelPolicyPreferenceWriteSnapshot,
} from "./starterModelPolicyPreferenceWriter";

describe("StarterModelPolicyPreferenceWriter", () => {
  it("serializes one scope and coalesces pending intent to the latest value", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const changes: StarterModelPolicyPreferenceWriteSnapshot[] = [];
    const writer = new StarterModelPolicyPreferenceWriter({
      save,
      onStateChange: (_scope, snapshot) => { changes.push(snapshot); },
    });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    const exact = writer.write(scope, { mode: "exact", tier: "fast" });
    const advanced = writer.write(scope, { mode: "tiered", tier: "advanced" });
    const frontier = writer.write(scope, { mode: "tiered", tier: "frontier" });

    expect(save).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => { expect(save).toHaveBeenCalledTimes(2); });
    expect(save.mock.calls[1]?.[1]).toEqual({ mode: "tiered", tier: "frontier" });

    second.resolve();
    await Promise.all([exact, advanced, frontier]);
    expect(writer.snapshot(scope)).toEqual({ saving: false });
    expect(changes.at(-1)).toEqual({ saving: false });
  });

  it("keeps machine and path scopes independent", async () => {
    const machineARepo = { machineId: "remote-a", cwd: "/repo" };
    const machineAOther = { machineId: "remote-a", cwd: "/other" };
    const machineBRepo = { machineId: "remote-b", cwd: "/repo" };
    const requests = new Map<string, ReturnType<typeof deferred>>([
      [scopeKey(machineARepo), deferred()],
      [scopeKey(machineAOther), deferred()],
      [scopeKey(machineBRepo), deferred()],
    ]);
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>((scope) => {
      const request = requests.get(scopeKey(scope));
      if (request === undefined) throw new Error("Unexpected preference write scope");
      return request.promise;
    });
    const writer = new StarterModelPolicyPreferenceWriter({ save });

    const first = writer.write(machineARepo, { mode: "exact" });
    const second = writer.write(machineAOther, { mode: "tiered", tier: "advanced" });
    const third = writer.write(machineBRepo, { mode: "tiered", tier: "frontier" });

    expect(save).toHaveBeenCalledTimes(3);
    expect(writer.snapshot(machineARepo)).toEqual({ saving: true });
    expect(writer.snapshot(machineAOther)).toEqual({ saving: true });
    expect(writer.snapshot(machineBRepo)).toEqual({ saving: true });
    expect(writer.snapshot({ machineId: "unused", cwd: "/repo" })).toEqual({ saving: false });

    requests.get(scopeKey(machineARepo))?.resolve();
    await first;
    await vi.waitFor(() => { expect(writer.snapshot(machineARepo)).toEqual({ saving: false }); });
    expect(writer.snapshot(machineAOther)).toEqual({ saving: true });
    expect(writer.snapshot(machineBRepo)).toEqual({ saving: true });

    requests.get(scopeKey(machineAOther))?.resolve();
    requests.get(scopeKey(machineBRepo))?.resolve();
    await Promise.all([second, third]);
  });

  it("clears a first failure after a pending write succeeds", async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const writer = new StarterModelPolicyPreferenceWriter({ save });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    const failed = writer.write(scope, { mode: "exact" });
    const succeeding = writer.write(scope, { mode: "tiered", tier: "capable" });

    first.reject(new Error("first failed"));
    await expect(failed).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(save).toHaveBeenCalledTimes(2); });
    expect(writer.snapshot(scope)).toEqual({ saving: true, error: "Error: first failed" });

    second.resolve();
    await expect(succeeding).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(writer.snapshot(scope)).toEqual({ saving: false }); });
  });

  it("resolves a latest failed write and exposes its error through cloned snapshots", async () => {
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>()
      .mockRejectedValue(new Error("disk full"));
    const writer = new StarterModelPolicyPreferenceWriter({ save });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    await expect(writer.write(scope, { mode: "tiered", tier: "frontier" })).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(writer.snapshot(scope)).toEqual({ saving: false, error: "Error: disk full" });
    });

    const exposed = writer.snapshot(scope);
    exposed.error = "changed outside the writer";
    expect(writer.snapshot(scope)).toEqual({ saving: false, error: "Error: disk full" });
  });

  it("does not let a state observer exception poison persistence", async () => {
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>()
      .mockResolvedValue(undefined);
    const onStateChange = vi.fn(() => { throw new Error("observer failed"); });
    const writer = new StarterModelPolicyPreferenceWriter({ save, onStateChange });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    await expect(writer.write(scope, { mode: "exact" })).resolves.toBeUndefined();
    await expect(writer.write(scope, { mode: "tiered", tier: "fast" })).resolves.toBeUndefined();
    await vi.waitFor(() => { expect(writer.snapshot(scope)).toEqual({ saving: false }); });

    expect(save).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenCalled();
  });

  it("registers the worker before invoking a reentrant save collaborator", async () => {
    const first = deferred();
    let nestedWrite: Promise<void> | undefined;
    const save = vi.fn<StarterModelPolicyPreferenceWriterDependencies["save"]>((scope) => {
      if (save.mock.calls.length === 1) {
        nestedWrite = writer.write(scope, { mode: "tiered", tier: "fast" });
        return first.promise;
      }
      return Promise.resolve();
    });
    const writer = new StarterModelPolicyPreferenceWriter({ save });
    const scope = { machineId: "remote-a", cwd: "/repo" };

    const initialWrite = writer.write(scope, { mode: "exact" });

    expect(save).toHaveBeenCalledTimes(1);
    if (nestedWrite === undefined) throw new Error("Expected the save collaborator to enqueue a write");
    first.resolve();
    await Promise.all([initialWrite, nestedWrite]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[1]).toEqual({ mode: "tiered", tier: "fast" });
  });
});

function scopeKey(scope: StarterModelPolicyPreferenceWriteScope): string {
  return JSON.stringify([scope.machineId, scope.cwd]);
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => { resolve(); };
    rejectPromise = (error) => { reject(error); };
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred promise was not initialized");
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
