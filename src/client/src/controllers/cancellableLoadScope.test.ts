import { describe, expect, it } from "vitest";
import { CancellableLoadScope, isLoadCancellation } from "./cancellableLoadScope";

describe("CancellableLoadScope", () => {
  it("has no signal before the first load starts", () => {
    expect(new CancellableLoadScope().signal).toBeUndefined();
  });

  it("aborts the previous load when a new one starts", () => {
    const scope = new CancellableLoadScope();

    const first = scope.restart();
    expect(first.aborted).toBe(false);

    const second = scope.restart();

    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it("exposes the newest signal so work resumed later cannot capture a stale one", () => {
    const scope = new CancellableLoadScope();

    const first = scope.restart();
    const second = scope.restart();

    expect(scope.signal).toBe(second);
    expect(scope.signal).not.toBe(first);
  });

  it("aborts the open load without opening a replacement", () => {
    const scope = new CancellableLoadScope();
    const open = scope.restart();

    scope.abort();

    expect(open.aborted).toBe(true);
    expect(scope.signal).toBeUndefined();
  });

  it("is safe to abort when nothing is loading", () => {
    const scope = new CancellableLoadScope();

    expect(() => { scope.abort(); scope.abort(); }).not.toThrow();
    expect(scope.signal).toBeUndefined();
  });

  it("recognizes an abort as supersession rather than a failure", () => {
    const scope = new CancellableLoadScope();
    const signal = scope.restart();
    scope.abort();

    expect(isLoadCancellation(signal.reason)).toBe(true);
    expect(isLoadCancellation(new Error("Session not found"))).toBe(false);
    expect(isLoadCancellation("network down")).toBe(false);
  });

  it("recognizes a DOM-style abort error from a cancelled fetch", () => {
    // fetch() rejects with a DOMException named AbortError; jsdom/node both
    // surface that shape, and it must not reach the user as an error banner.
    const abortError = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

    expect(isLoadCancellation(abortError)).toBe(true);
  });
});
