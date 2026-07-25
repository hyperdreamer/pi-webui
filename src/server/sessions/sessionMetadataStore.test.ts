import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
