import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataStore } from "./sessionMetadataStore.js";

describe("SessionMetadataStore", () => {
  let filePath: string;
  let store: SessionMetadataStore;

  beforeEach(() => {
    filePath = join(tmpdir(), `session-metadata-test-${randomUUID()}.json`);
    store = new SessionMetadataStore(filePath);
  });

  afterEach(async () => {
    await unlink(filePath).catch(() => undefined);
  });

  it("returns undefined for an unknown session path", async () => {
    await expect(store.get("/unknown/path")).resolves.toBeUndefined();
  });

  it("stores and retrieves pinned metadata", async () => {
    await store.pin("/sessions/abc.jsonl");
    const meta = await store.get("/sessions/abc.jsonl");
    expect(meta).toEqual({ pinned: true });
  });

  it("removes the pinned flag on unpin", async () => {
    await store.pin("/sessions/abc.jsonl");
    await store.unpin("/sessions/abc.jsonl");
    const meta = await store.get("/sessions/abc.jsonl");
    expect(meta?.pinned).toBe(false);
  });

  it("returns pinned paths only", async () => {
    await store.pin("/a.jsonl");
    await store.pin("/b.jsonl");
    await store.pin("/c.jsonl");
    await store.unpin("/b.jsonl");

    const pinned = await store.pinnedPaths();
    expect(new Set(pinned)).toEqual(new Set(["/a.jsonl", "/c.jsonl"]));
  });

  it("isolates metadata by path", async () => {
    await store.pin("/one.jsonl");
    await store.pin("/two.jsonl");

    const one = await store.get("/one.jsonl");
    const two = await store.get("/two.jsonl");

    expect(one).toEqual({ pinned: true });
    expect(two).toEqual({ pinned: true });
  });

  it("survives a fresh read-back (persistence)", async () => {
    await store.pin("/persist.jsonl");

    const reloaded = new SessionMetadataStore(filePath);
    const meta = await reloaded.get("/persist.jsonl");
    expect(meta).toEqual({ pinned: true });
  });

  it("returns an empty set when nothing is pinned", async () => {
    await expect(store.pinnedPaths()).resolves.toEqual([]);
  });

  it("does not throw when unpinning a non-existent path", async () => {
    await expect(store.unpin("/never-pinned.jsonl")).resolves.toBeUndefined();
  });

  it("parses additive signed order metadata while preserving pin-only files", async () => {
    await writeFile(filePath, JSON.stringify({
      "/old.jsonl": { pinned: true },
      "/ordered.jsonl": {
        pinned: false,
        order: { position: 2, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
    }), "utf8");

    await expect(store.snapshot()).resolves.toEqual({
      "/old.jsonl": { pinned: true },
      "/ordered.jsonl": {
        pinned: false,
        order: { position: 2, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
    });
  });

  it("rejects malformed order position, scope, and pin signatures", async () => {
    const invalidOrders = [
      [],
      { position: -1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      { position: 0.5, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      { position: Number.MAX_SAFE_INTEGER + 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      { position: 0, scope: { kind: "root" }, pinned: false },
      { position: 0, scope: { kind: "root", cwd: "" }, pinned: false },
      { position: 0, scope: { kind: "root", cwd: "/repo", extra: true }, pinned: false },
      { position: 0, scope: { kind: "children", parentSessionPath: "" }, pinned: false },
      { position: 0, scope: { kind: "future", cwd: "/repo" }, pinned: false },
      { position: 0, scope: { kind: "root", cwd: "/repo" } },
      { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: "no" },
      { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false, extra: true },
    ];
    for (const order of invalidOrders) {
      await writeFile(filePath, JSON.stringify({ "/ordered.jsonl": { order } }), "utf8");
      await expect(store.snapshot()).rejects.toThrow("Invalid session metadata order");
    }
  });

  it("clears order when pinning, unpinning, or clearing directly", async () => {
    await writeFile(filePath, JSON.stringify({
      "/session.jsonl": {
        order: { position: 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
    }), "utf8");

    await store.pin("/session.jsonl");
    expect(await store.get("/session.jsonl")).toEqual({ pinned: true });
    await writeFile(filePath, JSON.stringify({
      "/session.jsonl": {
        pinned: true,
        order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: true },
      },
    }), "utf8");
    await store.unpin("/session.jsonl");
    expect(await store.get("/session.jsonl")).toEqual({ pinned: false });
    await writeFile(filePath, JSON.stringify({
      "/session.jsonl": {
        pinned: false,
        order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
    }), "utf8");
    await store.clearOrder("/session.jsonl");
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      "/session.jsonl": { pinned: false },
    });
  });

  it("atomically normalizes a complete group and preserves unrelated metadata", async () => {
    await store.pin("/pinned.jsonl");
    await store.replaceOrder(
      ["/second.jsonl", "/first.jsonl"],
      { kind: "root", cwd: "/repo" },
      false,
    );

    expect(await store.snapshot()).toEqual({
      "/pinned.jsonl": { pinned: true },
      "/second.jsonl": {
        order: { position: 0, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
      "/first.jsonl": {
        order: { position: 1, scope: { kind: "root", cwd: "/repo" }, pinned: false },
      },
    });
  });

  it("rejects the whole batch when current pin metadata differs", async () => {
    await store.pin("/changed.jsonl");
    await expect(store.replaceOrder(
      ["/unchanged.jsonl", "/changed.jsonl"],
      { kind: "root", cwd: "/repo" },
      false,
    )).rejects.toThrow("Session pin state changed during reorder");
    expect(await store.get("/unchanged.jsonl")).toBeUndefined();
  });

  it("serializes complete batches with deterministic last-writer order", async () => {
    const first = store.replaceOrder(
      ["/first.jsonl", "/second.jsonl"],
      { kind: "root", cwd: "/repo" },
      false,
    );
    const second = store.replaceOrder(
      ["/second.jsonl", "/first.jsonl"],
      { kind: "root", cwd: "/repo" },
      false,
    );
    await Promise.all([first, second]);
    const snapshot = await store.snapshot();
    expect(snapshot["/second.jsonl"]?.order?.position).toBe(0);
    expect(snapshot["/first.jsonl"]?.order?.position).toBe(1);
  });

  it("removes the temporary file when the atomic rename fails", async () => {
    const renameFailure = vi.fn(() => Promise.reject(new Error("rename failed")));
    const failingStore = new SessionMetadataStore(filePath, {
      mkdir,
      readFile,
      writeFile,
      rename: renameFailure,
      unlink,
    });

    await expect(failingStore.replaceOrder(
      ["/first.jsonl"],
      { kind: "root", cwd: "/repo" },
      false,
    )).rejects.toThrow("rename failed");
    expect(renameFailure).toHaveBeenCalledOnce();
    const tempPrefix = `.${basename(filePath)}.`;
    expect((await readdir(dirname(filePath)))
      .filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp")))
      .toEqual([]);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
