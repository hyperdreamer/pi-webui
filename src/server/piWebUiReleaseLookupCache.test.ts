import { describe, expect, it, vi } from "vitest";
import { createPiWebUiReleaseLookupCache } from "./piWebUiReleaseLookupCache.js";

describe("createPiWebUiReleaseLookupCache", () => {
  it("serves a fresh cached release lookup", async () => {
    let now = 1_000;
    const load = vi.fn(() => Promise.resolve("1.0.0"));
    const cache = createPiWebUiReleaseLookupCache(load, { ttlMs: 100, now: () => now });

    await expect(cache.get("0.9.0")).resolves.toMatchObject({ latestVersion: "1.0.0", checkedAtMs: 1_000 });
    now = 1_050;
    await expect(cache.get("0.9.1")).resolves.toMatchObject({ latestVersion: "1.0.0", checkedAtMs: 1_000 });

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith("0.9.0");
  });

  it("bypasses a fresh lookup when forced", async () => {
    let now = 1_000;
    const load = vi.fn()
      .mockResolvedValueOnce("1.0.0")
      .mockResolvedValueOnce("1.1.0");
    const cache = createPiWebUiReleaseLookupCache(load, { ttlMs: 100, now: () => now });

    await cache.get("0.9.0");
    now = 1_050;

    await expect(cache.get("0.9.0", { force: true })).resolves.toMatchObject({ latestVersion: "1.1.0", checkedAtMs: 1_050 });
    await expect(cache.get("0.9.0")).resolves.toMatchObject({ latestVersion: "1.1.0", checkedAtMs: 1_050 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(["forced-first", "regular-first"] as const)("does not let an older regular lookup replace a forced result when %s completes", async (completionOrder) => {
    const regular = createDeferred<string>();
    const forced = createDeferred<string>();
    const load = vi.fn()
      .mockImplementationOnce(() => regular.promise)
      .mockImplementationOnce(() => forced.promise);
    const cache = createPiWebUiReleaseLookupCache(load);

    const regularLookup = cache.get("0.9.0");
    const forcedLookup = cache.get("0.9.0", { force: true });
    if (completionOrder === "forced-first") {
      forced.resolve("2.0.0");
      await expect(forcedLookup).resolves.toMatchObject({ latestVersion: "2.0.0" });
      regular.resolve("1.0.0");
      await expect(regularLookup).resolves.toMatchObject({ latestVersion: "1.0.0" });
    } else {
      regular.resolve("1.0.0");
      await expect(regularLookup).resolves.toMatchObject({ latestVersion: "1.0.0" });
      forced.resolve("2.0.0");
      await expect(forcedLookup).resolves.toMatchObject({ latestVersion: "2.0.0" });
    }

    await expect(cache.get("0.9.0")).resolves.toMatchObject({ latestVersion: "2.0.0" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("makes regular callers join a pending forced lookup", async () => {
    const forced = createDeferred<string>();
    const load = vi.fn(() => forced.promise);
    const cache = createPiWebUiReleaseLookupCache(load);

    const forcedLookup = cache.get("0.9.0", { force: true });
    const regularLookup = cache.get("0.9.0");

    expect(regularLookup).toBe(forcedLookup);
    forced.resolve("2.0.0");
    await expect(regularLookup).resolves.toMatchObject({ latestVersion: "2.0.0" });
    expect(load).toHaveBeenCalledOnce();
  });
});

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
