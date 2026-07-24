import { describe, expect, it, vi } from "vitest";
import type { Machine, PiWebUiReleaseStatus, PiWebUiStatusResponse } from "../api";
import { initialAppState, type AppState } from "../appState";
import { PiWebUiStatusController, type PiWebUiStatusControllerDependencies } from "./piWebUiStatusController";

type StatusApi = NonNullable<PiWebUiStatusControllerDependencies["api"]>;

describe("PiWebUiStatusController", () => {
  it("targets the selected machine and applies refreshed status", async () => {
    const harness = createHarness("remote-a");
    harness.piWebUiStatus.mockResolvedValue(status("remote"));

    await harness.controller.refresh();

    expect(harness.piWebUiStatus).toHaveBeenCalledWith("remote-a");
    expect(harness.state().piWebUiStatus?.generatedAt).toBe("remote");
  });

  it("does not let an older periodic response overwrite a forced response", async () => {
    const harness = createHarness();
    const regular = createDeferred<PiWebUiStatusResponse>();
    const forced = createDeferred<PiWebUiStatusResponse>();
    harness.piWebUiStatus.mockReturnValue(regular.promise);
    harness.checkForUpdates.mockReturnValue(forced.promise);

    const regularRequest = harness.controller.refresh();
    const forcedRequest = harness.controller.checkForUpdates();
    forced.resolve(status("forced"));
    await forcedRequest;
    regular.resolve(status("regular"));
    await regularRequest;

    expect(harness.state().piWebUiStatus?.generatedAt).toBe("forced");
  });

  it("deduplicates forced checks and suppresses periodic refresh while one is pending", async () => {
    const harness = createHarness();
    const forced = createDeferred<PiWebUiStatusResponse>();
    harness.checkForUpdates.mockReturnValue(forced.promise);

    const first = harness.controller.checkForUpdates();
    const second = harness.controller.checkForUpdates();
    await harness.controller.refresh();

    expect(second).toBe(first);
    expect(harness.checkForUpdates).toHaveBeenCalledOnce();
    expect(harness.piWebUiStatus).not.toHaveBeenCalled();

    forced.resolve(status("forced"));
    await first;
  });

  it("does not apply a response or error after the selected machine changes", async () => {
    const harness = createHarness("remote-a");
    const forced = createDeferred<PiWebUiStatusResponse>();
    harness.checkForUpdates.mockReturnValue(forced.promise);

    const request = harness.controller.checkForUpdates();
    harness.selectMachine("remote-b");
    forced.resolve(status("remote-a", { error: "registry unavailable" }));
    await expect(request).resolves.toBeUndefined();

    expect(harness.state().piWebUiStatus).toBeUndefined();
  });

  it.each([
    [{ error: "registry unavailable" }, "PI WEBUI update check failed: registry unavailable"],
    [{ skipped: true }, "PI WEBUI update check was skipped"],
  ] as const)("applies status and rejects an unsuccessful manual check", async (release, message) => {
    const harness = createHarness();
    harness.checkForUpdates.mockResolvedValue(status("checked", release));

    await expect(harness.controller.checkForUpdates()).rejects.toThrow(message);

    expect(harness.state().piWebUiStatus?.generatedAt).toBe("checked");
  });

  it("clears current status and reports periodic refresh failures", async () => {
    const harness = createHarness();
    const error = new Error("offline");
    harness.setStatus(status("old"));
    harness.piWebUiStatus.mockRejectedValue(error);

    await harness.controller.refresh();

    expect(harness.state().piWebUiStatus).toBeUndefined();
    expect(harness.onRefreshError).toHaveBeenCalledWith("local", error);
  });
});

function createHarness(machineId = "local") {
  let state: AppState = { ...initialAppState(), selectedMachine: machine(machineId) };
  const piWebUiStatus = vi.fn<StatusApi["piWebUiStatus"]>();
  const checkForUpdates = vi.fn<StatusApi["checkForUpdates"]>();
  const onRefreshError = vi.fn<(machineId: string, error: unknown) => void>();
  const controller = new PiWebUiStatusController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { api: { piWebUiStatus, checkForUpdates }, onRefreshError },
  );
  return {
    controller,
    piWebUiStatus,
    checkForUpdates,
    onRefreshError,
    state: () => state,
    setStatus: (piWebUiStatusValue: PiWebUiStatusResponse) => { state = { ...state, piWebUiStatus: piWebUiStatusValue }; },
    selectMachine: (id: string) => { state = { ...state, selectedMachine: machine(id) }; },
  };
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    ...(id === "local" ? {} : { baseUrl: `https://${id}.example.test` }),
    createdAt: "now",
    updatedAt: "now",
  };
}

function status(generatedAt: string, release: Partial<PiWebUiReleaseStatus> = {}): PiWebUiStatusResponse {
  return {
    packageName: "@hyperdreamer/pi-webui",
    generatedAt,
    components: {
      web: { component: "web", label: "Web/UI", stale: false, available: true },
      sessiond: { component: "sessiond", label: "Session daemon", stale: false, available: true },
    },
    release: { packageName: "@hyperdreamer/pi-webui", updateAvailable: false, ...release },
    commands: {},
    messages: [],
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
